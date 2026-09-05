import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createApp } from "../app.js";
import { issueAuthToken } from "../auth.js";
import {
    initDB,
    createUser,
    createSession,
    getHistoryMessages,
} from "../db/index.js";

/**
 * W4-R2 — graph 可靠性矩阵（真实 LangGraph 节点 + 真实 HTTP /chat）。
 *
 * W4-R1 给 graph 的工具/流裸点接上了 withRetry + config.abortSignal（toolExecutor
 * bug、executeToolCalls signal 贯通、generalChat/searchAgent/knowledge 三处接线），
 * 但此前没有任何测试真正跑过 LangGraph 节点——只有 withRetry/classifyError 的纯
 * 语义单测。本文件把请求一路打进真实 graph 链（USE_LANGGRAPH=true），唯一注入点是
 * `services.makeLlm`（chatGraph.js:2208 → config.configurable.makeLlm），用确定性
 * fake LLM 驱动真实节点，验证：
 *
 *  1. flaky LLM（首次 503）→ 节点级 withRetry 重试 → 成功流 + [DONE] + assistant 落库；
 *  2. retry 耗尽 → 冒泡为公开错误 envelope（errorCode/retryable/requestId，不泄 provider）；
 *  3. 退避中 HTTP reader.cancel()（半开断连）→ withRetry 退避被 abort 唤醒（attempt==1，
 *     不落假 assistant）；
 *  4. 单服务器双用户并发：A 取消不影响 B 完成。
 *
 * Secrets：只用合成 marker 与假 secret，绝不含真实密钥/用户内容。
 * 关键约定：fake LLM 必须在 `stream()` 被调用时抛（withRetry 包的是调用，不是 for-await
 * 迭代）；scenario 按末条 HumanMessage content 分流，使同服 AB 请求彼此独立。
 */

const PREV_ENV = {
    langgraph: process.env.USE_LANGGRAPH,
    contextBuilder: process.env.CONTEXT_BUILDER_ENABLED,
};

const servers = [];
let base = "";

const ALICE = { username: "r2_alice" };
const BOB = { username: "r2_bob" };

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

