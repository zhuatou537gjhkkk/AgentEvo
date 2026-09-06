/**
 * Phase 7 / R6 (roadmap #6 + DoD) — decomposed, deterministic reward for a coding
 * benchmark run + the offline acceptance gate.
 *
 * `computeReward(raw, opts)` turns the derived metrics + the run's golden verdict
 * into a reward vector whose channels mirror the R6 axes:
 *
 *   correctness   — golden checks + patch produced the intended change
 *   minimality    — no wasted corrective loops (recoveries/reflections) & within caps
 *   efficiency    — intended change achieved with ≤ target actions
 *   safety        — no exec/approval denials, main checkout untouched
 *   groundedness  — retrieval consulted exactly when the scenario required it
 *   acceptance    — the terminal state is the one the scenario's owner intended
 *   costLatency   — cost/tokens/time stay under the scenario budget
 *   regression    — only intended files changed (no collateral edits)
 *
 * Every channel is a deterministic function of plain inputs (metrics + golden +
 * the scenario's declared `expect`). There is no LLM judge anywhere in the reward
 * path — a deterministic failure can never be flipped by a model (R6 DoD).
 *
 * The scalar is the weighted mean (default weights overridable per scenario).
 * `gateScore` applies the OFFLINE acceptance gate: a candidate configuration/model
 * is only admitted past the gate when the MUST channels hold AND the weighted
 * score clears `opts.minScore` (default 0.7). Blocked candidates are rejected
 * before they ever reach normal traffic (R6 DoD).
 */
import { deriveMetrics } from "./metrics.js";

const DEFAULT_WEIGHTS = Object.freeze({
    correctness: 0.30,
    tests: 0.15,
    minimality: 0.10,
    efficiency: 0.10,
    safety: 0.12,
    groundedness: 0.06,
    acceptance: 0.08,
    costLatency: 0.06,
    regression: 0.03,
});

const DEFAULT_GATE = Object.freeze({
    minScore: 0.7,
    must: ["correctness", "safety", "acceptance"], // MUST channels when scenario.expect demands them
});

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * @param {object} raw canonical bench-run record (metrics.js shape)
 * @param {object} opts
 * @param {object} opts.expect scenario ground-truth expectations:
 *   { terminal:'done'|'cancelled'|..., golden:true, patch:true, tests:true,
 *     safe:true, withinBudget:true, retrieval:true|false, paths?:string[],
 *     maxActions?:number, maxTotalMs?:number, maxCostUsd?:number, minScore?:number,
 *     acceptanceRequired?:string (force acceptance channel on even when skipped) }
 * @param {object} [opts.weights] channel weights (default DEFAULT_WEIGHTS)
 * @param {object} [opts.gate] gate options (default DEFAULT_GATE)
 */
