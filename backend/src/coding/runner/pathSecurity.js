/**
 * Phase 7 / R1 — Workspace path security (the shared spine of every runner op).
 *
 * The rule is deliberately narrow and re-checked on EVERY access (access-time
 * re-resolution, roadmap R1): a workspace op may only touch a path whose
 * canonical form (realpath — symlinks and Windows junctions resolved) is inside
 * the project's canonical root, and that root must itself be inside a server-
 * configured allowed root. A trusted project whose root was moved, deleted, or
 * re-pointed (junction/symlink) so it no longer canonicalizes inside an allowed
 * root is treated as stale/out-of-bounds — never silently re-anchored.
 *
 * Rejected outright before any filesystem touch:
 *   - absolute paths, Windows drive / device (`\\.\`, `\\?\`) and UNC forms;
 *   - traversal segments (`..`, `.`-only) — strict, no "safe" collapsing;
 *   - control bytes / NUL, over-length paths;
 *   - any resolved target that escapes the project root (symlink/junction escape).
 *
 * Allowed roots come from `CODING_ALLOWED_ROOTS` (path.delimiter separated) or an
 * explicit test override. Only existing, canonicalized roots count.
 */
import fs from "node:fs";
import path from "node:path";
import { codingError } from "../util.js";

export const PATH_MAX_LENGTH = 512;
export const PATH_MAX_SEGMENTS = 48;

// ── allowed roots configuration (env read at call time, like coding/flags.js) ──
let allowedRootsOverride = null; // test-only: array of raw root strings

export function setAllowedRootsOverride(roots) {
    allowedRootsOverride = Array.isArray(roots) ? roots.map(String) : null;
}

export function clearAllowedRootsOverride() {
    allowedRootsOverride = null;
}

/** Server-configured allowed roots, canonicalized. Missing/relative entries are dropped. */
export function configuredAllowedRoots() {
    const raw = allowedRootsOverride || parseAllowedRootsEnv();
    const out = [];
    for (const entry of raw) {
        const trimmed = String(entry || "").trim();
        if (!trimmed) continue;
        const canonical = canonicalExisting(path.resolve(trimmed));
        if (canonical) out.push(canonical);
    }
    return out;
}

function parseAllowedRootsEnv() {
    const value = process.env.CODING_ALLOWED_ROOTS;
    if (value == null) return [];
    const rawList = String(value).split(path.delimiter);
    // Colon is a drive-letter separator on win32; path.delimiter is ';' there, so
    // a ';' list is correct. On POSIX delimiter ':' — a single root is expected.
    return rawList.map((s) => s.trim()).filter(Boolean);
}

/** realpath if it exists, else null (never throws on ENOENT). */
export function canonicalExisting(p) {
    try {
        return fs.realpathSync(p);
    } catch {
        return null;
    }
}

function sameVolume(a, b) {
    if (process.platform !== "win32") return true;
    const aRoot = path.parse(a).root;
    const bRoot = path.parse(b).root;
    if (!aRoot || !bRoot) return false;
    return aRoot.toLowerCase() === bRoot.toLowerCase();
}

