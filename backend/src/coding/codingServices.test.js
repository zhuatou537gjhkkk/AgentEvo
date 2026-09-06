import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import db, { createUser, initDB } from "../db/index.js";
import { defaultProjectService } from "./projects.js";
import { defaultRunService } from "./runs.js";
import { defaultApprovalService } from "./approvals.js";
import { defaultEventStore } from "./events.js";
import { CodingRuntimeRegistry } from "./runtimeRegistry.js";
import { clearCodingFlags, codingCapabilities } from "./flags.js";

/**
 * R0 — service-layer contract for projects/runs/approvals + runtime registry.
 *
 * Runs against the worker-isolated empty DB (vitest.setup.js). Two real users
 * prove the `WHERE owner_user_id AND tenant_id` filters at the service layer;
 * route-level enforcement (flags gates + 409 single-runtime) is exercised over
 * HTTP in routes/codingRegistrar.test.js. This file also pins the regression for
 * the better-sqlite3 boolean bind that broke run start (terminal → 1/0).
 */

let ALICE;
let BOB;
let aliceScope;
let bobScope;

const registries = [];
function freshRegistry() {
    const registry = new CodingRuntimeRegistry({ idleMs: 10_000, sweepIntervalMs: 60_000 });
    registries.push(registry);
    return registry;
}

beforeAll(() => {
    initDB();
    ALICE = { id: createUser("Code Alice", "hash-ca") };
    BOB = { id: createUser("Code Bob", "hash-cb") };
    aliceScope = { userId: ALICE.id, tenantId: `user:${ALICE.id}` };
    bobScope = { userId: BOB.id, tenantId: `user:${BOB.id}` };
    // Event log ON so transition/approval events are asserted; other flags stay OFF
    process.env.CODING_EVENT_LOG_ENABLED = "true";
});

afterAll(() => {
    for (const registry of registries) registry.dispose();
    registries.length = 0;
    clearCodingFlags();
});

afterEach(() => {
    for (const registry of registries) registry.dispose();
    registries.length = 0;
});

function expectCodingError(fn, code, status) {
    let error = null;
    try { fn(); } catch (err) { error = err; }
    expect(error).not.toBeNull();
    expect(error.code).toBe(code);
    expect(error.statusCode).toBe(status);
    return error;
}

describe("CodingProjectService — register/trust/lifecycle", () => {
    it("registers an untrusted project and rejects duplicate roots for the same owner", () => {
        const project = defaultProjectService.register(aliceScope, {
            name: "proj-a",
            rootPath: "D:\\repo\\alpha",
            meta: { stack: "node" },
        });
        expect(project.id).toMatch(/^proj_/);
        expect(project.status).toBe("registered");
        expect(project.trusted).toBe(false);

        expectCodingError(
            () => defaultProjectService.register(aliceScope, { name: "dup", rootPath: "D:\\repo\\alpha" }),
            "DUPLICATE_PROJECT", 409,
        );
    });

    it("trusts only by explicit server-side action; lifecycle is registered ⇄ trusted → terminal", () => {
        const project = defaultProjectService.register(aliceScope, { name: "proj-trust", rootPath: "/srv/a" });
        const trusted = defaultProjectService.update(aliceScope, project.id, { trusted: true });
        expect(trusted.status).toBe("trusted");
        expect(trusted.trusted).toBe(true);
        expect(trusted.trustedAt).not.toBeNull();

        const demoted = defaultProjectService.update(aliceScope, project.id, { trusted: false });
        expect(demoted.status).toBe("registered");
        expect(demoted.trusted).toBe(false);

        const revoked = defaultProjectService.revoke(aliceScope, project.id);
        expect(revoked.status).toBe("revoked");
        expect(revoked.trusted).toBe(false);

        // terminal cannot be revived or re-trusted
        expectCodingError(
            () => defaultProjectService.update(aliceScope, project.id, { status: "trusted" }),
            "PROJECT_TERMINAL", 409,
        );
    });

    it("lists are owner-scoped: two users may hold the same root path independently", () => {
        defaultProjectService.register(aliceScope, { name: "same-root", rootPath: "/shared" });
        const bobOwn = defaultProjectService.register(bobScope, { name: "same-root", rootPath: "/shared" });
        expect(bobOwn.id).toMatch(/^proj_/);

        const aliceList = defaultProjectService.list(aliceScope, { status: "registered" });
        expect(aliceList.length).toBeGreaterThan(0);
        expect(aliceList.every((p) => p.rootPath === "/shared")).toBe(false); // alice has other roots too

        expect(defaultProjectService.get(bobScope, defaultProjectService.list(aliceScope, {})[0].id)).toBeNull();
    });
});

