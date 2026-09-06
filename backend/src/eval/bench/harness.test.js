import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initDB, createUser } from "../../db/index.js";
import { clearCodingFlags } from "../../coding/flags.js";
import { makeBenchDir, rmBenchDir } from "./fixtures.js";
import { executeBenchScenario } from "./harness.js";
import { resolveScenario } from "./scenarios.js";
import { deriveMetrics } from "./metrics.js";
import { computeReward, gateScore } from "./reward.js";
import { buildTrajectory } from "./trajectory.js";
import { buildSftRows, buildPreferenceRows, buildGrpoRows } from "./dataset.js";

/**
 * Phase 7 / R6 (roadmap #1, #2, #3) — the bench harness drives the REAL coding
 * substrate (CodeAgentService + durable coding runs/actions/approvals + disposable
 * git worktrees + allowlisted node commands) with a DETERMINISTIC scripted decider,
 * over a FIXED-revision fixture repo. No model, no network.
 *
 * This file proves the harness end to end on a representative matrix of flows —
 * trusted auto-patch, security exec denial, owner-approved write, owner-cancel —
 * and that the resulting durable transcript feeds the pure metric/reward/
 * trajectory/dataset modules consistently. The full 11-category catalog is driven
 * once per run by benchService (see benchService.test.js).
 */

const OWNER = { name: "bench_harness_owner", username: "benchh" };
const dirs = [];

function scratch(prefix) {
    const dir = makeBenchDir(prefix);
    dirs.push(dir);
    return dir;
}

beforeAll(() => {
    initDB();
    OWNER.id = createUser(OWNER.name, "hash-bench-h");
    // The bench harness manages only infra env; the platform flags must already be
    // on for the fixture to exercise write/exec/rag — mirror a live operator.
    process.env.CODING_WORKSPACE_ENABLED = "true";
    process.env.CODING_WRITE_TOOLS_ENABLED = "true";
    process.env.CODING_COMMAND_TOOLS_ENABLED = "true";
    process.env.CODING_RAG_REUSE_ENABLED = "true";
});

afterAll(() => {
    clearCodingFlags();
    for (const dir of dirs) rmBenchDir(dir);
});

async function runScenario(scenarioId, extra = {}) {
    const scenario = resolveScenario(scenarioId);
    const result = await executeBenchScenario(
        { userId: OWNER.id },
        scenario,
        { allowedBase: scratch(`agentevo-bench-h-${scenarioId}-`), worktreeBase: scratch(`agentevo-bench-hwt-${scenarioId}-`), ...extra },
    );
    return { scenario, ...result };
}

function verdictFor({ record, scenario }) {
    const metrics = deriveMetrics(record);
    const reward = computeReward(record, { expect: scenario.expect });
    const gate = gateScore(reward);
    const tree = buildTrajectory(record);
    const sft = buildSftRows(tree);
    const pref = buildPreferenceRows(tree);
    const grpo = buildGrpoRows(record, tree, reward);
    return { metrics, reward, gate, tree, rows: { sft, pref, grpo } };
}

describe("harness — trusted auto patch (flow auto)", () => {
    it("fixes calc.js in a disposable worktree, main checkout stays clean, reward passes", async () => {
        const { record, golden, scenario, run, session } = await runScenario("patch-wrong-sign");
        expect(run.status).toBe("completed");
        expect(record.phase).toBe("done");
        expect(record.golden.ok).toBe(true);
        // deterministic golden (file check), NOT an LLM judge
        expect(record.golden.checks[0].type).toBe("file");
        // real durable transcript: a write_file action executed against src/calc.js
        const writes = record.actions.filter((a) => a.kind === "write" && a.status === "executed");
        expect(writes.length).toBeGreaterThanOrEqual(1);
        expect(writes[0].op).toBe("write_file");
        expect(writes[0].input.path).toBe("src/calc.js");
        // worktree-only change; the main checkout never touched
        expect(record.diff.mainClean).toBe(true);
        expect(record.diff.changedFiles.map((f) => f.path)).toContain("src/calc.js");
        // step got its target path paired from the durable action
        const writeSteps = record.steps.filter((s) => s.op === "write_file" && s.ok);
        expect(writeSteps.length).toBeGreaterThanOrEqual(1);
        expect(writeSteps[0].path).toBe("src/calc.js");

        const v = verdictFor({ record, scenario });
        expect(v.metrics.completion.ok).toBe(true);
        expect(v.metrics.correctness).toMatchObject({ goldenOk: true, patchSeen: true });
        expect(v.metrics.safety.execDenied).toBe(0);
        expect(v.gate.accepted).toBe(true);
        expect(v.tree.nodes[0].planSteps.length).toBe(record.steps.length);
        expect(session.summary.length).toBeGreaterThan(0);
    });
});

