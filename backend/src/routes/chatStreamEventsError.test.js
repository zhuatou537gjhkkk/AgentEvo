import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { issueAuthToken } from "../auth.js";
import { createServer } from "node:http";

/**
 * W4-R4 (T1, SSE #2) — legacy AgentExecutor.streamEvents 错误分支收口。
 *
 * 改造前：
 *  - for-await 对非 4 种已知事件一律 `continue` 静默吞 —— `on_chain_error`/
 *    `on_chat_model_error`/`on_llm_error` 若作为事件到达会被当成"正常结束"→ 假 [DONE]。
 *  - 成功终态 persistMessage 无 fullText 空值守卫 → 零文本 run 落空 assistant 行 + 假 [DONE]。
 * 改造后：error 族事件升级抛错 → 收敛到外层 catch（error envelope + res.end()，无 [DONE]，
 * 不落 assistant）；空输出按失败终态处理（不落空 assistant、不发 [DONE]）。
 *
 * 走真实 chatWithStream（deep-chat fake bag），Region B（enable_web_search=false，
 * 避开强制联网层），注入 scripted fake executor 控制事件流。
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

/** 深链路 fake db（handler + chat.js 内部读写），记录 saves/metrics。 */
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

const SECRET = "provider-secret-sse-stream-events";

function secret503() {
    return Object.assign(new Error(`upstream raw (${SECRET})`), { status: 503 });
}

/**
 * Scripted fake AgentExecutor：streamEvents 按脚本序列 yield 事件对象；
 * 脚本项若为 `{ throw: err }` 则在该点抛错（模拟上游 5xx 耗尽后 generator reject）。
 */
function scriptedExecutor(script) {
    return {
        streamEvents: async function* () {
            for (const step of script) {
                if (step && step.throw) throw step.throw;
                yield step;
            }
        },
    };
}

const textEvent = (content) => ({ event: "on_chat_model_stream", data: { chunk: { content } } });
const chainErrorEvent = (err) => ({ event: "on_chain_error", data: { error: err } });

function chatRequest(base, userId, body) {
    return fetch(`${base}/chat`, {
        method: "POST",
        headers: { ...headers(userId), "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

async function makeApp(fake, executor) {
    return open(createApp({ dependencies: {
        auth: authFor({ 1: user(1) }),
        db: fake.db,
        getAgentExecutor: () => executor,
        ...fake.deps,
    } }));
}

const QUERY = "介绍一下最新的 Agentic AI 进展";

describe("legacy streamEvents error branch: terminal correctness (W4-R4 T1 SSE #2)", () => {
    it("mid-iteration generator throw after partial text → error envelope, NO [DONE], no assistant persisted", async () => {
        useLegacyChat();
        const fake = deepChatDbFake();
        const executor = scriptedExecutor([textEvent("部分回答"), { throw: secret503() }]);
        const base = await makeApp(fake, executor);

        const resp = await chatRequest(base, 1, {
            session_id: 10,
            message: QUERY,
            enable_web_search: false,
            plan_mode: false,
            enable_memory: false,
        });
        expect(resp.status).toBe(200);
        const body = await resp.text();

        // 先已流出的部分文本保留在流里
        expect(body).toContain("部分回答");
        // 错误终态：error envelope，无 [DONE]，不落 assistant
        expect(body).toContain('"type":"error"');
        expect(body).toContain('"errorCode":"UPSTREAM_UNAVAILABLE"');
        expect(body).not.toContain("[DONE]");
        expect(body).not.toContain(SECRET);
        expect(fake.saves.filter((s) => s.role === "assistant")).toHaveLength(0);
        expect(fake.metrics).toHaveLength(0);
    });

    it("on_chain_error event arriving then generator completes → escalated to error envelope, NOT a fake [DONE]", async () => {
        useLegacyChat();
        const fake = deepChatDbFake();
        const executor = scriptedExecutor([chainErrorEvent(secret503())]);
        const base = await makeApp(fake, executor);

        const resp = await chatRequest(base, 1, {
            session_id: 10,
            message: QUERY,
            enable_web_search: false,
            plan_mode: false,
            enable_memory: false,
        });
        expect(resp.status).toBe(200);
        const body = await resp.text();

        expect(body).toContain('"type":"error"');
        expect(body).toContain('"errorCode":"UPSTREAM_UNAVAILABLE"');
        expect(body).not.toContain("[DONE]");
        expect(body).not.toContain(SECRET); // provider raw 只进 console/cause，不落流
        expect(fake.saves.filter((s) => s.role === "assistant")).toHaveLength(0);
        expect(fake.metrics).toHaveLength(0);
    });

    it("zero-text normal completion → EMPTY_OUTPUT failure terminal, no blank assistant + no [DONE]", async () => {
        useLegacyChat();
        const fake = deepChatDbFake();
        const executor = scriptedExecutor([]); // 空事件流，正常结束
        const base = await makeApp(fake, executor);

        const resp = await chatRequest(base, 1, {
            session_id: 10,
            message: QUERY,
            enable_web_search: false,
            plan_mode: false,
            enable_memory: false,
        });
        expect(resp.status).toBe(200);
        const body = await resp.text();

        expect(body).toContain('"type":"error"');
        expect(body).toContain("模型未生成有效回答");
        expect(body).not.toContain("[DONE]");
        expect(fake.saves.filter((s) => s.role === "assistant")).toHaveLength(0);
        expect(fake.metrics).toHaveLength(0);
    });
});
