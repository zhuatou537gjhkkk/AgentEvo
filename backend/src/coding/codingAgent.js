/**
 * Phase 7 / R2 — CodeAgentService: a bounded, resumable coding loop.
 *
 * The MVP "Local Coding Agent" turn: context → plan → action → observe →
 * verify → summary, with hard budgets on turns / actions / wall-clock /
 * transcript size / repeated failure. It is the graph-side seam that the main
 * Graph's `code_agent` node (a thin adapter) calls when a request is an
 * explicit, server-verified coding run. It drives ops through the SAME
 * owner-scoped run surface as the run endpoints
 * (CodingRunWorkspaceRunner.runOp / resumeApproved), so every side effect lands
 * in the run's disposable worktree and is recorded as an action/approval/
 * artifact — nothing here touches the filesystem or the main checkout.
 *
 * Decision layer is INJECTED (`decide`), which keeps the loop deterministic and
 * LLM-agnostic: the tests drive it with a scripted decider; a real model-tool
 * harness supplies it later. The loop is resumable: when an op requires an
 * owner decision it stops at `awaiting_approval` with the pending action;
 * whoever decides (owner UI or a live turn) resumes with the identical op/args
 * via `resumeApproved`, then calls `run()` again. The atomic claim in the
 * approval service guarantees a resume never duplicates the side effect.
 *
 * Result shape stays graph-compatible: `{ codeResults, planResults, subTasks,
 * plan, tokenUsage }` so the main Synthesizer merges it exactly like the
 * text-only code node.
 */
import { codingError, requireCodingScope } from "./util.js";
import { defaultRunWorkspaceRunner } from "./runWorkspaceRunner.js";
import { defaultRunService } from "./runs.js";
import { defaultApprovalService } from "./approvals.js";
import { codingWorkspaceEnabled, codingWriteToolsEnabled, codingBatchReadsEnabled, projectRagReuseEnabled } from "./flags.js";
import { defaultProjectService } from "./projects.js";
import { defaultOpScheduler } from "./opScheduler.js";
import { pushReadObservation } from "./observationFeed.js";

const CODE_BUDGET_DEFAULTS = Object.freeze({
    maxTurns: 8,            // decider calls before the loop halts
    maxActions: 24,         // executed ops (read+write+exec) per session
    maxWallMs: 5 * 60 * 1000, // hard wall-clock ceiling
    maxTranscriptChars: 24 * 1024, // transcript summary bound (never file content)
    maxRepeatedFailure: 2,  // same op+args failing twice → halt (bounded retry)
    maxVerifyRuns: 3,       // how many times the session may re-run a verify op
});

function clampBudget(budget = {}) {
    // The server resolver may intentionally return `budget: null` when no
    // per-run override is configured. Treat null like the omitted value so the
    // bounded coding loop always starts with safe defaults.
    const source = budget ?? {};
    const out = { ...CODE_BUDGET_DEFAULTS };
    for (const key of Object.keys(CODE_BUDGET_DEFAULTS)) {
        const value = source[key];
        if (Number.isFinite(value)) out[key] = Math.max(1, Math.trunc(value));
    }
    return out;
}

/** op + args → a stable signature for repeated-failure detection. */
function opSignature(op, args) {
    return `${String(op)}:${String(args?.path || args?.executable || args?.cwdRelative || "")}`;
}

function newStepId(stepIndex) {
    return `step_${String(stepIndex + 1).padStart(2, "0")}`;
}

