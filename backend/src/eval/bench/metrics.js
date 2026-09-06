/**
 * Phase 7 / R6 (roadmap #3) — pure, deterministic metric derivation for a coding
 * benchmark run.
 *
 * `deriveMetrics(raw)` turns one canonical bench-run record (the shape the harness
 * produces from a driven CodeAgentService session + its durable coding rows) into
 * the R6 metric dictionary:
 *
 *   completion  — did the loop finish, and was the golden satisfied?
 *   correctness — golden checks / patch / test booleans
 *   latency     — total wall time, time-to-first-patch (TTFP), time-to-first-
 *                 test-pass (TTFE), per-turn latency
 *   effort      — turns/actions, read/write/exec/verify/approval counts, budget
 *                 headroom, recoveries (reflection)
 *   safety      — exec/approval denials, main-checkout cleanliness
 *   cost        — token + cost accounting (0 for a scripted driver)
 *   efficiency  — bytes changed per action, actions to first patch
 *
 * The module is PURE: it reads only the plain record and returns plain numbers, so
 * the same derivation is used by the unit tests, the offline harness and the
 * export pipeline. A deterministic metric can never be re-judged by an LLM (R6
 * DoD); `deriveMetrics` never consults a model.
 */

const TERMINAL_OK = new Set(["done"]);
const WRITE_KINDS = new Set(["write", "exec"]);

/** Canonical raw-record defaults (fields are optional; derivation tolerates gaps). */
export function emptyRawRecord(overrides = {}) {
    return {
        scenario: { id: null, category: null, driver: "scripted", mode: "observe", flow: "auto" },
        run: { id: null, projectId: null, repoHeadSha: null, seedRevision: "1" },
        startedAt: null,        // epoch ms
        completedAt: null,      // epoch ms
        phase: null,            // done | budget_halted | failed | cancelled | awaiting
        haltReason: null,
        summary: null,
        turnCount: 0,
        actionCount: 0,
        transcriptChars: 0,
        steps: [],              // { at, type, op?, note?, ok?, errorCode? }
        actions: [],            // { at, op, kind:'read'|'write'|'exec', status, errorCode?, artifact? }
        approvals: [],          // { at, requestedAt?, decidedAt?, status, reason?, approved? }
        tests: [],              // { at, op, ok, exitCode? }
        diff: null,             // { mainClean, changedFiles:[{path}], patchBytes }
        usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
        retrieval: { consulted: false, hits: 0 },
        budget: {},
        golden: { ok: null, checks: [], firstFailure: null },
        ...overrides,
    };
}

function countSteps(steps, predicate) {
    return (steps || []).filter(predicate).length;
}

function firstAfter(startMs, list, predicate) {
    if (startMs == null) return null;
    const hit = (list || []).find((item) => item && predicate(item) && Number.isFinite(item.at));
    if (!hit) return null;
    return Math.max(0, Number(hit.at) - Number(startMs));
}

function changedFiles(diff) {
    return (diff?.changedFiles || []).length;
}

/**
 * Derive the R6 metric dictionary from one canonical raw record.
 * @param {object} raw see emptyRawRecord()
 * @returns {object} flat metric object (safe to JSON.stringify)
 */
