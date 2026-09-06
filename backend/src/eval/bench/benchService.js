/**
 * Phase 7 / R6 — bench service: orchestrate one offline coding-benchmark run,
 * persist its summary, and serve owner-consented trajectory/dataset export.
 *
 *   runScenario  — drive one scenario over the REAL coding substrate (harness.js)
 *                  with a deterministic fake model, then derive metrics/reward/gate
 *                  and persist the bench_runs summary + a sanitized raw record.
 *   list/get     — read the run ledger (no raw payloads in listings).
 *   setConsent   — owner opt-in; export endpoints refuse without it (R6 #5).
 *   export…      — rebuild the 5-level trajectory / SFT/preference/GRPO dataset from
 *                  the raw cache, under an explicit redaction policy.
 *
 * All derivation is PURE (metrics/reward/trajectory/dataset never call a model), so
 * a deterministic failure can never be re-judged, and a candidate config/model that
 * fails the offline gate is rejected before it ever reaches normal traffic (R6 DoD).
 */
import db, { initDB } from "../../db/index.js";
import { codingError, newId, sanitizeStored, nowSql } from "../../coding/util.js";
import { executeBenchScenario, sqlDateToMs } from "./harness.js";
import { deriveMetrics } from "./metrics.js";
import { computeReward, gateScore } from "./reward.js";
import { buildTrajectory, countTrajectory, exportTrajectory, normalizeRedaction } from "./trajectory.js";
import { exportDataset } from "./dataset.js";
import { listScenarioIds, resolveScenario, publicScenarioMeta, validateCatalog } from "./scenarios.js";

const RAW_CACHE_MAX_BYTES = 2 * 1024 * 1024;

function toRun(row) {
    if (!row) return null;
    const parse = (text) => { try { return JSON.parse(text); } catch { return {}; } };
    return {
        id: row.id,
        ownerUserId: row.owner_user_id,
        tenantId: row.tenant_id,
        scenarioId: row.scenario_id,
        category: row.category,
        driver: row.driver,
        mode: row.mode,
        status: row.status,
        repoHeadSha: row.repo_head_sha || null,
        projectId: row.project_id || null,
        codingRunId: row.coding_run_id || null,
        configVersionId: row.config_version_id || null,
        seedRevision: row.seed_revision,
        consent: Number(row.consent) === 1,
        metrics: parse(row.metrics_json),
        reward: parse(row.reward_json),
        result: parse(row.result_json),
        errorCode: row.error_code || null,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        updatedAt: row.updated_at,
    };
}

function requireOwner(scope, label = "bench run") {
    const userId = Number(scope?.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
        throw codingError("INVALID_CODING_SCOPE", `${label} ownership is required`, 400);
    }
    const tenantId = String(scope?.tenantId || `user:${userId}`);
    return { userId, tenantId };
}

/** Listing-safe catalog view (never files/script/decider content). */
export function listScenarios() {
    return listScenarioIds().map((id) => publicScenarioMeta(resolveScenario(id)));
}

export function getScenarioMeta(scenarioId) {
    return publicScenarioMeta(resolveScenario(scenarioId));
}

/**
 * Run one scenario to completion and persist its summary + raw cache.
 *
 * @param {object} scope authenticated owner scope
 * @param {string} scenarioId resolved catalog scenario
 * @param {object} [opts] harness opts (allowedBase, worktreeBase, env, cleanup…)
 * @returns {Promise<object>} bench_runs summary row (parsed, consent=false)
 */
