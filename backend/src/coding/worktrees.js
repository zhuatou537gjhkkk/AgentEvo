/**
 * Phase 7 / R2 — CodingWorktreeService: disposable git-worktree lifecycle.
 *
 * The R2 execution rule is that NOTHING the model asks for ever mutates the main
 * checkout. A write-enabled run (`edit`/`trusted`) is provisioned with its own
 * disposable worktree + branch created from a recorded base commit/branch, so:
 *
 *   - every write/command side effect lands in an isolated working tree that the
 *     owner can throw away wholesale (teardown = `git worktree remove` + branch
 *     delete + status `removed`), and
 *   - the diff against the run's base is exactly "what this run changed".
 *
 * Worktree paths are SERVER-decided and recorded on the coding_runs row
 * (worktree_path/branch/base_branch/base_commit/worktree_status). A client/model
 * never supplies a worktree location. Non-git roots (or a root that is a git
 * subdirectory rather than the repository top level) are recorded as
 * `unsupported` and the run stays read-only on the main checkout — R2 MVP does
 * not invent a half-git execution environment.
 *
 * Worktree lifecycle statuses (coding_runs.worktree_status):
 *   none → provisioning → ready (git worktree add ok; base identity recorded)
 *                       → unsupported (not a repo top level / no HEAD)
 *                       → failed (provisioning error → WORKTREE_PROVISION_FAILED)
 *   ready → removed (teardown ok — dir gone + branch deleted)
 * Provisioning is a server capability decision: it only ever runs for a
 * write-enabled run whose project is trusted and within the allowed roots, all
 * re-validated at call time.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codingError, nowSql, requireCodingScope } from "./util.js";
import { runGit, gitRepoInfo } from "./runner/git.js";
import { canonicalExisting, isPathWithin, resolveProjectRoot } from "./runner/pathSecurity.js";
import { normalizePreset } from "./presets.js";
import defaultEventStore from "./events.js";
import defaultRunService from "./runs.js";

let baseOverride = null; // test-only: absolute directory string

export function setWorktreeBaseOverride(dir) {
    baseOverride = dir ? String(dir) : null;
}

export function clearWorktreeBaseOverride() {
    baseOverride = null;
}

/** Server-decided base directory for disposable worktrees. */
export function configuredWorktreeBase() {
    const raw = String(baseOverride || process.env.CODING_WORKTREE_BASE || "").trim();
    return raw || path.join(os.tmpdir(), "agentevo-worktrees");
}

function runSubdir(scope, project, run) {
    const { userId, tenantId } = requireCodingScope(scope, "worktree");
    return path.join(configuredWorktreeBase(), `u${userId}`, `${tenantId.replace(/[^a-zA-Z0-9_-]/g, "_")}`, String(project.id), String(run.id));
}

/** Canonicalize a path if it exists as a directory, else null. */
function canonicalDir(p) {
    try {
        const st = fs.statSync(p);
        if (!st.isDirectory()) return null;
        return fs.realpathSync(p);
    } catch {
        return null;
    }
}

async function repoBaseIdentity(repoRoot) {
    const info = await gitRepoInfo(repoRoot);
    return { isRepo: info.isRepo, toplevel: info.toplevel, baseBranch: info.branch, baseCommit: info.commit };
}

export class CodingWorktreeService {
    /**
     * @param {object} [options]
     * @param {object} [options.runService] owner-scoped run service (default singleton)
     * @param {object} [options.eventStore] durable run event log (default singleton)
     */
    constructor({ runService = defaultRunService, eventStore = defaultEventStore } = {}) {
        this.runService = runService;
        this.eventStore = eventStore;
    }

    _append(scope, runId, event) {
        try {
            this.eventStore.appendEvent(scope, runId, event);
        } catch {
            // Event log is observational; a failed append never aborts a mutation.
        }
    }

    _writePreset(run) {
        return normalizePreset(run?.preset || run?.mode);
    }