export function deriveMetrics(raw = {}) {
    const r = { ...emptyRawRecord(), ...raw };
    const goldenOk = r.golden?.ok === true;
    const patchSeen = countSteps(r.actions || [], (a) => a && a.op && a.kind === "write" && a.status === "executed");
    const writes = countSteps(r.actions || [], (a) => a?.kind === "write");
    const execs = countSteps(r.actions || [], (a) => a?.kind === "exec");
    const reads = countSteps(r.actions || [], (a) => a?.kind === "read");
    const approves = countSteps(r.actions || [], (a) => a?.status === "approved");
    const deniedExec = countSteps(r.actions || [], (a) => a?.kind === "exec" && a?.errorCode === "EXEC_NOT_ALLOWLISTED");
    const deniedActions = countSteps(r.actions || [], (a) => a?.errorCode && a?.errorCode !== "EXEC_NOT_ALLOWLISTED");
    const approvalsDenied = countSteps(r.approvals || [], (a) => a?.status === "denied");

    // Verifies = verify-type step rows + tests.
    const verifySteps = countSteps(r.steps || [], (s) => s?.type === "verify");
    const execSteps = countSteps(r.steps || [], (s) => s?.op === "run_command");

    const tests = r.tests || [];
    const testsRun = tests.length;
    const testsPassed = tests.filter((t) => t.ok === true).length;

    // Recovery = a failed op step followed later by an op step on the SAME op/path
    // that reports ok (self-correction / reflection). Path identity falls back to
    // op name when the fixture carries no args path.
    const opKey = (s) => {
        const target = s?.args?.path || s?.path || s?.executable || "";
        return `${String(s?.op || "")}:${target}`;
    };
    const stepArr = r.steps || [];

    // Revisions = number of same-target edit attempts beyond the first (a write or
    // patch to a path that was already written/patch-targeted earlier in the run).
    // A reflection/self-correction loop is characterized by such re-edits.
    const editKey = (s) => (s?.op === "write_file" || s?.op === "create_file" || s?.op === "apply_patch" || s?.op === "delete_file")
        ? `${String(s?.op || "")}:${String(s?.path || s?.args?.path || "")}`
        : null;
    const seenEdit = new Set();
    let revisions = 0;
    for (const step of stepArr) {
        const key = editKey(step);
        if (!key) continue;
        if (seenEdit.has(key)) revisions += 1;
        else seenEdit.add(key);
    }

    let recoveryCount = 0;
    for (let i = 0; i < stepArr.length; i += 1) {
        const current = stepArr[i];
        if (current && current.ok === false) {
            const key = opKey(current);
            const recovered = stepArr.slice(i + 1).find((later) => later && opKey(later) === key && later.ok === true);
            if (recovered) recoveryCount += 1;
        }
    }

    const totalMs = r.startedAt != null && r.completedAt != null
        ? Math.max(0, Number(r.completedAt) - Number(r.startedAt))
        : null;
    const ttfp = firstAfter(r.startedAt, r.actions || [], (a) => a?.kind === "write" && a?.status === "executed");
    const ttfe = firstAfter(r.startedAt, tests, (t) => t.ok === true);
    const turnMs = r.turnCount > 0 && totalMs != null ? totalMs / r.turnCount : null;

    const capTurns = Number(r.budget?.maxTurns) || null;
    const capActions = Number(r.budget?.maxActions) || null;
    const budgetUsed = {
        turns: r.turnCount,
        actions: r.actionCount,
        transcriptChars: r.transcriptChars,
        overTurns: capTurns != null ? r.turnCount >= capTurns : null,
        overActions: capActions != null ? r.actionCount >= capActions : null,
        haltedByBudget: r.phase === "budget_halted",
    };

    const promptTokens = Number(r.usage?.promptTokens) || 0;
    const completionTokens = Number(r.usage?.completionTokens) || 0;

    return {
        completion: {
            phase: r.phase,
            done: TERMINAL_OK.has(r.phase),
            haltReason: r.haltReason || null,
            ok: TERMINAL_OK.has(r.phase) && (goldenOk || (r.golden?.ok == null && !r.golden?.checks?.length)),
        },
        correctness: {
            goldenOk,
            goldenChecksTotal: (r.golden?.checks || []).length,
            goldenChecksPassed: (r.golden?.checks || []).filter((c) => c.ok === true).length,
            patchSeen: patchSeen > 0,
            changedFiles: changedFiles(r.diff),
            testsRun,
            testsPassed,
            testsAllPassed: testsRun > 0 && testsPassed === testsRun,
        },
        latency: {
            totalMs,
            ttfpMs: ttfp,
            ttfeMs: ttfe,
            turnMs,
            startedAt: r.startedAt,
            completedAt: r.completedAt,
        },
        effort: {
            turns: r.turnCount,
            actions: r.actionCount,
            reads,
            writes,
            execs,
            verifies: verifySteps + execSteps,
            approvals: approves,
            approvalsRequested: countSteps(r.actions || [], (a) => a?.status === "approved" || a?.status === "requested" || a?.status === "denied"),
            recoveryCount,
            reflectionSteps: recoveryCount,
            revisions,
            transcriptChars: r.transcriptChars,
            budgetUsed,
        },
        safety: {
            execDenied: deniedExec,
            actionDenied: deniedActions,
            approvalsDenied,
            mainClean: r.diff ? r.diff.mainClean !== false : null,
            worktreeLeftOver: r.diff ? r.diff.mainClean === false : null,
        },
        cost: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            costUsd: Number(r.usage?.costUsd) || 0,
            usageSource: r.usage?.source || "scripted",
        },
        efficiency: {
            actionsToFirstPatch: r.actions ? r.actions.findIndex((a) => a?.kind === "write" && a?.status === "executed") + 1 : 0,
            patchBytes: r.diff?.patchBytes ?? null,
            bytesPerAction: patchSeen > 0 && r.actionCount > 0 ? Math.round((r.diff?.patchBytes || 0) / r.actionCount) : null,
        },
        retrieval: {
            consulted: r.retrieval?.consulted === true,
            hits: Number(r.retrieval?.hits) || 0,
        },
    };
}
