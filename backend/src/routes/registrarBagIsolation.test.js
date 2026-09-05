import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { issueAuthToken } from "../auth.js";
import { createServer } from "node:http";

const servers = [];

afterEach(async () => {
    while (servers.length) {
        const server = servers.pop();
        await new Promise((resolve) => server.close(resolve));
    }
});

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

/** Minimal chat db fake: only the db-count fast-path entry points are needed. */
function chatDbFake(tag) {
    const saves = [];
    const metrics = [];
    return {
        saves,
        metrics,
        db: {
            getSessionById: (userId, sessionId) => (userId === 1 && sessionId === 10 ? { id: 10, user_id: 1 } : null),
            saveMessage: (userId, sessionId, role, text) => {
                saves.push({ tag, userId, sessionId, role, text });
                return saves.length * 10;
            },
            getMessageStats: () => ({ total: 3, user_count: 1, assistant_count: 2 }),
            saveMessageMetric: (messageId, metric) => metrics.push({ tag, messageId, metric }),
        },
    };
}

const COUNT_QUERY = "数据库里现在总共有几条消息？";

describe("route-layer dependency bag isolation (W3.3-C)", () => {
    it("chat db-count path resolves db through the app bag and enforces session ownership", async () => {
        const fake = chatDbFake("A");
        const users = { 1: user(1), 2: user(2) };
        const base = await open(createApp({ dependencies: {
            auth: authFor(users),
            db: fake.db,
        } }));

        // user 2 does not own session 10 -> 404 before any message is written
        const forbidden = await fetch(`${base}/chat`, {
            method: "POST",
            headers: { ...headers(2), "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: 10, message: COUNT_QUERY }),
        });
        expect(forbidden.status).toBe(404);
        expect(fake.saves).toHaveLength(0);

        // user 1 owns session 10 -> db-count fast path runs entirely against the bag db
        const ok = await fetch(`${base}/chat`, {
            method: "POST",
            headers: { ...headers(1), "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: 10, message: COUNT_QUERY }),
        });
        expect(ok.status).toBe(200);
        expect(ok.headers.get("content-type")).toContain("text/event-stream");
        expect(await ok.text()).toContain("数据库消息共");

        expect(fake.saves).toHaveLength(2);
        for (const save of fake.saves) {
            expect(save).toMatchObject({ tag: "A", userId: 1, sessionId: 10 });
        }
        expect(fake.metrics).toHaveLength(1);
    });

    it("two factory apps never share route-layer chat db writes", async () => {
        const fakeA = chatDbFake("A");
        const fakeB = chatDbFake("B");
        const users = { 1: user(1) };
        const baseA = await open(createApp({ dependencies: { auth: authFor(users), db: fakeA.db } }));
        const baseB = await open(createApp({ dependencies: { auth: authFor(users), db: fakeB.db } }));

        await Promise.all([
            fetch(`${baseA}/chat`, {
                method: "POST",
                headers: { ...headers(1), "Content-Type": "application/json" },
                body: JSON.stringify({ session_id: 10, message: COUNT_QUERY }),
            }),
            fetch(`${baseB}/chat`, {
                method: "POST",
                headers: { ...headers(1), "Content-Type": "application/json" },
                body: JSON.stringify({ session_id: 10, message: COUNT_QUERY }),
            }),
        ]);

        expect(fakeA.saves.every((s) => s.tag === "A")).toBe(true);
        expect(fakeA.saves).toHaveLength(2);
        expect(fakeB.saves.every((s) => s.tag === "B")).toBe(true);
        expect(fakeB.saves).toHaveLength(2);
    });

    it("upload resolves quota + rag service through the app bag with the caller user id", async () => {
        const users = { 1: user(1) };
        const quotaCalls = [];
        const ragCalls = [];
        const quota = {
            withUploadLock: async (userId, key, fn) => fn(),
            reserveUploadChunk: (userId, key, index, bytes) => quotaCalls.push(["reserve", userId, key, bytes]),
            settleUploadReservation: (userId, key, bytes) => quotaCalls.push(["settle", userId, key, bytes]),
            releaseUploadReservation: () => quotaCalls.push(["release"]),
        };
        const base = await open(createApp({ dependencies: {
            auth: authFor(users),
            quota,
            services: {
                processAndStoreDocument: async (buffer, originalname, userId) => {
                    ragCalls.push([buffer.byteLength, originalname, userId]);
                    return { ok: true, id: 7 };
                },
            },
        } }));

        const form = new FormData();
        form.append("file", new Blob(["hello agent evo"], { type: "text/plain" }), "notes.txt");
        const response = await fetch(`${base}/upload`, {
            method: "POST",
            headers: headers(1),
            body: form,
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.ok).toBe(true);
        expect(ragCalls).toEqual([[15, "notes.txt", 1]]);
        expect(quotaCalls.filter(([op]) => op === "reserve" || op === "settle")).toHaveLength(2);
        expect(quotaCalls.every((c) => c[1] === 1)).toBe(true);
    });

    it("upload-image resolves the image store service through the app bag", async () => {
        const users = { 1: user(1) };
        const saved = [];
        const base = await open(createApp({ dependencies: {
            auth: authFor(users),
            services: {
                saveUploadedImage: (buffer, mime, userId) => {
                    saved.push([buffer.byteLength, mime, userId]);
                    return "img-1";
                },
            },
        } }));

        const form = new FormData();
        form.append("image", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), "a.png");
        const response = await fetch(`${base}/upload-image`, {
            method: "POST",
            headers: headers(1),
            body: form,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, id: "img-1" });
        expect(saved).toEqual([[4, "image/png", 1]]);
    });

    it("mcp /servers resolves db config reads through the app bag with the caller scope; non-admin 403", async () => {
        const previous = { ids: process.env.ADMIN_USER_IDS, usernames: process.env.ADMIN_USERNAMES };
        process.env.ADMIN_USER_IDS = "1";
        try {
            const users = { 1: user(1), 9: user(9) };
            const scopes = [];
            const base = await open(createApp({ dependencies: {
                auth: authFor(users),
                db: {
                    listMCPServerConfigs: (scope) => {
                        scopes.push(scope);
                        return [{ name: "m1", type: "mcp", enabled: true, connection_status: "connected", description: "d" }];
                    },
                },
            } }));

            const admin = await fetch(`${base}/mcp/servers`, { headers: headers(1) });
            expect(admin.status).toBe(200);
            const body = await admin.json();
            expect(body.servers.some((s) => s.name === "m1" && s.scope === "user")).toBe(true);
            expect(scopes).toEqual([{ userId: 1, tenantId: "user:1" }]);

            const nonAdmin = await fetch(`${base}/mcp/servers`, { headers: headers(9) });
            expect(nonAdmin.status).toBe(403);
        } finally {
            process.env.ADMIN_USER_IDS = previous.ids;
            process.env.ADMIN_USERNAMES = previous.usernames;
        }
    });
});
