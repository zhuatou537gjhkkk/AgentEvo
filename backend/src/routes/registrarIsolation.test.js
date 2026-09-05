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

describe("factory registrar isolation (W3.3-C)", () => {
    it("observability/metrics routes through the injected aggregator with the caller scope", async () => {
        const calls = [];
        const users = { 2: user(2) };
        const base = await open(createApp({ dependencies: {
            auth: authFor(users),
            services: {
                metricsAggregator: {
                    getFullReport: (userId, window) => { calls.push([userId, window]); return { window, totalRequests: 3 }; },
                },
            },
        } }));
        const response = await fetch(`${base}/observability/metrics?window=30d`, { headers: headers(2) });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({ ok: true, totalRequests: 3 });
        expect(calls).toEqual([[2, "30d"]]);
    });

    it("observability trace detail is owner-scoped per authenticated user", async () => {
        const lookups = [];
        const users = { 1: user(1), 2: user(2) };
        const traceA = { trace_id: "A", trace_type: "graph", root_span: "{}", agent_traversal_path: "[]", tool_call_count: 1, error_count: 0, total_latency_ms: 5, model: "m", created_at: null };
        const base = await open(createApp({ dependencies: {
            auth: authFor(users),
            db: {
                getTraceById: (traceId, userId, scope) => {
                    lookups.push([traceId, Number(userId), scope]);
                    return Number(userId) === 1 && traceId === "A" ? traceA : null;
                },
                getRecentTraces: () => [],
                getRecentObservability: () => [],
            },
        } }));
        const own = await fetch(`${base}/observability/traces/A`, { headers: headers(1) });
        const other = await fetch(`${base}/observability/traces/A`, { headers: headers(2) });
        expect(own.status).toBe(200);
        expect(other.status).toBe(404);
        expect(lookups).toEqual([
            ["A", 1, { userId: 1, tenantId: "user:1" }],
            ["A", 2, { userId: 2, tenantId: "user:2" }],
        ]);
    });

    it("observability traces/otel export uses injected TraceCollector", async () => {
        const users = { 1: user(1) };
        const toOtel = [];
        const base = await open(createApp({ dependencies: {
            auth: authFor(users),
            db: {
                getTraceById: () => ({ trace_id: "T", root_span: "{}", agent_traversal_path: '["router"]', tool_call_count: 2, error_count: 0, model: "m" }),
            },
            services: { TraceCollector: { toOpenTelemetry: (record) => { toOtel.push(record); return { resourceSpans: [] }; } } },
        } }));
        const response = await fetch(`${base}/observability/traces/T/otel`, { headers: headers(1) });
        expect(response.status).toBe(200);
        expect(toOtel).toHaveLength(1);
        expect(toOtel[0]).toMatchObject({ traceId: "T", agentTraversalPath: ["router"] });
    });

    it("observability/otel/import passes the caller scope and saves via injected db", async () => {
        const users = { 3: user(3) };
        const saved = [];
        const imported = [];
        const base = await open(createApp({ dependencies: {
            auth: authFor(users),
            db: {
                getSessionById: (userId, sessionId) => (sessionId === 100 ? { id: 100 } : null),
                getSessions: () => [],
                createSession: () => 500,
                saveTrace: (trace) => { saved.push(trace); return 77; },
            },
            services: { otelToInternalTrace: (otelJson, opts) => { imported.push(opts); return { traceId: "imp", toolCallCount: 1, agentTraversalPath: [] }; } },
        } }));
        const payload = { otel: { resourceSpans: [] }, session_id: 100 };
        const response = await fetch(`${base}/observability/otel/import`, {
            method: "POST",
            headers: { ...headers(3), "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        expect(response.status).toBe(200);
        expect(imported).toEqual([{ userId: 3, sessionId: 100 }]);
        expect(saved).toEqual([{ traceId: "imp", toolCallCount: 1, agentTraversalPath: [] }]);
        // invalid session of another owner is rejected before import
        const bad = await fetch(`${base}/observability/otel/import`, {
            method: "POST",
            headers: { ...headers(3), "Content-Type": "application/json" },
            body: JSON.stringify({ otel: { resourceSpans: [] }, session_id: 999 }),
        });
        expect(bad.status).toBe(404);
    });

    it("agent-config GET routes the caller scope into the injected service", async () => {
        const calls = [];
        const users = { 5: user(5) };
        const base = await open(createApp({ dependencies: {
            auth: authFor(users),
            services: {
                agentConfig: {
                    getAll: (scope) => { calls.push(["getAll", scope]); return [{ key: "agent.router.instruction", value: "x" }]; },
                    set: () => { calls.push(["set"]); return true; },
                    listVersions: () => [],
                    getVersion: () => null,
                    restoreVersion: () => false,
                    renameVersion: () => false,
                    removeVersion: () => false,
                },
            },
        } }));
        const response = await fetch(`${base}/agent-config`, { headers: headers(5) });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.configs).toHaveLength(1);
        expect(calls).toEqual([["getAll", { userId: 5, tenantId: "user:5" }]]);
    });

    it("memory routes bind each request to the authenticated user (two-user isolation)", async () => {
        const users = { 1: user(1), 2: user(2) };
        const stores = {
            1: { memories: [{ id: 10, content: "u1 secret", type: "episodic" }] },
            2: { memories: [] },
        };
        const serviceFor = (userId) => ({
            userId,
            summary: (limit) => stores[userId].memories.slice(0, limit),
            search: (query, types, limit) => stores[userId].memories.filter((m) => String(m.content).includes(query)).slice(0, limit),
            stats: () => ({ total: stores[userId].memories.length }),
            remove: (id) => {
                const index = stores[userId].memories.findIndex((m) => m.id === Number(id));
                if (index === -1) return false;
                stores[userId].memories.splice(index, 1);
                return true;
            },
            forget: () => ({ deleted: stores[userId].memories.length }),
            consolidate: () => ({ consolidated: 0 }),
        });
        const base = await open(createApp({ dependencies: {
            auth: authFor(users),
            services: { createMemoryService: (userId) => serviceFor(Number(userId)) },
        } }));

        const list1 = await fetch(`${base}/memory`, { headers: headers(1) });
        const list2 = await fetch(`${base}/memory`, { headers: headers(2) });
        expect(list1.status).toBe(200);
        expect((await list1.json()).memories).toEqual([{ id: 10, content: "u1 secret", type: "episodic" }]);
        expect((await list2.json()).memories).toEqual([]);

        // user 2 cannot delete user 1's memory; user 1 can
        const del2 = await fetch(`${base}/memory/10`, { method: "DELETE", headers: headers(2) });
        expect(del2.status).toBe(404);
        expect(stores[1].memories).toHaveLength(1);

        const stats2 = await fetch(`${base}/memory/stats`, { headers: headers(2) });
        expect(stats2.status).toBe(200);
        expect(await stats2.json()).toEqual({ total: 0 });
    });

    it("config and observability routes return 403 for non-admin when admin policy is enforced", async () => {
        const previous = { ids: process.env.ADMIN_USER_IDS, usernames: process.env.ADMIN_USERNAMES };
        process.env.ADMIN_USER_IDS = "1";
        try {
            const users = { 1: user(1), 9: user(9) };
            const base = await open(createApp({ dependencies: {
                auth: authFor(users),
                services: { agentConfig: { getAll: () => [], set: () => true, listVersions: () => [], getVersion: () => null, restoreVersion: () => false, renameVersion: () => false, removeVersion: () => false } },
            } }));
            const admin = await fetch(`${base}/agent-config`, { headers: headers(1) });
            const nonAdmin = await fetch(`${base}/agent-config`, { headers: headers(9) });
            expect(admin.status).toBe(200);
            expect(nonAdmin.status).toBe(403);
        } finally {
            process.env.ADMIN_USER_IDS = previous.ids;
            process.env.ADMIN_USERNAMES = previous.usernames;
        }
    });
});
