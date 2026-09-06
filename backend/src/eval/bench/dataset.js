/**
 * Phase 7 / R6 (roadmap #8) — dataset export for the Agentic-RL loop.
 *
 * Once bench runs mature past the offline acceptance gate they can be exported into
 * training/eval corpora. Three export kinds mirror the three standard recipes and
 * all run OUT of the serving process (training/offline eval happen elsewhere):
 *
 *   sft        — (state, next-action) rows: a prompt of the run goal + prior plan
 *                steps, completed by the model-authored next decision.
 *   preference — chosen/rejected PAIRS derived deterministically from the run: a
 *                failed attempt followed by a corrected attempt on the same target
 *                yields rejected=first, chosen=second; an owner-approved action over
 *                a denied attempt of the same op yields chosen=approved.
 *   grpo       — one row per run: the (redacted) action trace + the reward vector +
 *                scalar. Group-relative advantage (GRPO) filtering is computed
 *                offline across rows sharing a scenario_id.
 *
 * Every row is derived from the CONSENTED, REDACTED trajectory — never from raw
 * model text without a policy. Redaction rules follow trajectory.js (structural /
 * paths / full) and dataset rows always carry the run/scenario provenance so a
 * deterministic offline gate can re-run them reproducibly.
 */
import { buildTrajectory, exportTrajectory } from "./trajectory.js";

export const DATASET_KINDS = ["sft", "preference", "grpo"];

function opTarget(step) {
    const s = step || {};
    if (s.args?.path) return s.args.path;
    if (s.path) return s.path;
    if (s.args?.executable || s.executable) return s.args?.executable || s.executable;
    return "";
}

/** One-line redacted narration of a plan step (no file content, ever). */
function narrateStep(step, index, { includeNote = true } = {}) {
    const s = step || {};
    const kind = s.type || "op";
    const target = opTarget(s);
    let text = `${index + 1}. ${kind}`;
    if (s.op) text += ` ${s.op}`;
    if (target) text += ` ${target}`;
    if (s.ok === true) text += " ok";
    if (s.ok === false) text += ` failed${s.errorCode ? `:${s.errorCode}` : ""}`;
    if (includeNote && s.note) text += ` — ${s.note}`;
    return text;
}

function decisionsList(planSteps) {
    return planSteps.map((s, i) => narrateStep(s, i)).join("\n");
}

/**
 * Build SFT rows from a trajectory tree.
 * @returns {{ rows: object[], kind: "sft" }}
 */
export function buildSftRows(tree, { includeNote = true } = {}) {
    const steps = tree?.nodes?.[0]?.planSteps || [];
    const rows = [];
    const goal = tree?.goal || tree?.scenarioId || "coding";
    const runId = tree?.run?.id || null;
    for (let i = 0; i < steps.length; i += 1) {
        const prompt = [
            `Task: ${goal}`,
            `Scenario: ${tree?.scenarioId || "coding"} (${tree?.category || "coding"}).`,
            "Observed steps:",
            decisionsList(steps.slice(0, i + 1)),
        ].join("\n");
        const next = steps[i + 1];
        const completion = next ? narrateStep(next, i, { includeNote }) : (steps[i]?.type === "done" ? steps[i].summary || "" : (tree?.summary || ""));
        rows.push({
            kind: "sft",
            runId,
            scenarioId: tree?.scenarioId || null,
            prompt,
            completion,
        });
    }
    return { rows, kind: "sft" };
}

/**
 * Deterministically derive preference pairs from a trajectory.
 * A recovery (failed step → successful step on the SAME target) emits
 * rejected = failed attempt text, chosen = corrected attempt text.
 */
export function buildPreferenceRows(tree) {
    const steps = tree?.nodes?.[0]?.planSteps || [];
    const rows = [];
    const targetKey = (s) => `${s.op || ""}|${opTarget(s)}`;
    for (let i = 0; i < steps.length; i += 1) {
        const current = steps[i];
        if (!current || current.ok !== false) continue;
        const key = targetKey(current);
        const recoveryIdx = steps.findIndex((later, j) => j > i && later.ok === true && targetKey(later) === key);
        if (recoveryIdx < 0) continue;
        rows.push({
            kind: "preference",
            runId: tree?.run?.id || null,
            scenarioId: tree?.scenarioId || null,
            rejected: narrateStep(current, i),
            chosen: narrateStep(steps[recoveryIdx], recoveryIdx),
        });
    }
    return { rows, kind: "preference" };
}

/**
 * One GRPO-ready row per run: a compact redacted action trace (op + ok + errors,
 * never content) plus the reward channels/scalar the offline runner computed.
 */
export function buildGrpoRows(raw, tree, reward) {
    const steps = tree?.nodes?.[0]?.planSteps || [];
    const trace = steps.map((s, i) => ({
        step: i + 1,
        type: s.type || "op",
        op: s.op || null,
        ok: s.ok ?? null,
        errorCode: s.errorCode || null,
    }));
    return {
        rows: [{
            kind: "grpo",
            runId: tree?.run?.id || null,
            codingRunId: tree?.run?.codingRunId || null,
            scenarioId: tree?.scenarioId || null,
            category: tree?.category || null,
            repoHeadSha: tree?.run?.repoHeadSha || null,
            phase: tree?.phase || null,
            trace,
            reward: reward?.channels || {},
            rewardScalar: reward?.scalar ?? null,
        }],
        kind: "grpo",
    };
}

/**
 * Export one or more dataset kinds from a run. Requires an already-consented,
 * redacted trajectory (`tree` must be the export of a consented run; the caller —
 * bench service/route — enforces consent before calling).
 *
 * @returns {{ format:"jsonl", kinds: object[] }}
 */
export function exportDataset({ raw = {}, tree = null, reward = null, kinds = ["sft", "preference", "grpo"], redact = "full" } = {}) {
    const want = kinds.filter((k) => DATASET_KINDS.includes(k));
    const treeValue = tree || buildTrajectory(raw);
    const safeTree = redact === "full" ? treeValue : exportTrajectory(treeValue, { redact });
    const out = [];
    if (want.includes("sft")) out.push(buildSftRows(safeTree));
    if (want.includes("preference")) out.push(buildPreferenceRows(safeTree));
    if (want.includes("grpo")) out.push(buildGrpoRows(raw, safeTree, reward));
    return { format: "jsonl", kinds: out };
}
