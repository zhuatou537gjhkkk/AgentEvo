import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createApp } from "../../app.js";
import { issueAuthToken } from "../../auth.js";
import { createUser, initDB } from "../../db/index.js";
import { clearCodingFlags } from "../../coding/flags.js";

/**
 * Phase 7 / R6 — bench registrar HTTP contract (real app, real DB, native HTTP).
 *
 * The bench tree is an ADMIN + operator-gated offline surface mounted by
 * registerAllRoutes (app.js). Proves the enforcement boundary the pure service
 * layer deliberately lacks:
 *  - unauthenticated → 401 everywhere (requireAuth precedes the router);
 *  - BENCH_ENABLED dark by default → the whole tree is 403
 *    BENCH_FEATURE_DISABLED even for an admin (mounting is inert);
 *  - requireAdmin: with ADMIN_USERNAMES set, a non-allowlisted owner gets
 *    FORBIDDEN before any bench handler runs;
 *  - feature flow: POST /bench/run drives one fixed-revision scenario over the
 *    real coding substrate and echoes ONLY the durable summary row (never the
 *    raw transcript); consent gates trajectory/dataset export (R6 #5); an
 *    unknown scenario id is a 404 without running anything.
 *
 * Mirrors codingRegistrar.test.js fixture style: worker-isolated empty DB
 * (vitest.setup.js), never the real dev database. Env flags are per-process and
 * restored in afterAll. Assertions key on errorCode + status (envelope shape).
 */

const ALICE = { name: "bench_http_alice", username: "benchalice" };

const servers = [];
let base = "";

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
        headers: user ? headers(user) : {},
        body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: response.status, body: json, text };
}

beforeAll(async () => {
    initDB();
    ALICE.id = createUser(ALICE.name, "hash-bench-http");
    base = await open(createApp());
});

afterAll(async () => {
    while (servers.length) {
        const server = servers.pop();
        await new Promise((resolve) => server.close(resolve));
    }
    delete process.env.BENCH_ENABLED;
    delete process.env.ADMIN_USERNAMES;
    clearCodingFlags();
});

describe("R6 bench registrar — default dark (BENCH_ENABLED unset)", () => {
    it("the whole bench tree requires auth", async () => {
        const anon = await request("GET", "/bench/scenarios", null, null);
        expect(anon.status).toBe(401);
    });

    it("the whole bench tree is 403 while BENCH_ENABLED is dark (admin, inert mount)", async () => {
        const scenarios = await request("GET", "/bench/scenarios", ALICE, null);
        expect(scenarios.status).toBe(403);
        expect(scenarios.body.errorCode).toBe("BENCH_FEATURE_DISABLED");

        const run = await request("POST", "/bench/run", ALICE, { scenario_id: "navigation-locate-config" });
        expect(run.status).toBe(403);
        expect(run.body.errorCode).toBe("BENCH_FEATURE_DISABLED");

        const exportPath = await request("GET", "/bench/runs/bench_none/trajectory", ALICE, null);
        expect(exportPath.status).toBe(403);
        expect(exportPath.body.errorCode).toBe("BENCH_FEATURE_DISABLED");
    });
});

describe("R6 bench registrar — requireAdmin boundary", () => {
    beforeAll(() => {
        // Only a phantom allowlisted admin may pass; ALICE is not in it, so the
        // non-production default-open admin path must NOT apply here.
        process.env.ADMIN_USERNAMES = "bench-root-admin";
    });
    afterAll(() => {
        delete process.env.ADMIN_USERNAMES;
    });

    it("a non-allowlisted owner is refused before any bench handler runs", async () => {
        const scenarios = await request("GET", "/bench/scenarios", ALICE, null);
        expect(scenarios.status).toBe(403);
        expect(scenarios.body.errorCode).toBe("FORBIDDEN");
    });
});

