/**
 * Phase 7 / R2 — CodingActionExecutor: one side-effecting op, fully audited.
 *
 * A write/exec op NEVER touches the filesystem directly from a route or a model
 * tool. It flows through here:
 *
 *   op + args
 *     → effect class (write/exec) from the op
 *     → preset policy at call time (effectivePolicy + feature-flag intersection)
 *     → durable action + approval transcript (requestApproval)
 *     → policy decision: auto (trusted write → [policy:preset]) or
 *       owner decision (approve mode → run waits in waiting_approval until the
 *       owner decides via POST /coding/approvals/:id/decision)
 *     → atomic claim (claimActionExecution: one winner, no double side effects)
 *     → execute against the run's disposable WORKTREE (writeRunner / commandRunner)
 *     → artifact row (digests) + action settlement (executed | failed)
 *
 * Decision ≠ execution: recording an action/approval NEVER runs it. Execution
 * only happens when (a) policy auto-approves, or (b) an owner approved AND the
 * caller holds the live args to execute (the model turn that waited, or an
 * explicit execute request) — an approved row alone is never auto-run.
 *
 * Args are held in memory by the live caller; the durable row stores only a
 * redacted summary (op/path/bytes — never file content, never secrets).
 */
import { createHash } from "node:crypto";
import { codingError, requireCodingScope } from "./util.js";
import { effectivePolicy, writePolicyError, execPolicyError } from "./presets.js";
import { isWriteOp, isExecOp } from "./runner/protocol.js";
import { defaultRunService } from "./runs.js";
import defaultApprovalService from "./approvals.js";
import defaultWorktreeService from "./worktrees.js";
import { defaultWriteRunner } from "./runner/writeRunner.js";
import defaultArtifactService from "./artifacts.js";

const DECISION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min for an owner decision
const DECISION_POLL_MS = 400;
const APPROVAL_AUTO_REASON = "[policy:preset]";

function normalizeStorageRef(run, rel) {
    return `worktree://${run.id}/${rel || ""}`;
}