describe("CodingRunService — snapshot + lifecycle transitions", () => {
    let rootCounter = 0;
    function makeProject() {
        rootCounter += 1;
        return defaultProjectService.register(aliceScope, { name: "run-proj", rootPath: `/repo-${rootCounter}` });
    }

    it("creates a run with a server-decided snapshot linked to an owned trusted project", () => {
        const project = makeProject();
        const run = defaultRunService.createRun(aliceScope, { projectId: project.id, sessionId: null });
        expect(run.id).toMatch(/^run_/);
        expect(run.status).toBe("created");
        expect(run.mode).toBe("observe");
        expect(run.projectId).toBe(project.id);
        expect(run.eventSeq).toBe(1); // run.created appended under the event log
        expect(run.snapshot.project.id).toBe(project.id);
        expect(run.snapshot.project.trusted).toBe(false);
        expect(run.snapshot.mode).toBe("observe");
        expect(run.snapshot.graph).toBe("chatGraph");
        expect(run.snapshot.scope.tenantId).toBe(`user:${ALICE.id}`);
        expect(run.snapshot.capabilities.eventLog).toBe(true);
    });

    it("rejects unavailable modes and foreign/linked projects", () => {
        const project = makeProject();
        expectCodingError(
            () => defaultRunService.createRun(aliceScope, { projectId: project.id, mode: "write" }),
            "MODE_NOT_AVAILABLE", 400,
        );
        // foreign project (BOB owns it) is invisible to ALICE → 404
        const bobProject = defaultProjectService.register(bobScope, { name: "bob-p", rootPath: "/bob" });
        expectCodingError(
            () => defaultRunService.createRun(aliceScope, { projectId: bobProject.id }),
            "PROJECT_NOT_FOUND", 404,
        );
    });

    it("starts a created run (regression: better-sqlite3 boolean bind)", () => {
        const project = makeProject();
        const run = defaultRunService.createRun(aliceScope, { projectId: project.id });
        expect(run.status).toBe("created");

        const started = defaultRunService.startRun(aliceScope, run.id);
        expect(started.status).toBe("running");
        expect(started.startedAt).not.toBeNull();
        expect(started.eventSeq).toBeGreaterThan(run.eventSeq); // run.started appended

        const events = defaultEventStore.listEvents(aliceScope, run.id, { afterSeq: 0 });
        expect(events.map((e) => e.type)).toEqual(["run.created", "run.started"]);
        expect(events.every((e) => e.seq > 0 && e.payload && typeof e.payload === "object")).toBe(true);
    });

    it("cancel → terminal; a terminal run cannot start or re-cancel", () => {
        const run = defaultRunService.createRun(aliceScope, {});
        const cancelled = defaultRunService.cancelRun(aliceScope, run.id);
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.completedAt).not.toBeNull();

        expectCodingError(() => defaultRunService.startRun(aliceScope, run.id), "RUN_TERMINAL", 409);
        expectCodingError(() => defaultRunService.cancelRun(aliceScope, run.id), "RUN_TERMINAL", 409);
    });

    it("fail/complete record error_code only for fail", () => {
        const run = defaultRunService.createRun(aliceScope, {});
        const failed = defaultRunService.failRun(aliceScope, run.id, { errorCode: "TOOL_CRASHED" });
        expect(failed.status).toBe("failed");
        expect(failed.errorCode).toBe("TOOL_CRASHED");

        const next = defaultRunService.createRun(aliceScope, {});
        const done = defaultRunService.completeRun(aliceScope, next.id);
        expect(done.status).toBe("completed");
        expect(done.errorCode).toBeNull();
    });

    it("run reads/writes are owner-scoped (cross-owner 404)", () => {
        const project = makeProject();
        const run = defaultRunService.createRun(aliceScope, { projectId: project.id });

        expect(defaultRunService.getRun(bobScope, run.id)).toBeNull();
        expectCodingError(() => defaultRunService.startRun(bobScope, run.id), "NOT_FOUND", 404);
        expectCodingError(() => defaultRunService.cancelRun(bobScope, run.id), "NOT_FOUND", 404);
        // ALICE can still cancel her own run afterwards
        expect(defaultRunService.cancelRun(aliceScope, run.id).status).toBe("cancelled");
    });
});

