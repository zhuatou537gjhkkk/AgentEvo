/**
 * Phase 7 / R6 (roadmap #2) — offline bench harness over the REAL coding substrate.
 *
 * `executeBenchScenario` drives one scenario through the same owner-scoped coding
 * services a live coding run uses (CodeAgentService + CodingRunService + real
 * workspace runner + durable actions/approvals/events), but with a DETERMINISTIC
 * fake model: the scenario's authored scripted decider (or its custom decider, e.g.
 * rag). Tools are real (worktree writes + allowlisted node commands), so the
 * durable transcript is a faithful record a live candidate would also produce.
 *
 * Flows:
 *   auto      — policy decides (trusted writes execute immediately; observe reads)
 *   approve   — a pause is approved and the session resumes (one round trip)
 *   reconnect — the pause is RECORDED as an interruption, the session waits
 *               `reconnectDelayMs`, then the owner approves and it resumes
 *               (recovery latency is observable in metrics)
 *   cancel    — the owner CANCELS the run at the pause; the session is abandoned
 *
 * The harness owns the coding feature-flag env for the duration of the run and
 * restores it afterwards. It returns the canonical raw record (metrics.js shape)
 * plus the deterministic golden verdict; metric/reward/trajectory/dataset
 * derivation is composed by the bench service from that record.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { initDB } from "../../db/index.js";
import { CodeAgentService } from "../../coding/codingAgent.js";
import { defaultProjectService } from "../../coding/projects.js";
import { defaultRunService } from "../../coding/runs.js";
import { defaultApprovalService } from "../../coding/approvals.js";
import { setCommandAllowlistOverride, clearCommandAllowlistOverride } from "../../coding/runner/commandRunner.js";
import { codingError } from "../../coding/util.js";
import { buildBenchRepo, porcelainStatus, commitBenchChange } from "./fixtures.js";
import { runGoldenChecks } from "./golden.js";
import { emptyRawRecord } from "./metrics.js";

const ENV_KEYS = [
    "CODING_WORKSPACE_ENABLED",
    "CODING_EVENT_LOG_ENABLED",
    "CODING_WRITE_TOOLS_ENABLED",
    "CODING_COMMAND_TOOLS_ENABLED",
    "CODING_BATCH_READS",
    "CODING_RAG_REUSE_ENABLED",
    "CODING_ALLOWED_ROOTS",
    "CODING_WORKTREE_BASE",
    "CODING_COMMAND_ALLOWLIST",
];

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) OR ISO (already Z) → epoch ms; null-safe. */
export function sqlDateToMs(value, fallback = null) {
    if (value == null) return fallback;
    const text = String(value);
    const ms = Date.parse(/[zZ]$/.test(text) ? text : `${text.replace(" ", "T")}Z`);
    return Number.isFinite(ms) ? ms : fallback;
}

function snapshotEnv() {
    const out = {};
    for (const key of ENV_KEYS) out[key] = process.env[key];
    return out;
}

function restoreEnv(saved) {
    for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
}

function setEnv(map) {
    for (const [key, value] of Object.entries(map)) {
        if (value === undefined || value === null || value === "") delete process.env[key];
        else process.env[key] = String(value);
    }
}

function makeBenchDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readRel(root, rel) {
    const target = path.join(root, rel);
    try {
        return fs.readFileSync(target, "utf8");
    } catch {
        return null;
    }
}

/** fs walk (excluding .git) collecting rel → content. */
function treeSnapshot(root) {
    const out = {};
    const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === ".git") continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(abs, rel);
            else out[rel] = fs.readFileSync(abs, "utf8");
        }
    };
    walk(root, "");
    return out;
}