// A server-side completion guard for the simplest explicit mutation request.
// This is intentionally independent of the LLM decider: a premature `done`
// response must never make a create-file task look successful without a write.
function requiredFileWrite(goal, steps) {
    const text = String(goal || "");
    if (!/(创建|新建|新增|create|添加).*(文件|file)/i.test(text)) return null;
    const pathMatch = text.match(/[`「“\"]([^`」”\"]+)[`」”\"]/)
        || text.match(/文件\s+([\w./-]+)(?=[，,。\s]|$)/i);
    const contentMatch = text.match(/(?:(?:只)?写入(?:一行)?|内容(?:为|是)?|content\s*[:：])\s*[:：]?\s*[`「“"]([^`」”"]+)[`」”"]/i)
        || text.match(/(?:(?:只)?写入(?:一行)?|内容(?:为|是)?|content\s*[:：])\s*[:：]?\s*([^。\n]+?)(?=。|$)/i);
    if (!pathMatch || !contentMatch) return null;
    const hasWrite = (steps || []).some((step) => step?.ok === true && ["write_file", "create_file", "apply_patch"].includes(String(step.op)));
    // "创建一个文件 X" targets a BRAND-NEW path — the runner rejects write_file on a
    // missing target ("write_file requires an existing file"), so a create intent
    // must emit create_file or the guard would fail every turn until budget_halted.
    return hasWrite ? null : { op: "create_file", args: { path: pathMatch[1].trim(), content: `${contentMatch[1]}\n` }, note: "落实用户要求创建文件" };
}

export class CodeAgentService {
    /**
     * @param {object} [deps]
     */
    constructor({
        runRunner = defaultRunWorkspaceRunner,
        runService = defaultRunService,
        approvals = defaultApprovalService,
        opScheduler = defaultOpScheduler,
        retrieval = null,
    } = {}) {
        this.runRunner = runRunner;
        this.runService = runService;
        this.approvals = approvals;
        // R3 batch-reads scheduler (opScheduler.js). It is a NO-OP seam unless the
        // decider emits a multi-op `ops` decision AND CODING_BATCH_READS is enabled —
        // the single-op loop path never consults it, so the default stays sequential.
        this.opScheduler = opScheduler || null;
        // Phase 7 / R4 (roadmap #8) — SHARED project-code retrieval seam. A NO-OP
        // by default: unless an owner injects a real `retrieval` service AND
        // CODING_RAG_REUSE_ENABLED is on, every decider ctx sees `retrievalEnabled:
        // false` and `retrieval: null`, so the production singleton (constructed with
        // no deps) behaves byte-for-byte as before.
        this.retrieval = retrieval || null;
    }

    /** R4 gate: reuse only engages when a retrieval service was injected AND the flag is ON. */
    _retrievalReuseEnabled() {
        return this.retrieval != null && projectRagReuseEnabled();
    }

    /** R3 gate: batching only engages when a scheduler is present AND the flag is ON. */
    _batchReadsEnabled() {
        return this.opScheduler != null && codingBatchReadsEnabled();
    }

    /**
     * Begin a bounded coding session. The session object is plain in-memory
     * state owned by the caller (a /chat node turn or a test); run/resume step
     * through it and produce graph-compatible partial results when done.
     *
     * @param {object} scope authenticated owner scope
     * @param {object} spec
     * @param {object} spec.run owner-scoped coding run record
     * @param {object} spec.project owner-scoped coding project record
     * @param {string} spec.goal the user's coding goal
     * @param {Function} spec.decide decision layer:
     *   `async (ctx) => ({type:"op", op, args, note?})`
     *                     run one workspace op (read immediate; write/exec may pause)
     *   `async (ctx) => ({type:"verify", op, args})`
     *                     run an op whose output is recorded under "verify"
     *   `async (ctx) => ({type:"ops", ops:[{op, args?, note?}], note?})`
     *                     run several ops in one turn. When the session has an
     *                     opScheduler AND CODING_BATCH_READS is enabled AND every
     *                     op in the set is a read, independent reads share a wave
     *                     and run in parallel; a set containing any write/exec/verify
     *                     (or batching off) executes each op sequentially through the
     *                     same per-op machinery (a write may still pause for approval).
     *   `async (ctx) => ({type:"note", text})` append a step note
     *   `async (ctx) => ({type:"done", summary})` finish
     *   ctx = { goal, steps: [{type, op?, note?, ok?, summary?, at}], stepIndex }
     * @param {object} [spec.budget]
     * @param {(evt: object) => void} [spec.onEvent]
     * @returns {object} session
     */
    begin(scope, { run, project, goal, decide, budget = {}, onEvent = null } = {}) {
        const scoped = requireCodingScope(scope, "codingAgent");
        console.log(`[coding][agent] begin run=${String(run?.id || "")} goal=${JSON.stringify(String(goal || "").slice(0, 160))} decider=${typeof decide}`);
        if (!run?.id) throw codingError("NOT_FOUND", "coding run not found", 404);
        if (!project?.id) throw codingError("NOT_FOUND", "coding project not found", 404);
        if (typeof decide !== "function") {
            throw codingError("CODING_AGENT_NO_DECIDER", "a decide() function is required to run a bounded coding session", 400);
        }
        return {
            scoped,
            scope,
            run,
            project,
            goal: String(goal || ""),
            decide,
            budget: clampBudget(budget),
            onEvent,
            startedAt: Date.now(),
            steps: [],
            pending: null,      // { actionId, op, args } when awaiting_owner_decision
            phase: "running",   // running | awaiting_owner_decision | done | budget_halted | failed
            haltReason: null,
            failureCounts: new Map(), // opSignature → consecutive failures
            actionCount: 0,
            turnCount: 0,
            transcriptChars: 0,
            summary: null,
            finalResult: null,
            // R5 — in-memory read observation feed (observationFeed.js). Lets a real
            // LLM decider see recent read content. NEVER durable / never in steps /
            // never in transcriptChars — only surfaced via ctx.observations.
            observations: [],
        };
    }

    _emit(session, evt) {
        if (typeof session.onEvent === "function") session.onEvent(evt);
    }

    /**
     * R5 — refresh the in-memory run snapshot from the run service after a write
     * auto-provisioned (or otherwise mutated) the worktree. `capabilityRoot`
     * (worktrees.js) decides "main vs worktree" purely from the run object it is
     * handed, so a stale `session.run` captured at begin() would keep reads pinned
     * to the main checkout even after the worktree exists.
     */
    _refreshRunState(session) {
        try {
            if (!this.runService || typeof this.runService.getRun !== "function") return;
            if (!session?.run?.id) return;
            const fresh = this.runService.getRun(session.scope, session.run.id);
            if (fresh) session.run = fresh;
        } catch {
            // stub/offline runs (tests without a real run service row) → no-op.
        }
    }

    _appendStep(session, step) {
        session.steps.push({ at: new Date().toISOString(), ...step });
        const text = step.note || step.summary || step.op || step.type || "";
        session.transcriptChars += Buffer.byteLength(String(text), "utf8");
    }

    _checkBudgets(session, step) {
        if (session.actionCount >= session.budget.maxActions) {
            session.phase = "budget_halted";
            session.haltReason = "maxActions";
        } else if (session.turnCount >= session.budget.maxTurns) {
            session.phase = "budget_halted";
            session.haltReason = "maxTurns";
        } else if (Date.now() - session.startedAt > session.budget.maxWallMs) {
            session.phase = "budget_halted";
            session.haltReason = "maxWallMs";
        } else if (session.transcriptChars > session.budget.maxTranscriptChars) {
            session.phase = "budget_halted";
            session.haltReason = "transcriptChars";
        } else if (step && step.ok === false) {
            const signature = opSignature(step.op, step.args);
            const failures = (session.failureCounts.get(signature) || 0) + 1;
            session.failureCounts.set(signature, failures);
            if (failures >= session.budget.maxRepeatedFailure) {
                session.phase = "budget_halted";
                session.haltReason = "repeatedFailure";
            }
        }
    }

    /**
     * Advance the session until it needs an owner decision, halts on a budget,
     * fails, or completes. Idempotent re-entry: after an external resume, call
     * `run(session)` again to keep stepping from where it stopped.
     *
     * @returns {Promise<object>} a status snapshot: { phase, pending?, result? }
     */
    async run(session) {
        if (!session || session.phase === "done" || session.phase === "failed") {
            return this._snapshot(session);
        }
        session.phase = "running";
        while (session.phase === "running") {
            session.turnCount += 1;
            this._checkBudgets(session);
            if (session.phase !== "running") break;

            const context = this._ctx(session);
            const requiredWrite = requiredFileWrite(session.goal, session.steps);
            console.log(`[coding][agent] turn=${session.turnCount} requiredWrite=${requiredWrite ? "yes" : "no"} steps=${session.steps.length}`);
            const decision = requiredWrite
                ? { type: "op", ...requiredWrite }
                : await session.decide(context);
            if (!decision || typeof decision !== "object") {
                session.phase = "failed";
                session.haltReason = "invalidDecision";
                break;
            }
            const { type, summary } = decision;

            if (type === "done") {
                session.summary = String(summary || "").slice(0, session.budget.maxTranscriptChars);
                session.phase = "done";
                session.finalResult = this._toGraphResult(session);
                this._emit(session, { type: "session.done", summary: session.summary });
                break;
            }
            if (type === "note") {
                this._appendStep(session, { type: "note", note: String(decision.text || "") });
                continue;
            }
            if (type === "op" || type === "verify") {
                const advanced = await this._executeOpDecision(session, {
                    type,
                    op: decision.op,
                    args: decision.args || {},
                    note: decision.note || null,
                });
                if (!advanced) break; // paused for decision / halted
                continue;
            }
            // R3 — multi-op decision (see decide() JSDoc). Sequential by default; the
            // parallel read path only engages when CODING_BATCH_READS is enabled.
            if (type === "ops") {
                const batch = Array.isArray(decision.ops) ? decision.ops : [];
                const entries = batch.filter((e) => e && typeof e === "object" && typeof e.op === "string");
                if (entries.length !== batch.length) {
                    session.phase = "failed";
                    session.haltReason = "invalidDecision";
                    break;
                }
                const canBatch = entries.length > 0
                    && this._batchReadsEnabled()
                    && entries.every((e) => this.opScheduler.classifyOp(e.op) === "read");
                if (canBatch) {
                    await this._executeReadBatch(session, entries, decision.note || null);
                    if (session.phase !== "running") break;
                    continue;
                }
                // Batching off, or a write/exec/verify in the set → sequential executor.
                let proceeded = true;
                for (const entry of entries) {
                    const kind = entry.kind === "verify" || entry.type === "verify" ? "verify" : "op";
                    const advanced = await this._executeOpDecision(session, {
                        type: kind,
                        op: entry.op,
                        args: entry.args || {},
                        note: entry.note || decision.note || null,
                    });
                    if (!advanced) {
                        proceeded = false;
                        break;
                    }
                }
                if (!proceeded) break;
                continue;
            }
            session.phase = "failed";
            session.haltReason = "invalidDecision";
            break;
        }
        return this._snapshot(session);
    }

    /**
     * Resume a session that stopped at `awaiting_owner_decision`. The caller
     * re-supplies the identical op/args (never reconstructed from the redacted
     * durable row) and the run-scoped runner's atomic claim executes the action
     * at most once, then the loop keeps going.
     *
     * @returns {Promise<object>} status snapshot after continuing to the next stop.
     */
    async resume(session, { op, args } = {}) {
        const pending = session?.pending;
        if (!pending) return this._snapshot(session);
        const request = { op: op || pending.op, args: args || pending.args };
        const resumed = await this.runRunner.resumeApproved(session.scope, {
            run: session.run,
            project: session.project,
            request,
            actionId: pending.actionId,
        });
        session.actionCount += 1;
        this._appendStep(session, {
            type: "op",
            op: request.op,
            note: "resumed after owner approval",
            ok: resumed?.status === "executed",
        });
        this._emit(session, { type: "action.resumed", actionId: pending.actionId, status: resumed?.status });
        session.pending = null;
        session.phase = "running";
        return this.run(session);
    }

    async _executeOp(session, op, args, kind) {
        const { scope, run, project } = session;
        let outcome;
        try {
            outcome = await this.runRunner.runOp(scope, {
                run,
                project,
                request: { op, args },
                opts: { wait: false }, // never block a server turn: pause for a decision instead
            });
        } catch (error) {
            // A rejected/denied/broken op is a bounded step failure, not a fatal one:
            // the decision layer sees ok:false (and repeated failures trip a budget).
            const errorCode = error?.code || "EXECUTION_FAILED";
            this._emit(session, { type: "op.rejected", op, errorCode });
            return { effect: "write", op, ok: false, errorCode };
        }
        session.actionCount += 1;

        // Reads execute immediately and are "observed".
        if (outcome?.effect === "read") {
            this._emit(session, { type: "op.observed", op, path: args.path || null });
            // R5 — capture a bounded, in-memory snippet so a real LLM decider can
            // see what it read. runOp returns {ok,effect,op,data} where `data` IS
            // the read payload (readRunner.js / git.js shapes). Never durable.
            session.observations = pushReadObservation(session.observations || [], {
                op,
                args,
                data: outcome.data,
            });
            return { effect: "read", op, ok: outcome.ok !== false };
        }
        // Write/exec: executed right away when server policy auto-approved.
        if (outcome?.status === "executed") {
            this._emit(session, {
                type: "action.executed",
                actionId: outcome.action?.id || null,
                artifactId: outcome.artifact?.id || null,
                op,
            });
            // A trusted write auto-provisions the run worktree on first use; refresh
            // the run snapshot so later reads (capabilityRoot) target the worktree
            // and can actually see the change just written.
            this._refreshRunState(session);
            return { effect: "write", op, ok: true, kind };
        }
        // Owner decision required → pause the loop with the pending action.
        if (outcome?.status === "awaiting_approval") {
            session.pending = { actionId: outcome.action.id, op, args };
            session.phase = "awaiting_owner_decision";
            this._emit(session, {
                type: "approval_requested",
                runId: String(run.id),
                approvalId: outcome.approval?.id || null,
                actionId: outcome.action.id,
                op,
            });
            return { effect: "write", op, ok: false, awaiting: true };
        }
        // settle/denied/other — surface the errorCode if present.
        const errorCode = outcome?.errorCode || outcome?.action?.errorCode;
        this._emit(session, { type: "op.rejected", op, errorCode });
        return { effect: "write", op, ok: false, errorCode: errorCode || "EXECUTION_NOT_RUN" };
    }

    /**
     * Record a single op outcome as a step (identical step shape for both the
     * sequential loop and the parallel read batch) and run the budget check.
     */
    _recordOpStep(session, op, note, outcome, kind = "op") {
        const step = {
            type: outcome.effect === "read" || kind === "op" ? "op" : "verify",
            op,
            note: note || null,
        };
        // Stamp a definitive ok flag on EVERY executed step. Completion guards
        // (requiredFileWrite here, inferRequiredFileWrite in llmDecider) treat a
        // step with no `ok` as "not done" — so an executed write used to look
        // unfinished and the create-file guard re-fired the SAME write every turn
        // until the turn budget halted the session (budget_halted / maxTurns).
        // Executed/observed → ok:true; awaiting owner decision or rejected/errored
        // → ok:false.
        if (outcome.errorCode) {
            step.ok = false;
            step.errorCode = outcome.errorCode;
        } else if (outcome.awaiting === true || outcome.ok === false) {
            step.ok = false;
        } else {
            step.ok = true;
        }
        this._appendStep(session, step);
        this._checkBudgets(session, step);
    }

    /** Run ONE op decision through the sequential machinery. Returns false when the
     * loop must stop (paused on approval, budget-halted, or failed). */
    async _executeOpDecision(session, { type, op, args = {}, note = null }) {
        const outcome = await this._executeOp(session, op, args, type);
        if (session.phase !== "running") return false; // paused for decision / halted
        this._recordOpStep(session, op, note, outcome, type);
        return true;
    }

    /**
     * R3 — execute an all-read batch. The scheduler partitions the reads into waves;
     * reads that share a wave (disjoint targets, within readConcurrency) dispatch
     * concurrently through the SAME `_executeOp` used by the sequential loop, so
     * action accounting, events and budget checks stay identical. Steps are appended
     * in original op order (wave order is a stable partition).
     */
    async _executeReadBatch(session, entries, note) {
        const descriptors = entries.map((e) => ({ op: e.op, args: e.args || {}, note: e.note || note || null }));
        const { waves } = this.opScheduler.plan(descriptors, { readBatch: true });
        for (const wave of waves) {
            const outcomes = await Promise.all(
                wave.map(async (entry) => ({ entry, outcome: await this._executeOp(session, entry.op, entry.args, "op") })),
            );
            for (const { entry, outcome } of outcomes) {
                this._recordOpStep(session, entry.op, entry.note, outcome, "op");
                if (session.phase !== "running") return; // halted mid-batch; stop
            }
        }
    }

    _ctx(session) {
        return {
            goal: session.goal,
            stepIndex: session.steps.length,
            turn: session.turnCount,
            steps: session.steps.map((s) => ({
                type: s.type,
                op: s.op || null,
                ok: s.ok ?? null,
                errorCode: s.errorCode || null,
                note: s.note || s.summary || null,
            })),
            // Phase 7 / R4 (roadmap #8) — shared project-code retrieval surfaced to
            // the decider. Additive + default-NULL: with no injected retrieval (or
            // flag OFF) ctx carries the exact same keys as before plus retrieval:null
            // / retrievalEnabled:false, which no legacy decider reads.
            projectId: session.scope?.projectId ?? session.project?.id ?? null,
            retrieval: this.retrieval,
            retrievalEnabled: this._retrievalReuseEnabled(),
            // R5 — recent read-op content (observationFeed.js), rendered to bounded
            // text snippets. Top-level only: never folded into steps/transcript.
            observations: Array.isArray(session.observations) ? [...session.observations] : [],
        };
    }

    _snapshot(session) {
        return {
            phase: session.phase,
            haltReason: session.haltReason || null,
            pending: session.pending ? { actionId: session.pending.actionId, op: session.pending.op } : null,
            result: session.phase === "done" ? session.finalResult : null,
            turnCount: session.turnCount,
            actionCount: session.actionCount,
            summary: session.summary || null,
        };
    }

    /**
     * Graph-compatible partial result: the Synthesizer merges `codeResults`
     * text plus a single completed `subTask` whose result is in `planResults`
     * (Plan mode) — exactly the shape the text-only code node returns.
     */
    _toGraphResult(session) {
        const summaryText = session.summary || session.steps.map((s) => s.note || s.summary || s.op || "").filter(Boolean).join("\n");
        const id = newStepId(0);
        const subTasks = [{
            id,
            title: "coding",
            type: "agent",
            agent: "code",
            status: "completed",
            result: summaryText,
        }];
        return {
            codeResults: summaryText,
            planResults: { [id]: summaryText },
            subTasks,
            plan: [],
            tokenUsage: null,
            summary: summaryText,
            stepCount: session.steps.length,
        };
    }
}

/**
 * Server-side /chat coding-execution gate (roadmap R2: execution is enabled on
 * `/chat` ONLY when an explicit project + coding run + server trust/policy pass).
 *
 * The plain chat text path has no execution capability at all; the only /chat-
 * adjacent execution surface is the graph's `code_agent` coding branch, which is
 * fed a `config.configurable.codingTask` descriptor that THIS function authorises.
 * The descriptor is never built from client/model intent — only from the run's
 * durable owner-scoped record + the live feature flags. Observe runs and
 * untrusted/terminal projects can never produce a coding execution.
 *
 * @returns {Promise<{active:boolean, reason?:string, scope?:object, run?:object,
 *   project?:object, preset?:string, goal?:string, budget?:object|null}>}
 */
export async function resolveCodingRunTask(
    { runService = defaultRunService, projectService = defaultProjectService } = {},
    scope,
    { runId = null, goal = "", budget = null } = {},
) {
    if (runId == null) return { active: false, reason: "no_run_id" };
    if (!codingWorkspaceEnabled() || !codingWriteToolsEnabled()) {
        return { active: false, reason: "coding_disabled" };
    }
    const scoped = requireCodingScope(scope, "coding gate");
    const run = runService.getRun(scoped, runId);
    if (!run) return { active: false, reason: "run_not_found" };
    const preset = run.preset || run.mode;
    if (preset !== "edit" && preset !== "trusted") return { active: false, reason: "observe" };
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
        return { active: false, reason: "run_terminal" };
    }
    if (!run.projectId) return { active: false, reason: "run_has_no_project" };
    const project = projectService.get(scoped, run.projectId);
    if (!project) return { active: false, reason: "project_not_found" };
    if (String(project.status || "") !== "trusted" || Number(project.trusted) !== 1) {
        return { active: false, reason: "project_not_trusted" };
    }
    return {
        active: true,
        reason: null,
        scope: scoped,
        run,
        project,
        preset,
        goal: String(goal || ""),
        budget: budget || null,
    };
}

export const defaultCodingAgentService = new CodeAgentService();
export default defaultCodingAgentService;