export async function runScenario(scope, scenarioId, opts = {}) {
    validateCatalog();
    const scoped = requireOwner(scope);
    const scenario = resolveScenario(scenarioId); // throws BENCH_SCENARIO_NOT_FOUND
    const harness = await executeBenchScenario(scoped, scenario, {
        allowedBase: opts.allowedBase || null,
        worktreeBase: opts.worktreeBase || null,
        env: opts.env || {},
        eventLog: opts.eventLog !== false,
        reconnectDelayMs: opts.reconnectDelayMs,
    });
    const { record, run: codingRun, project, paths } = harness;

    const metrics = deriveMetrics(record);
    const reward = computeReward(record, { expect: scenario.expect });
    const gate = gateScore(reward);
    const tree = buildTrajectory(record);
    const counts = countTrajectory(tree);

    const id = newId("bench_");
    const tenantId = scoped.tenantId;
    const userId = scoped.userId;
    const completedAt = nowSql();
    const rewardPayload = { ...reward, gate };
    const resultPayload = {
        phase: record.phase,
        haltReason: record.haltReason || null,
        goldenOk: metrics.correctness.goldenOk,
        changedFiles: (record.diff?.changedFiles || []).map((f) => f.path),
        mainClean: record.diff?.mainClean ?? null,
        patchBytes: record.diff?.patchBytes ?? null,
        summary: record.summary || null,
        trajectory: counts,
        retrieval: record.retrieval,
        flowNotes: record.flowNotes || [],
    };

    db.prepare(
        `INSERT INTO bench_runs
            (id, owner_user_id, tenant_id, scenario_id, category, mode, status,
             repo_head_sha, project_id, coding_run_id, seed_revision, consent,
             metrics_json, reward_json, result_json, error_code, created_at, completed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, '1', 0, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(
        id, userId, tenantId, scenario.id, scenario.category, scenario.mode,
        record.run?.repoHeadSha || codingRun?.baseCommit || null,
        project?.id || null,
        codingRun?.id || record.run?.id || null,
        sanitizeStored(metrics),
        sanitizeStored(rewardPayload),
        sanitizeStored(resultPayload),
        completedAt, completedAt, completedAt,
    );
    db.prepare(
        `INSERT INTO bench_run_raws (run_id, owner_user_id, tenant_id, raw_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(id, userId, tenantId, sanitizeStored(record, { maxBytes: RAW_CACHE_MAX_BYTES }), completedAt);

    if (opts.cleanup !== false) {
        const { rmBenchDir } = await import("./fixtures.js");
        for (const dir of new Set([paths.allowedBase, paths.worktreeBase])) {
            if (dir) { try { rmBenchDir(dir); } catch { /* best-effort */ } }
        }
    }

    const row = db.prepare(
        "SELECT * FROM bench_runs WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
    ).get(id, userId, tenantId);
    return { run: toRun(row), record, metrics, reward, gate };
}

export function listRuns(scope, { scenarioId = null, status = null, limit = 50 } = {}) {
    initDB();
    const { userId, tenantId } = requireOwner(scope);
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 50));
    const clauses = ["owner_user_id = ? AND tenant_id = ?"];
    const args = [userId, tenantId];
    if (scenarioId) { clauses.push("scenario_id = ?"); args.push(String(scenarioId)); }
    if (status) { clauses.push("status = ?"); args.push(String(status)); }
    const rows = db.prepare(
        `SELECT * FROM bench_runs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    ).all(...args, safeLimit);
    return rows.map(toRun);
}

export function getRun(scope, runId) {
    initDB();
    const { userId, tenantId } = requireOwner(scope);
    const row = db.prepare(
        "SELECT * FROM bench_runs WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
    ).get(String(runId), userId, tenantId);
    if (!row) return null;
    return toRun(row);
}

/** Owner consent opt-in — required before any trajectory/dataset export (R6 #5). */
export function setConsent(scope, runId, consent) {
    initDB();
    const { userId, tenantId } = requireOwner(scope);
    const row = db.prepare(
        "SELECT id FROM bench_runs WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
    ).get(String(runId), userId, tenantId);
    if (!row) throw codingError("BENCH_RUN_NOT_FOUND", "bench run not found", 404);
    db.prepare(
        "UPDATE bench_runs SET consent = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
    ).run(consent ? 1 : 0, String(runId), userId, tenantId);
    return getRun(scope, runId);
}

function loadRaw(scope, run) {
    const { userId, tenantId } = requireOwner(scope);
    const rawRow = db.prepare(
        "SELECT raw_json FROM bench_run_raws WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ?",
    ).get(String(run.id), userId, tenantId);
    if (!rawRow) throw codingError("BENCH_RAW_MISSING", "bench run has no raw record", 404);
    try { return JSON.parse(rawRow.raw_json); } catch {
        throw codingError("BENCH_RAW_CORRUPT", "bench run raw record is unreadable", 409);
    }
}

function assertConsented(run) {
    if (!run || run.consent !== true) {
        throw codingError("BENCH_CONSENT_REQUIRED", "owner consent is required for trajectory/dataset export", 403);
    }
}

/**
 * Export the owner-consented 5-level trajectory of a run under a redaction policy
 * ("structural" | "paths" | "full"). R6 #4/#5.
 */
export function exportRunTrajectory(scope, runId, { redact = "paths" } = {}) {
    const run = getRun(scope, runId);
    if (!run) throw codingError("BENCH_RUN_NOT_FOUND", "bench run not found", 404);
    assertConsented(run);
    const raw = loadRaw(scope, run);
    const tree = buildTrajectory(raw);
    const policy = normalizeRedaction(redact);
    const trajectory = exportTrajectory(tree, { redact: policy });
    return { trajectory, counts: countTrajectory(tree), redact: policy, consent: true, scenarioId: run.scenarioId, repoHeadSha: run.repoHeadSha };
}

/**
 * Export SFT/preference/GRPO-ready rows under a redaction policy. R6 #8 output is a
 * flat JSONL string per kind; training/eval stays OUTSIDE the serving process.
 */
export function exportRunDataset(scope, runId, { kinds = ["sft", "preference", "grpo"], redact = "full" } = {}) {
    const run = getRun(scope, runId);
    if (!run) throw codingError("BENCH_RUN_NOT_FOUND", "bench run not found", 404);
    assertConsented(run);
    const raw = loadRaw(scope, run);
    const tree = buildTrajectory(raw);
    const reward = computeReward(raw, { expect: raw.scenario?.expect || {} });
    const policy = normalizeRedaction(redact);
    // Dataset provenance binds to the bench-run artifact (the row that owns
    // consent + gate + raw); the underlying coding-run id is retained so a
    // consumer can still trace back to the durable coding_runs row.
    const provenanceTree = JSON.parse(JSON.stringify(tree));
    provenanceTree.run = {
        ...(provenanceTree.run || {}),
        id: run.id,
        codingRunId: tree?.run?.id || run.codingRunId || null,
    };
    const dataset = exportDataset({ raw, tree: provenanceTree, reward, kinds, redact: policy });
    return { format: "jsonl", consent: true, kinds: dataset.kinds, scenarioId: run.scenarioId, repoHeadSha: run.repoHeadSha };
}

export { sqlDateToMs };
export const __benchInternals = { requireOwner, loadRaw, assertConsented };
