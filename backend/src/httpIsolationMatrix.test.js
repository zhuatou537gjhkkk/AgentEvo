import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { issueAuthToken } from "./auth.js";
import {
    initDB,
    createUser,
    createSession,
    saveMessage,
    getHistoryMessages,
    saveTrace,
    addMemory,
    getFeedbackByMessage,
    getTraceById,
} from "./db/index.js";

/**
 * A3 — real-DB HTTP two-user isolation matrix.
 *
 * Unlike the fake-dependency registrar contracts (registrarIsolation/Bag/Service),
 * this boots the FULL real app (createApp() with module defaults → real db/auth/
 * services on this worker's isolated temp DB) over native HTTP and mints real
 * JWTs for two real users. It therefore proves the db-layer `WHERE user_id`
 * owner filters hold end-to-end, not just that routes forward req.user.
 *
 * Non-goals (deliberately excluded, each covered elsewhere):
 *  - upload endpoints caller wiring        → registrarBagIsolation.test.js
 *  - /chat owner 404 + two-factory concurrency → registrarServiceIsolation / registrarBagIsolation
 *  - eval deep owner matrix (admin-only tree) → covered by scope columns + admin gate here
 *  - durable quota cross-process           → uploadQuotaDurable.test.js
 *
 * Secrets: only synthetic markers below; never user content.
 */

const ALICE = { name: "iso_alice", username: "alice" };
const BOB = { name: "iso_bob", username: "bob" };
const ALICE_SECRET = "ALICE_PRIVATE_9f2c1d";
const BOB_SECRET = "BOB_PRIVATE_7a1e3b";
const ALICE_MEM = "ALICE_MEM_SECRET_c4d9";

const servers = [];
let base = "";

const PREV_ADMIN = { ids: process.env.ADMIN_USER_IDS, names: process.env.ADMIN_USERNAMES };

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

function headers(user) {
    return {
        Authorization: `Bearer ${issueAuthToken({ id: user.id, username: user.username })}`,
        "Content-Type": "application/json",
    };
}

async function request(method, path, user, body) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: headers(user),
        body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: response.status, body: json, text };
}

// ── fixtures ──
let aliceSessionId;      // A-owned session with an 8-message history
let bobSessionId;        // B-owned session
let aliceUserMessageId;  // first user message inside aliceSessionId
let aliceMemoryId;       // resolved at runtime via GET /memory

function seedMessageHistory(userId, sessionId, baseRole, marker, count) {
    for (let i = 0; i < count; i += 1) {
        const role = i % 2 === 0 ? baseRole : (baseRole === "user" ? "assistant" : "user");
        const content = `${marker} history ${i} — ${role}`;
        saveMessage(userId, sessionId, role, content);
    }
}

beforeAll(async () => {
    initDB();
    ALICE.id = createUser(ALICE.name, "hash-a");
    BOB.id = createUser(BOB.name, "hash-b");
    // alice is the designated admin for admin-gate assertions; bob stays a normal user.
    process.env.ADMIN_USER_IDS = String(ALICE.id);

    aliceSessionId = createSession(ALICE.id, "A 的会话");
    bobSessionId = createSession(BOB.id, "B 的会话");
    seedMessageHistory(ALICE.id, aliceSessionId, "user", ALICE_SECRET, 8);
    seedMessageHistory(BOB.id, bobSessionId, "user", BOB_SECRET, 2);

    const aliceMessages = getHistoryMessages(ALICE.id, aliceSessionId, 200);
    aliceUserMessageId = aliceMessages.find((m) => m.role === "user").id;

    // A-owned trace + A-owned memory
    saveTrace({
        userId: ALICE.id,
        tenantId: `user:${ALICE.id}`,
        sessionId: aliceSessionId,
        traceId: "alice-trace-1",
        traceType: "chat",
        rootSpan: { name: "alice span" },
        agentTraversalPath: ["router"],
    });
    addMemory(ALICE.id, aliceSessionId, ALICE_MEM, "working");

    base = await open(createApp()); // module defaults = real db/auth/services
});

afterAll(async () => {
    while (servers.length) {
        const server = servers.pop();
        await new Promise((resolve) => server.close(resolve));
    }
    process.env.ADMIN_USER_IDS = PREV_ADMIN.ids;
    process.env.ADMIN_USERNAMES = PREV_ADMIN.names;
});

async function messagesOf(userId, sessionId) {
    const result = await request("GET", `/sessions/${sessionId}/messages`, user(userId), null);
    return result;
}

function user(id) {
    return id === ALICE.id ? { id: ALICE.id, username: ALICE.username } : { id: BOB.id, username: BOB.username };
}

