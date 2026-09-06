import { describe, expect, it } from "vitest";
import { buildTrajectory, countTrajectory, exportTrajectory } from "./trajectory.js";
import { emptyRawRecord } from "./metrics.js";

/**
 * Phase 7 / R6 (roadmap #4, #5) — five-level trajectory + redacted export.
 * Pure structural tests over synthetic records: the hierarchy shape, the durable
 * action link, and that structural/paths/full redaction always strips exactly the
 * right fields (owner ids never leave as raw ids).
 */

const T0 = 1_700_000_000_000;

function recordWithWrite() {
    return emptyRawRecord({
        scenario: { id: "scen-approval", category: "approval", driver: "scripted", mode: "edit", flow: "approve" },
        run: { id: "run_7", projectId: "proj_1", repoHeadSha: "sha-fixed", seedRevision: "1" },
        startedAt: T0,
        completedAt: T0 + 6000,
        phase: "done",
        summary: "fixed calc after owner approved the write",
        turnCount: 4,
        actionCount: 3,
        steps: [
            { at: T0 + 100, type: "op", op: "read_file", note: "read the buggy file" },
            { at: T0 + 900, type: "op", op: "write_file", note: "awaiting owner approval" },
            { at: T0 + 2000, type: "note", note: "owner approved; resumed" },
            { at: T0 + 3000, type: "op", op: "write_file", note: "resumed after owner approval", ok: true },
        ],
        actions: [
            { id: "act_1", at: T0 + 900, op: "write_file", kind: "write", status: "executed", approvalId: "appr_1" },
            { id: "act_2", at: T0 + 100, op: "read_file", kind: "read", status: "executed" },
        ],
        approvals: [{ id: "appr_1", actionId: "act_1", status: "approved", decidedBy: 42, reason: "owner approves", decidedAt: T0 + 2500 }],
        tests: [],
        diff: { mainClean: true, changedFiles: [{ path: "src/calc.js" }], patchBytes: 12 },
        golden: { ok: true, checks: [], firstFailure: null },
    });
}

describe("buildTrajectory — five-level hierarchy", () => {
    it("lays out run → agent → plan steps with the right tiers", () => {
        const tree = buildTrajectory(recordWithWrite());
        expect(tree.level).toBe("run");
        expect(tree.kind).toBe("coding_run");
        expect(tree.run.repoHeadSha).toBe("sha-fixed");
        expect(tree.nodes).toHaveLength(1);
        expect(tree.nodes[0]).toMatchObject({ level: "agent", node: "code_agent", turnCount: 4 });
        const counts = countTrajectory(tree);
        expect(counts.planSteps).toBe(4);
        expect(counts.actions).toBe(1); // only the write_file linked to a durable write action
        expect(counts.approvals).toBe(1);
        // read_file runner-op + awaiting-write action runner-op + resumed-write runner-op
        expect(counts.runnerOps).toBe(3);
    });

    it("links the awaiting write step to its durable action + approval with role, not owner id", () => {
        const tree = buildTrajectory(recordWithWrite());
        const node = tree.nodes[0];
        // step index 1 is the write that paused for owner approval → carries the action
        const pauseStep = node.planSteps[1];
        expect(pauseStep.actions).toHaveLength(1);
        const action = pauseStep.actions[0];
        expect(action).toMatchObject({ level: "action", tool: "write_file", kind: "write", status: "executed" });
        expect(action.actionId).toBe("act_1");
        expect(action.approval.status).toBe("approved");
        expect(action.approval.decidedBy).toBe("owner");
        expect(action.approval.decidedBy).not.toBe(42);
        // the resumed step (index 3) executes the same effect but creates no new action row
        expect(node.planSteps[3].actions).toBeUndefined();
        expect(node.planSteps[3].runnerOps[0]).toMatchObject({ level: "runner_op", op: "write_file", ok: true });
    });
});

describe("exportTrajectory — redaction tiers + consent boundary", () => {
    it("structural export keeps shape + ids but drops prose, paths and summaries", () => {
        const exported = exportTrajectory(buildTrajectory(recordWithWrite()), { redact: "structural" });
        expect(exported.run.id).toBe("run_7");
        expect(exported.summary).toBeNull();
        const node = exported.nodes[0];
        // note prose and op names stripped at the structural tier; action rows hidden
        expect(node.planSteps[0].op).toBeUndefined();
        expect(node.planSteps[0].note).toBeUndefined();
        expect(node.planSteps[1].actions).toBeUndefined();
    });

    it("paths export keeps op + status but still drops note prose and reason", () => {
        const exported = exportTrajectory(buildTrajectory(recordWithWrite()), { redact: "paths" });
        const node = exported.nodes[0];
        const pauseStep = node.planSteps[1];
        expect(pauseStep.op).toBe("write_file");
        expect(pauseStep.note).toBeUndefined(); // prose redacted until full
        expect(pauseStep.actions[0].approval.reason).toBeUndefined();
        expect(pauseStep.actions[0].approval.status).toBe("approved");
    });

    it("full export (owner-consented) keeps notes + reason and still roles owner ids", () => {
        const exported = exportTrajectory(buildTrajectory(recordWithWrite()), { redact: "full" });
        expect(exported.summary).toContain("fixed calc");
        const node = exported.nodes[0];
        const pauseStep = node.planSteps[1];
        expect(pauseStep.actions[0].approval.reason).toContain("owner approves");
        expect(pauseStep.actions[0].approval.decidedBy).toBe("owner");
        const noteStep = node.planSteps[0];
        expect(noteStep.note).toContain("read the buggy file");
    });

    it("unknown redaction levels normalize to the safe 'paths' default", () => {
        const exported = exportTrajectory(buildTrajectory(recordWithWrite()), { redact: "everything" });
        expect(exported.summary).toBeNull();
        expect(exported.nodes[0].planSteps[1].op).toBe("write_file");
    });
});

describe("buildTrajectory — read/note fallback tiers", () => {
    it("a read-only observe record places reads under runnerOps without an action row", () => {
        const tree = buildTrajectory(emptyRawRecord({
            scenario: { id: "nav", category: "navigation", mode: "observe" },
            run: { id: "run_9", repoHeadSha: "sha", seedRevision: "1" },
            steps: [
                { at: T0, type: "op", op: "list_tree", note: "inspect the tree" },
                { at: T0 + 10, type: "op", op: "read_file", path: "src/a.js" },
            ],
            actions: [],
            phase: "done",
            summary: "found it",
        }));
        const counts = countTrajectory(tree);
        expect(counts.actions).toBe(0);
        expect(counts.runnerOps).toBe(2);
        const step0 = tree.nodes[0].planSteps[0];
        expect(step0.runnerOps[0]).toMatchObject({ level: "runner_op", op: "list_tree", effect: "read" });
    });
});