/** True when `child` equals `parent` or is strictly beneath it (canonical inputs). */
export function isPathWithin(parent, child) {
    if (!parent || !child) return false;
    if (!sameVolume(parent, child)) return false;
    const rel = path.relative(
        process.platform === "win32" ? parent.toLowerCase() : parent,
        process.platform === "win32" ? child.toLowerCase() : child,
    );
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const DRIVE_PREFIX = /^[a-zA-Z]:/;

/** Extended-length / device-namespace prefixes (`\\?\`, `\\.\`, and `//` twins). */
function isDeviceLike(raw) {
    return raw.startsWith("\\\\?\\") || raw.startsWith("\\\\.\\")
        || raw.startsWith("//?/") || raw.startsWith("//./");
}

/**
 * Reject + split a user-supplied relative subpath under `canonicalRoot` into its
 * validated clean segments. Shared by the existing-path resolver (resolveSubpath)
 * and the R2 write-target resolver (resolveWriteTarget) so rejections never
 * diverge. Returns `{ segs, rel }`; throws on traversal/absolute/UNC/device/
 * control/over-length. A `.` segment is dropped; `..` is never tolerated.
 *
 * @returns {{ segs: string[], rel: string }}
 */
export function parseRelSegments(canonicalRoot, rawPath) {
    if (rawPath == null || rawPath === "") {
        return { segs: [], rel: "" };
    }
    if (typeof rawPath !== "string") {
        throw codingError("INVALID_WORKSPACE_ARGS", "path must be a string", 400);
    }
    if (rawPath.length > PATH_MAX_LENGTH) {
        throw codingError("PATH_TOO_LONG", `path exceeds ${PATH_MAX_LENGTH} chars`, 400);
    }
    if (rawPath.includes("\0")) {
        throw codingError("INVALID_WORKSPACE_ARGS", "path contains NUL", 400);
    }
    // UNC / device-namespace forms first (most specific), then drive forms,
    // then plain rooted/absolute paths — every one is rejected outright.
    if (rawPath.startsWith("\\\\") || rawPath.startsWith("//")) {
        if (isDeviceLike(rawPath)) {
            throw codingError("DEVICE_PATH_NOT_ALLOWED", "device paths are not allowed", 403);
        }
        throw codingError("UNC_PATH_NOT_ALLOWED", "UNC paths are not allowed", 403);
    }
    if (DRIVE_PREFIX.test(rawPath)) {
        throw codingError("DEVICE_PATH_NOT_ALLOWED", "drive paths are not allowed", 403);
    }
    if (rawPath.startsWith("/") || rawPath.startsWith("\\")) {
        throw codingError("ABSOLUTE_PATH_NOT_ALLOWED", "absolute paths are not allowed", 403);
    }

    // Treat both separators as separators (Windows-safe while still portable).
    const segs = rawPath.split(/[\\/]/).filter((s) => s !== "");
    if (segs.length > PATH_MAX_SEGMENTS) {
        throw codingError("PATH_TOO_DEEP", `path exceeds ${PATH_MAX_SEGMENTS} segments`, 400);
    }
    for (const seg of segs) {
        if (seg === "..") {
            throw codingError("PATH_TRAVERSAL", "parent traversal is not allowed", 403);
        }
        if (seg === ".") continue;
        for (const ch of seg) {
            const code = ch.charCodeAt(0);
            if (code < 32 || code === 127) {
                throw codingError("INVALID_WORKSPACE_ARGS", "path contains control characters", 400);
            }
        }
    }
    const cleanSegs = segs.filter((s) => s !== ".");
    return { segs: cleanSegs, rel: cleanSegs.join("/") };
}

/**
 * Validate + normalize a user-supplied relative subpath under `canonicalRoot`.
 * Returns the logical posix segments AND the canonical absolute path. The caller
 * must open only the returned canonical path — never the un-resolved join.
 *
 * @returns {{ rel: string, abs: string, segs: string[], exists: true }}
 */
export function resolveSubpath(canonicalRoot, rawPath) {
    const { segs: cleanSegs, rel } = parseRelSegments(canonicalRoot, rawPath);
    if (cleanSegs.length === 0) {
        return { rel: "", abs: canonicalRoot, segs: [], exists: true };
    }
    const logical = path.join(canonicalRoot, ...cleanSegs);

    // Resolve symlinks/junctions at the FINAL target, then enforce containment.
    const canonical = canonicalExisting(logical);
    if (!canonical) {
        throw codingError("WORKSPACE_PATH_NOT_FOUND", "path does not exist", 404);
    }
    if (!isPathWithin(canonicalRoot, canonical)) {
        throw codingError("PATH_ESCAPE", "path escapes the project root", 403);
    }
    return { rel, abs: canonical, segs: cleanSegs, exists: true };
}

/**
 * R2 write-target resolver: same rejections as resolveSubpath but the FINAL
 * target may not exist yet (create_file/apply-to-new). Every EXISTING ancestor
 * is canonicalized and containment-checked as we walk, so a symlink/junction
 * parent can never redirect the write outside the root; the returned `abs` is
 * rooted at the canonical deepest-existing ancestor plus the remaining segments.
 *
 * @param {{ allowMissing?: boolean }} [opts] allowMissing=false keeps the
 *   read-only behavior (missing final target → WORKSPACE_PATH_NOT_FOUND).
 * @returns {{ rel: string, abs: string, segs: string[], exists: boolean }}
 */
export function resolveWriteTarget(canonicalRoot, rawPath, { allowMissing = true } = {}) {
    const { segs: cleanSegs, rel } = parseRelSegments(canonicalRoot, rawPath);
    if (cleanSegs.length === 0) {
        return { rel: "", abs: canonicalRoot, segs: [], exists: true };
    }
    let cur = canonicalRoot;
    for (let i = 0; i < cleanSegs.length; i += 1) {
        const next = path.join(cur, cleanSegs[i]);
        const canon = canonicalExisting(next);
        if (canon) {
            if (!isPathWithin(canonicalRoot, canon)) {
                throw codingError("PATH_ESCAPE", "path escapes the project root", 403);
            }
            cur = canon;
            continue;
        }
        if (!allowMissing) {
            throw codingError("WORKSPACE_PATH_NOT_FOUND", "path does not exist", 404);
        }
        const remainder = cleanSegs.slice(i);
        return { rel, abs: path.join(cur, ...remainder), segs: cleanSegs, exists: false };
    }
    return { rel, abs: cur, segs: cleanSegs, exists: true };
}

/**
 * Resolve the project root itself: canonical + git top-level + allowed-root
 * containment. Every runner op calls this so a stale/demoted/out-of-bounds
 * project can never be cached past a trust/config change.
 *
 * `project` must already be owner-scoped (route fetch); this function only
 * decides *capability*: trusted, non-terminal, existing, within allowed roots.
 */
export function resolveProjectRoot(project) {
    if (!project) throw codingError("NOT_FOUND", "coding project not found", 404);
    if (project.status === "archived" || project.status === "revoked") {
        throw codingError("PROJECT_TERMINAL", `project is ${project.status}`, 409);
    }
    if (project.trusted !== true) {
        throw codingError("PROJECT_NOT_TRUSTED", "project must be explicitly trusted before workspace access", 403);
    }
    const rawRoot = String(project.rootPath || "").trim();
    if (!rawRoot) throw codingError("PROJECT_ROOT_INVALID", "project has no root path", 422);
    const canonicalRoot = canonicalExisting(path.resolve(rawRoot));
    if (!canonicalRoot) {
        throw codingError("PROJECT_ROOT_MISSING", "project root no longer exists (stale trust?)", 422);
    }
    const allowed = configuredAllowedRoots();
    if (allowed.length === 0) {
        throw codingError("NO_ALLOWED_ROOTS", "no workspace allowed roots are configured", 403);
    }
    const inside = allowed.some((root) => isPathWithin(root, canonicalRoot));
    if (!inside) {
        throw codingError("ROOT_OUT_OF_BOUNDS", "project root is outside the allowed workspace roots", 403);
    }
    return canonicalRoot;
}
