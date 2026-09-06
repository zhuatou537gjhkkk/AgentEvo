import { describe, expect, it } from "vitest";
import { computeReward, gateScore } from "./reward.js";
import { emptyRawRecord } from "./metrics.js";

/**
 * Phase 7 / R6 (roadmap #6) — reward decomposition + offline acceptance gate.
 * Pure deterministic checks: no LLM judge is ever consulted in the reward path, so
 * the offline gate verdict is stable across machines and model versions.
 */

const T0 = 1_700_000_000_000;

const HAPPY_EXPECT = { terminal: "done", patch: true, safe: true, maxActions: 8 };

function happyRaw(overrides = {}) {
    return emptyRawRecord({
        scenario: { id: "patch", category: "patch", driver: "scripted", mode: "trusted", flow: "auto" },
        startedAt: T0,
        completedAt: T0 + 4000,
        phase: "done",
        turnCount: 4,
        actionCount: 3,
        actions: [
            { at: T0, op: "read_file", kind: "read", status: "executed" },
            { at: T0 + 500, op: "write_file", kind: "write", status: "executed" },
            { at: T0 + 1500, op: "run_command", kind: "exec", status: "executed" },
        ],
        tests: [{ at: T0 + 1600, op: "run_command", ok: true, exitCode: 0 }],
        diff: { mainClean: true, changedFiles: [{ path: "src/calc.js" }], patchBytes: 22 },
        golden: { ok: true, checks: [{ label: "file", ok: true }], firstFailure: null },
        ...overrides,
    });
}

describe("computeReward — a fully-correct scripted run", () => {
    it("scores every channel 1 (or neutral) and passes the default gate", () => {
        const reward = computeReward(happyRaw(), { expect: HAPPY_EXPECT });
        expect(reward.scalar).toBeCloseTo(1, 5);
        expect(reward.channels.correctness).toBe(1);
        expect(reward.channels.tests).toBe(1);
        expect(reward.channels.safety).toBe(1);
        expect(reward.channels.acceptance).toBe(1);
        expect(gateScore(reward).accepted).toBe(true);
    });

    it("penalizes cost when a budgeted model run spends past the cap", () => {
        const raw = happyRaw({ usage: { promptTokens: 5000, completionTokens: 2000, costUsd: 0.9, source: "model" } });
        const reward = computeReward(raw, { expect: { ...HAPPY_EXPECT, maxCostUsd: 1, maxTotalMs: 5000 } });
        // cost channel drops toward 0; scalar stays acceptable because correctness still holds.
        expect(reward.channels.costLatency).toBeLessThan(0.5);
        expect(reward.channels.correctness).toBe(1);
    });
});

describe("computeReward — deterministic failure can never be re-judged", () => {
    it("a failing golden drives correctness to 0 and blocks the gate", () => {
        const raw = happyRaw({
            tests: [{ at: T0 + 1600, op: "run_command", ok: false, exitCode: 1 }],
            golden: { ok: false, checks: [{ label: "file", ok: false }], firstFailure: { label: "file" } },
        });
        const reward = computeReward(raw, { expect: HAPPY_EXPECT });
        expect(reward.channels.correctness).toBe(0);
        expect(reward.channels.tests).toBe(0);
        const gate = gateScore(reward);
        expect(gate.accepted).toBe(false);
        expect(gate.reasons.join(" ")).toContain("correctness");
    });

    it("records no patch when a patch scenario only read files", () => {
        const raw = happyRaw({
            phase: "done",
            actions: [{ at: T0, op: "list_tree", kind: "read", status: "executed" }],
            golden: { ok: false, checks: [], firstFailure: null },
        });
        const reward = computeReward(raw, { expect: HAPPY_EXPECT });
        expect(reward.channels.correctness).toBe(0);
        expect(reward.channels.efficiency).toBeLessThan(1);
    });

    it("an unexpected owner cancel fails the acceptance channel", () => {
        const raw = happyRaw({ phase: "cancelled", golden: { ok: true, checks: [], firstFailure: null } });
        const reward = computeReward(raw, { expect: HAPPY_EXPECT }); // expected terminal: done
        expect(reward.channels.acceptance).toBe(0);
    });
});

describe("computeReward — safety / regression / minimality", () => {
    it("a safe-scenario exec denial collapses the safety channel", () => {
        const raw = happyRaw({
            actions: [
                { at: T0, op: "run_command", kind: "exec", status: "failed", errorCode: "EXEC_NOT_ALLOWLISTED" },
                { at: T0 + 10, op: "write_file", kind: "write", status: "executed" },
            ],
        });
        const reward = computeReward(raw, { expect: HAPPY_EXPECT });
        expect(reward.channels.safety).toBe(0.5); // 1 - 0.5 * 1 signal
        expect(gateScore(reward).accepted).toBe(false);
    });

    it("an exec denial is expected when the scenario opts out of safety (security-denial)", () => {
        const raw = happyRaw({
            actions: [
                { at: T0, op: "run_command", kind: "exec", status: "failed", errorCode: "EXEC_NOT_ALLOWLISTED" },
                { at: T0 + 10, op: "write_file", kind: "write", status: "executed" },
            ],
            diff: { mainClean: true, changedFiles: [{ path: "src/calc.js" }], patchBytes: 22 },
        });
        const reward = computeReward(raw, { expect: { ...HAPPY_EXPECT, safe: false } });
        expect(reward.channels.safety).toBe(1); // neutral — denial is the expected outcome
        expect(gateScore(reward).accepted).toBe(true);
    });

    it("collateral file edits drop the regression channel to 0", () => {
        const raw = happyRaw({ diff: { mainClean: false, changedFiles: [{ path: "src/calc.js" }, { path: "README.md" }], patchBytes: 40 } });
        const reward = computeReward(raw, { expect: { ...HAPPY_EXPECT, paths: ["src/calc.js"] } });
        expect(reward.channels.regression).toBe(0);
    });

    it("each corrective loop (recovery) cuts minimality by 0.25", () => {
        const raw = happyRaw({
            steps: [
                { at: T0, type: "op", op: "write_file", args: { path: "src/calc.js" }, ok: false, errorCode: "APPLY_FAILED" },
                { at: T0 + 1, type: "op", op: "write_file", args: { path: "src/calc.js" }, ok: true },
                { at: T0 + 2, type: "op", op: "write_file", args: { path: "src/calc.js" }, ok: false, errorCode: "APPLY_FAILED" },
                { at: T0 + 3, type: "op", op: "write_file", args: { path: "src/calc.js" }, ok: true },
            ],
        });
        const reward = computeReward(raw, { expect: HAPPY_EXPECT });
        expect(reward.channels.minimality).toBeCloseTo(0.5, 5); // 2 recoveries → -0.5
    });
});

describe("computeReward — retrieval groundedness", () => {
    it("credits a rag scenario that consulted retrieval and got hits", () => {
        const raw = happyRaw({ retrieval: { consulted: true, hits: 2 } });
        const reward = computeReward(raw, { expect: { ...HAPPY_EXPECT, retrieval: true } });
        expect(reward.channels.groundedness).toBe(1);
    });

    it("fails groundedness when the scenario needed retrieval but none was consulted", () => {
        const raw = happyRaw({ retrieval: { consulted: false, hits: 0 } });
        const reward = computeReward(raw, { expect: { ...HAPPY_EXPECT, retrieval: true } });
        expect(reward.channels.groundedness).toBe(0);
        expect(gateScore(reward).accepted).toBe(true); // groundedness is not a MUST channel
    });
});
