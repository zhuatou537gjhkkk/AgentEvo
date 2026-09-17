/**
 * Phase 7 / R7 — landRunToMain: surface a completed run's disposable-worktree
 * changes onto the REAL project checkout (working tree only, NO commit).
 *
 * R2's rule is that nothing a model asks for ever mutates the main checkout:
 * every write lands in a disposable git worktree created from the project's
 * recorded base commit. That keeps the run fully isolated while it executes,
 * but a *completed* run's output is exactly the diff the owner wants in the
 * real code. This module bridges that gap deliberately, at the owner's
 * explicit request, and only ever via `git apply` on the project working tree:
 *
 *   - the run must be terminal `completed`, owned by the caller, preset NOT
 *     `observe`, with a LIVE disposable worktree (the changes still exist),
 *   - the project is re-resolved through resolveProjectRoot (trust + allowed
 *     roots + existence are all re-checked at apply time),
 *   - the patch is `git diff` of the worktree's staged tree against the run's
 *     base commit — exactly "what this run changed",
 *   - `git apply --check` runs first; any overlap/conflict (main moved ahead,
 *     file already changed/created) REFUSES the whole landing instead of
 *     half-applying. Nothing is committed, nothing is staged on main.
 *
 * Binary changes and oversized patches are refused (no lossy utf8 round-trip).
 * Every successful landing is recorded as a durable `run.landed_main` event.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { codingError, requireCodingScope } from "./util.js";
import { runGit, gitRepoInfo } from "./runner/git.js";
import { resolveProjectRoot } from "./runner/pathSecurity.js";
import { normalizePreset } from "./presets.js";
import defaultEventStore from "./events.js";

/** Landing refuses patches larger than this (defense against runaway runs). */
const LAND_MAX_PATCH_BYTES = 32 * 1024 * 1024;
/** Landing must be requested on an explicit, completed run. */
const TERMINAL_COMPLETED = "completed";

/** Canonicalize a directory path if it exists and is a directory, else null. */
function canonicalDir(p) {
    try {
        const st = fs.statSync(String(p));
        if (!st.isDirectory()) return null;
        return fs.realpathSync(String(p));
    } catch {
        return null;
    }
}

function sameToplevel(a, b) {
    const x = String(a || "").toLowerCase().replace(/[\\/]+$/, "");
    const y = String(b || "").toLowerCase().replace(/[\\/]+$/, "");
    return process.platform === "win32" ? x === y : x === y;
}

