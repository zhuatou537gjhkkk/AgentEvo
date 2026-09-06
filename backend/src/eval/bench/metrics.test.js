import { describe, expect, it } from "vitest";
import { deriveMetrics, emptyRawRecord } from "./metrics.js";

/**
 * Phase 7 / R6 (roadmap #3) — deterministic metric derivation. These fixtures are
 * SYNTHETIC transcripts: pure JS, no worktree, no DB, no LLM. Every derivation
 * must be a pure function of the record so an offline run and the HTTP export
 * always agree (and a deterministic failure can never be re-judged by a model).
 */

const T0 = 1_700_000_000_000;

function happyPatchRecord(overrides = {}) {
    return emptyRawRecord({
        scenario: { id: "scen-patch", category: "patch", driver: "scripted", mode: "trusted", flow: "auto" },
        run: { id: "run_1", projectId: "proj_1", repoHeadSha: "abc123", seedRevision: "1" },
        startedAt: T0,
        completedAt: T0 + 4000,
        phase: "done",
        summary: "fixed calc.js and verified the test passes",
        turnCount: 4,
        actionCount: 3,
        transcriptChars: 900,
        steps: [
            { at: T0 + 100, type: "op", op: "read_file", path: "src/calc.js", ok: true },
            { at: T0 + 500, type: "op", op: "write_file", path: "src/calc.js", ok: true },
            { at: T0 + 1800, type: "verify", op: "run_command", executable: "node", ok: true },
            { at: T0 + 3000, type: "note", note: "tests pass" },
        ],
        actions: [
            { at: T0 + 100, op: "read_file", kind: "read", status: "executed" },
            { at: T0 + 500, op: "write_file", kind: "write", status: "executed" },
            { at: T0 + 1800, op: "run_command", kind: "exec", status: "executed" },
        ],
        approvals: [{ at: T0 + 500, requestedAt: T0 + 450, status: "approved" }],
        tests: [{ at: T0 + 1900, op: "run_command", ok: true, exitCode: 0 }],
        diff: { mainClean: true, changedFiles: [{ path: "src/calc.js" }], patchBytes: 22 },
        usage: { promptTokens: 1200, completionTokens: 90, costUsd: 0.0009, source: "model" },
        budget: { maxTurns: 8, maxActions: 12 },
        golden: {
            ok: true,
            checks: [{ label: "file:src/calc.js", ok: true }, { label: "text", ok: true }],
            firstFailure: null,
        },
        ...overrides,
    });
}

describe("deriveMetrics — completion/correctness/latency", () => {
    it("a done run whose golden passes reports completion.ok with patch + test success", () => {
        const m = deriveMetrics(happyPatchRecord());
        expect(m.completion).toMatchObject({ phase: "done", done: true, ok: true, haltReason: null });
        expect(m.correctness).toMatchObject({ goldenOk: true, patchSeen: true, changedFiles: 1, testsRun: 1, testsPassed: 1, testsAllPassed: true });
        expect(m.latency.totalMs).toBe(4000);
        expect(m.latency.ttfpMs).toBe(500);   // first write settled at T0+500
        expect(m.latency.ttfeMs).toBe(1900);  // first passing test
        expect(m.latency.turnMs).toBe(1000);
    });

    it("leaves ttfp/ttfe null when the run never patches/tests", () => {
        const raw = emptyRawRecord({
            phase: "done",
            startedAt: T0,
            completedAt: T0 + 100,
            actions: [{ at: T0, op: "list_tree", kind: "read", status: "executed" }],
        });
        const m = deriveMetrics(raw);
        expect(m.latency.ttfpMs).toBeNull();
        expect(m.latency.ttfeMs).toBeNull();
        expect(m.correctness.patchSeen).toBe(false);
    });
});

describe("deriveMetrics — budget / effort / recovery", () => {
    it("records a budget halt and the headroom numbers", () => {
        const m = deriveMetrics(emptyRawRecord({
            phase: "budget_halted",
            haltReason: "maxTurns",
            turnCount: 8,
            actionCount: 5,
            budget: { maxTurns: 8, maxActions: 12 },
        }));
        expect(m.completion.done).toBe(false);
        expect(m.completion.ok).toBe(false);
        expect(m.effort.budgetUsed).toMatchObject({ overTurns: true, overActions: false, haltedByBudget: true });
    });

    it("counts a failed attempt followed by a successful same-target op as recovery/reflection", () => {
        const raw = emptyRawRecord({
            steps: [
                { at: T0 + 0, type: "op", op: "write_file", args: { path: "src/calc.js" }, ok: false, errorCode: "APPLY_FAILED" },
                { at: T0 + 10, type: "op", op: "write_file", args: { path: "src/calc.js" }, ok: true },
                { at: T0 + 20, type: "op", op: "write_file", args: { path: "src/other.js" }, ok: true },
            ],
        });
        const m = deriveMetrics(raw);
        expect(m.effort.recoveryCount).toBe(1);
        expect(m.effort.reflectionSteps).toBe(1);
    });

    it("counts same-path re-edits as revisions (reflection signal) even when both succeed", () => {
        const m = deriveMetrics(emptyRawRecord({
            steps: [
                { type: "op", op: "write_file", path: "src/calc.js", ok: true },
                { type: "op", op: "write_file", path: "src/calc.js", ok: true },   // reflection re-edit
                { type: "op", op: "write_file", path: "src/other.js", ok: true },
                { type: "op", op: "write_file", path: "src/calc.js", ok: true },   // third attempt
            ],
        }));
        expect(m.effort.revisions).toBe(2); // two re-edits of calc.js past the first
    });

    it("does not count a failed op with no later same-target success as recovery", () => {
        const m = deriveMetrics(emptyRawRecord({
            steps: [
                { at: T0, type: "op", op: "write_file", args: { path: "a.js" }, ok: false },
                { at: T0 + 1, type: "op", op: "read_file", args: { path: "b.js" }, ok: true },
            ],
        }));
        expect(m.effort.recoveryCount).toBe(0);
    });
});

describe("deriveMetrics — safety / cost / efficiency", () => {
    it("flags exec denials and main-checkout dirt separately", () => {
        const m = deriveMetrics(emptyRawRecord({
            phase: "done",
            actions: [
                { op: "run_command", kind: "exec", status: "failed", errorCode: "EXEC_NOT_ALLOWLISTED" },
                { op: "write_file", kind: "write", status: "executed" },
            ],
            approvals: [{ status: "denied" }],
            diff: { mainClean: false, changedFiles: [], patchBytes: 0 },
        }));
        expect(m.safety.execDenied).toBe(1);
        expect(m.safety.approvalsDenied).toBe(1);
        expect(m.safety.mainClean).toBe(false);
    });

    it("sums token/cost and reports a scripted (no-model) default", () => {
        const m = deriveMetrics(emptyRawRecord());
        expect(m.cost).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, usageSource: "scripted" });
        const withTokens = deriveMetrics(emptyRawRecord({ usage: { promptTokens: 200, completionTokens: 40, costUsd: 0.01, source: "model" } }));
        expect(withTokens.cost).toMatchObject({ totalTokens: 240, costUsd: 0.01, usageSource: "model" });
    });

    it("derives actions-to-first-patch and bytes per action", () => {
        const m = deriveMetrics(happyPatchRecord());
        expect(m.efficiency.actionsToFirstPatch).toBe(2); // read is index 0 → write is 2nd action
        expect(m.efficiency.patchBytes).toBe(22);
    });
});
