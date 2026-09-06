/**
 * Phase 7 / R6 (roadmap #4, #5) — five-level coding trajectory + redacted export.
 *
 * `buildTrajectory(raw)` lifts one canonical bench-run record into the R6 trace
 * hierarchy:
 *
 *   L1 coding run     — the whole run (project, fixed repo revision, outcome)
 *   L2 agent/node     — the code_agent node invocation (turn/action accounting)
 *   L3 plan step      — one loop decision/observation (op/verify/note/done)
 *   L4 action/tool    — a durable write/exec action (approval + artifact + settle)
 *   L5 runner op      — the underlying op execution (read audit / exec result meta)
 *
 * The durable substrate (coding_runs/coding_actions/coding_approvals/coding_events)
 * already stores REDACTED rows (never file content, never secrets). What those rows
 * do not carry is the model-authored note/summary text; that only exists in the raw
 * bench record. `exportTrajectory` therefore enforces an explicit redaction policy:
 *
 *   "structural" — ids + statuses + op names + counts only (no notes/summaries,
 *                  no paths, no command details)
 *   "paths"      — + file paths + executable + exit codes (still no prose)
 *   "full"       — + step notes/summaries + structured command args (owner-consented)
 *
 * Owner numeric ids are always replaced by roles. Everything here is a pure function
 * of plain data; the consent gate itself lives at the bench service / HTTP layer.
 */
import { emptyRawRecord } from "./metrics.js";

const REDACTION_LEVELS = new Set(["structural", "paths", "full"]);

export function normalizeRedaction(redact) {
    if (!REDACTION_LEVELS.has(redact)) return "paths";
    return redact;
}

function pick(obj, keys) {
    const out = {};
    for (const key of keys) if (obj && obj[key] !== undefined) out[key] = obj[key];
    return out;
}

function clone(v) {
    if (v == null) return v;
    return JSON.parse(JSON.stringify(v));
}

/** Link plan steps to durable actions in order: write/exec steps consume one action. */
function linkActions(steps, actions = [], approvals = []) {
    const approvalByAction = new Map();
    for (const appr of approvals || []) {
        if (appr.id || appr.approvalId) approvalByAction.set(appr.id || appr.approvalId, appr);
    }
    const queue = [...actions].filter((a) => a && a.op);
    const byStep = [];
    for (const step of steps || []) {
        if (step.op && (step.type === "op" || step.type === "verify") && queue.length) {
            const idx = queue.findIndex((a) => a.tool === step.op || a.op === step.op);
            if (idx >= 0) {
                byStep.push(queue.splice(idx, 1)[0]);
                continue;
            }
        }
        byStep.push(null);
    }
    return { byStep, approvalByAction };
}

/**
 * Build the five-level trajectory tree.
 * @param {object} raw canonical bench-run record (metrics.js shape)
 * @returns {object} trajectory tree
 */
export function buildTrajectory(raw = {}) {
    const r = { ...emptyRawRecord(), ...raw };
    const sc = r.scenario || {};
    const actions = (r.actions || []).map((a, i) => ({ seq: i + 1, ...a }));
    const approvals = r.approvals || [];
    const { byStep, approvalByAction } = linkActions(r.steps, actions, approvals);

    const planSteps = (r.steps || []).map((step, index) => {
        const base = {
            level: "plan_step",
            stepIndex: index,
            kind: step.type || "op",
            at: step.at ?? null,
        };
        if (step.op) base.op = step.op;
        if (step.path) base.path = step.path;
        else if (step.args?.path) base.path = step.args.path;
        if (step.executable) base.executable = step.executable;
        else if (step.args?.executable) base.executable = step.args.executable;
        if (step.note) base.note = step.note;
        if (step.ok !== undefined) base.ok = step.ok;
        if (step.errorCode) base.errorCode = step.errorCode;
        if (step.summary) base.summary = step.summary;
        if (step.type === "done") base.summary = base.summary || r.summary || null;

        // A note/observation step has no op execution beneath it.
        if (!step.op) return base;

        const effect = effectFor(step.op);
        const linked = byStep[index];
        if (linked && (effect === "write" || effect === "exec")) {
            // L4 action/tool ← the durable write/exec action.
            const approval = linked.approvalId ? approvalByAction.get(linked.approvalId) : null;
            const actionNode = {
                level: "action",
                actionId: linked.id || null,
                tool: linked.tool || linked.op,
                kind: linked.kind || effect,
                status: linked.status || null,
                at: linked.at ?? null,
                errorCode: linked.errorCode || null,
            };
            if (approval) {
                actionNode.approval = {
                    approvalId: approval.id || approval.approvalId || null,
                    status: approval.status || null,
                    reason: approval.reason || null,
                    decidedAt: approval.decidedAt || approval.decided_at || null,
                    decidedBy: roleOf(approval.decidedBy ?? approval.decided_by),
                };
            }
            if (linked.artifact) actionNode.artifact = pick(linked.artifact, ["id", "kind", "path", "sizeBytes", "digest"]);
            const runner = { op: step.op, effect, at: step.at ?? null };
            if (step.ok === true) runner.ok = true;
            else if (step.ok === false) runner.ok = false;
            if (step.errorCode || linked.errorCode) runner.errorCode = step.errorCode || linked.errorCode;
            actionNode.runnerOps = [{ level: "runner_op", ...runner }];
            base.actions = [actionNode];
            return base;
        }

        // L5 runner-op: a read op executes directly; a write/exec step with no
        // durable row (synthetic fixture / fake runner) still gets a trace entry so
        // the hierarchy is never silently empty.
        const runner = { op: step.op, effect: effect || "read", at: step.at ?? null };
        if (step.ok !== undefined) runner.ok = step.ok;
        if (step.errorCode) runner.errorCode = step.errorCode;
        base.runnerOps = [{ level: "runner_op", ...runner }];
        return base;
    });

    return {
        level: "run",
        kind: "coding_run",
        scenarioId: sc.id || null,
        category: sc.category || null,
        driver: sc.driver || "scripted",
        mode: sc.mode || "observe",
        flow: sc.flow || "auto",
        goal: sc.goal || null,
        run: {
            id: r.run?.id || null,
            projectId: r.run?.projectId || null,
            repoHeadSha: r.run?.repoHeadSha || null,
            seedRevision: r.run?.seedRevision || "1",
        },
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        phase: r.phase,
        haltReason: r.haltReason || null,
        summary: r.summary || null,
        nodes: [
            {
                level: "agent",
                kind: "agent_node",
                node: "code_agent",
                turnCount: r.turnCount,
                actionCount: r.actionCount,
                planSteps,
            },
        ],
    };
}

