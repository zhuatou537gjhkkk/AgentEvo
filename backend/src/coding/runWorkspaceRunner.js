/**
 * Phase 7 / R2 — CodingRunWorkspaceRunner: owner-scoped run workspace surface.
 *
 * A run may issue read ops (list/read/search/git) against its disposable worktree
 * (once provisioned) and write/exec ops through the action executor. Reads never
 * need an action row — they are audited in the read runner. Writes/execs ALWAYS
 * create a durable action + approval + artifact transcript and run only inside the
 * run's worktree. Everything is owner-scoped; capability (preset/trust/allowed
 * roots/worktree) is re-resolved at op time.
 *
 * This runner is the single seam both the run-scoped HTTP endpoints and the model
 * adapter (CodeAgentService) call — no route ever reaches the filesystem directly.
 */
import { defaultActionExecutor } from "./actionExecutor.js";
import { defaultWorktreeService } from "./worktrees.js";
import { defaultWorkspaceRunner } from "./runner/readRunner.js";
import { codingError } from "./util.js";
import { isReadOp } from "./runner/protocol.js";

export class CodingRunWorkspaceRunner {
    constructor({
        readRunner = defaultWorkspaceRunner,
        actionExecutor = defaultActionExecutor,
        worktreeManager = defaultWorktreeService,
    } = {}) {
        this.readRunner = readRunner;
        this.actionExecutor = actionExecutor;
        this.worktreeManager = worktreeManager;
    }

    /**
     * Dispatch one run-scoped op. `run`/`project` are owner-scoped records.
     *
     * @param {object} scope authenticated owner scope
     * @param {{ run: object, project: object, request: {op:string, args:object},
     *           opts?: object }} ctx
     * @returns {Promise<object>} read result or action-executor summary
     */
    async runOp(scope, { run, project, request, opts = {} }) {
        if (!run?.id) throw codingError("NOT_FOUND", "coding run not found", 404);
        if (!project?.id) throw codingError("NOT_FOUND", "coding project not found", 404);
        const op = String(request?.op || "");
        if (isReadOp(op)) {
            const cap = this.worktreeManager.capabilityRoot({ project, run });
            // invokeAtRoot targets the resolved root (worktree when ready) and
            // validates read-only dispatch + limits internally.
            const result = await this.readRunner.invokeAtRoot(cap.root, project, op, request.args || {});
            return { ok: true, effect: "read", op: result.op, data: result.data };
        }
        return this.actionExecutor.execute(scope, { run, project, request, opts });
    }

    /**
     * Resume an approved-but-unexecuted action with live args (owner approved while
     * the model turn was paused; reconnect/re-run claims it exactly once).
     */
    resumeApproved(scope, { run, project, request, actionId, opts = {} }) {
        return this.actionExecutor.executeApproved(scope, { run, project, request, actionId, opts });
    }
}

export const defaultRunWorkspaceRunner = new CodingRunWorkspaceRunner();
export default defaultRunWorkspaceRunner;
