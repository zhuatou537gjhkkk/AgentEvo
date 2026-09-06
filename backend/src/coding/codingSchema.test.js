import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db, { createUser, initDB } from "../db/index.js";
import { defaultEventStore } from "./events.js";
import { defaultRunService } from "./runs.js";
import { clearCodingFlags, CODING_FLAG_NAMES, codingCapabilities } from "./flags.js";

/**
 * R0 — schema/flags/event-log contract.
 *
 * Verifies the additive migration is idempotent and ledgered (R0-CODING-1), all
 * five coding flags read OFF by default and live at call time, and CodingEventStore
 * allocates run-scoped seq from coding_runs.event_seq so it is monotonic and never
 * reuses a number after a row is deleted (replay safety). Runs on this worker's
 * isolated empty DB (vitest.setup.js); never the real dev database.
 */

const CODING_TABLES = [
    "coding_projects", "coding_runs", "coding_events",
    "coding_actions", "coding_approvals", "coding_artifacts",
];

let userId;
let tenantId;
let scope;

beforeAll(() => {
    initDB();
    userId = createUser("Schema Dev", "hash-schema");
    tenantId = `user:${userId}`;
    scope = { userId, tenantId };
});

afterAll(() => {
    clearCodingFlags();
});

function tableNames() {
    return db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'coding_%' ORDER BY name",
    ).all().map((row) => row.name);
}

describe("R0 additive schema + migration ledger", () => {
    it("creates all six coding_* tables and is idempotent across repeated initDB", () => {
        initDB(); // second+ call must be a no-op
        initDB();
        const names = tableNames();
        for (const table of CODING_TABLES) expect(names).toContain(table);
        // exactly the six coding tables (no stray/duplicated DDL)
        expect(names).toHaveLength(CODING_TABLES.length);
        const again = tableNames();
        expect(again).toEqual(names);
    });

    it("ledgers R0-CODING-1 exactly once, even when initDB runs repeatedly", () => {
        const count = () => db.prepare(
            "SELECT COUNT(*) AS c FROM security_migration_audit WHERE migration = 'R0-CODING-1'",
        ).get().c;
        initDB();
        expect(count()).toBe(1);
        // UNIQUE(migration) + INSERT OR IGNORE means a manual duplicate stays ignored
        db.prepare("INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES ('R0-CODING-1', '{}')").run();
        expect(count()).toBe(1);
    });

    it("coding tables carry the owner/tenant scoping columns", () => {
        for (const table of CODING_TABLES) {
            const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
            expect(cols).toContain("owner_user_id");
            expect(cols).toContain("tenant_id");
        }
        // run snapshot/event counters required by the durable contract
        const runsCols = db.prepare("PRAGMA table_info(coding_runs)").all().map((c) => c.name);
        expect(runsCols).toContain("snapshot_json");
        expect(runsCols).toContain("event_seq");
        const eventsCols = db.prepare("PRAGMA table_info(coding_events)").all().map((c) => c.name);
        expect(eventsCols).toContain("seq");
    });
});

describe("coding flags default off, live at call time", () => {
    it("reports every capability false in a fresh process", () => {
        for (const name of CODING_FLAG_NAMES) delete process.env[name];
        const caps = codingCapabilities();
        expect(caps).toEqual({ workspace: false, eventLog: false, runner: false, writeTools: false, commandTools: false });
    });

    it("flips at call time (per-call env read, not import time)", () => {
        clearCodingFlags();
        expect(codingCapabilities().workspace).toBe(false);
        process.env.CODING_WORKSPACE_ENABLED = "true";
        expect(codingCapabilities().workspace).toBe(true);
        expect(codingCapabilities().runner).toBe(false);
        process.env.CODING_RUNNER_ENABLED = "1";
        expect(codingCapabilities().runner).toBe(true);
        clearCodingFlags();
        expect(codingCapabilities().workspace).toBe(false);
    });
});

describe("CodingEventStore seq allocation + replay safety", () => {
    it("creates a run with event_seq 0 while the event log is dark", () => {
        clearCodingFlags(); // event log off: _append is a no-op
        const run = defaultRunService.createRun(scope, { mode: "observe" });
        expect(run.status).toBe("created");
        expect(run.eventSeq).toBe(0);
        expect(defaultEventStore.getLastSeq(scope, run.id)).toBe(0);
    });

    it("allocates monotonic seq from the run counter; deletion never reuses a seq", () => {
        // run is created while the log is still dark so event_seq starts at 0
        const run = defaultRunService.createRun(scope, { mode: "observe" });
        expect(run.eventSeq).toBe(0);
        process.env.CODING_EVENT_LOG_ENABLED = "true";

        const e1 = defaultEventStore.appendEvent(scope, run.id, { type: "run.status", payload: { from: "created", to: "planning" } });
        const e2 = defaultEventStore.appendEvent(scope, run.id, { type: "run.status", payload: { from: "planning", to: "running" } });
        const e3 = defaultEventStore.appendEvent(scope, run.id, { type: "run.started", payload: {} });
        expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);

        // delete the middle row, then append: counter continues past 3 → 4
        db.prepare("DELETE FROM coding_events WHERE run_id = ? AND seq = 2").run(run.id);
        const e4 = defaultEventStore.appendEvent(scope, run.id, { type: "run.status", payload: {} });
        expect(e4.seq).toBe(4);
        expect(defaultEventStore.getLastSeq(scope, run.id)).toBe(4);

        const seqs = defaultEventStore.listEvents(scope, run.id, { afterSeq: 0 }).map((e) => e.seq);
        expect(seqs).toEqual([1, 3, 4]); // ascending, gap left by the deleted row
    });

    it("after=lastSeq returns nothing — replay yields no duplicates", () => {
        const run = defaultRunService.createRun(scope, { mode: "observe" });
        const first = defaultEventStore.appendEvent(scope, run.id, { type: "run.started", payload: {} });
        const last = defaultEventStore.getLastSeq(scope, run.id);
        expect(last).toBe(first.seq);
        expect(defaultEventStore.listEvents(scope, run.id, { afterSeq: last })).toEqual([]);
        expect(defaultEventStore.listEvents(scope, run.id, { afterSeq: last - 1 }).map((e) => e.seq)).toEqual([last]);
    });

    it("rejects unknown event types and foreign runs", () => {
        const run = defaultRunService.createRun(scope, { mode: "observe" });
        let error;
        try { defaultEventStore.appendEvent(scope, run.id, { type: "not.a.real.type" }); } catch (err) { error = err; }
        expect(error.code).toBe("INVALID_EVENT_TYPE");
        expect(error.statusCode).toBe(400);

        try { defaultEventStore.appendEvent(scope, "run_missing", { type: "run.status", payload: {} }); } catch (err) { error = err; }
        expect(error.code).toBe("NOT_FOUND");
        expect(error.statusCode).toBe(404);

        const otherId = createUser("Foreign User", "hash-foreign");
        const otherScope = { userId: otherId, tenantId: `user:${otherId}` };
        try { defaultEventStore.appendEvent(otherScope, run.id, { type: "run.status", payload: {} }); } catch (err) { error = err; }
        expect(error.code).toBe("NOT_FOUND");
    });
});