/** git diff --name-status output → [{ path, status }] with A/M/D/R mapping. */
export function parseNameStatus(raw, basePath = "") {
    const lines = String(raw || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const files = [];
    for (const line of lines) {
        const [statusRaw, ...rest] = line.split("\t");
        const status = String(statusRaw || "")[0] || "M"; // R100 → R
        const tail = rest.length > 1 ? rest[rest.length - 1] : rest[0] || "";
        if (!tail) continue;
        const map = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied" };
        files.push({ path: tail, status: map[status] || "modified" });
    }
    return files;
}

export class LandToMainService {
    constructor({ eventStore = defaultEventStore } = {}) {
        this.eventStore = eventStore;
    }

    _append(scope, runId, event) {
        try {
            this.eventStore.appendEvent(scope, runId, event);
        } catch {
            // Event log is observational; a failed append never fails a landing.
        }
    }

    /**
     * Apply a completed run's worktree changes to the real project checkout's
     * working tree (no commit, no staging on main). Returns a landed summary.
     */
    async land(scope, { run, project }) {
        const scoped = requireCodingScope(scope, "landToMain");
        if (!run?.id) throw codingError("NOT_FOUND", "coding run not found", 404);
        if (!project?.id) throw codingError("NOT_FOUND", "coding project not found", 404);

        // 1. Explicit, terminal success is the only thing we land.
        if (String(run.status) !== TERMINAL_COMPLETED) {
            throw codingError("RUN_NOT_COMPLETED", `只有已完成（completed）的 run 才能应用到真实代码（当前：${run.status || "?"}）`, 409);
        }
        if (normalizePreset(run.preset || run.mode) === "observe") {
            throw codingError("RUN_OBSERVE_NO_LAND", "observe 只读 run 没有可应用的改动", 422);
        }

        // 2. The disposable worktree holding the changes must still be live.
        const worktreePath = canonicalDir(run.worktreePath);
        if (run.worktreeStatus !== "ready" || !worktreePath) {
            throw codingError("WORKTREE_NOT_READY", "run 的工作树已不存在，无法应用（请勿先 teardown）", 409);
        }
        const baseCommit = String(run.baseCommit || "").trim();
        if (!baseCommit) {
            throw codingError("RUN_NO_BASE_COMMIT", "run 缺少 base commit，无法生成改动", 422);
        }

        // 3. The real checkout is re-resolved + re-authorized here (not upstream).
        const realRoot = resolveProjectRoot(project);
        const info = await gitRepoInfo(realRoot);
        if (!info.isRepo || !sameToplevel(info.toplevel, realRoot)) {
            throw codingError("NOT_GIT_REPO", "项目根目录不是 git 仓库顶层，无法落地改动", 422);
        }
        if (!info.commit) {
            throw codingError("NOT_GIT_REPO", "项目仓库没有 HEAD", 422);
        }
        const baseReachable = await runGit(realRoot, ["cat-file", "-e", `${baseCommit}^{commit}`]);
        if (baseReachable.code !== 0) {
            throw codingError("LAND_BASE_MISSING", `主仓库缺少 run 的 base commit ${baseCommit.slice(0, 12)}，无法安全生成 patch`, 409);
        }

        // 4. Capture the run's full change in the worktree: stage everything, then
        //    diff against the recorded base. Staging a disposable worktree is
        //    harmless — teardown deletes it wholesale.
        const staged = await runGit(worktreePath, ["add", "-A"]);
        if (staged.code !== 0) {
            throw codingError("LAND_STAGE_FAILED", `无法暂存 run 工作树改动：${String(staged.stderr || "").slice(0, 200)}`, 422);
        }
        const nameStatus = await runGit(worktreePath, ["diff", "--cached", "--name-status", baseCommit]);
        const numstat = await runGit(worktreePath, ["diff", "--cached", "--numstat", baseCommit]);
        if (String(nameStatus.stdout || "").trim() === "") {
            this._restoreIndex(worktreePath);
            return { applied: false, changed: 0, reason: "no_changes", files: [] };
        }
        // Binary hunks can't survive runGit's utf8 decode — refuse instead of
        // corrupting. `git diff --numstat` prints binary rows as "-\t-\t<path>".
        const binary = String(numstat.stdout || "").split("\n").some((l) => l.startsWith("-"));
        if (binary) {
            this._restoreIndex(worktreePath);
            throw codingError("LAND_BINARY_UNSUPPORTED", "该 run 含二进制文件改动，暂不支持落地（避免编码损坏）", 422);
        }
        const patch = await runGit(worktreePath, ["diff", "--cached", "--binary", baseCommit], {
            maxBytes: LAND_MAX_PATCH_BYTES,
        });
        if (patch.code !== 0 || patch.truncated || Buffer.byteLength(patch.stdout, "utf8") > LAND_MAX_PATCH_BYTES) {
            this._restoreIndex(worktreePath);
            throw codingError("LAND_PATCH_TOO_LARGE", "run 改动过大（>32MiB）或 diff 失败，拒绝落地", 422);
        }
        const patchText = patch.stdout || "";
        if (!patchText.trim()) {
            this._restoreIndex(worktreePath);
            return { applied: false, changed: 0, reason: "no_changes", files: [] };
        }
        this._restoreIndex(worktreePath);

        // 5. Refuse on ANY overlap/conflict before touching the real working tree.
        const patchFile = path.join(os.tmpdir(), `agentevo-land-${run.id}-${randomUUID()}.patch`);
        fs.writeFileSync(patchFile, patchText, "utf8");
        try {
            const check = await runGit(realRoot, ["apply", "--check", "--binary", patchFile]);
            if (check.code !== 0) {
                throw codingError(
                    "LAND_CONFLICT",
                    `无法干净地应用到真实代码（主分支可能已前进或文件已被改动）：${String(check.stderr || "冲突").slice(0, 300)}。请先在仓库里处理冲突后重试。`,
                    409,
                );
            }
            const applied = await runGit(realRoot, ["apply", "--binary", patchFile]);
            if (applied.code !== 0) {
                throw codingError("LAND_APPLY_FAILED", `落地失败：${String(applied.stderr || "").slice(0, 300)}`, 422);
            }
        } finally {
            fs.rmSync(patchFile, { force: true });
        }

        const files = parseNameStatus(nameStatus.stdout, path.dirname(path.resolve(realRoot)));
        const counts = { added: 0, modified: 0, deleted: 0, changed: files.length };
        for (const f of files) counts[f.status] = (counts[f.status] || 0) + 1;
        const branch = String(run.baseBranch || info.branch || "main");

        this._append(scoped, run.id, {
            type: "run.landed_main",
            payload: {
                method: "working_tree",
                branch,
                baseCommit,
                files: files.slice(0, 500),
                counts,
                landedAt: new Date().toISOString(),
            },
        });
        console.log(`[coding][land] run ${run.id} → ${branch} working tree (added=${counts.added} modified=${counts.modified} deleted=${counts.deleted})`);

        return {
            applied: true,
            method: "working_tree",
            branch,
            baseCommit,
            files,
            counts,
        };
    }

    /** Best-effort: restore the disposable worktree index (keep working tree). */
    _restoreIndex(worktreePath) {
        runGit(worktreePath, ["reset", "-q"]).catch(() => {});
    }
}

export const defaultLandToMainService = new LandToMainService();
export default defaultLandToMainService;
