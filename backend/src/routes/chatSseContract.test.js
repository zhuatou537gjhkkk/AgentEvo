import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { issueAuthToken } from "../auth.js";
import { createServer } from "node:http";

/**
 * W4-R3 (C2) — SSE 错误终态契约（legacy 路径）。
 *
 * #1  legacy chat.js 内部 catch 在 error envelope 后**不再**发 `[DONE]`（对齐 graph
 *      语义 —— 前端把 [DONE] 当成功，error+[DONE] 会被误读为成功）。
 * #3  路由级兜底：chatWithStreamImpl 内部 try 之前（getHistoryMessages 预取等）的
 *      抛错会逃逸到 Express4（不转发 async rejection），SSE 头已发时若不收尾会挂死。
 *      chatImpl 现在捕获并写 SSE error envelope + res.end。
 *
 * 两个用例验证修复后的**终态契约**（都断言不挂死 + 不泄 provider secret）：
 * - #1  内部 try 内（emitThought 之后、首帧已 flush）的错误 → SSE error envelope，
 *        **不含** `data: [DONE]`（#1：legacy error 后不再发 [DONE]，对齐 graph）。
 * - #3  pre-try（getHistoryMessages 预取，发生在首帧前）抛错 → route guard 收尾为
 *        干净 JSON 500（旧行为：Express4 不转发 async rejection，socket 挂死）。
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

const SECRET = "provider-secret-sse-e2e";

function secret503() {
    return Object.assign(new Error(`fake upstream raw (${SECRET})`), { status: 503 });
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

async function postChat(base, userId, body) {
    return fetch(`${base}/chat`, {
        method: "POST",
        headers: { ...headers(userId), "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

function noopTrace() {
    return {
        startTrace: () => "trace-x",
        startSpan: () => "span-x",
        endSpan: () => {},
        finishTrace: () => {},
        getTrace: () => ({ toolCallCount: 0, agentTraversalPath: [] }),
    };
}

describe("legacy SSE error terminal contract (W4-R3 C2)", () => {
    it("#3 pre-try getHistoryMessages throw does NOT hang — route guard returns clean 500 envelope", async () => {
        useLegacyChat();
        const users = { 1: user(1) };
        const saves = [];
        const db = {
            getSessionById: (userId, sid) =>
                userId === 1 && sid === 10 ? { id: 10, user_id: 1 } : null,
            saveMessage: (userId, sid, role, text) => {
                saves.push({ role, text });
                return 500 + saves.length;
            },
            getHistoryMessages: () => {
                throw secret503(); // 模拟 pre-try DB 读取故障（逃逸 chat.js 内部 try@118）
            },
        };
        const base = await open(createApp({ dependencies: {
            auth: authFor(users),
            db,
            getAgentExecutor: () => ({ streamEvents: async function* () {} }),
            createTraceCollector: noopTrace,
            createOnlineEvaluator: () => ({ maybeEvaluate: () => {} }),
        } }));

        const resp = await postChat(base, 1, {
            session_id: 10,
            message: "你好（pre-try 故障）",
            enable_web_search: false,
            plan_mode: false,
            enable_memory: false,
        });
        // pre-try（chat.js:88 fetchHistory）发生在首帧 emitThought(:119) 之前 → SSE 头未
        // flush，headersSent=false → guard 走 JSON 500 分支。能 resolve 说明未挂死（旧行为：
        // Express 4 不转发 async rejection，此请求 socket 会一直开着直到客户端超时）。
        expect(resp.status).toBe(500);
        expect(resp.headers.get("content-type")).toContain("application/json");
        const body = await resp.text();

        expect(body).toContain('"errorCode":"UPSTREAM_UNAVAILABLE"');
        expect(body).toContain('"requestId"');
        expect(body).not.toContain("data: [DONE]");
        expect(body).not.toContain(SECRET);
    });

    it("#1 legacy internal catch on streamDirectChat failure emits error envelope WITHOUT [DONE] and persists no assistant", async () => {
        useLegacyChat();
        const users = { 1: user(1) };
        const saves = [];
        const db = {
            getSessionById: (userId, sid) =>
                userId === 1 && sid === 10 ? { id: 10, user_id: 1 } : null,
            saveMessage: (userId, sid, role, text) => {
                saves.push({ role, text });
                return 500 + saves.length;
            },
            getHistoryMessages: () => [],
        };
        const base = await open(createApp({ dependencies: {
            auth: authFor(users),
            db,
            streamDirectChat: async () => { throw secret503(); }, // 直接流（bypass 分支）失败
            createTraceCollector: noopTrace,
            createOnlineEvaluator: () => ({ maybeEvaluate: () => {} }),
        } }));

        // 创意任务 → shouldBypassTools → 走 directStream（chat.js:124，位于内部 try 内）
        const resp = await postChat(base, 1, {
            session_id: 10,
            message: "帮我写一条广告语（测试 SSE 终态）",
            enable_web_search: false,
            plan_mode: false,
            enable_memory: false,
        });
        expect(resp.status).toBe(200);
        const body = await resp.text();

        expect(body).toContain('"type":"error"');
        expect(body).toContain('"errorCode":"UPSTREAM_UNAVAILABLE"');
        expect(body).not.toContain("data: [DONE]"); // #1：error 后无 [DONE]
        expect(body).not.toContain(SECRET);
        // 失败不落 assistant
        expect(saves.filter((s) => s.role === "assistant").length).toBe(0);
    });
});
