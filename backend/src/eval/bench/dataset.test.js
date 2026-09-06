import { describe, expect, it } from "vitest";
import { buildTrajectory } from "./trajectory.js";
import { computeReward } from "./reward.js";
import { emptyRawRecord } from "./metrics.js";
import { buildSftRows, buildPreferenceRows, buildGrpoRows, exportDataset } from "./dataset.js";

/**
 * Phase 7 / R6 (roadmap #8) — dataset export (SFT / preference / GRPO-ready).
 * Rows are derived deterministically from consented, redacted trajectories; they
 * carry run/scenario provenance so an offline trainer can reproduce the gate.
 */

const T0 = 1_700_000_000_000;

function recordWithRecovery(overrides = {}) {
    return emptyRawRecord({
        scenario: { id: "scen-test", category: "test", driver: "scripted", mode: "trusted", flow: "auto", goal: "make src/calc.js tests pass" },
        run: { id: "run_3", projectId: "proj_1", repoHeadSha: "sha-1", seedRevision: "1" },
        startedAt: T0,
        completedAt: T0 + 5000,
        phase: "done",
        summary: "fixed the sign so add() returns the sum and the suite passes",
        turnCount: 6,
        actionCount: 5,
        steps: [
            { at: T0, type: "op", op: "read_file", path: "src/calc.js", note: "read the function" },
            { at: T0 + 200, type: "op", op: "write_file", path: "src/calc.js", note: "first attempt", ok: false, errorCode: "VERIFY_FAILED" },
            { at: T0 + 900, type: "op", op: "write_file", path: "src/calc.js", note: "second attempt after reflection", ok: true },
            { at: T0 + 1500, type: "verify", op: "run_command", executable: "node", note: "run the suite", ok: true },
        ],
        actions: [
            { at: T0 + 200, op: "write_file", kind: "write", status: "executed", errorCode: null },
            { at: T0 + 900, op: "write_file", kind: "write", status: "executed" },
        ],
        approvals: [],
        tests: [{ at: T0 + 1600, op: "run_command", ok: true, exitCode: 0 }],
        diff: { mainClean: true, changedFiles: [{ path: "src/calc.js" }], patchBytes: 12 },
        golden: { ok: true, checks: [{ label: "file", ok: true }], firstFailure: null },
        ...overrides,
    });
}

describe("buildSftRows — (prompt, completion) supervision", () => {
    it("emits one row per observed prefix, ending with the run summary", () => {
        const tree = buildTrajectory(recordWithRecovery());
        const { rows } = buildSftRows(tree);
        expect(rows).toHaveLength(4);
        const first = rows[0];
        expect(first.prompt).toContain("make src/calc.js tests pass");
        expect(first.prompt).toContain("1. op read_file src/calc.js");
        expect(first.completion).toContain("write_file");
        const last = rows[3];
        expect(last.completion).toContain("fixed the sign");
        for (const row of rows) {
            expect(row).toMatchObject({ kind: "sft", runId: "run_3", scenarioId: "scen-test" });
        }
    });
});

describe("buildPreferenceRows — deterministic chosen/rejected pairs", () => {
    it("turns a failed attempt + same-target correction into one preference pair", () => {
        const tree = buildTrajectory(recordWithRecovery());
        const { rows } = buildPreferenceRows(tree);
        expect(rows).toHaveLength(1);
        const pair = rows[0];
        expect(pair.rejected).toContain("failed:VERIFY_FAILED");
        expect(pair.chosen).toContain("ok");
        expect(pair.kind).toBe("preference");
    });

    it("yields no pair when the agent never self-corrects", () => {
        const tree = buildTrajectory(emptyRawRecord({
            scenario: { id: "s", category: "patch", goal: "g" },
            run: { id: "r", repoHeadSha: "s", seedRevision: "1" },
            steps: [
                { at: T0, type: "op", op: "write_file", path: "a.js", ok: true },
            ],
        }));
        const { rows } = buildPreferenceRows(tree);
        expect(rows).toHaveLength(0);
    });
});

describe("buildGrpoRows — trace + reward vector per run", () => {
    it("packages a compact action trace and the decomposed reward", () => {
        const raw = recordWithRecovery();
        const tree = buildTrajectory(raw);
        const reward = computeReward(raw, { expect: { terminal: "done", patch: true, safe: true, maxActions: 8 } });
        const { rows } = buildGrpoRows(raw, tree, reward);
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.trace).toHaveLength(4);
        expect(row.trace[2]).toMatchObject({ type: "op", op: "write_file", ok: true });
        expect(row.reward.correctness).toBe(1);
        expect(row.rewardScalar).toBeGreaterThan(0);
        expect(row.repoHeadSha).toBe("sha-1");
    });
});

describe("exportDataset — kind selection + provenance", () => {
    it("exports only the requested kinds under a jsonl envelope", () => {
        const raw = recordWithRecovery();
        const tree = buildTrajectory(raw);
        const reward = computeReward(raw, { expect: { terminal: "done", patch: true } });
        const out = exportDataset({ raw, tree, reward, kinds: ["sft", "grpo"] });
        expect(out.format).toBe("jsonl");
        expect(out.kinds.map((k) => k.kind)).toEqual(["sft", "grpo"]);
        expect(out.kinds[0].rows.length).toBeGreaterThan(0);
    });

    it("rebuilds the trajectory from raw when no tree is supplied", () => {
        const out = exportDataset({ raw: recordWithRecovery(), kinds: ["grpo"] });
        expect(out.kinds[0].rows[0].runId).toBe("run_3");
    });
});
