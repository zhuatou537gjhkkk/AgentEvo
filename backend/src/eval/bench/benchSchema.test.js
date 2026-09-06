import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db, { createUser, initDB } from "../../db/index.js";
import { clearBenchFlags, BENCH_FLAG_NAMES, benchCapabilities, benchEnabled, benchRealModelEnabled } from "./flags.js";

/**
 * Phase 7 / R6 — bench_runs schema / flags / migration-ledger contract.
 *
 * The offline coding-benchmark substrate stores its per-scenario run ledger in one
 * additive table (`bench_runs`) that points at the durable coding substrate
 * (coding_run_id), the repo revision it ran against (repo_head_sha + seed_revision),
 * the config snapshot it used (config_version_id), and the derived
 * metrics/reward/result JSON — WITHOUT rewriting any legacy table. Run on this
 * worker's isolated empty DB (vitest.setup.js); never the real dev database.
 */

const BENCH_RUN_COLUMNS = [
    "id", "owner_user_id", "tenant_id",
    "scenario_id", "category", "driver", "mode", "status",
    "repo_head_sha", "project_id", "coding_run_id", "config_version_id",
    "seed_revision", "consent",
    "metrics_json", "reward_json", "result_json", "error_code",
    "created_at", "completed_at", "updated_at",
];

let userId;
let tenantId;

beforeAll(() => {
    initDB();
    userId = createUser("Bench Dev", "hash-bench-schema");
    tenantId = `user:${userId}`;
});

afterAll(() => {
    clearBenchFlags();
});

describe("R6 additive bench_runs schema + migration ledger", () => {
    it("creates bench_runs idempotently across repeated initDB", () => {
        initDB();
        initDB();
        const exists = () => db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='bench_runs'",
        ).all();
        expect(exists()).toHaveLength(1);
        // exactly once, no duplicate DDL
        const again = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='bench_runs'",
        ).all();
        expect(again).toEqual(exists());
    });

    it("carries the owner/tenant/scope/revision/consent columns", () => {
        const cols = db.prepare("PRAGMA table_info(bench_runs)").all().map((c) => c.name);
        for (const col of BENCH_RUN_COLUMNS) expect(cols).toContain(col);
        expect(cols).toContain("owner_user_id");
        expect(cols).toContain("tenant_id");
    });

    it("indexes bench_runs by (tenant, created) and (tenant, scenario)", () => {
        const indexes = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='bench_runs'",
        ).all().map((row) => row.name);
        expect(indexes).toContain("idx_bench_runs_scope_created");
        expect(indexes).toContain("idx_bench_runs_scope_scenario");
    });

    it("ledgers R6-BENCH-1 exactly once, even when initDB runs repeatedly", () => {
        const count = () => db.prepare(
            "SELECT COUNT(*) AS c FROM security_migration_audit WHERE migration = 'R6-BENCH-1'",
        ).get().c;
        initDB();
        expect(count()).toBe(1);
        // UNIQUE(migration) + INSERT OR IGNORE means a manual duplicate stays ignored
        db.prepare("INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES ('R6-BENCH-1', '{}')").run();
        expect(count()).toBe(1);
    });
});

describe("bench flags default off, live at call time", () => {
    it("reports every bench capability false in a fresh process", () => {
        clearBenchFlags();
        const caps = benchCapabilities();
        expect(caps).toEqual({ enabled: false, realModel: false });
    });

    it("flips at call time (per-call env read, not import time)", () => {
        clearBenchFlags();
        expect(benchEnabled()).toBe(false);
        expect(benchCapabilities().realModel).toBe(false);
        process.env.BENCH_ENABLED = "true";
        expect(benchEnabled()).toBe(true);
        expect(benchCapabilities().realModel).toBe(false);
        process.env.BENCH_REAL_MODEL_ENABLED = "1";
        expect(benchRealModelEnabled()).toBe(true);
        clearBenchFlags();
        expect(benchEnabled()).toBe(false);
    });

    it("exposes exactly the two documented flag names", () => {
        clearBenchFlags();
        expect(BENCH_FLAG_NAMES).toEqual(["BENCH_ENABLED", "BENCH_REAL_MODEL_ENABLED"]);
        for (const name of BENCH_FLAG_NAMES) delete process.env[name];
    });
});