describe("ApprovalService — request/decide transcript + redaction + expiry", () => {
    function makeRun() {
        return defaultRunService.createRun(aliceScope, {});
    }

    it("records a requested approval+action with sanitized input (secrets never persisted)", () => {
        const run = makeRun();
        const result = defaultApprovalService.requestApproval(aliceScope, run.id, {
            type: "write",
            tool: "edit_file",
            input: { path: "src/a.ts", content: "export const a = 1;\n", api_key: "SK-LIVE-ABCDEF123456", secret_token: "X-SECRET-TOKEN-99" },
            requestedBy: ALICE.id,
            reason: "rewrite module A",
        });
        expect(result.action.status).toBe("requested");
        expect(result.approval.status).toBe("requested");
        expect(result.action.seq).toBe(1);
        expect(result.action.tool).toBe("edit_file");

        // sanitized boundary: no credential-like key/value reaches the object...
        expect(result.action.input).toEqual({ path: "src/a.ts", content: "export const a = 1;\n" });
        // ...and nothing reaches the row either
        const raw = db.prepare("SELECT input_json FROM coding_actions WHERE id = ?").get(result.action.id).input_json;
        expect(raw).not.toContain("SK-LIVE-");
        expect(raw).not.toContain("X-SECRET-TOKEN-99");
        expect(raw).not.toContain("api_key");
    });

    it("owner-only decision: approve flips action+approval and appends events", () => {
        const run = makeRun();
        const { action, approval } = defaultApprovalService.requestApproval(aliceScope, run.id, {
            type: "exec", tool: "run_tests", input: { args: ["--watch=false"] },
        });

        // BOB cannot decide ALICE's approval
        expectCodingError(
            () => defaultApprovalService.decide(bobScope, approval.id, { approve: true, decidedBy: BOB.id }),
            "NOT_FOUND", 404,
        );

        const decided = defaultApprovalService.decide(aliceScope, approval.id, { approve: true, decidedBy: ALICE.id });
        expect(decided.approval.status).toBe("approved");
        expect(decided.approval.decidedBy).toBe(ALICE.id);
        expect(decided.action.status).toBe("approved");

        const events = defaultEventStore.listEvents(aliceScope, run.id, { afterSeq: 0 });
        const types = events.map((e) => e.type);
        expect(types).toContain("approval.approved");
        expect(types).toContain("action.decided");

        // a decided approval cannot be decided twice
        expectCodingError(
            () => defaultApprovalService.decide(aliceScope, approval.id, { approve: false }),
            "APPROVAL_DECIDED", 409,
        );
    });

    it("deny marks the action denied and appends approval.denied", () => {
        const run = makeRun();
        const { approval } = defaultApprovalService.requestApproval(aliceScope, run.id, {
            type: "network", tool: "http_get", input: { url: "https://example.com" },
        });
        const decided = defaultApprovalService.decide(aliceScope, approval.id, { approve: false, reason: "blocked host" });
        expect(decided.approval.status).toBe("denied");
        expect(decided.action.status).toBe("denied");
        const events = defaultEventStore.listEvents(aliceScope, run.id, { afterSeq: 0 });
        expect(events.map((e) => e.type)).toContain("approval.denied");
    });

    it("expired approvals reject decisions and are marked expired", () => {
        const run = makeRun();
        const { approval } = defaultApprovalService.requestApproval(aliceScope, run.id, {
            type: "read", tool: "read_file", input: { path: "/etc/passwd" },
        });
        // backdate past the second-granularity clock → deterministic expiry branch
        db.prepare("UPDATE coding_approvals SET expires_at = '2000-01-01 00:00:00' WHERE id = ?").run(approval.id);
        const error = expectCodingError(
            () => defaultApprovalService.decide(aliceScope, approval.id, { approve: true }),
            "APPROVAL_EXPIRED", 409,
        );
        expect(error).toBeTruthy();
        expect(defaultApprovalService.getApproval(aliceScope, approval.id).status).toBe("expired");
    });

    it("rejects unsupported effects and blocks approvals on terminal runs", () => {
        const run = makeRun();
        expectCodingError(
            () => defaultApprovalService.requestApproval(aliceScope, run.id, { type: "teleport", tool: "x" }),
            "INVALID_ACTION_TYPE", 400,
        );
        const done = defaultRunService.completeRun(aliceScope, run.id);
        expect(done.status).toBe("completed");
        expectCodingError(
            () => defaultApprovalService.requestApproval(aliceScope, run.id, { type: "write", tool: "edit_file", input: {} }),
            "RUN_TERMINAL", 409,
        );
    });
});

