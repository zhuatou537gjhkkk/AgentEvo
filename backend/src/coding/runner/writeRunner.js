/**
 * Phase 7 / R2 — WorkspaceWriteRunner: atomic, digest-tracked file mutations.
 *
 * Runs only against a run's DISPOSABLE WORKTREE root (never the main checkout —
 * the caller resolves capability first). Every mutation:
 *
 *   1. re-resolves the target through resolveWriteTarget (canonical existing
 *      ancestors + containment) so a symlink/junction parent can never redirect
 *      the write outside the worktree;
 *   2. records the before/after sha256 digests + size and returns them as the
 *      op result (the caller persists an artifact row + action transcript);
 *   3. writes atomically (same-directory temp file + rename) so a crash never
 *      leaves a half-written file.
 *
 * Reserved paths are refused: no mutation may touch `.git` (in a worktree that
 * is a gitdir-pointer file whose loss would orphan the worktree), and existing
 * files larger than the write limit or that are binary are left untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { codingError } from "../util.js";
import { resolveWriteTarget } from "./pathSecurity.js";
import { WORKSPACE_LIMITS } from "./protocol.js";

export function sha256Hex(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function fileDigest(absPath) {
    try {
        const buf = await fs.promises.readFile(absPath);
        return { digest: createHash("sha256").update(buf).digest("hex"), size: buf.length };
    } catch {
        return null; // ENOENT → null; caller decides if that is an error
    }
}

function looksBinary(text) {
    const sample = String(text || "").slice(0, 4096);
    for (const ch of sample) {
        const code = ch.charCodeAt(0);
        if (code === 0 || (code > 0 && code < 9) || (code > 13 && code < 32)) return true;
    }
    return false;
}

function assertNoReserved(target) {
    if (!target.rel) {
        throw codingError("INVALID_WORKSPACE_ARGS", "cannot mutate the project root itself", 400);
    }
    if (target.segs.some((seg) => seg.toLowerCase() === ".git")) {
        throw codingError("RESERVED_PATH", "git internals are not writable through workspace ops", 403);
    }
}

async function assertNotBinaryExisting(absPath) {
    let fd;
    try {
        fd = await fs.promises.open(absPath, "r");
        const buf = Buffer.alloc(8192);
        const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
        if (bytesRead > 0) {
            const head = buf.subarray(0, bytesRead);
            if (head.includes(0) || looksBinary(head.toString("utf8"))) {
                throw codingError("FILE_IS_BINARY", "target file is not a text file", 422);
            }
        }
    } catch (error) {
        if (error?.code === "FILE_IS_BINARY") throw error;
    } finally {
        if (fd) await fd.close().catch(() => {});
    }
}

async function atomicWrite(absPath, content) {
    const dir = path.dirname(absPath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.coding-tmp-${process.pid}-${randomUUID()}`);
    await fs.promises.writeFile(tmp, content, "utf8");
    try {
        await fs.promises.rename(tmp, absPath);
    } catch (error) {
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
        throw error;
    }
}

async function ensureParentIsDir(absPath) {
    const st = await fs.promises.stat(path.dirname(absPath)).catch(() => null);
    if (!st || !st.isDirectory()) {
        throw codingError("WORKSPACE_PATH_NOT_FOUND", "target directory does not exist in the worktree", 404);
    }
}

/** Shape of a validated write op request: { op, args } from prepareRunOpRequest. */
export class WorkspaceWriteRunner {
    /**
     * @param {string} root canonical disposable-worktree root (already capability-resolved)
     * @param {object} request { op, args } already validated by prepareRunOpRequest
     */
    async invoke(root, { op, args }) {
        switch (op) {
            case "write_file":
                return this._write(root, args.path, args.content);
            case "create_file":
                return this._create(root, args.path, args.content);
            case "delete_file":
                return this._delete(root, args.path);
            case "apply_patch":
                return this._patch(root, args.path, args.patch, args.digest);
            default:
                throw codingError("INVALID_WORKSPACE_OP", `not a write op: ${op}`, 400);
        }
    }

    async _resolve(root, rawPath) {
        const target = resolveWriteTarget(root, rawPath, { allowMissing: true });
        assertNoReserved(target);
        return target;
    }