function sha256Of(text) {
    return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

/** Summary of an op for the durable action row (redacted: never file content). */
function redactedInput(request) {
    const { op, args } = request;
    if (op === "write_file" || op === "create_file") {
        return { op, path: args.path, bytes: Buffer.byteLength(args.content, "utf8") };
    }
    if (op === "delete_file") return { op, path: args.path };
    if (op === "apply_patch") {
        return { op, path: args.path, patchBytes: Buffer.byteLength(args.patch, "utf8"), digest: args.digest || null };
    }
    if (op === "run_command") {
        return { op, executable: args.executable, args: args.args, cwdRelative: args.cwdRelative || "", timeoutMs: args.timeoutMs, outputLimit: args.outputLimit };
    }
    return { op, path: args.path || null };
}

function effectForOp(op) {
    if (isWriteOp(op)) return "write";
    if (isExecOp(op)) return "exec";
    return null;
}

export class CodingActionExecutor {
    /**
     * @param {object} [deps]
     */
    constructor({
        runService = defaultRunService,
        approvals = defaultApprovalService,
        worktreeManager = defaultWorktreeService,
        writeRunner = defaultWriteRunner,
        artifacts = defaultArtifactService,
    } = {}) {
        this.runService = runService;
        this.approvals = approvals;
        this.worktreeManager = worktreeManager;
        this.writeRunner = writeRunner;
        this.artifacts = artifacts;
    }

    _assertRequest(scope, run, project, request) {
        const scoped = requireCodingScope(scope, "action");
        if (!run?.id) throw codingError("NOT_FOUND", "coding run not found", 404);
        if (!project?.id) throw codingError("NOT_FOUND", "coding project not found", 404);
        const effect = effectForOp(request?.op);
        if (!effect) throw codingError("INVALID_WORKSPACE_OP", `op '${request?.op}' is not a write/exec effect`, 400);
        const policy = effectivePolicy(run.preset || run.mode);
        const policyError = effect === "write" ? writePolicyError(policy, effect) : execPolicyError(policy, effect);
        if (policyError) throw policyError;
        return { scoped, effect, policy };
    }

    // Executable policy is enforced at the EXECUTOR (server decision) so an
    // out-of-bounds executable is rejected BEFORE an approval is even requested —
    // the owner is never asked to approve something the server would refuse anyway.
    async _assertExecAllowlisted(request) {
        if (request?.op !== "run_command") return;
        const { configuredCommandAllowlist } = await import("./runner/commandRunner.js");
        const allowed = configuredCommandAllowlist();
        if (!allowed.includes(request.args.executable)) {
            throw codingError("EXEC_NOT_ALLOWLISTED", `executable '${request.args.executable}' is not allowlisted`, 403);
        }
    }

    async _ensureWorktree(scoped, run, project) {
        // Refresh from the durable run record: a caller may hold a STALE run row
        // (e.g. a long-lived agent session fetched it before provisioning). Trusting
        // that stale `worktreeStatus` would re-provision an already-provisioned run
        // and fail (`git worktree add -b <existing-branch>`). The DB is authoritative.
        const current = this.runService.getRun(scoped, run.id) || run;
        let refreshedRun = current;
        if (current.worktreeStatus === "none" || current.worktreeStatus === "provisioning") {
            refreshedRun = await this.worktreeManager.provision(scoped, { project, run: current });
        }
        if (refreshedRun.worktreeStatus === "unsupported") {
            throw codingError("WORKTREE_UNSUPPORTED", "this project root is not a git working tree — writes/commands are not available", 422);
        }
        if (refreshedRun.worktreeStatus !== "ready") {
            throw codingError("WORKTREE_NOT_READY", "worktree is not ready", 409);
        }
        const cap = this.worktreeManager.capabilityRoot({ project, run: refreshedRun });
        if (cap.mode !== "worktree") {
            throw codingError("WORKTREE_NOT_READY", "write/exec requires a provisioned worktree", 409);
        }
        return { run: refreshedRun, root: cap.root };
    }

    /**
     * Execute (or pause for) one write/exec op on a run. `run`/`project` must be
     * owner-scoped records already fetched by the caller.
     *
     * @returns {Promise<{status:"executed"|"awaiting_approval", run:object,
     *   action:object|null, approval:object|null, artifact:object|null, data?:object}>}
     */
    async execute(scope, { run, project, request, opts = {} }) {
        const { scoped, effect, policy } = this._assertRequest(scope, run, project, request);
        await this._assertExecAllowlisted(request);
        const { approvals, runService } = this;
        const runId = String(run.id);
        const op = request.op;

        // Capability: provision the disposable worktree on first need. Main checkout
        // is never written — the worktree requirement is absolute for write/exec.
        const { root } = await this._ensureWorktree(scoped, run, project);

        // Durable transcript: action + approval (redacted input only — content/patch
        // never reaches the row, so a secret written by the model stays out of the DB).
        const { approval, action } = approvals.requestApproval(scoped, runId, {
            type: effect,
            tool: op,
            input: redactedInput(request),
            timeoutMs: opts.decisionTimeoutMs || null,
            policy: { preset: policy.preset, effect, write: policy.write, exec: policy.exec },
            reason: `coding ${effect} op: ${op}`,
            expiresInMs: opts.decisionTimeoutMs || DECISION_TIMEOUT_MS,
        });

        // Auto-approve by server policy (trusted write). The decision is recorded as
        // a policy decision, not the model granting itself permission.
        const auto = effect === "write" ? policy.write === "auto" : policy.exec === "auto";
        if (auto) {
            approvals.decide(scoped, approval.id, {
                approve: true,
                decidedBy: null,
                reason: `${APPROVAL_AUTO_REASON} ${policy.preset} preset write`,
            });
        } else if (!opts.wait) {
            // Approve-mode op but caller is not a live turn: pause cleanly. Decision
            // alone never executes — a later live turn must claim and run it.
            try { runService.waitForApproval(scoped, runId); } catch { /* run already waiting */ }
            return {
                status: "awaiting_approval",
                run: runService.getRun(scoped, runId),
                action,
                approval,
                artifact: null,
            };
        } else {
            // Live turn: surface the approval request, pause run status, then wait.
            try { runService.waitForApproval(scoped, runId); } catch { /* already waiting */ }
            if (typeof opts.onApproval === "function") {
                opts.onApproval({
                    type: "approval_requested",
                    approvalId: approval.id,
                    actionId: action.id,
                    runId,
                    tool: op,
                    effect,
                    policy: policy.preset,
                    summary: redactedInput(request),
                    expiresInMs: opts.decisionTimeoutMs || DECISION_TIMEOUT_MS,
                });
            }
            const verdict = await this._waitForDecision(scoped, runId, approval.id, {
                timeoutMs: opts.decisionTimeoutMs || DECISION_TIMEOUT_MS,
                signal: opts.signal,
            });
            try { runService.resumeRun(scoped, runId); } catch { /* run may have been cancelled */ }
            if (verdict !== "approved") {
                const denial = this._currentDecision(scoped, approval.id);
                throw codingError(
                    denial === "denied" ? "APPROVAL_DENIED" : denial === "expired" ? "APPROVAL_EXPIRED" : "APPROVAL_CANCELLED",
                    denial === "denied" ? "owner denied this action" : "approval is no longer open",
                    409,
                );
            }
        }

        return this._claimAndRun(scoped, { run, project, request, action, approval, root, signal: opts.signal || null });
    }

    /**
     * R2 resume: execute an ALREADY-APPROVED action with live args (the caller
     * re-supplies the identical request; args are never reconstructed from the
     * redacted row). The atomic claim guarantees at-most-once side effects even if
     * two resumes race — a reconnect can never duplicate the work.
     */
    async executeApproved(scope, { run, project, request, actionId, opts = {} }) {
        const { scoped, effect } = this._assertRequest(scope, run, project, request);
        await this._assertExecAllowlisted(request);
        const { approvals } = this;
        const runId = String(run.id);
        const action = approvals.getAction(scoped, actionId);
        if (!action || action.runId !== runId) throw codingError("NOT_FOUND", "action not found for this run", 404);
        if (action.tool !== request.op || action.type !== effect) {
            throw codingError("ACTION_MISMATCH", "approved action does not match the requested op", 409);
        }
        this._assertMatchesApproval(action, request);
        if (action.status === "executed" || action.status === "failed" || action.status === "executing") {
            // Reconnect after a completed/failed action: settle already happened — the
            // side effect ran at most once, and resuming reports that fact idempotently.
            return { status: "executed", run: this.runService.getRun(scoped, runId), action, approval: null, artifact: null, data: { settled: true, state: action.status } };
        }
        if (action.status !== "approved") {
            throw codingError("ACTION_NOT_APPROVED", `action is ${action.status}, not approved`, 409);
        }

        const { root } = await this._ensureWorktree(scoped, run, project);
        return this._claimAndRun(scoped, { run, project, request, action, approval: null, root, signal: opts.signal || null });
    }

    /** Bind the approved record to the exact request being executed (write path parity). */
    _assertMatchesApproval(action, request) {
        const summary = action.input || {};
        if (summary.op !== request.op) {
            throw codingError("ACTION_MISMATCH", "approved action op does not match the request", 409);
        }
        if (request.op === "run_command") {
            if (summary.executable !== request.args.executable) {
                throw codingError("ACTION_MISMATCH", "approved action executable does not match the request", 409);
            }
        } else if (summary.path && summary.path !== request.args.path) {
            throw codingError("ACTION_MISMATCH", "approved action path does not match the request", 409);
        }
    }

    /** Atomic claim + execute + artifact + settle. Exactly one caller wins the claim. */
    async _claimAndRun(scoped, { run, project, request, action, approval, root, signal = null }) {
        const { approvals, runService } = this;
        const runId = String(run.id);
        const claim = approvals.claimActionExecution(scoped, action.id);
        if (!claim.claimed) {
            if (claim.reason === "already_settled") {
                return { status: "executed", run: runService.getRun(scoped, runId), action: approvals.getAction(scoped, action.id), approval, artifact: null, data: { settled: true } };
            }
            throw codingError("ACTION_NOT_EXECUTABLE", `action cannot run (${claim.reason})`, 409);
        }
        try {
            const result = request.op === "run_command"
                ? await this._runCommand(root, request, signal)
                : await this.writeRunner.invoke(root, request);
            const artifact = this._recordArtifact(scoped, runId, action.id, result);
            const settled = approvals.completeAction(scoped, action.id, { ok: true, artifactId: artifact?.id || null });
            return {
                status: "executed",
                run: runService.getRun(scoped, runId),
                action: settled,
                approval: approval ? approvals.getApproval(scoped, approval.id) : null,
                artifact,
                data: result,
            };
        } catch (error) {
            const code = error?.code || "EXECUTION_FAILED";
            approvals.completeAction(scoped, action.id, { ok: false, errorCode: code });
            throw error;
        }
    }

    async _runCommand(root, request, signal = null) {
        const { args } = request;
        const { executeStructuredCommand } = await import("./runner/commandRunner.js");
        let cwd = root;
        if (args.cwdRelative) {
            const { resolveSubpath } = await import("./runner/pathSecurity.js");
            const target = resolveSubpath(root, args.cwdRelative);
            let st;
            try { st = await import("node:fs").then((fs) => fs.promises.stat(target.abs)); } catch {
                throw codingError("WORKSPACE_PATH_NOT_FOUND", "command cwd does not exist", 404);
            }
            if (!st.isDirectory()) throw codingError("PATH_NOT_DIRECTORY", "command cwd is not a directory", 400);
            cwd = target.abs;
        }
        // Allowlist is enforced INSIDE executeStructuredCommand (CODING_COMMAND_ALLOWLIST,
        // fail-closed empty default) — the executor never decides executable policy.
        const result = await executeStructuredCommand({
            cwd,
            executable: args.executable,
            args: args.args,
            timeoutMs: args.timeoutMs,
            outputLimitBytes: args.outputLimit,
            signal,
        });
        // Decorate with the structured identity so the artifact row can audit which
        // command ran (executable/args/cwd), independent of its output bytes.
        return { ...result, executable: args.executable, args: args.args, cwdRelative: args.cwdRelative || "" };
    }

    _recordArtifact(scope, runId, actionId, result) {
        if (!result) return null;
        // File mutations carry a rel path + digests; a command result is recorded
        // as a `command.output` artifact (path null) with an output digest — never
        // the output bytes themselves.
        if (result.path) {
            const meta = { beforeDigest: result.beforeDigest || null };
            return this.artifacts.record(scope, {
                runId,
                actionId,
                kind: result.kind || "file.write",
                path: result.path,
                digest: result.afterDigest || result.beforeDigest || null,
                sizeBytes: result.sizeBytes ?? null,
                storageRef: normalizeStorageRef({ id: runId }, result.path),
                meta,
            });
        }
        if (result.executable) {
            const outText = `${result.stdout || ""}${result.stderr ? (result.stdout ? "\n" : "") + result.stderr : ""}`;
            return this.artifacts.record(scope, {
                runId,
                actionId,
                kind: "command.output",
                path: null,
                digest: outText ? sha256Of(outText) : null,
                sizeBytes: Buffer.byteLength(outText, "utf8"),
                storageRef: `worktree://${runId}/.commands/${String(result.executable)}`,
                meta: {
                    executable: result.executable,
                    args: result.args,
                    cwdRelative: result.cwdRelative || null,
                    exitCode: result.code ?? result.exitCode ?? null,
                    timedOut: result.timedOut === true,
                    cancelled: result.cancelled === true,
                    truncated: result.truncated === true,
                    durationMs: result.durationMs ?? null,
                },
            });
        }
        return null;
    }

    _currentDecision(scope, approvalId) {
        const approval = this.approvals.getApproval(scope, approvalId);
        return approval ? approval.status : "cancelled";
    }

    _waitForDecision(scope, runId, approvalId, { timeoutMs, signal }) {
        return new Promise((resolve) => {
            const started = Date.now();
            const tick = () => {
                if (signal?.aborted) { resolve("cancelled"); return; }
                if (Date.now() - started > timeoutMs) { resolve("expired"); return; }
                const status = this._currentDecision(scope, approvalId);
                if (status === "approved" || status === "denied" || status === "expired" || status === "cancelled") {
                    resolve(status);
                    return;
                }
                setTimeout(tick, DECISION_POLL_MS);
            };
            tick();
        });
    }
}

export const defaultActionExecutor = new CodingActionExecutor();
export default defaultActionExecutor;