const READ_EFFECT = new Set(["list_tree", "read_file", "search_text", "git.status", "git.diff", "git.show_file"]);
const WRITE_EFFECT = new Set(["write_file", "create_file", "delete_file", "apply_patch", "run_command"]);

function effectFor(op) {
    if (READ_EFFECT.has(op)) return "read";
    if (WRITE_EFFECT.has(op)) return op === "run_command" ? "exec" : "write";
    return null;
}

function roleOf(value) {
    if (value == null) return "policy";
    if (value === "policy") return "policy";
    return "owner"; // numeric owner/decider ids never leave the machine as raw ids
}

/**
 * Count the tiers of a trajectory (test/observability aid).
 * @returns {{planSteps:number, actions:number, runnerOps:number, approvals:number}}
 */
export function countTrajectory(tree) {
    const counts = { planSteps: 0, actions: 0, runnerOps: 0, approvals: 0 };
    for (const node of tree?.nodes || []) {
        for (const step of node.planSteps || []) {
            counts.planSteps += 1;
            counts.runnerOps += (step.runnerOps || []).length;
            for (const action of step.actions || []) {
                counts.actions += 1;
                counts.runnerOps += (action.runnerOps || []).length;
                if (action.approval) counts.approvals += 1;
            }
        }
    }
    return counts;
}

/**
 * Deep, redacted export of a trajectory for a CONSULTING owner. The policy
 * argument is server-decided (never client-supplied for the default path).
 */
export function exportTrajectory(tree, { redact = "paths" } = {}) {
    const level = normalizeRedaction(redact);
    const out = clone(tree);
    if (!out) return null;

    out.nodes = (out.nodes || []).map((node) => {
        const planSteps = (node.planSteps || []).map((step) => {
            const s = {
                level: "plan_step",
                stepIndex: step.stepIndex,
                kind: step.kind,
            };
            if (step.at != null) s.at = step.at;
            if (level === "paths" || level === "full") {
                if (step.op) s.op = step.op;
                if (step.path) s.path = step.path;
                if (step.executable) s.executable = step.executable;
                if (step.ok !== undefined) s.ok = step.ok;
                if (step.errorCode) s.errorCode = step.errorCode;
                if (level === "full" && step.note) s.note = step.note;
            }
            if (level === "full" && step.summary) s.summary = step.summary;

            if (step.actions && level !== "structural") {
                s.actions = (step.actions || []).map((a) => {
                    const na = {
                        level: "action",
                        actionId: a.actionId,
                        tool: level === "full" || a.status ? a.tool : null,
                        kind: a.kind,
                        status: a.status,
                        at: a.at ?? null,
                    };
                    if (level === "paths" || level === "full") {
                        if (a.errorCode) na.errorCode = a.errorCode;
                        if (a.artifact && level === "full") na.artifact = a.artifact;
                    }
                    if (a.approval) {
                        na.approval = {
                            approvalId: a.approval.approvalId,
                            status: a.approval.status,
                            decidedBy: a.approval.decidedBy,
                        };
                        if (level === "full" && a.approval.reason) na.approval.reason = a.approval.reason;
                    }
                    if (a.runnerOps) na.runnerOps = exportRunnerOps(a.runnerOps, level);
                    return na;
                });
            }
            if (step.runnerOps) s.runnerOps = exportRunnerOps(step.runnerOps, level);
            return s;
        });
        return { level: "agent", node: node.node, turnCount: node.turnCount, actionCount: node.actionCount, planSteps };
    });
    // summary text is dropped unless the owner consented to "full".
    if (level !== "full") out.summary = null;
    return out;
}

function exportRunnerOps(ops, level) {
    return (ops || []).map((op) => {
        const o = { level: "runner_op", op: op.op, effect: op.effect, at: op.at ?? null };
        if (level === "paths" || level === "full") {
            if (op.ok !== undefined) o.ok = op.ok;
            if (op.errorCode) o.errorCode = op.errorCode;
            if (level === "full" && op.path) o.path = op.path;
            if (op.executable) o.executable = op.executable;
        }
        return o;
    });
}
