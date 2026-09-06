import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createApp } from "../app.js";
import { issueAuthToken } from "../auth.js";
import { createSession, createUser, initDB } from "../db/index.js";
import { clearCodingFlags } from "../coding/flags.js";

/**
 * R0 — coding registrar HTTP contract (real app, real DB, native HTTP).
 *
 * Proves the enforcement boundary the pure services deliberately lack:
 *  - flags OFF by default → every /coding route (except capabilities) is 403;
 *    capabilities itself requires auth (401 without a bearer).
 *  - flags ON → owner-scoped project/run/event/approval flows over HTTP, with
 *    the single-runtime start lock (second concurrent start → 409) and the
 *    terminal restart guard, plus credential redaction across the wire.
 *  - two-user isolation end-to-end (GET/PATCH/cancel/decision → 404 cross-owner).
 *
 * Mirrors httpIsolationMatrix.test.js fixture style: worker-isolated empty DB
 * (vitest.setup.js), never the real dev database. Env flags are per-process and
 * restored in afterAll. Error envelopes preserve `errorCode` (publicMessage
 * rewrites only the human `message`), so assertions key on errorCode + status.
 */

const ALICE = { name: "reg_alice", username: "regalice" };
const BOB = { name: "reg_bob", username: "regbob" };
const SECRET_MARKER = "SK-LIVE-REGISTRAR-9f2c";

const servers = [];
let base = "";

// populated in declaration order within the "flags on" describe
let aliceProj;
let bobProj;
let aliceSessionId;
let bobSessionId;
let runMain;     // ALICE run linked to her trusted project (start/cancel/events)
let runBob;
let runApproval; // ALICE run kept non-terminal for approval decisions

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

beforeAll(async () => {
    initDB();
    ALICE.id = createUser(ALICE.name, "hash-ra");
    BOB.id = createUser(BOB.name, "hash-rb");
    aliceSessionId = createSession(ALICE.id, "reg alice session");
    bobSessionId = createSession(BOB.id, "reg bob session");
    base = await open(createApp()); // module defaults = real db/auth/services on this worker DB
});

afterAll(async () => {
    while (servers.length) {
        const server = servers.pop();
        await new Promise((resolve) => server.close(resolve));
    }
    clearCodingFlags();
});

describe("R0 registrar — default dark (all coding flags off)", () => {
    it("capabilities require auth and report every capability false", async () => {
        const anon = await fetch(`${base}/coding/capabilities`);
        expect(anon.status).toBe(401);

        const caps = await request("GET", "/coding/capabilities", ALICE, null);
        expect(caps.status).toBe(200);
        expect(caps.body.capabilities).toEqual({
            workspace: false, eventLog: false, runner: false, writeTools: false, commandTools: false,
        });
    });

    it("the whole coding tree is 403 while the workspace flag is off", async () => {
        const projectList = await request("GET", "/coding/projects", ALICE, null);
        expect(projectList.status).toBe(403);
        expect(projectList.body.errorCode).toBe("CODING_FEATURE_DISABLED");

        const projectCreate = await request("POST", "/coding/projects", ALICE, { name: "x", root_path: "/x" });
        expect(projectCreate.status).toBe(403);
        expect(projectCreate.body.errorCode).toBe("CODING_FEATURE_DISABLED");

        const events = await request("GET", "/coding/runs/run_none/events", ALICE, null);
        expect(events.status).toBe(403);
        expect(events.body.errorCode).toBe("CODING_FEATURE_DISABLED");

        const approvals = await request("POST", "/coding/runs/run_none/approvals", ALICE, { type: "write", tool: "t", input: {} });
        expect(approvals.status).toBe(403);
        expect(approvals.body.errorCode).toBe("CODING_FEATURE_DISABLED");
    });
});

