import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { issueAuthToken } from "../auth.js";
import { createServer } from "node:http";

// W3.3-G: 深链路服务层注入（chatWithStream 内部）+ 双 factory 并发矩阵。
//
// 与 registrarBagIsolation（仅覆盖 handler 层的 db 调用）不同，本文件把请求
// 一路打进真实的 chatWithStreamImpl：/chat handler 把实例依赖 bag 穿进
// options.deps，chat.js 内部的 saveMessage/getHistoryMessages/getAgentExecutor/
// TraceCollector/OnlineEvaluator 都从该 bag 解析。factory 提供 fake db +
// 确定性 executor（只吐 model chunk、不碰 LLM/网络/真库），从而以真实聊天链路
// 验证隔离。

const servers = [];
const PREV_USE_LANGGRAPH = process.env.USE_LANGGRAPH;

afterEach(async () => {
    // 本文件注入只作用于 legacy chatWithStream；强制关闭 LangGraph 以免真实图碰 LLM
    process.env.USE_LANGGRAPH = PREV_USE_LANGGRAPH;
    while (servers.length) {
        const server = servers.pop();
        await new Promise((resolve) => server.close(resolve));
    }
});

/** 深链路注入仅覆盖 chatWithStream，测试一律走 legacy 路径。 */
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

/**
 * 确定性 agent executor：绝不构造 ChatOpenAI，streamEvents 只吐一个文本 chunk。
 * chat.js 的 `for await` 消费后自动结束 → assistant 文本即为该 chunk 内容。
 */
function deterministicExecutor(tag) {
    return {
        streamEvents: async function* () {
            yield { event: "on_chat_model_stream", data: { chunk: { content: `服务${tag}回答` } } };
        },
    };
}

function noopTrace(tag) {
    return {
        startTrace: () => `trace-${tag}`,
        startSpan: () => `span-${tag}`,
        endSpan: () => {},
        finishTrace: () => {},
        getTrace: () => ({ toolCallCount: 0, agentTraversalPath: [] }),
    };
}

/** 完整覆盖深链路 chat 的 fake db：handler 层 + chatWithStream 内部读写。 */
function deepChatDbFake(tag, { ownerId = 1, sessionId = 10 } = {}) {
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
                userId === ownerId && sid === sessionId ? { id: sessionId, user_id: ownerId } : null,
            saveMessage: (userId, sid, role, text) => {
                saves.push({ tag, userId, sid, role, text });
                return nextId++;
            },
            getHistoryMessages: (userId, sid) => {
                historyReads.push({ tag, userId, sid });
                return [];
            },
            saveMessageMetric: (messageId, metric) => metrics.push({ tag, messageId, metric }),
        },
        deps: {
            createTraceCollector: () => noopTrace(tag),
            createOnlineEvaluator: () => ({
                maybeEvaluate: (arg) => evals.push({ tag, ...arg }),
            }),
        },
    };
}

const GENERAL_QUERY = "你好";

function chatRequest(base, userId, body) {
    return fetch(`${base}/chat`, {
        method: "POST",
        headers: { ...headers(userId), "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

describe("deep chat-pipeline service isolation (W3.3-G)", () => {
    it("general chat runs the real chatWithStream against the bag db/executor/trace/eval", async () => {
        useLegacyChat();
        const fake = deepChatDbFake("A");
        const users = { 1: user(1) };
        const base = await open(createApp({ dependencies: {
            auth: authFor(users),
            db: fake.db,
            getAgentExecutor: () => deterministicExecutor("A"),
            ...fake.deps,
        } }));

        const ok = await chatRequest(base, 1, { session_id: 10, message: GENERAL_QUERY });
        expect(ok.status).toBe(200);
        expect(ok.headers.get("content-type")).toContain("text/event-stream");
        const body = await ok.text();
        expect(body).toContain("服务A回答");

        // handler 预存 user + chat 内部存 assistant，全部落在 bag db
        expect(fake.saves).toHaveLength(2);
        expect(fake.saves[0]).toMatchObject({ tag: "A", userId: 1, sid: 10, role: "user", text: GENERAL_QUERY });
        expect(fake.saves[1]).toMatchObject({ tag: "A", userId: 1, sid: 10, role: "assistant", text: "服务A回答" });
        // 深链路历史读取走 bag
        expect(fake.historyReads).toHaveLength(1);
        expect(fake.historyReads[0]).toMatchObject({ tag: "A", userId: 1, sid: 10 });
        // trace/eval 用注入的 fake，绝不碰真库
        expect(fake.metrics).toHaveLength(1);
        expect(fake.evals).toHaveLength(1);
        expect(fake.evals[0]).toMatchObject({ tag: "A", userId: 1, sessionId: 10, messageId: 101 });
    });

    it("non-owner is rejected by the deep chain before any write reaches its bag", async () => {
        useLegacyChat();
        const fake = deepChatDbFake("A");
        const users = { 1: user(1), 2: user(2) };
        const base = await open(createApp({ dependencies: {
            auth: authFor(users),
            db: fake.db,
            getAgentExecutor: () => deterministicExecutor("A"),
            ...fake.deps,
        } }));
        const forbidden = await chatRequest(base, 2, { session_id: 10, message: GENERAL_QUERY });
        expect(forbidden.status).toBe(404);
        expect(fake.saves).toHaveLength(0);
        expect(fake.evals).toHaveLength(0);
    });
});

describe("dual-factory concurrency matrix (W3.3-G)", () => {
    it("two factory apps run the real chat pipeline concurrently without sharing any state", async () => {
        useLegacyChat();
        const fakeA = deepChatDbFake("A", { ownerId: 1, sessionId: 10 });
        const fakeB = deepChatDbFake("B", { ownerId: 2, sessionId: 20 });
        const usersA = { 1: user(1) };
        const usersB = { 2: user(2) };
        const baseA = await open(createApp({ dependencies: {
            auth: authFor(usersA),
            db: fakeA.db,
            getAgentExecutor: () => deterministicExecutor("A"),
            ...fakeA.deps,
        } }));
        const baseB = await open(createApp({ dependencies: {
            auth: authFor(usersB),
            db: fakeB.db,
            getAgentExecutor: () => deterministicExecutor("B"),
            ...fakeB.deps,
        } }));

        const [resA, resB] = await Promise.all([
            chatRequest(baseA, 1, { session_id: 10, message: GENERAL_QUERY }),
            chatRequest(baseB, 2, { session_id: 20, message: GENERAL_QUERY }),
        ]);
        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);
        expect(await resA.text()).toContain("服务A回答");
        expect(await resB.text()).toContain("服务B回答");

        // 每个 factory 只读写自己的 bag，永不串库
        expect(fakeA.saves).toHaveLength(2);
        expect(fakeA.saves.every((s) => s.tag === "A" && s.userId === 1 && s.sid === 10)).toBe(true);
        expect(fakeB.saves).toHaveLength(2);
        expect(fakeB.saves.every((s) => s.tag === "B" && s.userId === 2 && s.sid === 20)).toBe(true);
        expect(fakeA.evals.every((e) => e.tag === "A")).toBe(true);
        expect(fakeB.evals.every((e) => e.tag === "B")).toBe(true);
        expect(fakeA.historyReads.every((r) => r.tag === "A")).toBe(true);
        expect(fakeB.historyReads.every((r) => r.tag === "B")).toBe(true);
    });
});
