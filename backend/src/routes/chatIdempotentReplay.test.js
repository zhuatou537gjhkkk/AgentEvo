import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createApp } from "../app.js";
import { issueAuthToken } from "../auth.js";
import { initDB, createUser, createSession, getHistoryMessages } from "../db/index.js";

/**
 * W4-R5 (T3) — /chat 同 key 完成后"重连/重放"无副作用（真实 DB + 真实幂等链）。
 *
 * 历波记录幂等只到 db 层（db/idempotency.test.js）与消息去重；从未在真实 HTTP
 * /chat 上断言：同一 X-Idempotency-Key 在首次完成后再次 POST → 服务端走
 * `reserveChatIdempotency` 的 completed 分支 → `writeReplaySSE` 直接回放存储的
 * 文本（`X-Idempotency-Replayed: true`）并提前 return —— 不再调 executor、不再落
 * 第二条 user/assistant 消息。
 *
 * 本文件用真实 DB（per-worker 临时库）+ 真实 app 默认依赖，仅注入一个计数 executor
 * （deterministic 单 chunk），`USE_LANGGRAPH=false` 走 legacy chatWithStream。
 */

const PREV_USE_LANGGRAPH = process.env.USE_LANGGRAPH;
const servers = [];
let base = "";

const ALICE = { username: "w4r5_replay_alice" };
const KEY = `replay-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const executorCalls = { count: 0 };

function countingExecutor() {
    return {
        streamEvents: async function* () {
            executorCalls.count += 1;
            yield { event: "on_chat_model_stream", data: { chunk: { content: "服务R回答" } } };
        },
    };
}

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

function headers() {
    return {
        Authorization: `Bearer ${issueAuthToken({ id: ALICE.id, username: ALICE.username })}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": KEY,
    };
}

const BODY = {
    session_id: null,
    message: "你好，重放测试（请不要统计库里的消息数）",
    enable_web_search: false,
    plan_mode: false,
    enable_memory: false,
};

async function postChat() {
    const resp = await fetch(`${base}/chat`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(BODY),
    });
    return resp;
}

describe("/chat idempotent replay — reconnect after completion has no side effects (W4-R5 T3)", () => {
    beforeAll(async () => {
        process.env.USE_LANGGRAPH = "false";
        initDB();
        ALICE.id = createUser(ALICE.username, "hash-a");
        BODY.session_id = createSession(ALICE.id, `W4R5 replay ${Date.now()}`);
        base = await open(createApp({ dependencies: { getAgentExecutor: () => countingExecutor() } }));
    });

    afterAll(async () => {
        if (PREV_USE_LANGGRAPH === undefined) delete process.env.USE_LANGGRAPH;
        else process.env.USE_LANGGRAPH = PREV_USE_LANGGRAPH;
        while (servers.length) {
            const server = servers.pop();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it("first request executes once, persists user+assistant, completes with [DONE]", async () => {
        const resp = await postChat();
        expect(resp.status).toBe(200);
        const body = await resp.text();
        expect(executorCalls.count).toBe(1);
        expect(body).toContain("服务R回答");
        expect(body).toContain("data: [DONE]");
        expect(getHistoryMessages(ALICE.id, BODY.session_id, 50).map((m) => m.role)).toEqual(["user", "assistant"]);
    });

    it("same key re-connect replays stored response: no re-execute, no extra messages", async () => {
        const resp = await postChat();
        expect(resp.status).toBe(200);
        expect(resp.headers.get("x-idempotency-replayed")).toBe("true");
        const body = await resp.text();
        expect(executorCalls.count).toBe(1); // executor 未被再次调用
        expect(body).toContain("服务R回答"); // 回放存储文本
        expect(body).toContain("data: [DONE]");
        // 无第二条 user/assistant（replay 在保存前提前 return）
        expect(getHistoryMessages(ALICE.id, BODY.session_id, 50).map((m) => m.role)).toEqual(["user", "assistant"]);
    });
});