/** Deterministic fs diff of a (worktree) tree against the scenario seed files. */
function diffAgainstSeed(treeRoot, seedFiles) {
    const current = treeSnapshot(treeRoot);
    const seed = seedFiles || {};
    const changedFiles = [];
    let patchBytes = 0;
    const keys = new Set([...Object.keys(current), ...Object.keys(seed)]);
    for (const rel of keys) {
        const before = seed[rel];
        const after = current[rel];
        if (before === after) continue;
        changedFiles.push({ path: rel, added: after != null, deleted: before != null && after == null });
        if (after != null && before != null) patchBytes += Math.abs(Buffer.byteLength(after, "utf8") - Buffer.byteLength(before, "utf8"));
        else if (after != null) patchBytes += Buffer.byteLength(after, "utf8");
        else patchBytes += Buffer.byteLength(before, "utf8");
    }
    return { changedFiles, patchBytes };
}

// Side-effecting ops that map 1:1 to a durable write/exec action row.
const WRITE_EXEC_OPS = new Set([
    "write_file", "create_file", "delete_file", "apply_patch", "run_command",
]);

/**
 * Session steps carry op + note only (never the args). Pair each side-effecting
 * step with its durable action's redacted input so metric/trajectory modules can
 * see the target path/executable (revisions/reflection need same-path re-edits).
 * Reads are audited, not acted, so they carry no target and are skipped.
 */
function enrichStepTargets(steps, actions) {
    const targets = actions
        .filter((a) => a && (a.kind === "write" || a.kind === "exec") && WRITE_EXEC_OPS.has(a.op))
        .map((a) => ({ op: a.op, path: a.input?.path || null, executable: a.input?.executable || null }));
    let ti = 0;
    for (const step of steps || []) {
        if (!step || !WRITE_EXEC_OPS.has(step.op)) continue;
        const target = targets[ti];
        if (target && target.op === step.op) {
            step.path = target.path || null;
            step.executable = target.executable || null;
            ti += 1;
        }
    }
    return steps;
}

/**
 * An exec denied at the ALLOWLIST gate never reaches requestApproval, so no
 * durable action row exists — surface it as a failed exec action so the safety
 * channel can see the denial (owner was never even asked to approve it).
 */
function surfaceDeniedExecs(steps, actions) {
    const out = actions.slice();
    const hasDenial = () => out.some((a) => a.kind === "exec" && a.errorCode === "EXEC_NOT_ALLOWLISTED");
    for (const step of steps || []) {
        if (step.ok === false && step.errorCode === "EXEC_NOT_ALLOWLISTED" && step.op === "run_command" && !hasDenial()) {
            out.push({
                id: `denied_${step.at}`,
                at: step.at,
                op: "run_command",
                kind: "exec",
                status: "failed",
                input: { op: "run_command", executable: step.executable || null },
                errorCode: "EXEC_NOT_ALLOWLISTED",
                approvalId: null,
            });
        }
    }
    return out;
}

/** Build a scripted decider from the scenario's linear script. */
export function scriptedDecider(script, { onDecision = null } = {}) {
    const steps = Array.isArray(script) ? script : [];
    let index = 0;
    return async () => {
        const entry = steps[Math.min(index, Math.max(0, steps.length - 1))];
        if (index < steps.length) index += 1;
        if (typeof onDecision === "function") onDecision(entry, index);
        if (!entry) return { type: "done", summary: "no script" };
        if (entry.done) return { type: "done", summary: entry.summary || "" };
        const type = entry.kind === "verify" ? "verify" : "op";
        return { type, op: entry.op, args: entry.args || {}, note: entry.note || null };
    };
}

/** Wrap a scenario retrieval fixture into the ctx.retrieval seam + count usage. */
function retrievalFromFixture(fixture, counter) {
    return async ({ query, projectId } = {}) => {
        counter.calls += 1;
        const texts = (fixture || {})[String(query || "")] || [];
        counter.hits += texts.length;
        return {
            status: texts.length ? "ok" : "no_match",
            mode: "bench-fixture",
            query,
            projectId,
            items: texts.map((text) => ({ text, content: text, score: 1, source: "bench-fixture" })),
            count: texts.length,
            metrics: { consulted: true, latencyMs: 0 },
        };
    };
}