describe("R0 registrar — feature flows (workspace + event log on)", () => {
    beforeAll(() => {
        process.env.CODING_WORKSPACE_ENABLED = "true";
        process.env.CODING_EVENT_LOG_ENABLED = "true";
    });

    it("capabilities reflect the flipped flags", async () => {
        const caps = await request("GET", "/coding/capabilities", ALICE, null);
        expect(caps.body.capabilities.workspace).toBe(true);
        expect(caps.body.capabilities.eventLog).toBe(true);
        expect(caps.body.capabilities.runner).toBe(false);
        expect(caps.body.capabilities.commandTools).toBe(false);
    });

    it("project lifecycle over HTTP: register/duplicate/trust/revoke, terminal is final", async () => {
        const created = await request("POST", "/coding/projects", ALICE, {
            name: "throwaway", root_path: "/workspaces/throwaway", meta: { stack: "ts" },
        });
        expect(created.status).toBe(201);
        expect(created.body.project.status).toBe("registered");
        expect(created.body.project.trusted).toBe(false);

        const dup = await request("POST", "/coding/projects", ALICE, { name: "dup", root_path: "/workspaces/throwaway" });
        expect(dup.status).toBe(409);
        expect(dup.body.errorCode).toBe("DUPLICATE_PROJECT");

        const revoked = await request("DELETE", `/coding/projects/${created.body.project.id}`, ALICE, null);
        expect(revoked.status).toBe(200);
        expect(revoked.body.project.status).toBe("revoked");

        const revive = await request("PATCH", `/coding/projects/${created.body.project.id}`, ALICE, { trusted: true });
        expect(revive.status).toBe(409);
        expect(revive.body.errorCode).toBe("PROJECT_TERMINAL");
    });

    it("creates runs whose snapshot carries the server-decided project (HTTP project-link regression)", async () => {
        const aliceCreated = await request("POST", "/coding/projects", ALICE, {
            name: "alice main", root_path: "/workspaces/alice-main", meta: {},
        });
        expect(aliceCreated.status).toBe(201);
        aliceProj = aliceCreated.body.project;
        const trust = await request("PATCH", `/coding/projects/${aliceProj.id}`, ALICE, { trusted: true });
        expect(trust.body.project.trusted).toBe(true);
        aliceProj = trust.body.project;

        const bobCreated = await request("POST", "/coding/projects", BOB, { name: "bob main", root_path: "/workspaces/bob-main" });
        expect(bobCreated.status).toBe(201);
        bobProj = bobCreated.body.project;

        const run = await request("POST", "/coding/runs", ALICE, {
            project_id: aliceProj.id,
            session_id: aliceSessionId,
            mode: "observe",
        });
        expect(run.status).toBe(201);
        runMain = run.body.run;
        expect(runMain.status).toBe("created");
        expect(runMain.projectId).toBe(aliceProj.id);
        expect(runMain.sessionId).toBe(aliceSessionId);
        expect(runMain.snapshot.project.id).toBe(aliceProj.id);
        expect(runMain.snapshot.project.status).toBe("trusted");
        expect(runMain.snapshot.project.trusted).toBe(true);
        expect(runMain.snapshot.mode).toBe("observe");
        expect(runMain.snapshot.graph).toBe("chatGraph");
        expect(runMain.eventSeq).toBe(1);

        const runB = await request("POST", "/coding/runs", BOB, { project_id: bobProj.id, session_id: bobSessionId });
        expect(runB.status).toBe(201);
        runBob = runB.body.run;
        expect(runBob.snapshot.project.id).toBe(bobProj.id);

        // R0 offers only observe mode
        const badMode = await request("POST", "/coding/runs", ALICE, { project_id: aliceProj.id, mode: "write" });
        expect(badMode.status).toBe(400);
        expect(badMode.body.errorCode).toBe("MODE_NOT_AVAILABLE");
    });

    it("durable events replay cleanly with after_seq (no duplicates)", async () => {
        const initial = await request("GET", `/coding/runs/${runMain.id}/events?after_seq=0`, ALICE, null);
        expect(initial.status).toBe(200);
        expect(initial.body.count).toBe(1);
        expect(initial.body.events[0].type).toBe("run.created");
        expect(initial.body.events[0].seq).toBe(1);

        const tail = await request("GET", `/coding/runs/${runMain.id}/events?after_seq=${initial.body.last_seq}`, ALICE, null);
        expect(tail.status).toBe(200);
        expect(tail.body.events).toEqual([]);
        expect(tail.body.count).toBe(0);

        const invalid = await request("GET", `/coding/runs/${runMain.id}/events?after_seq=-5`, ALICE, null);
        expect(invalid.status).toBe(400);
        expect(invalid.body.errorCode).toBe("INVALID_AFTER_SEQ");
    });

    it("single-runtime start: second concurrent start is 409; cancelled run cannot restart", async () => {
        const started = await request("POST", `/coding/runs/${runMain.id}/start`, ALICE, null);
        expect(started.status).toBe(200);
        expect(started.body.run.status).toBe("running");
        expect(started.body.runtime.active).toBe(true);

        const concurrent = await request("POST", `/coding/runs/${runMain.id}/start`, ALICE, null);
        expect(concurrent.status).toBe(409);
        expect(concurrent.body.errorCode).toBe("CONCURRENT_RUNTIME");

        const cancelled = await request("POST", `/coding/runs/${runMain.id}/cancel`, ALICE, null);
        expect(cancelled.status).toBe(200);
        expect(cancelled.body.run.status).toBe("cancelled");
        expect(cancelled.body.runtime.hadRuntime).toBe(true);

        // runtime released by cancel → a new start reaches the DB and is refused
        const restart = await request("POST", `/coding/runs/${runMain.id}/start`, ALICE, null);
        expect(restart.status).toBe(409);
        expect(restart.body.errorCode).toBe("RUN_TERMINAL");

        const events = await request("GET", `/coding/runs/${runMain.id}/events?after_seq=0`, ALICE, null);
        expect(events.body.events.map((e) => e.type)).toEqual(["run.created", "run.started", "run.cancelled"]);
        expect(events.body.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    it("approval request/decision over HTTP redacts credentials end-to-end", async () => {
        const created = await request("POST", "/coding/runs", ALICE, { mode: "observe" });
        expect(created.status).toBe(201);
        runApproval = created.body.run;

        const req1 = await request("POST", `/coding/runs/${runApproval.id}/approvals`, ALICE, {
            type: "write",
            tool: "edit_file",
            input: { path: "src/a.ts", content: "export const a = 1;", api_key: SECRET_MARKER },
            reason: "rewrite module A",
        });
        expect(req1.status).toBe(201);
        expect(req1.body.action.status).toBe("requested");
        expect(req1.body.approval.status).toBe("requested");
        expect(req1.text).not.toContain(SECRET_MARKER);

        const req2 = await request("POST", `/coding/runs/${runApproval.id}/approvals`, ALICE, {
            type: "network", tool: "http_get", input: { url: "https://example.com" },
        });
        expect(req2.status).toBe(201);
        const approvalA1 = req1.body.approval.id;
        const approvalA2 = req2.body.approval.id;

        const actions = await request("GET", `/coding/runs/${runApproval.id}/actions`, ALICE, null);
        expect(actions.status).toBe(200);
        expect(actions.body.count).toBe(2);
        expect(actions.text).not.toContain(SECRET_MARKER);
        const storedInput = actions.body.actions.find((a) => a.id === req1.body.action.id).input;
        expect(storedInput).toEqual({ path: "src/a.ts", content: "export const a = 1;" });

        const approvals = await request("GET", `/coding/runs/${runApproval.id}/approvals`, ALICE, null);
        expect(approvals.body.approvals.map((a) => a.status)).toEqual(["requested", "requested"]);

        // cross-owner decision is invisible → 404
        const bobDecides = await request("POST", `/coding/approvals/${approvalA1}/decision`, BOB, { approve: true });
        expect(bobDecides.status).toBe(404);
        expect(bobDecides.body.errorCode).toBe("NOT_FOUND");

        // owner decides: approve A1, deny A2
        const ok = await request("POST", `/coding/approvals/${approvalA1}/decision`, ALICE, { approve: true, reason: "ok" });
        expect(ok.status).toBe(200);
        expect(ok.body.approval.status).toBe("approved");
        expect(ok.body.action.status).toBe("approved");

        const deny = await request("POST", `/coding/approvals/${approvalA2}/decision`, ALICE, { approve: false, reason: "blocked host" });
        expect(deny.status).toBe(200);
        expect(deny.body.approval.status).toBe("denied");

        const double = await request("POST", `/coding/approvals/${approvalA1}/decision`, ALICE, { approve: false });
        expect(double.status).toBe(409);
        expect(double.body.errorCode).toBe("APPROVAL_DECIDED");

        const events = await request("GET", `/coding/runs/${runApproval.id}/events?after_seq=0`, ALICE, null);
        const types = events.body.events.map((e) => e.type);
        expect(types).toContain("action.requested");
        expect(types).toContain("approval.approved");
        expect(types).toContain("approval.denied");
    });

    it("two-user isolation over HTTP: cross-owner reads/writes are 404", async () => {
        // BOB cannot see or mutate ALICE's project / run
        const crossProject = await request("GET", `/coding/projects/${aliceProj.id}`, BOB, null);
        expect(crossProject.status).toBe(404);
        const crossPatch = await request("PATCH", `/coding/projects/${aliceProj.id}`, BOB, { trusted: false });
        expect(crossPatch.status).toBe(404);

        const crossRun = await request("GET", `/coding/runs/${runMain.id}`, BOB, null);
        expect(crossRun.status).toBe(404);
        const crossCancel = await request("POST", `/coding/runs/${runApproval.id}/cancel`, BOB, null);
        expect(crossCancel.status).toBe(404);
        expect(crossCancel.body.errorCode).toBe("NOT_FOUND");

        // owner still controls the resource afterwards
        const selfCancel = await request("POST", `/coding/runs/${runApproval.id}/cancel`, ALICE, null);
        expect(selfCancel.status).toBe(200);
        expect(selfCancel.body.run.status).toBe("cancelled");

        // project lists are disjoint
        const aliceList = await request("GET", "/coding/projects", ALICE, null);
        const bobList = await request("GET", "/coding/projects", BOB, null);
        const aliceIds = aliceList.body.projects.map((p) => p.id);
        const bobIds = bobList.body.projects.map((p) => p.id);
        expect(aliceIds).toContain(aliceProj.id);
        expect(bobIds).toContain(bobProj.id);
        expect(aliceIds.some((id) => bobIds.includes(id))).toBe(false);

        // run lists are disjoint too
        const aliceRuns = (await request("GET", "/coding/runs", ALICE, null)).body.runs.map((r) => r.id);
        const bobRuns = (await request("GET", "/coding/runs", BOB, null)).body.runs.map((r) => r.id);
        expect(aliceRuns).toContain(runMain.id);
        expect(bobRuns).toContain(runBob.id);
        expect(aliceRuns.some((id) => bobRuns.includes(id))).toBe(false);
    });
});
