import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { AIMessageChunk } from "@langchain/core/messages";
import { createApp } from "../app.js";
import { issueAuthToken } from "../auth.js";
import { agentTools } from "../mcp/tools.js";
import {
    initDB,
    createUser,
    createSession,
    getHistoryMessages,
} from "../db/index.js";

/**
 * W4-R4 (T2) — graph 真实工具 flaky 矩阵（searchAgentNode × 真实 web_search 工具）。
 *
 * §20/§22 反复标注的缺口：真实工具 `invoke` 侧无法经 makeLlm seam 注入 flaky，
 * 工具退避/耗尽/abort 只在纯语义单测覆盖。R3 只测了 legacy 强制联网步（fake tool +
 * USE_LANGGRAPH=false），从未驱动真实 graph 节点上的真实工具 withRetry。
 *
 * 本文件把请求打进真实 LangGraph 链（USE_LANGGRAPH=true）→ router 返回 search 意图 →
 * 真实 searchAgentNode → `toolRegistry.getTool("web_search")` 拿到的就是 mcp/tools.js
 * 的 `bochaSearchTool` **同一实例**（registerLocalTools 存原始对象）。测试临时替换其
 * `.func` 为 flaky 假函数（before/afterEach 保存还原），让真实 DynamicTool.invoke +
 * 节点级 withRetry(retries:1, signal) 端到端执行。唯一 LLM 注入点是 services.makeLlm
 * （router 非流式 invoke → search JSON；search solo summarizer 流式 stream → 固定文本）。
 *
 * 场景：1) flaky 一次 → 重试成功注入结果；2) 恒 503 → 耗尽后 {ok:false,...联网检索暂时
 * 不可用} 降级、solo 仍出回答；3) 退避中半开断连（reader.cancel）→ withRetry 退避被
 * abort 唤醒（calls==1，不落假 assistant）。secrets 只用合成 marker。
 */

const PREV_ENV = {
    langgraph: process.env.USE_LANGGRAPH,
    contextBuilder: process.env.CONTEXT_BUILDER_ENABLED,
};

const servers = [];
let base = "";

const ALICE = { username: "w4r4_alice" };

const webSearchTool = agentTools.find((t) => t.name === "web_search");
expect(webSearchTool).toBeTruthy();
const ORIGINAL_FUNC = webSearchTool.func;