describe("CodingRuntimeRegistry — single runtime, subscribers, cancel, idle eviction", () => {
    const scope = () => aliceScope;

    it("acquireStart is single-winner per (owner, run); isActive reflects a live runtime", () => {
        const registry = freshRegistry();
        const token = registry.acquireStart(scope(), "run_1");
        expect(token).toMatch(/^rt_/);
        expect(registry.isActive(scope(), "run_1")).toBe(true);
        // second acquire for the same run loses; different run is unaffected
        expect(registry.acquireStart(scope(), "run_1")).toBeNull();
        expect(registry.acquireStart(scope(), "run_2")).toMatch(/^rt_/);
        // BOB's scope is a different key → allowed
        expect(registry.acquireStart(bobScope, "run_1")).toMatch(/^rt_/);
    });

    it("attachSubscriber/broadcast/cancel fan out to every subscriber and release token-guards", () => {
        const registry = freshRegistry();
        const token = registry.acquireStart(scope(), "run_c");
        const seen = [];
        const detachA = registry.attachSubscriber(scope(), "run_c", (e) => seen.push(e));
        const detachB = registry.attachSubscriber(scope(), "run_c", (e) => seen.push(e));

        expect(registry.broadcast(scope(), "run_c", { type: "stream.heartbeat" })).toBe(2);
        expect(seen).toHaveLength(2);

        detachA();
        expect(registry.broadcast(scope(), "run_c", { type: "stream.heartbeat" })).toBe(1);

        const outcome = registry.cancel(scope(), "run_c", { reason: "owner cancel" });
        expect(outcome).toEqual({ hadRuntime: true, subscriberCount: 1 });
        expect(seen.some((e) => e.type === "run.cancelled" && e.reason === "owner cancel")).toBe(true);

        // wrong token cannot release; correct token frees the runtime
        expect(() => registry.releaseRun(scope(), "run_c", { token: "rt_wrong" })).toThrowError(/token/i);
        expect(registry.releaseRun(scope(), "run_c", { token })).toBe(true);
        expect(registry.isActive(scope(), "run_c")).toBe(false);
        expect(registry.releaseRun(scope(), "run_c")).toBe(false); // idempotent no-op
    });

    it("heartbeat keeps a runtime alive past its idle threshold; evictIdle reaps idle runtimes", () => {
        const registry = freshRegistry(); // idleMs 10_000
        const token = registry.acquireStart(scope(), "run_idle");
        const entry = registry.getEntry(scope(), "run_idle");
        expect(entry).not.toBeNull();

        // push far into the past, then heartbeat refreshes to ~now
        entry.lastActiveAt = Date.now() - 60_000;
        expect(registry.heartbeat(token)).toBe(true);
        expect(registry.evictIdle(Date.now() + 5_000)).toEqual([]); // refreshed → not idle

        // idle again → eviction reports the run and drops the runtime
        entry.lastActiveAt = Date.now() - 60_000;
        const evicted = registry.evictIdle();
        expect(evicted).toHaveLength(1);
        expect(evicted[0].runId).toBe("run_idle");
        expect(registry.isActive(scope(), "run_idle")).toBe(false);
        expect(registry.heartbeat(token)).toBe(false); // token gone
    });

    it("dispose stops the sweeper and clears all live runtimes", () => {
        const registry = freshRegistry();
        registry.acquireStart(scope(), "run_x");
        expect(registry.stats().active).toBe(1);
        registry.dispose();
        expect(registry.stats().active).toBe(0);
        expect(() => registry.acquireStart(scope(), "run_y")).toThrowError(/disposed/i);
    });
});

describe("capability snapshot defaults (service layer)", () => {
    it("reports runner/write/command tools dark unless the matching flag is set", () => {
        clearCodingFlags();
        const caps = codingCapabilities();
        expect(caps.workspace).toBe(false);
        expect(caps.eventLog).toBe(false);
        process.env.CODING_RUNNER_ENABLED = "true";
        expect(codingCapabilities().runner).toBe(true);
        clearCodingFlags();
    });
});