async function postChat(user, sessionId, message, { planMode = false } = {}) {
    const response = await fetch(`${base}/chat`, {
        method: "POST",
        headers: headers(user),
        body: JSON.stringify({
            session_id: sessionId,
            message,
            enable_web_search: false,
            plan_mode: planMode,
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
 * 确定性 LLM 工厂：注入 `createApp({ dependencies: { services: { makeLlm } } })`。
 *
 * makeLlm(opts) 按 opts.streaming 分流：
 *  - 非 streaming（router/planner，temperature=0）→ invoke fake：固定返回 general 分类 JSON；
 *  - streaming（generalChat 等）→ streaming fake：同时实现 `.stream` 与 `.bindTools()→{stream}`，
 *    闭包内 attempt 计数（每次 stream() 调用 +1），从末条 HumanMessage content 读 scenario。
 *
 * scenarioFor(content) → { mode: "ok"|"flaky"|"exhaust", text?, secret?, delayMs? }：
 *  - ok     ：yield 单 chunk { content: text }（可选 delayMs 制造并发窗口）；
 *  - flaky  ：attempt 1 抛可重试 503（secret 入 error.message），之后 ok；
 *  - exhaust：恒抛可重试 503。
 *
 * @returns {{ makeLlm: Function, log: Array<{content:string,attempt:number}>, whenFirstFail: Function }}
 */
function makeFakeMakeLlm({ scenarioFor }) {
    const generalJson = JSON.stringify({
        intents: ["general"],
        primarySource: null,
        analysis: "reliability e2e",
        searchQuery: null,
    });

    const log = [];
    const failWaiters = new Map(); // content → resolve()

    const okStream = (text, delayMs = 0) =>
        (async function* () {
            if (delayMs > 0) await sleep(delayMs);
            yield { content: text };
        })();

    const failWith = (secret) =>
        Object.assign(new Error(`fake upstream unavailable (${secret})`), { status: 503 });

    const streamingOnce = (streamer) => async (msgs) => {
        const last = msgs?.[msgs.length - 1];
        const content = typeof last?.content === "string"
            ? last.content
            : String(last?.content ?? "");
        streamer.attempt += 1;
        log.push({ content, attempt: streamer.attempt });
        const sc = scenarioFor(content);
        if (sc?.mode === "exhaust") throw failWith(sc.secret);
        if (sc?.mode === "flaky" && streamer.attempt === 1) {
            failWaiters.get(content)?.();
            throw failWith(sc.secret);
        }
        return okStream(sc?.text ?? content, sc?.delayMs ?? 0);
    };

    const makeLlm = (opts) => {
        if (opts?.streaming !== true) {
            // router / planner（planMode=false 时不调 LLM）：只被 router.invoke 使用
            return {
                invoke: async () => ({ content: generalJson }),
                stream: async function* () {},
            };
        }
        // generalChat 等 streaming 节点：每 makeLlm() 一个实例、独立 attempt
        const streamer = { attempt: 0 };
        const stream = streamingOnce(streamer);
        return {
            stream,
            bindTools: () => ({ stream }),
        };
    };

    return {
        makeLlm,
        log,
        whenFirstFail(content) {
            if (failWaiters.has(content)) return failWaiters.get(content);
            let resolve;
            const promise = new Promise((r) => { resolve = r; });
            failWaiters.set(content, () => resolve());
            return promise;
        },
    };
}

function attemptsFor(log, marker) {
    return log.filter((e) => e.content.includes(marker)).length;
}

// 每场景独立 app + fresh session；用户 beforeAll 建一次。
async function bootApp(fake) {
    return open(createApp({ dependencies: { services: { makeLlm: fake.makeLlm } } }));
}

function newSession(userId) {
    return createSession(userId, `W4R2 session ${Date.now()}`);
}

describe("graph reliability matrix (W4-R2)", () => {
    beforeAll(() => {
        initDB();
        ALICE.id = createUser(ALICE.username, "hash-a");
        BOB.id = createUser(BOB.username, "hash-b");
    });

    beforeEach(() => {
        process.env.USE_LANGGRAPH = "true";
        process.env.CONTEXT_BUILDER_ENABLED = "false";
    });

    afterEach(async () => {
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

    it("1) flaky LLM (first call 503) retries at the graph node and completes with text + [DONE] + persisted assistant", async () => {
        const MSG = "请复述下面这句话：R2FLAKY123";
        const fake = makeFakeMakeLlm({
            scenarioFor: (c) => c.includes("R2FLAKY123")
                ? { mode: "flaky", text: "你好-重试成功" }
                : { mode: "ok", text: c },
        });
        base = await bootApp(fake);
        const sessionId = newSession(ALICE.id);

        const resp = await postChat(ALICE, sessionId, MSG);
        expect(resp.status).toBe(200);
        expect(resp.headers.get("content-type")).toContain("text/event-stream");
        const body = await resp.text();

        expect(body).toContain("你好-重试成功");
        expect(body).toContain("data: [DONE]");
        expect(body).toContain('"request_id"');
        // withRetry retries:2 → stream() 恰好被调 2 次（attempt1 抛、attempt2 成功）
        expect(attemptsFor(fake.log, "R2FLAKY123")).toBe(2);
        // assistant 落库（真实 DB）
        expect(rolesOf(ALICE.id, sessionId)).toEqual(["user", "assistant"]);
        expect(assistantTextsOf(ALICE.id, sessionId)).toEqual(["你好-重试成功"]);
    });

    it("2) retry exhaustion surfaces a public error envelope (UPSTREAM_UNAVAILABLE/retryable/request_id) with no provider secret leak", async () => {
        const MSG = "请复述下面这句话：R2EXH888";
        const SECRET = "provider-secret-e2e-abc";
        const fake = makeFakeMakeLlm({
            scenarioFor: () => ({ mode: "exhaust", secret: SECRET }),
        });
        base = await bootApp(fake);
        const sessionId = newSession(ALICE.id);

        const resp = await postChat(ALICE, sessionId, MSG);
        expect(resp.status).toBe(200);
        const body = await resp.text();

        // 重试预算确实被耗尽（retries:2 → ≥3 次尝试；hasTools 下 tooled+fallback 会更多）
        expect(attemptsFor(fake.log, "R2EXH888")).toBeGreaterThanOrEqual(3);
        expect(body).toContain('"errorCode":"UPSTREAM_UNAVAILABLE"');
        expect(body).toContain('"retryable":true');
        expect(body).toContain('"type":"error"');
        expect(body).toContain('"request_id"');
        // 无成功终态、不泄 provider secret、不落假 assistant
        expect(body).not.toContain("data: [DONE]");
        expect(body).not.toContain(SECRET);
        expect(rolesOf(ALICE.id, sessionId)).toEqual(["user"]);
    });

    it("3) half-open disconnect (reader.cancel) during retry backoff wakes withRetry promptly (attempt stays 1, no fake assistant persisted)", async () => {
        const MSG = "请复述下面这句话：R2ABORT77";
        const fake = makeFakeMakeLlm({
            scenarioFor: (c) => c.includes("R2ABORT77")
                ? { mode: "flaky", text: "不应到达的文本" }
                : { mode: "ok", text: c },
        });
        base = await bootApp(fake);
        const sessionId = newSession(ALICE.id);

        const firstFail = fake.whenFirstFail(MSG);
        const resp = await postChat(ALICE, sessionId, MSG);
        expect(resp.status).toBe(200);
        const reader = resp.body.getReader();

        // 等服务器端 attempt1 抛出并进入 withRetry 退避
        await firstFail;
        // 读掉首帧，确保连接/SSE 已建立，再制造半开断连
        const first = await reader.read();
        expect(first.done).toBe(false);
        await reader.cancel();

        // 等待超过最大退避窗（baseDelay 200ms × jitter ≈ ≤240ms）：若 abort 未唤醒退避，
        // attempt2 会在 ~200ms 内发生并成功落库 → 下方断言失败即暴露该 bug。
        await sleep(400);

        expect(attemptsFor(fake.log, "R2ABORT77")).toBe(1);
        expect(rolesOf(ALICE.id, sessionId)).toEqual(["user"]); // 仅 user，无假 assistant
    });

    it("4) concurrent users: A's disconnect during backoff does not cancel B's in-flight run", async () => {
        const MSG_A = "请复述下面这句话：R2ABORT_A1";
        const MSG_B = "请复述下面这句话：R2OK_B1";
        const fake = makeFakeMakeLlm({
            scenarioFor: (c) => {
                if (c.includes("R2ABORT_A1")) return { mode: "flaky", text: "A文本" };
                if (c.includes("R2OK_B1")) return { mode: "ok", text: "乙用户正常完成", delayMs: 800 };
                return { mode: "ok", text: c };
            },
        });
        base = await bootApp(fake);
        const sessionA = newSession(ALICE.id);
        const sessionB = newSession(BOB.id);

        const firstFailA = fake.whenFirstFail(MSG_A);
        const respA = await postChat(ALICE, sessionA, MSG_A);
        const respB = await postChat(BOB, sessionB, MSG_B);
        expect(respA.status).toBe(200);
        expect(respB.status).toBe(200);

        const readerA = respA.body.getReader();
        // A 已进入退避 → 取消 A；B 尚在 800ms ok 延迟窗口内 → 应不受影响地完成
        await firstFailA;
        await readerA.cancel();

        const bodyB = await respB.text();
        expect(bodyB).toContain("乙用户正常完成");
        expect(bodyB).toContain("data: [DONE]");
        expect(attemptsFor(fake.log, "R2OK_B1")).toBe(1); // B 无 flaky 泄漏
        expect(rolesOf(BOB.id, sessionB)).toEqual(["user", "assistant"]);
        expect(assistantTextsOf(BOB.id, sessionB)).toEqual(["乙用户正常完成"]);

        await sleep(400);
        expect(attemptsFor(fake.log, "R2ABORT_A1")).toBe(1); // A 未进入 attempt2
        expect(rolesOf(ALICE.id, sessionA)).toEqual(["user"]); // A 无假 assistant
    });
});