/**
 * Run one scenario to a terminal state and return its canonical record + golden.
 *
 * @param {object} scope authenticated owner scope ({ userId, tenantId })
 * @param {object} scenario resolved scenario catalog entry
 * @param {object} opts
 * @param {string} opts.allowedBase temp dir under which the fixture repo is built
 * @param {string} opts.worktreeBase temp dir for disposable worktrees
 * @param {object} [opts.env] extra/override coding env for the duration of the run
 * @param {boolean} [opts.eventLog=true] record durable run events while driving
 * @param {number} [opts.reconnectDelayMs=60] pause before approving on reconnect
 * @param {object} [opts.projectService] injectable project service (tests)
 */
export async function executeBenchScenario(scope, scenario, {
    allowedBase = null,
    worktreeBase = null,
    env = {},
    eventLog = true,
    reconnectDelayMs = 60,
} = {}) {
    if (!scenario?.id) throw codingError("BENCH_NO_SCENARIO", "a resolved scenario is required", 400);
    if (!allowedBase) allowedBase = makeBenchDir("agentevo-bench-allowed-");
    if (!worktreeBase) worktreeBase = makeBenchDir("agentevo-bench-wt-");
    fs.mkdirSync(allowedBase, { recursive: true });
    fs.mkdirSync(worktreeBase, { recursive: true });

    const saved = snapshotEnv();
    clearCommandAllowlistOverride();
    // NOTE: the platform feature flags (workspace/write/command/rag-reuse) are NOT
    // toggled here — a bench run must never grant a capability the server operator
    // has not enabled. We only pin the per-run INFRA for the disposable fixture:
    // allowed roots, worktree base, the scenario's exec allowlist, and event logging.
    // Scenario exec also relies on the operator's command flag; write modes on the
    // operator's write flag; rag driver on CODING_RAG_REUSE_ENABLED.
    const wanted = {
        CODING_EVENT_LOG_ENABLED: eventLog ? "true" : undefined,
        CODING_BATCH_READS: undefined,
        CODING_ALLOWED_ROOTS: allowedBase,
        CODING_WORKTREE_BASE: worktreeBase,
        CODING_COMMAND_ALLOWLIST: scenario.allowlist?.join(",") || undefined,
        ...env,
    };
    setEnv(wanted);
    if (scenario.allowlist?.length) setCommandAllowlistOverride(scenario.allowlist);

    let runId = null;
    let repoRoot = "";
    let worktreeRoot = null;
    try {
        initDB();
        const { userId, tenantId } = scope;
        // 1. build the disposable fixture repo at its FIXED revision + trust it.
        const built = buildBenchRepo(allowedBase, scenario.files || {});
        repoRoot = built.repoDir;
        const projectRecord = defaultProjectService.register({ userId }, { name: `bench-${scenario.id}`, rootPath: repoRoot });
        defaultProjectService.update({ userId }, projectRecord.id, { trusted: true });
        const project = defaultProjectService.get({ userId }, projectRecord.id);

        // 2. create the durable coding run (mode from the scenario).
        const run = defaultRunService.createRun({ userId, tenantId }, {
            projectId: project.id,
            mode: scenario.mode || "observe",
        });
        runId = run.id;
        const startedAt = Date.now();

        // 3. retrieval seam (rag) + CodeAgentService with optional injected retrieval.
        const retrievalCounter = { calls: 0, hits: 0 };
        let retrievalFn = null;
        if (scenario.driverName === "rag" && scenario.retrieval) {
            retrievalFn = retrievalFromFixture(scenario.retrieval.fixture, retrievalCounter);
        }
        const service = new CodeAgentService({ retrieval: retrievalFn });

        // 4. decider (custom for rag, else scripted linear).
        const handle = {
            consulted: (info = {}) => {
                retrievalCounter.calls = Math.max(1, retrievalCounter.calls);
                retrievalCounter.hits = Math.max(retrievalCounter.hits, Number(info?.hits) || 0);
            },
        };
        let decide;
        if (typeof scenario.decider === "function") {
            decide = (ctx) => scenario.decider(ctx, handle);
        } else {
            decide = scriptedDecider(scenario.script || []);
        }

        const budget = {
            maxTurns: scenario.budget?.maxTurns || 8,
            maxActions: scenario.budget?.maxActions || 12,
        };
        const session = service.begin({ userId, tenantId }, {
            run,
            project,
            goal: scenario.goal,
            decide,
            budget,
        });

        // 5. drive to a stop, handling approval stops per the scenario flow.
        let flowNotes = [];
        const flow = scenario.flow || "auto";
        const approvals = defaultApprovalService;
        const runService = defaultRunService;
        for (;;) {
            const snap = await service.run(session);
            if (snap.phase === "done" || snap.phase === "budget_halted" || snap.phase === "failed") {
                if (snap.phase === "done") {
                    try { runService.completeRun({ userId, tenantId }, runId); } catch { /* best-effort */ }
                } else if (snap.phase === "budget_halted") {
                    try { runService.failRun({ userId, tenantId }, runId, { errorCode: snap.haltReason }); } catch { /* best-effort */ }
                }
                break;
            }
            if (snap.phase !== "awaiting_owner_decision") break;
            if (flow === "auto") {
                throw codingError("BENCH_FLOW_MISMATCH", `scenario ${scenario.id} paused for approval under flow 'auto'`, 409);
            }
            if (flow === "cancel") {
                try { runService.cancelRun({ userId, tenantId }, runId); } catch { /* best-effort */ }
                flowNotes.push("cancelled at approval gate");
                break;
            }
            // approve | reconnect: decide ALL open approvals (there is one), then resume.
            const interruptedAt = Date.now();
            if (flow === "reconnect") {
                flowNotes.push(`interrupted ${interruptedAt - startedAt}ms in; awaiting owner`);
                await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
            }
            const open = approvals.listApprovals({ userId, tenantId }, { runId, status: "requested" });
            for (const appr of open) {
                approvals.decide({ userId, tenantId }, appr.id, { approve: true, reason: `bench flow ${flow}` });
            }
            const pending = session.pending || snap.pending;
            if (!pending) {
                throw codingError("BENCH_NO_PENDING", "awaiting decision but no pending action", 409);
            }
            if (flow === "reconnect") flowNotes.push(`resumed ${Date.now() - interruptedAt}ms after owner returned`);
            await service.resume(session, { op: pending.op, args: pending.args });
        }

        // 6. durable action/approval transcript.
        const actions = approvals.listActions({ userId, tenantId }, runId, { limit: 1000 }).map((a) => ({
            id: a.id,
            at: sqlDateToMs(a.createdAt, startedAt),
            op: a.tool,
            kind: a.type,
            status: a.status,
            input: a.input || {},
            errorCode: a.errorCode || null,
            approvalId: a.approvalId || null,
        }));
        const approvalRows = approvals.listApprovals({ userId, tenantId }, { runId, limit: 1000 }).map((a) => ({
            id: a.id,
            actionId: a.actionId,
            at: sqlDateToMs(a.requestedAt, startedAt),
            status: a.status,
            reason: a.reason || null,
            approved: a.status === "approved",
        }));

        // 7. repo facts: main checkout untouched? worktree tree diffed vs seed.
        const runFresh = runService.getRun({ userId, tenantId }, runId);
        const mainClean = porcelainStatus(repoRoot) === "";
        let diff = null;
        let readRoot = repoRoot;
        if (runFresh?.worktreeStatus === "ready" && runFresh.worktreePath) {
            worktreeRoot = runFresh.worktreePath;
            readRoot = worktreeRoot;
            diff = { mainClean, ...diffAgainstSeed(worktreeRoot, scenario.files) };
        } else {
            diff = { mainClean, changedFiles: [], patchBytes: 0 };
        }

        // 8. deterministic golden (file/command/text over the resolved tree).
        const completedAt = Date.now();
        const runSummary = session.summary || "";
        const commandChecks = [];
        const api = {
            summary: runSummary,
            readFile: (rel) => readRel(readRoot, rel) ?? "",
            runCommand: (executable, args, cwd) => {
                try {
                    const output = execFileSync(String(executable), args || [], {
                        cwd: cwd || readRoot,
                        encoding: "utf8",
                        timeout: 30_000,
                        stdio: ["ignore", "pipe", "pipe"],
                    });
                    return { code: 0, output: String(output) };
                } catch (error) {
                    const code = typeof error?.status === "number" ? error.status : 1;
                    const output = String(error?.stdout || "") + String(error?.stderr || "");
                    return { code, output };
                }
            },
        };
        const goldenResult = runGoldenChecks(scenario.golden || {}, api);
        const goldenSpec = (scenario.golden?.checks || []);
        // Result checks carry only {label, ok}; re-attach the kind from the spec so
        // consumers can tell text/file/command apart, and record command checks as
        // the run's deterministic test results (executed against the worktree).
        const goldenChecks = (goldenResult.checks || []).map((check, index) => ({
            ...check,
            type: goldenSpec[index]?.type || null,
        }));
        goldenSpec.forEach((check, index) => {
            if (check.type === "command") {
                commandChecks.push({
                    at: completedAt,
                    op: check.executable,
                    ok: goldenResult.checks?.[index]?.ok === true,
                    exitCode: null,
                });
            }
        });

        // 9. canonical record. Pair steps to their durable targets (paths/exe), then
        // surface exec denials — a denial never reached requestApproval so it has no
        // action row. Normalize ok: absent ⇒ success (only an explicit failure flags).
        const steps = enrichStepTargets(
            (session.steps || []).map((s) => ({
                at: sqlDateToMs(s.at, startedAt),
                type: s.type || "op",
                op: s.op || null,
                note: s.note || null,
                ok: s.ok === false || s.errorCode ? false : true,
                errorCode: s.errorCode || null,
            })),
            actions,
        );
        const surfacedActions = surfaceDeniedExecs(steps, actions);
        const record = emptyRawRecord({
            scenario: {
                id: scenario.id,
                category: scenario.category,
                driver: "scripted",
                mode: scenario.mode || "observe",
                flow,
                goal: scenario.goal,
            },
            run: {
                id: runId,
                projectId: project.id,
                repoHeadSha: built.headSha,
                seedRevision: "1",
            },
            startedAt,
            completedAt,
            phase: runFresh.status === "cancelled" ? "cancelled"
                : runFresh.status === "failed" ? (session.phase === "budget_halted" ? "budget_halted" : "failed")
                    : session.phase,
            haltReason: session.haltReason || null,
            summary: runSummary,
            turnCount: session.turnCount,
            actionCount: session.actionCount,
            transcriptChars: session.transcriptChars,
            steps,
            actions: surfacedActions,
            approvals: approvalRows,
            tests: commandChecks,
            diff,
            usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, source: "scripted" },
            retrieval: { consulted: retrievalCounter.calls > 0, hits: retrievalCounter.hits },
            budget,
            golden: { ok: goldenResult.ok, checks: goldenChecks, firstFailure: goldenResult.firstFailure },
            flowNotes,
        });

        return {
            record,
            golden: goldenResult,
            session,
            run: runFresh,
            project,
            paths: { repoRoot, worktreeRoot, allowedBase, worktreeBase },
        };
    } finally {
        clearCommandAllowlistOverride();
        restoreEnv(saved);
    }
}

/** Re-provision a fixture repo with a NEW change commit (reconnect/regression helper). */
export function advanceRepo(repoRoot, files, message = "second change", date = "2026-01-03T00:00:00Z") {
    for (const [rel, content] of Object.entries(files || {})) {
        const target = path.join(repoRoot, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(content));
    }
    return commitBenchChange(repoRoot, message, date);
}