describe("A3 HTTP 双用户隔离矩阵（真实 DB + 原生 HTTP）", () => {
    it("sessions CRUD 写路径跨 owner 404，读路径 200 空且零内容泄露", async () => {
        // A sees own 8-message history
        const ownMessages = await messagesOf(ALICE.id, aliceSessionId);
        expect(ownMessages.status).toBe(200);
        expect(ownMessages.body.messages).toHaveLength(8);
        expect(ownMessages.text).toContain(ALICE_SECRET);

        // B reading A's session id → 200 empty, no content disclosure
        const crossMessages = await request("GET", `/sessions/${aliceSessionId}/messages`, user(BOB.id), null);
        expect(crossMessages.status).toBe(200);
        expect(crossMessages.body.messages).toEqual([]);
        expect(crossMessages.text).not.toContain(ALICE_SECRET);

        const crossUsage = await request("GET", `/sessions/${aliceSessionId}/context-usage`, user(BOB.id), null);
        expect(crossUsage.status).toBe(200);
        expect(crossUsage.text).not.toContain(ALICE_SECRET);

        // B mutating A's session → 404 SESSION_NOT_FOUND
        const rename = await request("PATCH", `/sessions/${aliceSessionId}`, user(BOB.id), { title: "hijack" });
        expect(rename.status).toBe(404);
        expect(rename.body.errorCode).toBe("SESSION_NOT_FOUND");

        const pin = await request("PATCH", `/sessions/${aliceSessionId}/pin`, user(BOB.id), { pinned: true });
        expect(pin.status).toBe(404);
        expect(pin.body.errorCode).toBe("SESSION_NOT_FOUND");

        const remove = await request("DELETE", `/sessions/${aliceSessionId}`, user(BOB.id), null);
        expect(remove.status).toBe(404);
        expect(remove.body.errorCode).toBe("SESSION_NOT_FOUND");

        // A can still rename → session intact
        const ownRename = await request("PATCH", `/sessions/${aliceSessionId}`, user(ALICE.id), { title: "A 已改名" });
        expect(ownRename.status).toBe(200);

        const stillThere = await messagesOf(ALICE.id, aliceSessionId);
        expect(stillThere.body.messages).toHaveLength(8);
        expect(stillThere.text).toContain(ALICE_SECRET);
    });

    it("session 扩展（pair 删除 / branch / compact）跨 owner 无副作用", async () => {
        const beforeCount = getHistoryMessages(ALICE.id, aliceSessionId, 200).length;

        // B deletes A's message pair → 400, A's history unchanged
        const pair = await request("DELETE", `/sessions/${aliceSessionId}/messages/${aliceUserMessageId}/pair`, user(BOB.id), null);
        expect(pair.status).toBe(400);
        expect(getHistoryMessages(ALICE.id, aliceSessionId, 200)).toHaveLength(beforeCount);

        // B branches from A's session → 400, B's session list unchanged
        const bobSessionsBefore = (await request("GET", "/sessions", user(BOB.id), null)).body.sessions.length;
        const branch = await request("POST", `/sessions/${aliceSessionId}/branch`, user(BOB.id), { title: "sneak" });
        expect(branch.status).toBe(400);
        const bobSessionsAfter = (await request("GET", "/sessions", user(BOB.id), null)).body.sessions.length;
        expect(bobSessionsAfter).toBe(bobSessionsBefore);

        // B compacts A's session → 200 noop because B sees zero history, A's rows untouched
        const compact = await request("POST", `/sessions/${aliceSessionId}/compact`, user(BOB.id), {});
        expect(compact.status).toBe(200);
        expect(compact.body.data).toMatchObject({ messageCount: 0 });
        expect(compact.text).not.toContain(ALICE_SECRET);
        expect(getHistoryMessages(ALICE.id, aliceSessionId, 200)).toHaveLength(beforeCount);
    });

    it("memory 跨 owner 隔离：列表/统计隔离，删除他人记忆 404", async () => {
        const aliceList = await request("GET", "/memory", user(ALICE.id), null);
        expect(aliceList.status).toBe(200);
        expect(aliceList.text).toContain(ALICE_MEM);
        aliceMemoryId = aliceList.body.memories.find((m) => String(m.content).includes(ALICE_MEM)).id;

        const bobList = await request("GET", "/memory", user(BOB.id), null);
        expect(bobList.status).toBe(200);
        expect(bobList.body.memories).toEqual([]);
        expect(bobList.text).not.toContain(ALICE_MEM);

        const bobStats = await request("GET", "/memory/stats", user(BOB.id), null);
        expect(bobStats.status).toBe(200);
        expect(bobStats.body.total).toBe(0);

        const bobDelete = await request("DELETE", `/memory/${aliceMemoryId}`, user(BOB.id), null);
        expect(bobDelete.status).toBe(404);

        const stillThere = await request("GET", "/memory", user(ALICE.id), null);
        expect(stillThere.text).toContain(ALICE_MEM);
    });

    it("feedback 跨 owner 返回 200 但 DB 不落库；owner 本人正常落库", async () => {
        // B rates A's message → 200 but no row survives under either scope
        const cross = await request("POST", "/chat/feedback", user(BOB.id), {
            message_id: aliceUserMessageId, rating: "thumbs_up",
        });
        expect(cross.status).toBe(200);
        expect(getFeedbackByMessage(ALICE.id, aliceUserMessageId, { userId: ALICE.id, tenantId: `user:${ALICE.id}` })).toBeNull();
        expect(getFeedbackByMessage(BOB.id, aliceUserMessageId, { userId: BOB.id, tenantId: `user:${BOB.id}` })).toBeNull();

        // A rates own message → row saved
        const own = await request("POST", "/chat/feedback", user(ALICE.id), {
            message_id: aliceUserMessageId, rating: "thumbs_down", comment: "own message ok",
        });
        expect(own.status).toBe(200);
        const saved = getFeedbackByMessage(ALICE.id, aliceUserMessageId, { userId: ALICE.id, tenantId: `user:${ALICE.id}` });
        expect(saved).not.toBeNull();
        expect(saved.rating).toBe("thumbs_down");
    });

    it("observability trace 跨 owner 404；admin 门禁（B 403 / A 200）", async () => {
        // A owns alice-trace-1
        expect(getTraceById("alice-trace-1", ALICE.id, { userId: ALICE.id, tenantId: `user:${ALICE.id}` })).not.toBeNull();

        const bDetail = await request("GET", "/observability/traces/alice-trace-1", user(BOB.id), null);
        expect(bDetail.status).toBe(404);
        const bOtel = await request("GET", "/observability/traces/alice-trace-1/otel", user(BOB.id), null);
        expect(bOtel.status).toBe(404);

        const aDetail = await request("GET", "/observability/traces/alice-trace-1", user(ALICE.id), null);
        expect(aDetail.status).toBe(200);

        // admin-only groups: normal user B is refused, admin A passes
        const bConfig = await request("GET", "/agent-config", user(BOB.id), null);
        expect(bConfig.status).toBe(403);
        const aConfig = await request("GET", "/agent-config", user(ALICE.id), null);
        expect(aConfig.status).toBe(200);

        const bEval = await request("GET", "/eval/report", user(BOB.id), null);
        expect(bEval.status).toBe(403);
        const aEval = await request("GET", "/eval/report", user(ALICE.id), null);
        expect(aEval.status).toBe(200);

        const bMcp = await request("GET", "/mcp/servers", user(BOB.id), null);
        expect(bMcp.status).toBe(403);
    });

    it("并发混合操作：各用户数据互不串改", async () => {
        // Parallel session creation by both users
        const aIds = [];
        const bIds = [];
        await Promise.all([
            ...Array.from({ length: 4 }, async () => {
                const res = await request("POST", "/sessions", user(ALICE.id), { title: "A 并发" });
                aIds.push(res.body.id);
            }),
            ...Array.from({ length: 4 }, async () => {
                const res = await request("POST", "/sessions", user(BOB.id), { title: "B 并发" });
                bIds.push(res.body.id);
            }),
        ]);

        // Each user's list contains exactly their own new ids, never the other's
        const aList = (await request("GET", "/sessions", user(ALICE.id), null)).body.sessions;
        const bList = (await request("GET", "/sessions", user(BOB.id), null)).body.sessions;
        const aListIds = new Set(aList.map((s) => Number(s.id)));
        const bListIds = new Set(bList.map((s) => Number(s.id)));
        for (const id of aIds) expect(aListIds.has(id)).toBe(true);
        for (const id of bIds) expect(bListIds.has(id)).toBe(true);
        for (const id of bIds) expect(aListIds.has(id)).toBe(false);
        for (const id of aIds) expect(bListIds.has(id)).toBe(false);

        // Concurrent cross-owner mutations all fail with 404 and never delete/alter targets
        const target = aIds[0];
        const results = await Promise.all([
            request("PATCH", `/sessions/${target}`, user(BOB.id), { title: "steal" }),
            request("DELETE", `/sessions/${target}`, user(BOB.id), null),
            request("PATCH", `/sessions/${bIds[0]}`, user(ALICE.id), { title: "steal-back" }),
            request("PATCH", `/sessions/${target}`, user(ALICE.id), { title: "A 自己的改名" }),
        ]);
        expect(results.map((r) => r.status)).toEqual([404, 404, 404, 200]);

        // B cannot read A's concurrent session content; A's own rename survived
        const crossRead = await request("GET", `/sessions/${target}/messages`, user(BOB.id), null);
        expect(crossRead.status).toBe(200);
        expect(crossRead.body.messages).toEqual([]);
        const aOwn = await request("GET", "/sessions", user(ALICE.id), null);
        const renamed = aOwn.body.sessions.find((s) => Number(s.id) === target);
        expect(renamed.title).toBe("A 自己的改名");
    });
});
