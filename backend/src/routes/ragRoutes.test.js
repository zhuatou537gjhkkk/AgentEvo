import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createApp } from "../app.js";
import { issueAuthToken } from "../auth.js";
import { initDB } from "../db/index.js";
import { clearRagFlags } from "../rag/flags.js";

/**
 * Phase 7 / R4 (roadmap #9) — owner-scoped /rag HTTP contract (real app, native
 * HTTP, worker-isolated DB). Everything is default OFF: with no flags the whole
 * /rag tree is 403 RAG_FEATURE_DISABLED (401 without a bearer). When a flag is
 * ON the routes resolve injected bag services (ragIndexer / ragRetrieval /
 * ragRebuilder / durableSyncWrite), never the still-under-construction sibling
 * modules, so this suite is independent of the indexer/retrieval stack landing.
 *
 * Assertions key on status + errorCode (publicMessage rewrites only the human
 * `message`). Includes the best-effort durable dual-write wiring on /upload:
 * durable flag OFF → injected writer is never called; ON → it is called once
 * with the authenticated owner scope after the legacy index succeeded.
 */
const PROJECT = "proj_rag_1";
const servers = [];

async function open(app) {
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
    while (servers.length) {
        const server = servers.pop();
        await new Promise((resolve) => server.close(resolve));
    }
    clearRagFlags();
});

beforeAll(() => {
    // Ensure the knowledge_query_log / durable tables exist for the telemetry test.
    initDB();
});

function user(id) {
    return { id, username: `user-${id}`, tenant_id: `user:${id}` };
}

function authFor(users) {
    return { getUserById: (id) => users[Number(id)] || null };
}

function headers(userId) {
    return { Authorization: `Bearer ${issueAuthToken(user(userId))}` };
}

function jsonHeaders(userId) {
    return { ...headers(userId), "Content-Type": "application/json" };
}

async function post(base, path, userId, body) {
    const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: jsonHeaders(userId),
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: response.status, body: json, text };
}

async function get(base, path, userId) {
    const response = await fetch(`${base}${path}`, { headers: headers(userId) });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: response.status, body: json, text };
}

/** Quota + legacy rag fakes so /upload runs without touching real stores. */
function uploadFakes() {
    const ragCalls = [];
    const quota = {
        withUploadLock: async (userId, key, fn) => fn(),
        reserveUploadChunk: () => {},
        settleUploadReservation: () => {},
        releaseUploadReservation: () => {},
    };
    const services = {
        processAndStoreDocument: async (buffer, originalname, userId) => {
            ragCalls.push([buffer.byteLength, originalname, userId]);
            return { ok: true, id: 7 };
        },
    };
    return { quota, services, ragCalls };
}

describe("R4 /rag registrar — default dark (all RAG flags off)", () => {
    const users = { 1: user(1) };

    it("401 without a bearer token on every /rag route", async () => {
        const base = await open(createApp({ dependencies: { auth: authFor(users) } }));
        const paths = [
            "/rag/telemetry",
            `/rag/project/${PROJECT}/index`,
            `/rag/project/${PROJECT}/query`,
            `/rag/project/${PROJECT}/rebuild`,
        ];
        for (const p of paths) {
            const method = p.endsWith("telemetry") ? "GET" : "POST";
            const response = await fetch(`${base}${p}`, { method });
            expect(response.status).toBe(401);
        }
    });

    it("flags off → /rag/project/* and /rag/telemetry answer 403 RAG_FEATURE_DISABLED", async () => {
        const base = await open(createApp({ dependencies: { auth: authFor(users) } }));

        const telemetry = await get(base, "/rag/telemetry", 1);
        expect(telemetry.status).toBe(403);
        expect(telemetry.body.errorCode).toBe("RAG_FEATURE_DISABLED");

        const index = await post(base, `/rag/project/${PROJECT}/index`, 1, { files: [{ path: "a.js", text: "x" }] });
        expect(index.status).toBe(403);
        expect(index.body.errorCode).toBe("RAG_FEATURE_DISABLED");

        const query = await post(base, `/rag/project/${PROJECT}/query`, 1, { query: "x" });
        expect(query.status).toBe(403);
        expect(query.body.errorCode).toBe("RAG_FEATURE_DISABLED");

        const rebuild = await post(base, `/rag/project/${PROJECT}/rebuild`, 1, {});
        expect(rebuild.status).toBe(403);
        expect(rebuild.body.errorCode).toBe("RAG_FEATURE_DISABLED");
    });
});

