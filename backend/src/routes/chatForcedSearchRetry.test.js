import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { issueAuthToken } from "../auth.js";
import { createServer } from "node:http";

/**
 * W4-R3 (C3) — legacy 强制联网步 withRetry + 脱敏。
 *
 * 改造前：chat.js:207 裸调 `webSearchTool.invoke`，bocha 5xx 被 fetchBocha 吞成 [] →
 * 永远成功但"无结果"，模型被骗；失败时 raw err.message 塞进 inputForAgent 可被模型 echo。
 * 改造后：transient 抛 classifyable 错 → 此处 withRetry(retries:1) 真重试；耗尽可能
 * 回落 public 文案（toPublicError），raw 只进 console。
 *
 * 走真实 chatWithStream（deep-chat fake bag，与 registrarServiceIsolation 同构）：
 * 注入 fake webSearchTool + 捕获输入进 fake executor + fake db/trace/eval。
 */

const servers = [];
const PREV_USE_LANGGRAPH = process.env.USE_LANGGRAPH;

afterEach(async () => {
    process.env.USE_LANGGRAPH = PREV_USE_LANGGRAPH;
    while (servers.length) {
        const server = servers.pop();
        await new Promise((resolve) => server.close(resolve));
    }
});

function useLegacyChat() {
    process.env.USE_LANGGRAPH = "false";
}

async function open(app) {
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
}

function user(id) {
    return { id, username: `user-${id}`, tenant_id: `user:${id}` };
}

function authFor(users) {
    return { getUserById: (id) => users[Number(id)] || null };
}

function headers(userId) {
    return { Authorization: `Bearer ${issueAuthToken(user(userId))}` };
}

function noopTrace() {
    return {
        startTrace: () => "trace-f",
        startSpan: () => "span-f",
        endSpan: () => {},
        finishTrace: () => {},
        getTrace: () => ({ toolCallCount: 0, agentTraversalPath: [] }),
    };
}

/** 深链路 fake db（handler + chat.js 内部读写）。 */
function deepChatDbFake() {
    const saves = [];
    const metrics = [];
    const historyReads = [];
    const evals = [];
    let nextId = 100;
    return {
        saves,
        metrics,
        historyReads,
        evals,
        db: {
            getSessionById: (userId, sid) =>
                userId === 1 && sid === 10 ? { id: 10, user_id: 1 } : null,
            saveMessage: (userId, sid, role, text) => {
                saves.push({ role, text });
                return nextId++;
            },
            getHistoryMessages: (userId, sid) => {
                historyReads.push({ userId, sid });
                return [];
            },
            saveMessageMetric: (messageId, metric) => metrics.push({ messageId, metric }),
        },
        deps: {
            createTraceCollector: () => noopTrace(),
            createOnlineEvaluator: () => ({ maybeEvaluate: (arg) => evals.push(arg) }),
        },
    };
}

/** 记录 executor 收到的 agent input（用于断言强制检索注入内容/脱敏）。 */
function capturingExecutor(tag, captures) {
    return {
        streamEvents: async function* (invocation) {
            captures.input = invocation?.input ?? invocation;
            yield { event: "on_chat_model_stream", data: { chunk: { content: `服务${tag}回答` } } };
        },
    };
}

const SECRET = "provider-secret-forced-search";

function secret503() {
    return Object.assign(new Error(`bocha upstream raw (${SECRET})`), { status: 503 });
}

/** flaky fake web_search：前 failTimes 次抛 503，之后返回检索结果。 */
function flakyWebSearchTool(failTimes) {
    let calls = 0;
    return {
        name: "web_search",
        invoke: async () => {
            calls += 1;
            if (calls <= failTimes) throw secret503();
            return "模拟检索结果（命中条目 x3）";
        },
        get calls() {
            return calls;
        },
    };
}

const WEB_QUERY = "介绍一下最新的 Agentic AI 进展";

function chatRequest(base, userId, body) {
    return fetch(`${base}/chat`, {
        method: "POST",
        headers: { ...headers(userId), "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

async function makeApp(fake, webSearchTool, captures) {
    return open(createApp({ dependencies: {
        auth: authFor({ 1: user(1) }),
        db: fake.db,
        getAgentExecutor: () => capturingExecutor("F", captures),
        agentTools: [webSearchTool],
        ...fake.deps,
    } }));
}

describe("legacy forced web-search step: withRetry + sanitization (W4-R3 C3)", () => {
    it("transient 503 once → invoke retried (calls==2), result injected, secret never in stream", async () => {
        useLegacyChat();
        const fake = deepChatDbFake();
        const tool = flakyWebSearchTool(1); // 第 1 次 503，第 2 次成功
        const captures = {};
        const base = await makeApp(fake, tool, captures);

        const resp = await chatRequest(base, 1, {
            session_id: 10,
            message: WEB_QUERY,
            enable_web_search: true,
            plan_mode: false,
            enable_memory: false,
        });
        expect(resp.status).toBe(200);
        const body = await resp.text();

        expect(tool.calls).toBe(2); // withRetry(retries:1) 真重试发生
        // 成功 → forced tool_end 帧 + 注入结果文本
        expect(body).toContain('"tool_end"');
        expect(body).toContain("模拟检索结果");
        expect(body).toContain("服务F回答"); // executor 正常收尾
        expect(body).toContain("[DONE]");
        expect(body).not.toContain(SECRET);
        // agent input 携带检索结果
        expect(captures.input).toContain("模拟检索结果");
        expect(captures.input).not.toContain(SECRET);
    });

    it("persistent 503 → invoke retried once then exhausted; tool_error + public fallback, secret stays out", async () => {
        useLegacyChat();
        const fake = deepChatDbFake();
        const tool = flakyWebSearchTool(Number.MAX_SAFE_INTEGER); // 恒抛 503
        const captures = {};
        const base = await makeApp(fake, tool, captures);

        const resp = await chatRequest(base, 1, {
            session_id: 10,
            message: WEB_QUERY,
            enable_web_search: true,
            plan_mode: false,
            enable_memory: false,
        });
        expect(resp.status).toBe(200);
        const body = await resp.text();

        expect(tool.calls).toBe(2); // retries:1 → 尝试 2 次
        expect(body).toContain('"tool_error"');
        expect(body).toContain("联网检索失败");
        expect(body).not.toContain(SECRET);
        // executor 仍继续（服务端降级为让 agent 回答），input 只含脱敏公开文案
        expect(body).toContain("服务F回答");
        expect(captures.input).toContain("强制联网检索失败");
        expect(captures.input).toContain("上游服务暂时不可用，请稍后重试");
        expect(captures.input).not.toContain(SECRET);
    });
});