    /**
     * Provision the run's disposable worktree from the project's current HEAD.
     * Idempotent: a run whose worktree is already `ready` (path still present) is
     * returned untouched. Non-git / subdirectory / unborn-HEAD roots are recorded
     * `unsupported` (read-only MVP, NOT an error). Real provisioning failures throw
     * WORKTREE_PROVISION_FAILED after recording status `failed`.
     *
     * Only write-enabled presets provision; an `observe` run returns unchanged.
     *
     * @returns {Promise<object>} the refreshed run record (may carry unsupported).
     */
    async provision(scope, { project, run }) {
        const scoped = requireCodingScope(scope, "worktree");
        const runId = String(run?.id || "");
        if (!runId || !project?.id) {
            throw codingError("RUN_REQUIRES_PROJECT", "a write-enabled run needs an owned project", 400);
        }
        const preset = this._writePreset(run);
        if (preset === "observe") return run;

        if (run.worktreeStatus === "ready" && run.worktreePath) {
            const live = canonicalDir(run.worktreePath);
            if (live) return run; // already provisioned and live
        }

        // Capability re-resolution at access time: trust + allowed-roots + existence.
        const repoRoot = resolveProjectRoot(project);

        this.runService.updateWorktreeStatus(scoped, runId, "provisioning");

        const { isRepo, toplevel, baseBranch, baseCommit } = await repoBaseIdentity(repoRoot);
        const topLevelOk = toplevel
            && process.platform === "win32"
                ? toplevel.toLowerCase() === repoRoot.toLowerCase()
                : toplevel === repoRoot;
        if (!isRepo || !topLevelOk || !baseCommit) {
            // Non-git / subdirectory / empty-repo: read-only MVP (roadmap R2). This is
            // a recorded capability fact, not an error — the run proceeds read-only.
            this.runService.updateWorktreeStatus(scoped, runId, "unsupported");
            this._append(scoped, runId, { type: "run.worktree_unsupported", payload: { reason: baseCommit ? "not_top_level" : "no_head_or_non_git" } });
            return this.runService.getRun(scoped, runId);
        }

        const worktreePath = runSubdir(scoped, project, run);
        const worktreeBranch = `coding/run-${runId}`;
        try {
            await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
            // Clean any stale leftover at the target path (crash mid-add, prior retry).
            if (canonicalExisting(worktreePath)) {
                await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath], { timeoutMs: 30_000 });
                await fs.promises.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
            }
            const addArgs = ["worktree", "add", "-b", worktreeBranch, worktreePath, baseCommit];
            const added = await runGit(repoRoot, addArgs, { timeoutMs: 60_000, maxBytes: 256 * 1024 });
            if (added.code !== 0) {
                throw codingError(
                    "WORKTREE_PROVISION_FAILED",
                    `git worktree add failed: ${String(added.stderr || "unknown").slice(0, 200)}`,
                    422,
                );
            }
        } catch (error) {
            const already = error?.code === "WORKTREE_PROVISION_FAILED" ? error : null;
            try {
                this.runService.updateWorktreeStatus(scoped, runId, "failed");
            } catch {
                /* run may have been cancelled mid-provision; keep original error */
            }
            this._append(scoped, runId, { type: "run.worktree_failed", payload: { code: already?.code || error?.code || "WORKTREE_PROVISION_FAILED" } });
            throw already || codingError("WORKTREE_PROVISION_FAILED", `worktree provisioning failed: ${String(error.message).slice(0, 200)}`, 422);
        }

        this.runService.setWorktree(scoped, runId, {
            path: worktreePath,
            branch: worktreeBranch,
            baseBranch: baseBranch || null,
            baseCommit: baseCommit.slice(0, 40),
            status: "ready",
            provisionedAt: nowSql(),
        });
        this._append(scoped, runId, {
            type: "run.worktree_ready",
            payload: { branch: worktreeBranch, baseCommit: baseCommit.slice(0, 40) },
        });
        return this.runService.getRun(scoped, runId);
    }

    /**
     * Resolve the run-scoped canonical root for workspace ops. `worktree` when the
     * disposable worktree is live (all reads/writes after provisioning); otherwise
     * `main` (read-only project checkout — an unsupported/failed/none worktree can
     * never be written). Caller decides the op's allowed effects from the preset.
     *
     * @returns {{ mode: "worktree"|"main", root: string }}
     */
    capabilityRoot({ project, run }) {
        if (!project) throw codingError("NOT_FOUND", "coding project not found", 404);
        if (run?.worktreeStatus === "ready" && run.worktreePath) {
            const live = canonicalDir(run.worktreePath);
            if (live) return { mode: "worktree", root: live };
        }
        // Main-checkout reads are safe (no side effect); resolveProjectRoot still
        // enforces trust/allowed-roots so a demoted project is never readable.
        return { mode: "main", root: resolveProjectRoot(project) };
    }

    /**
     * Tear down the run's disposable worktree: `git worktree remove --force`,
     * prune, then delete the run branch. Best-effort — a teardown failure never
     * throws; the status is only advanced to `removed` when the worktree is gone.
     * The main checkout is never mutated (worktree remove does not touch it).
     *
     * @returns {Promise<object>} refreshed run record.
     */
    async teardown(scope, { project, run }) {
        const scoped = requireCodingScope(scope, "worktree");
        const runId = String(run?.id || "");
        if (!runId) throw codingError("NOT_FOUND", "coding run not found", 404);
        if (run.worktreeStatus === "removed" || run.worktreeStatus === "none" || run.worktreeStatus === "unsupported") {
            return run; // nothing provisioned → nothing to remove
        }

        const worktreePath = run.worktreePath ? String(run.worktreePath) : "";
        const worktreeBranch = run.worktreeBranch ? String(run.worktreeBranch) : "";

        // Defense: only ever remove a path that is (a) under our base and (b) the
        // recorded run directory — never something a tampered row could point at.
        const base = path.resolve(configuredWorktreeBase());
        const recorded = runSubdir(scoped, { id: run.projectId }, { id: runId });
        const safeToRemove = worktreePath
            && isPathWithin(base, worktreePath)
            && path.resolve(worktreePath) === path.resolve(recorded);

        let repoRoot = null;
        try {
            if (project?.id) repoRoot = resolveProjectRoot(project);
        } catch {
            repoRoot = null; // project revoked/gone → still best-effort fs cleanup below
        }

        if (repoRoot && safeToRemove && canonicalDir(worktreePath)) {
            await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath], { timeoutMs: 60_000 }).catch(() => {});
            await runGit(repoRoot, ["worktree", "prune"], { timeoutMs: 30_000 }).catch(() => {});
            if (worktreeBranch.startsWith("coding/run-")) {
                await runGit(repoRoot, ["branch", "-D", worktreeBranch], { timeoutMs: 30_000 }).catch(() => {});
            }
        }
        if (safeToRemove) {
            await fs.promises.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
        }

        const gone = safeToRemove ? !canonicalDir(worktreePath) : true;
        const nextStatus = gone ? "removed" : run.worktreeStatus;
        const updated = this.runService.setWorktree(scoped, runId, {
            path: run.worktreePath,
            branch: run.worktreeBranch,
            baseBranch: run.baseBranch,
            baseCommit: run.baseCommit,
            status: nextStatus,
            provisionedAt: run.provisionedAt,
        });
        if (gone) {
            this._append(scoped, runId, {
                type: "run.worktree_removed",
                payload: { branch: worktreeBranch || null },
            });
        }
        return updated;
    }
}

export const defaultWorktreeService = new CodingWorktreeService();
export default defaultWorktreeService;