    async _existingText(root, target) {
        const info = await fileDigest(target.abs);
        if (!info) throw codingError("WORKSPACE_PATH_NOT_FOUND", "path does not exist", 404);
        if (info.size > WORKSPACE_LIMITS.writeFileMaxBytes) {
            throw codingError("FILE_TOO_LARGE", `file exceeds ${WORKSPACE_LIMITS.writeFileMaxBytes} bytes`, 413);
        }
        await assertNotBinaryExisting(target.abs);
        const text = await fs.promises.readFile(target.abs, "utf8");
        return { text, beforeDigest: info.digest, size: info.size };
    }

    async _write(root, rawPath, content) {
        const target = await this._resolve(root, rawPath);
        const existing = await fileDigest(target.abs);
        if (!existing) {
            throw codingError("WORKSPACE_PATH_NOT_FOUND", "write_file requires an existing file (use create_file)", 404);
        }
        if (existing.size > WORKSPACE_LIMITS.writeFileMaxBytes) {
            throw codingError("FILE_TOO_LARGE", `file exceeds ${WORKSPACE_LIMITS.writeFileMaxBytes} bytes`, 413);
        }
        await assertNotBinaryExisting(target.abs);
        await atomicWrite(target.abs, content);
        const after = await fileDigest(target.abs);
        return {
            op: "write_file", path: target.rel, existed: true,
            beforeDigest: existing.digest, afterDigest: after.digest,
            sizeBytes: after.size, kind: "file.write",
        };
    }

    async _create(root, rawPath, content) {
        const target = await this._resolve(root, rawPath);
        const existing = await fileDigest(target.abs);
        if (existing) {
            throw codingError("WORKSPACE_PATH_ALREADY_EXISTS", "create_file target already exists (use write_file)", 409);
        }
        await ensureParentIsDir(target.abs);
        await atomicWrite(target.abs, content);
        const after = await fileDigest(target.abs);
        return {
            op: "create_file", path: target.rel, existed: false,
            beforeDigest: null, afterDigest: after.digest,
            sizeBytes: after.size, kind: "file.create",
        };
    }

    async _delete(root, rawPath) {
        const target = await this._resolve(root, rawPath);
        const info = await fileDigest(target.abs);
        if (!info) {
            throw codingError("WORKSPACE_PATH_NOT_FOUND", "delete_file target does not exist", 404);
        }
        const st = await fs.promises.stat(target.abs);
        if (!st.isFile()) {
            throw codingError("PATH_NOT_FILE", "delete_file target is not a file", 400);
        }
        await fs.promises.rm(target.abs, { force: true });
        return {
            op: "delete_file", path: target.rel, existed: true,
            beforeDigest: info.digest, afterDigest: null,
            sizeBytes: info.size, kind: "file.delete",
        };
    }

    async _patch(root, rawPath, patch, expectedDigest) {
        const target = await this._resolve(root, rawPath);
        const { text, beforeDigest } = await this._existingText(root, target);
        if (expectedDigest && expectedDigest !== beforeDigest) {
            throw codingError("WORKSPACE_STALE", "file changed since the patch was prepared", 409);
        }
        const apply = await loadApplyPatch();
        // tryApplyUnifiedPatch is the strict, single-file, NON-throwing adapter:
        // no fuzzy/offset matching — a hunk whose context does not match exactly
        // at its declared position is a failure (deterministic, replay-safe).
        const result = apply.tryApplyUnifiedPatch(text, patch);
        if (!result || result.ok !== true) {
            const reason = String(result?.reason || "patch does not apply cleanly").slice(0, 300);
            throw codingError("PATCH_APPLY_FAILED", reason, 422);
        }
        await atomicWrite(target.abs, result.text);
        const after = await fileDigest(target.abs);
        return {
            op: "apply_patch", path: target.rel, existed: true,
            beforeDigest, afterDigest: after.digest,
            sizeBytes: after.size, hunksApplied: result.hunksApplied,
            kind: "file.patch",
        };
    }
}

let applyPatchModule = null;
async function loadApplyPatch() {
    if (applyPatchModule) return applyPatchModule;
    applyPatchModule = await import("./applyPatch.js");
    return applyPatchModule;
}

/** Drop a cached apply-patch import (tests may swap the module under a fresh path). */
export function clearApplyPatchImportCache() {
    applyPatchModule = null;
}

export const defaultWriteRunner = new WorkspaceWriteRunner();
export default defaultWriteRunner;