describe("R4 /rag index — PROJECT_RAG_ENABLED", () => {
    const users = { 1: user(1), 2: user(2) };

    it("indexes a project snapshot through the injected bag service with the caller's owner scope", async () => {
        const calls = [];
        const ragIndexer = {
            index: async (args) => {
                calls.push(args);
                return { documents: 2, chunkCount: 10 };
            },
        };
        const base = await open(createApp({ dependencies: { auth: authFor(users), services: { ragIndexer } } }));
        process.env.PROJECT_RAG_ENABLED = "1";

        const response = await post(base, `/rag/project/${PROJECT}/index`, 2, {
            files: [
                { path: "src/auth.js", text: "export function login() {}" },
                { path: "src/db.js", text: "export const pool = {}" },
            ],
            commit: "c0ffee",
        });
        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(response.body.projectId).toBe(PROJECT);
        expect(response.body.documents).toBe(2);
        expect(response.body.chunks).toBe(10);

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            projectId: PROJECT,
            sourceCommit: "c0ffee",
            sourceRunId: null,
        });
        expect(calls[0].files).toEqual([
            { path: "src/auth.js", text: "export function login() {}" },
            { path: "src/db.js", text: "export const pool = {}" },
        ]);
        // server-authenticated owner scope — never a body-supplied owner
        expect(calls[0].scope).toEqual({ userId: 2, tenantId: "user:2" });
    });

    it("413 RAG_PAYLOAD_TOO_LARGE when more than 200 files — indexer not called", async () => {
        let called = false;
        const ragIndexer = { index: async () => { called = true; return {}; } };
        const base = await open(createApp({ dependencies: { auth: authFor(users), services: { ragIndexer } } }));
        process.env.PROJECT_RAG_ENABLED = "1";

        const files = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.js`, text: "x" }));
        const response = await post(base, `/rag/project/${PROJECT}/index`, 1, { files });
        expect(response.status).toBe(413);
        expect(response.body.errorCode).toBe("RAG_PAYLOAD_TOO_LARGE");
        expect(called).toBe(false);
    });

    it("413 RAG_PAYLOAD_TOO_LARGE when total chars exceed 2,000,000 — indexer not called", async () => {
        let called = false;
        const ragIndexer = { index: async () => { called = true; return {}; } };
        const base = await open(createApp({ dependencies: { auth: authFor(users), services: { ragIndexer } } }));
        process.env.PROJECT_RAG_ENABLED = "1";

        const files = [{ path: "big.txt", text: "y".repeat(2_000_001) }];
        const response = await post(base, `/rag/project/${PROJECT}/index`, 1, { files });
        expect(response.status).toBe(413);
        expect(response.body.errorCode).toBe("RAG_PAYLOAD_TOO_LARGE");
        expect(called).toBe(false);
    });

    it("400 RAG_BAD_REQUEST when files is not an array", async () => {
        const ragIndexer = { index: async () => ({}) };
        const base = await open(createApp({ dependencies: { auth: authFor(users), services: { ragIndexer } } }));
        process.env.PROJECT_RAG_ENABLED = "1";

        const response = await post(base, `/rag/project/${PROJECT}/index`, 1, { files: "nope" });
        expect(response.status).toBe(400);
        expect(response.body.errorCode).toBe("RAG_BAD_REQUEST");
    });

    it("422 RAG_INDEX_FAILED when the indexer throws", async () => {
        const ragIndexer = { index: async () => { throw new Error("indexer boom"); } };
        const base = await open(createApp({ dependencies: { auth: authFor(users), services: { ragIndexer } } }));
        process.env.PROJECT_RAG_ENABLED = "1";

        const response = await post(base, `/rag/project/${PROJECT}/index`, 1, { files: [{ path: "a.js", text: "x" }] });
        expect(response.status).toBe(422);
        expect(response.body.errorCode).toBe("RAG_INDEX_FAILED");
    });
});

describe("R4 /rag query — PROJECT_RAG_ENABLED", () => {
    const users = { 1: user(1) };

    it("healthy no_match → 200 status no_match with empty items (never an error)", async () => {
        const calls = [];
        const ragRetrieval = async (args) => {
            calls.push(args);
            return { status: "no_match", items: [], text: "", mode: "hybrid", metrics: { source: "durable" } };
        };
        const base = await open(createApp({ dependencies: { auth: authFor(users), services: { ragRetrieval } } }));
        process.env.PROJECT_RAG_ENABLED = "1";

        const response = await post(base, `/rag/project/${PROJECT}/query`, 1, { query: "nothing here" });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ ok: true, status: "no_match", items: [], text: "" });
        expect(calls[0]).toMatchObject({ projectId: PROJECT, query: "nothing here", scope: { userId: 1, tenantId: "user:1" } });
    });

    it("ok → 200 with items, text and metrics", async () => {
        const ragRetrieval = async () => ({
            status: "ok",
            mode: "hybrid",
            items: [{ filePath: "src/a.js", startLine: 1, endLine: 3, content: "x", commit: "abc" }],
            text: "[1] src/a.js:1-3\nx",
            metrics: { mode: "hybrid" },
        });
        const base = await open(createApp({ dependencies: { auth: authFor(users), services: { ragRetrieval } } }));
        process.env.PROJECT_RAG_ENABLED = "1";

        const response = await post(base, `/rag/project/${PROJECT}/query`, 1, { query: "login" });
        expect(response.status).toBe(200);
        expect(response.body.status).toBe("ok");
        expect(response.body.items).toHaveLength(1);
        expect(response.body.text).toContain("src/a.js");
    });

    it("backend failure (throw) → 502 RAG_QUERY_FAILED", async () => {
        const ragRetrieval = async () => { throw new Error("retrieval backend down"); };
        const base = await open(createApp({ dependencies: { auth: authFor(users), services: { ragRetrieval } } }));
        process.env.PROJECT_RAG_ENABLED = "1";

        const response = await post(base, `/rag/project/${PROJECT}/query`, 1, { query: "login" });
        expect(response.status).toBe(502);
        expect(response.body.errorCode).toBe("RAG_QUERY_FAILED");
    });

    it("status error (infrastructure) → 502 RAG_QUERY_FAILED", async () => {
        const ragRetrieval = async () => ({ status: "error", errorCode: "EMBEDDING_UNAVAILABLE", items: [] });
        const base = await open(createApp({ dependencies: { auth: authFor(users), services: { ragRetrieval } } }));
        process.env.PROJECT_RAG_ENABLED = "1";

        const response = await post(base, `/rag/project/${PROJECT}/query`, 1, { query: "login" });
        expect(response.status).toBe(502);
        expect(response.body.errorCode).toBe("RAG_QUERY_FAILED");
    });
});

describe("R4 /rag rebuild — PROJECT_RAG_ENABLED", () => {
    const users = { 1: user(1) };

    it("rebuild re-embeds a project through the injected rebuilder", async () => {
        const calls = [];
        const ragRebuilder = async (args) => {
            calls.push(args);
            return { total: 5, embedded: 5 };
        };
        const base = await open(createApp({ dependencies: { auth: authFor(users), services: { ragRebuilder } } }));
        process.env.PROJECT_RAG_ENABLED = "1";

        const response = await post(base, `/rag/project/${PROJECT}/rebuild`, 1, {});
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ ok: true, projectId: PROJECT, total: 5, embedded: 5 });
        expect(calls[0]).toMatchObject({ projectId: PROJECT, scope: { userId: 1, tenantId: "user:1" } });
    });

    it("422 RAG_REBUILD_FAILED when the rebuilder throws", async () => {
        const ragRebuilder = async () => { throw new Error("rebuild boom"); };
        const base = await open(createApp({ dependencies: { auth: authFor(users), services: { ragRebuilder } } }));
        process.env.PROJECT_RAG_ENABLED = "1";

        const response = await post(base, `/rag/project/${PROJECT}/rebuild`, 1, {});
        expect(response.status).toBe(422);
        expect(response.body.errorCode).toBe("RAG_REBUILD_FAILED");
    });
});

describe("R4 /rag telemetry — durable || project flag gate", () => {
    const users = { 1: user(1) };

    it("project flag on → 200 with a summary (real durable telemetry store, empty)", async () => {
        const base = await open(createApp({ dependencies: { auth: authFor(users) } }));
        process.env.PROJECT_RAG_ENABLED = "1";

        const response = await get(base, "/rag/telemetry", 1);
        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(response.body.telemetry.summary).toMatchObject({ total: 0, hit: 0, noMatch: 0, error: 0 });
        expect(Array.isArray(response.body.telemetry.recent)).toBe(true);
    });

    it("durable flag on (project off) → 200 telemetry", async () => {
        const base = await open(createApp({ dependencies: { auth: authFor(users) } }));
        process.env.RAG_DURABLE_ENABLED = "1";

        const response = await get(base, "/rag/telemetry", 1);
        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
    });
});

describe("R4 /upload durable dual-write wiring", () => {
    const users = { 1: user(1) };

    it("flag OFF → injected durableSyncWrite is never called; upload still 200", async () => {
        let durableCalls = 0;
        const { quota, services, ragCalls } = uploadFakes();
        services.durableSyncWrite = async () => {
            durableCalls += 1;
            return { written: true, reason: "indexed" };
        };
        const base = await open(createApp({ dependencies: { auth: authFor(users), quota, services } }));

        const form = new FormData();
        form.append("file", new Blob(["hello durable doc"], { type: "text/plain" }), "notes.txt");
        const response = await fetch(`${base}/upload`, {
            method: "POST",
            headers: headers(1),
            body: form,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ ok: true });
        expect(ragCalls).toEqual([[17, "notes.txt", 1]]);
        expect(durableCalls).toBe(0);
    });

    it("flag ON → dual-write runs after the legacy index with the authenticated owner scope", async () => {
        process.env.RAG_DURABLE_ENABLED = "1";
        const durableCalls = [];
        const { quota, services, ragCalls } = uploadFakes();
        services.durableSyncWrite = async (args) => {
            durableCalls.push(args);
            return { written: true, reason: "indexed", chunkCount: 3 };
        };
        const base = await open(createApp({ dependencies: { auth: authFor(users), quota, services } }));

        const form = new FormData();
        form.append("file", new Blob(["hello durable doc"], { type: "text/plain" }), "notes.txt");
        const response = await fetch(`${base}/upload`, {
            method: "POST",
            headers: headers(1),
            body: form,
        });
        expect(response.status).toBe(200);
        expect(ragCalls).toEqual([[17, "notes.txt", 1]]);
        expect(durableCalls).toHaveLength(1);
        expect(durableCalls[0]).toMatchObject({
            scope: { userId: 1, tenantId: "user:1" },
            fileName: "notes.txt",
        });
        expect(durableCalls[0].text).toBe("hello durable doc");
    });

    it("flag ON + writer throws → upload still succeeds (best-effort, never failing)", async () => {
        process.env.RAG_DURABLE_ENABLED = "1";
        const { quota, services } = uploadFakes();
        services.durableSyncWrite = async () => { throw new Error("durable store down"); };
        const base = await open(createApp({ dependencies: { auth: authFor(users), quota, services } }));

        const form = new FormData();
        form.append("file", new Blob(["hello durable doc"], { type: "text/plain" }), "notes.txt");
        const response = await fetch(`${base}/upload`, {
            method: "POST",
            headers: headers(1),
            body: form,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ ok: true });
    });
});