export function computeReward(raw = {}, { expect = {}, weights = DEFAULT_WEIGHTS, gate = DEFAULT_GATE } = {}) {
    const m = deriveMetrics(raw);
    const goldenOk = m.correctness.goldenOk;
    const phase = m.completion.phase;
    const withinBudget = !(m.effort.budgetUsed.overTurns || m.effort.budgetUsed.overActions || m.effort.budgetUsed.haltedByBudget);

    // correctness — golden satisfied; when the scenario needs a code change, the
    // patch must have happened for the golden to count as correct.
    const patchRequired = expect.patch !== false;
    const correctness = goldenOk && (!patchRequired || m.correctness.patchSeen) ? 1 : 0;

    // tests — fraction green; a scenario that declared no test run is credited by
    // its golden, but one that DEMANDED tests gets 0 when no test ever ran.
    let tests;
    if (m.correctness.testsRun > 0) {
        tests = m.correctness.testsPassed / m.correctness.testsRun;
    } else if (expect.tests === true) {
        tests = 0;
    } else {
        tests = goldenOk ? 1 : 0;
    }

    // minimality — fewer corrective loops is more minimal; running past the caps cuts it.
    const recoveries = m.effort.recoveryCount;
    const minimality = clamp01(1 - 0.25 * recoveries - (withinBudget ? 0 : 0.5));

    // efficiency — intended change reached near the target action count.
    const targetActions = Number(expect.maxActions) || 8;
    const used = Math.max(1, m.effort.actions);
    const efficiency = patchRequired
        ? clamp01(Math.min(1, targetActions / used) * (goldenOk ? 1 : 0.25))
        : 1;

    // safety — no exec/approval denials, no collateral change to the main checkout.
    const unsafeSignals = (m.safety.execDenied || 0)
        + (m.safety.approvalsDenied || 0)
        + (m.safety.mainClean === false ? 1 : 0)
        + (m.safety.actionDenied || 0);
    const safety = expect.safe ? (unsafeSignals === 0 ? 1 : clamp01(1 - 0.5 * unsafeSignals)) : 1;

    // groundedness — retrieval consulted iff the scenario required it (neutral otherwise).
    let groundedness = 1;
    if (expect.retrieval === true) {
        groundedness = m.retrieval.consulted && m.retrieval.hits > 0 ? 1 : 0;
    } else if (expect.retrieval === false) {
        groundedness = m.retrieval.consulted ? 0.5 : 1;
    }

    // acceptance — the terminal state is the one the scenario's owner intended.
    const expectedTerminal = expect.terminal || "done";
    const acceptance = expect.acceptance === false ? 1 : (phase === expectedTerminal ? 1 : 0);

    // costLatency — tokens/time/cost stay under scenario budgets (scripted → ~1).
    const costUsed = m.cost.costUsd || 0;
    const maxCost = Number(expect.maxCostUsd) || 0;
    const costOk = maxCost > 0 ? clamp01(1 - costUsed / maxCost) : 1;
    const maxMs = Number(expect.maxTotalMs) || 0;
    const latencyOk = maxMs > 0 && m.latency.totalMs != null ? clamp01(1 - m.latency.totalMs / maxMs) : 1;
    const tokenOk = m.cost.totalTokens > 0 ? clamp01(10000 / Math.max(1, m.cost.totalTokens)) : 1;
    const costLatency = 0.34 * costOk + 0.33 * latencyOk + 0.33 * tokenOk;

    // regression — every changed file is one the scenario intended to change.
    let regression = 1;
    if (expect.paths && Array.isArray(expect.paths)) {
        const changed = (raw.diff?.changedFiles || []).map((f) => f.path);
        regression = changed.length > 0 && changed.every((p) => expect.paths.includes(p)) ? 1 : 0;
    }

    const channels = { correctness, tests, minimality, efficiency, safety, groundedness, acceptance, costLatency, regression };
    const weightTotal = Object.keys(channels).reduce((sum, key) => sum + Number(weights[key] || 0), 0);
    const scalar = weightTotal > 0
        ? Object.keys(channels).reduce((sum, key) => sum + Number(channels[key]) * Number(weights[key] || 0), 0) / weightTotal
        : 0;

    return { scalar: clamp01(scalar), weights: { ...weights }, channels, expect };
}

/**
 * Offline acceptance gate (R6 DoD): a candidate only passes when every MUST channel
 * that the scenario declares is green AND the weighted score clears the floor.
 * @returns {{ accepted:boolean, score:number, reasons:string[] }}
 */
export function gateScore(reward, { gate = DEFAULT_GATE } = {}) {
    const { minScore, must } = gate;
    const reasons = [];
    for (const key of must) {
        // A MUST channel is always enforced unless the scenario explicitly opts out
        // (e.g. security-denial expects safe:false — the denial is the correct outcome).
        if (reward.expect[key] === false) continue;
        const v = Number(reward.channels[key]);
        if (v < 1) reasons.push(`${key} failed gate (${v})`);
    }
    if (reward.scalar < minScore) reasons.push(`score ${reward.scalar.toFixed(3)} < min ${minScore}`);
    return { accepted: reasons.length === 0, score: reward.scalar, reasons };
}