function open(app) {
    return new Promise((resolve) => {
        const server = createServer(app);
        server.listen(0, "127.0.0.1", () => {
            servers.push(server);
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function headers(user) {
    return {
        Authorization: `Bearer ${issueAuthToken({ id: user.id, username: user.username })}`,
        "Content-Type": "application/json",
    };
}

async function postSearchChat(user, sessionId, message) {
    const response = await fetch(`${base}/chat`, {
        method: "POST",
        headers: headers(user),
        body: JSON.stringify({
            session_id: sessionId,
            message,
            enable_web_search: true,
            plan_mode: false,
            enable_memory: false,
        }),
    });
    return response;
}

function rolesOf(userId, sessionId) {
    return getHistoryMessages(userId, sessionId, 50).map((m) => m.role);
}

function assistantTextsOf(userId, sessionId) {
    return getHistoryMessages(userId, sessionId, 50)
        .filter((m) => m.role === "assistant")
        .map((m) => String(m.content));
}

/**
 * LLM 工厂（照 chatGraphReliability 形态）：按 opts.streaming 分流。
 *  - 非 streaming（router）→ invoke 固定返回 search JSON（intents:["search"]）。
 *  - streaming（search solo summarizer，全波唯一流式调用点）→ 逐条记录末条消息 content
 *    （含 [web_search 结果] 内嵌文本，用于断言结果注入 / 降级文案），yield 单个可 concat
 *    的 AIMessageChunk（searchAgentNode 用 response.concat(chunk) 聚合）。
 */
function makeFakeMakeLlm() {
    const searchJson = JSON.stringify({
        intents: ["search"],
        primarySource: "search",
        analysis: "tool reliability e2e",
        searchQuery: "Agentic AI 最新进展 2026 | artificial intelligence news",
    });
    const summaryInputs = [];
    const makeLlm = (opts) => {
        if (opts?.streaming !== true) {
            return {
                invoke: async () => ({ content: searchJson }),
                stream: async function* () {},
            };
        }
        const stream = async (msgs) => {
            const last = msgs?.[msgs.length - 1];
            const content = typeof last?.content === "string"
                ? last.content
                : String(last?.content ?? "");
            summaryInputs.push(content);
            return (async function* () {
                yield new AIMessageChunk({ content: "搜索Agent回答" });
            })();
        };
        return { stream, bindTools: () => ({ stream }) };
    };
    return { makeLlm, summaryInputs };
}

/** Flaky web_search func：前 failTimes 次抛带 status 的错误（secret 进 message），之后成功。 */
function makeFlakyTool({ failTimes, secret, onFirstCall, status = 503 }) {
    let calls = 0;
    const func = async () => {
        calls += 1;
        if (calls === 1) onFirstCall?.();
        if (calls <= failTimes) {
            throw Object.assign(new Error(`bocha upstream raw (${secret})`), { status });
        }
        return "模拟检索结果（命中条目 x3）";
    };
    return { get calls() { return calls; }, func };
}

async function bootApp(fake) {
    return open(createApp({ dependencies: { services: { makeLlm: fake.makeLlm } } }));
}

function newSession(userId) {
    return createSession(userId, `W4R4 session ${Date.now()}`);
}

const SECRET = "provider-secret-graph-tool";
const QUERY = "介绍一下 Agentic AI 领域的最新进展";

describe("graph real-tool reliability matrix — searchAgent × web_search flaky (W4-R4 T2)", () => {
    beforeAll(() => {
        initDB();
        ALICE.id = createUser(ALICE.username, "hash-a");
    });

    beforeEach(() => {
        process.env.USE_LANGGRAPH = "true";
        process.env.CONTEXT_BUILDER_ENABLED = "false";
    });

    afterEach(async () => {
        webSearchTool.func = ORIGINAL_FUNC; // 还原真实 bocha func
        if (PREV_ENV.langgraph === undefined) delete process.env.USE_LANGGRAPH;
        else process.env.USE_LANGGRAPH = PREV_ENV.langgraph;
        if (PREV_ENV.contextBuilder === undefined) delete process.env.CONTEXT_BUILDER_ENABLED;
        else process.env.CONTEXT_BUILDER_ENABLED = PREV_ENV.contextBuilder;
        while (servers.length) {
            const server = servers.pop();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    afterAll(() => {
        servers.length = 0;
    });

    it("flaky once → node withRetry retries (calls==2), result injected, completes with [DONE]", async () => {
        const flaky = makeFlakyTool({ failTimes: 1, secret: SECRET });
        webSearchTool.func = flaky.func;
        const fake = makeFakeMakeLlm();
        base = await bootApp(fake);
        const sessionId = newSession(ALICE.id);

        const resp = await postSearchChat(ALICE, sessionId, QUERY);
        expect(resp.status).toBe(200);
        const body = await resp.text();

        expect(flaky.calls).toBe(2); // withRetry retries:1 → 真重试发生
        expect(body).toContain('"tool_end"');
        expect(body).toContain("模拟检索结果"); // 成功结果随 tool_end 流出
        expect(body).toContain("搜索Agent回答");
        expect(body).toContain("data: [DONE]");
        expect(body).not.toContain(SECRET);
        // search summarizer 收到的 LLM input 携带检索结果、无 secret
        expect(fake.summaryInputs.some((c) => c.includes("模拟检索结果"))).toBe(true);
        expect(fake.summaryInputs.join("\n")).not.toContain(SECRET);
        expect(rolesOf(ALICE.id, sessionId)).toEqual(["user", "assistant"]);
        expect(assistantTextsOf(ALICE.id, sessionId)).toEqual(["搜索Agent回答"]);
    });

    it("persistent 503 → exhausted (calls==2), graceful {ok:false} fallback surfaces, solo still answers, no secret", async () => {
        const flaky = makeFlakyTool({ failTimes: Number.MAX_SAFE_INTEGER, secret: SECRET });
        webSearchTool.func = flaky.func;
        const fake = makeFakeMakeLlm();
        base = await bootApp(fake);
        const sessionId = newSession(ALICE.id);

        const resp = await postSearchChat(ALICE, sessionId, QUERY);
        expect(resp.status).toBe(200);
        const body = await resp.text();

        expect(flaky.calls).toBe(2); // retries:1 → 尝试 2 次后耗尽
        expect(body).toContain('"tool_error"');
        // sse.toolError 一律写固定通用文案（不泄 provider 细节）
        expect(body).toContain("工具暂时不可用");
        // 降级后 solo summarizer 仍出回答 → 正常完成终态
        expect(body).toContain("搜索Agent回答");
        expect(body).toContain("data: [DONE]");
        expect(body).not.toContain(SECRET);
        // 具体降级原因只进入 searchResults fallback JSON → search LLM input，secret 不进
        const joined = fake.summaryInputs.join("\n");
        expect(joined).toContain("联网检索暂时不可用");
        expect(joined).toContain('"ok":false');
        expect(joined).not.toContain(SECRET);
        expect(rolesOf(ALICE.id, sessionId)).toEqual(["user", "assistant"]);
    });

    it("persistent 429 → classify retryable, exhausted (calls==2), generic tool_error + {ok:false} fallback, no secret", async () => {
        // 429（上游限流）与 503 同属可重试族；断言 429 在真实节点链路同样耗尽降级。
        const flaky = makeFlakyTool({ failTimes: Number.MAX_SAFE_INTEGER, secret: SECRET, status: 429 });
        webSearchTool.func = flaky.func;
        const fake = makeFakeMakeLlm();
        base = await bootApp(fake);
        const sessionId = newSession(ALICE.id);

        const resp = await postSearchChat(ALICE, sessionId, QUERY);
        expect(resp.status).toBe(200);
        const body = await resp.text();

        expect(flaky.calls).toBe(2); // retries:1 → 尝试 2 次后耗尽
        expect(body).toContain('"tool_error"');
        expect(body).toContain("工具暂时不可用");
        expect(body).toContain("搜索Agent回答");
        expect(body).toContain("data: [DONE]");
        expect(body).not.toContain(SECRET);
        const joined = fake.summaryInputs.join("\n");
        expect(joined).toContain("联网检索暂时不可用");
        expect(joined).toContain('"ok":false');
        expect(joined).not.toContain(SECRET);
        expect(rolesOf(ALICE.id, sessionId)).toEqual(["user", "assistant"]);
    });

    it("half-open disconnect during tool retry backoff wakes withRetry (calls stays 1, no fake assistant)", async () => {
        let firstCall = null;
        const firstCallPromise = new Promise((resolve) => { firstCall = resolve; });
        const flaky = makeFlakyTool({
            failTimes: Number.MAX_SAFE_INTEGER,
            secret: SECRET,
            onFirstCall: () => firstCall(),
        });
        webSearchTool.func = flaky.func;
        const fake = makeFakeMakeLlm();
        base = await bootApp(fake);
        const sessionId = newSession(ALICE.id);

        const resp = await postSearchChat(ALICE, sessionId, QUERY);
        expect(resp.status).toBe(200);
        const reader = resp.body.getReader();

        // attempt1 已抛并进入 withRetry 退避 → 读首帧（agent/tool_start 已 flush）后取消
        await firstCallPromise;
        await sleep(30); // 让 attempt1 抛错落到 withRetry 退避窗口
        const first = await reader.read();
        expect(first.done).toBe(false);
        await reader.cancel();

        // 等待超过最大退避窗：若 abort 未唤醒退避，attempt2 会在 ~200ms 内执行 → calls 变 2
        await sleep(400);

        expect(flaky.calls).toBe(1);
        expect(rolesOf(ALICE.id, sessionId)).toEqual(["user"]); // 无假 assistant
        expect(assistantTextsOf(ALICE.id, sessionId)).toEqual([]);
        expect(fake.summaryInputs).toHaveLength(0); // solo summarizer 从未运行
    });
});