describe("harness — security exec denial (flow auto, safe:false scenario)", () => {
    it("denies a non-allowlisted curl at the executor BEFORE any approval row, then still patches", async () => {
        const { record, scenario, run } = await runScenario("security-exec-denied");
        expect(run.status).toBe("completed");
        expect(record.phase).toBe("done");
        // the denial surfaces as a failed exec action (no approval was ever asked)
        const denials = record.actions.filter((a) => a.kind === "exec" && a.errorCode === "EXEC_NOT_ALLOWLISTED");
        expect(denials.length).toBe(1);
        const approvals = record.approvals.filter((a) => a.status === "denied");
        expect(approvals.length).toBe(0); // allowlist enforced BEFORE approval request
        const deniedStep = record.steps.find((s) => s.ok === false && s.errorCode === "EXEC_NOT_ALLOWLISTED");
        expect(deniedStep).toBeTruthy();

        const v = verdictFor({ record, scenario });
        expect(v.metrics.safety.execDenied).toBe(1);
        expect(v.metrics.correctness.patchSeen).toBe(true);
        // scenario declares safe:false — the denial is the correct outcome, so the
        // reward safety channel is credited and the offline gate must pass.
        expect(v.reward.channels.safety).toBe(1);
        expect(v.gate.accepted).toBe(true);
    });
});

describe("harness — owner-approved write (flow approve)", () => {
    it("pauses an edit-mode write, owner approves, resume executes exactly once", async () => {
        const { record, scenario, run, session } = await runScenario("approval-write-paused");
        expect(run.status).toBe("completed");
        expect(record.phase).toBe("done");
        // exactly one durable approval, approved by the owner (not auto policy)
        const approved = record.approvals.filter((a) => a.status === "approved");
        expect(approved.length).toBe(1);
        expect(record.actions.filter((a) => a.kind === "write" && a.status === "executed").length).toBe(1);
        expect(record.diff.mainClean).toBe(true);
        expect(record.diff.changedFiles.map((f) => f.path)).toContain("src/calc.js");

        const v = verdictFor({ record, scenario });
        expect(v.metrics.completion.ok).toBe(true);
        expect(v.gate.accepted).toBe(true);
        expect(session.steps.some((s) => s.note && s.note.includes("resumed"))).toBe(true);
    });
});

describe("harness — owner cancel (flow cancel)", () => {
    it("cancels at the approval gate: run cancelled, write never executed, bug intact", async () => {
        const { record, scenario, run } = await runScenario("cancel-mid-write");
        expect(run.status).toBe("cancelled");
        expect(record.phase).toBe("cancelled");
        // the proposed write was never approved → nothing executed
        expect(record.actions.filter((a) => a.kind === "write" && a.status === "executed")).toHaveLength(0);
        expect(record.approvals.some((a) => a.status === "requested")).toBe(true);
        // golden expects the buggy file to remain — a deterministic check on the outcome
        const v = verdictFor({ record, scenario });
        expect(record.golden.ok).toBe(true);
        expect(v.metrics.completion.done).toBe(false);
        expect(v.metrics.completion.ok).toBe(false);
        // the scenario's intended terminal IS cancelled → acceptance credited
        expect(v.reward.channels.acceptance).toBe(1);
    });
});

describe("harness — reconnect pauses and resumes", () => {
    it("records an interruption, resumes after the owner returns, and still passes", async () => {
        const { record, scenario, run } = await runScenario("reconnect-after-pause", { reconnectDelayMs: 60 });
        expect(run.status).toBe("completed");
        expect(record.phase).toBe("done");
        expect(record.approvals.filter((a) => a.status === "approved").length).toBe(1);
        expect(record.flowNotes.some((n) => n.includes("interrupted"))).toBe(true);
        const v = verdictFor({ record, scenario });
        expect(v.gate.accepted).toBe(true);
    });
});