describe("R6 bench registrar — feature flow (run / list / consent / export)", () => {
    beforeAll(() => {
        process.env.BENCH_ENABLED = "true";
        // The bench substrate shares the server's coding capability flags —
        // enabled here exactly as a live operator would for the offline eval.
        process.env.CODING_WORKSPACE_ENABLED = "true";
        process.env.CODING_WRITE_TOOLS_ENABLED = "true";
        process.env.CODING_COMMAND_TOOLS_ENABLED = "true";
        process.env.CODING_RAG_REUSE_ENABLED = "true";
        delete process.env.ADMIN_USERNAMES;
    });
    afterAll(() => {
        delete process.env.BENCH_ENABLED;
        clearCodingFlags();
    });

    it(
        "runs a scenario over HTTP, then consent gates export of redacted trajectory + dataset",
        async () => {
            const started = await request("POST", "/bench/run", ALICE, {
                scenario_id: "navigation-locate-config",
            });
            expect(started.status).toBe(201);
            expect(started.body.ok).toBe(true);
            const run = started.body.run;
            expect(run.id).toMatch(/^bench_/);
            expect(run.scenarioId).toBe("navigation-locate-config");
            expect(run.status).toBe("completed");
            expect(run.consent).toBe(false);
            expect(run.repoHeadSha).toMatch(/^[0-9a-f]{40}$/);
            expect(run.codingRunId).toBeTruthy();
            // The durable summary row never carries the raw transcript.
            expect(run.raw).toBeUndefined();
            expect(started.text).not.toContain('"steps"');

            // list + detail round-trip the same row
            const listed = await request("GET", "/bench/runs?scenario_id=navigation-locate-config", ALICE, null);
            expect(listed.status).toBe(200);
            expect(listed.body.runs.some((r) => r.id === run.id)).toBe(true);

            const detail = await request("GET", `/bench/runs/${run.id}`, ALICE, null);
            expect(detail.status).toBe(200);
            expect(detail.body.run.id).toBe(run.id);

            // no consent → trajectory/dataset export refused (R6 #5)
            const refusedTraj = await request("GET", `/bench/runs/${run.id}/trajectory?redact=paths`, ALICE, null);
            expect(refusedTraj.status).toBe(403);
            expect(refusedTraj.body.errorCode).toBe("BENCH_CONSENT_REQUIRED");

            const refusedDs = await request("GET", `/bench/runs/${run.id}/dataset?kinds=sft&redact=full`, ALICE, null);
            expect(refusedDs.status).toBe(403);
            expect(refusedDs.body.errorCode).toBe("BENCH_CONSENT_REQUIRED");

            // owner opts in
            const consented = await request("PATCH", `/bench/runs/${run.id}/consent`, ALICE, { consent: true });
            expect(consented.status).toBe(200);
            expect(consented.body.run.consent).toBe(true);

            // redacted trajectory export (no raw paths/prose)
            const traj = await request("GET", `/bench/runs/${run.id}/trajectory?redact=structural`, ALICE, null);
            expect(traj.status).toBe(200);
            expect(traj.body.trajectory.level).toBe("run");
            expect(traj.body.counts.planSteps).toBeGreaterThan(0);
            expect(traj.body.trajectory.nodes[0].node).toBe("code_agent");
            expect(traj.text).not.toContain("src/");
            expect(traj.text).not.toContain("RETRY_LIMIT");

            // dataset export carries bench-run provenance
            const ds = await request("GET", `/bench/runs/${run.id}/dataset?kinds=sft,grpo&redact=full`, ALICE, null);
            expect(ds.status).toBe(200);
            expect(ds.body.format).toBe("jsonl");
            expect(ds.body.kinds.map((k) => k.kind)).toEqual(["sft", "grpo"]);
            const sftRows = ds.body.kinds.find((k) => k.kind === "sft").rows;
            expect(sftRows.length).toBeGreaterThan(0);
            expect(sftRows[0]).toMatchObject({ kind: "sft", runId: run.id, scenarioId: "navigation-locate-config" });
        },
        120_000,
    );

    it("rejects an unknown scenario id over HTTP without running anything", async () => {
        const missing = await request("POST", "/bench/run", ALICE, { scenario_id: "does-not-exist" });
        expect(missing.status).toBe(404);
        expect(missing.body.errorCode).toBe("BENCH_SCENARIO_NOT_FOUND");
    });
});
