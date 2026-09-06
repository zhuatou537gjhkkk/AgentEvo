/**
 * Phase 7 / R1 — Workspace runner protocol skeleton.
 *
 * Every read-only operation the frontend/agent may issue is described here:
 * a structured op name, a strict argument schema, effect/layout metadata, and
 * hard limits. The registry is the seam where R2 write/exec ops join the same
 * transport — Express routes never reach the filesystem directly; they POST a
 * `{ op, args }` and the runner dispatches through this table. Validation runs
 * BEFORE any path resolution so a malformed op never touches disk.
 */
import { codingError } from "../util.js";
import { PATH_MAX_LENGTH } from "./pathSecurity.js";

export const WORKSPACE_LIMITS = Object.freeze({
    pathMaxLength: PATH_MAX_LENGTH,
    listDefaultDepth: 2,
    listMaxDepth: 6,
    listDirEntryCap: 400,     // entries returned per expanded directory
    listEntryCap: 1200,       // hard total across the whole tree response
    readDefaultLines: 400,
    readMaxLines: 2000,
    readStartLineMax: 1_000_000,
    readCharBudget: 2 * 1024 * 1024,   // stop reading past this many chars
    readStreamBudget: 16 * 1024 * 1024, // for the streaming (huge file) fallback
    searchQueryMax: 200,
    searchMaxFiles: 300,      // files scanned
    searchMaxMatchFiles: 60,  // distinct files we keep matches from
    searchMaxMatches: 200,    // match rows returned
    searchMaxFileBytes: 768 * 1024, // files larger than this are skipped
    searchMaxLineText: 300,
    searchTimeoutMs: 1500,
    diffMaxBytes: 400 * 1024,
    showMaxBytes: 512 * 1024,
    gitTimeoutMs: 8000,
    textLineMax: 4000,        // a single returned source line is truncated here

    // R2 — write + exec effect bounds (hard table, enforced before any disk touch)
    writeContentMaxBytes: 512 * 1024,  // write_file/create_file content cap
    patchMaxBytes: 768 * 1024,         // apply_patch text cap
    writeFileMaxBytes: 4 * 1024 * 1024, // a mutation target larger than this is refused
    execArgMaxLength: 200,             // single command arg cap
    execArgCountMax: 64,               // total args per command
    execDefaultTimeoutMs: 60_000,      // 60s
    execMaxTimeoutMs: 300_000,         // 5 min hard ceiling
    execMinTimeoutMs: 1000,
    execDefaultOutputLimit: 512 * 1024, // per-stream output cap (stdout/stderr each)
    execMaxOutputLimit: 2 * 1024 * 1024,
    execAllowlistMax: 256,             // allowlist entry length
});

const OPTIONAL_RELPATH = { optional: true };
const REQUIRED_RELPATH = { optional: false };

function validatePathField(value, { optional = false } = {}) {
    if (value == null || value === "") return optional ? "" : null;
    if (typeof value !== "string") {
        throw codingError("INVALID_WORKSPACE_ARGS", "path must be a string", 400);
    }
    if (value.length > PATH_MAX_LENGTH) {
        throw codingError("INVALID_WORKSPACE_ARGS", "path is too long", 400);
    }
    return value;
}

function intInRange(value, fallback, min, max, name) {
    if (value == null || value === "") return fallback;
    const n = Number(value);
    if (!Number.isInteger(n)) {
        throw codingError("INVALID_WORKSPACE_ARGS", `${name} must be an integer`, 400);
    }
    return Math.min(max, Math.max(min, n));
}

function cleanArgs(op, rawArgs = {}) {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    const out = {};
    switch (op) {
        case "list_tree": {
            const depth = intInRange(args.depth, WORKSPACE_LIMITS.listDefaultDepth, 1, WORKSPACE_LIMITS.listMaxDepth, "depth");
            const pathValue = validatePathField(args.path, OPTIONAL_RELPATH);
            out.path = pathValue;
            out.depth = depth;
            return out;
        }
        case "read_file": {
            const pathValue = validatePathField(args.path, REQUIRED_RELPATH);
            if (pathValue == null) throw codingError("INVALID_WORKSPACE_ARGS", "read_file requires a path", 400);
            const startLine = intInRange(args.start_line ?? args.startLine, 1, 1, WORKSPACE_LIMITS.readStartLineMax, "start_line");
            const maxLines = intInRange(args.max_lines ?? args.maxLines, WORKSPACE_LIMITS.readDefaultLines, 1, WORKSPACE_LIMITS.readMaxLines, "max_lines");
            out.path = pathValue;
            out.startLine = startLine;
            out.maxLines = maxLines;
            return out;
        }
        case "search_text": {
            const pathValue = validatePathField(args.path, OPTIONAL_RELPATH);
            const query = String(args.query ?? "");
            if (!query || query.length > WORKSPACE_LIMITS.searchQueryMax) {
                throw codingError("INVALID_WORKSPACE_ARGS", `search query is required (<=${WORKSPACE_LIMITS.searchQueryMax} chars)`, 400);
            }
            out.path = pathValue;
            out.query = query;
            out.regex = args.regex === true;
            return out;
        }
        case "git.status": {
            const pathValue = validatePathField(args.path, OPTIONAL_RELPATH);
            out.path = pathValue;
            return out;
        }
        case "git.diff": {
            const pathValue = validatePathField(args.path, OPTIONAL_RELPATH);
            out.path = pathValue;
            out.staged = args.staged === true;
            return out;
        }
        case "git.show_file": {
            const pathValue = validatePathField(args.path, REQUIRED_RELPATH);
            if (pathValue == null) throw codingError("INVALID_WORKSPACE_ARGS", "git.show_file requires a path", 400);
            const ref = String(args.ref ?? "HEAD");
            if (ref.length > 200) throw codingError("INVALID_WORKSPACE_ARGS", "ref is too long", 400);
            out.path = pathValue;
            out.ref = ref;
            return out;
        }

        // ── R2 write ops (run-scoped; resolveWriteTarget + worktree enforced) ──
        case "write_file": {
            const pathValue = validatePathField(args.path, REQUIRED_RELPATH);
            if (pathValue == null) throw codingError("INVALID_WORKSPACE_ARGS", "write_file requires a path", 400);
            const content = validateContent(args.content, WORKSPACE_LIMITS.writeContentMaxBytes, "content");
            out.path = pathValue;
            out.content = content;
            return out;
        }
        case "create_file": {
            const pathValue = validatePathField(args.path, REQUIRED_RELPATH);
            if (pathValue == null) throw codingError("INVALID_WORKSPACE_ARGS", "create_file requires a path", 400);
            const content = validateContent(args.content, WORKSPACE_LIMITS.writeContentMaxBytes, "content");
            out.path = pathValue;
            out.content = content;
            return out;
        }
        case "delete_file": {
            const pathValue = validatePathField(args.path, REQUIRED_RELPATH);
            if (pathValue == null) throw codingError("INVALID_WORKSPACE_ARGS", "delete_file requires a path", 400);
            out.path = pathValue;
            return out;
        }
        case "apply_patch": {
            const pathValue = validatePathField(args.path, REQUIRED_RELPATH);
            if (pathValue == null) throw codingError("INVALID_WORKSPACE_ARGS", "apply_patch requires a path", 400);
            const patch = validateContent(args.patch, WORKSPACE_LIMITS.patchMaxBytes, "patch");
            out.path = pathValue;
            out.patch = patch;
            out.digest = args.digest == null || args.digest === "" ? null : String(args.digest).slice(0, 64);
            return out;
        }
        case "run_command": {
            const executable = validateExecutable(args.executable);
            const argsList = validateArgs(args.args ?? args.argv);
            const cwdValue = validatePathField(args.cwd_relative ?? args.cwdRelative ?? "", OPTIONAL_RELPATH);
            const timeoutMs = intInRange(
                args.timeout_ms ?? args.timeoutMs,
                WORKSPACE_LIMITS.execDefaultTimeoutMs,
                WORKSPACE_LIMITS.execMinTimeoutMs,
                WORKSPACE_LIMITS.execMaxTimeoutMs,
                "timeout_ms",
            );
            const outputLimit = intInRange(
                args.output_limit ?? args.outputLimit,
                WORKSPACE_LIMITS.execDefaultOutputLimit,
                16 * 1024,
                WORKSPACE_LIMITS.execMaxOutputLimit,
                "output_limit",
            );
            out.executable = executable;
            out.args = argsList;
            out.cwdRelative = cwdValue;
            out.timeoutMs = timeoutMs;
            out.outputLimit = outputLimit;
            return out;
        }

        default:
            throw codingError("INVALID_WORKSPACE_OP", `unsupported workspace op: ${op}`, 400);
    }
}

function validateContent(value, maxBytes, name) {
    if (typeof value !== "string") {
        throw codingError("INVALID_WORKSPACE_ARGS", `${name} must be a string`, 400);
    }
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > maxBytes) {
        throw codingError("PAYLOAD_TOO_LARGE", `${name} exceeds ${maxBytes} bytes`, 413);
    }
    if (value.includes("\0")) {
        throw codingError("INVALID_WORKSPACE_ARGS", `${name} contains NUL`, 400);
    }
    return value;
}

/** Command input ONLY allows a bare executable name — no path separators, no flags-in-name. */
function validateExecutable(value) {
    if (typeof value !== "string") {
        throw codingError("INVALID_WORKSPACE_ARGS", "executable must be a string", 400);
    }
    const name = value.trim();
    if (!name || name.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        throw codingError("INVALID_WORKSPACE_ARGS", "executable must be a bare command name (no slashes, no flags)", 400);
    }
    return name;
}

function validateArgs(value) {
    if (value == null) return [];
    if (!Array.isArray(value)) {
        throw codingError("INVALID_WORKSPACE_ARGS", "args must be an array of strings", 400);
    }
    if (value.length > WORKSPACE_LIMITS.execArgCountMax) {
        throw codingError("INVALID_WORKSPACE_ARGS", `args exceeds ${WORKSPACE_LIMITS.execArgCountMax} entries`, 400);
    }
    return value.map((arg) => {
        if (typeof arg !== "string") {
            throw codingError("INVALID_WORKSPACE_ARGS", "each arg must be a string", 400);
        }
        if (arg.length > WORKSPACE_LIMITS.execArgMaxLength) {
            throw codingError("INVALID_WORKSPACE_ARGS", `an arg exceeds ${WORKSPACE_LIMITS.execArgMaxLength} chars`, 400);
        }
        if (arg.includes("\0")) {
            throw codingError("INVALID_WORKSPACE_ARGS", "args contain NUL", 400);
        }
        return arg;
    });
}

/** Read-effect ops the R1 runner understands (write/exec arrive in R2). */
export const READ_OPS = Object.freeze([
    "list_tree",
    "read_file",
    "search_text",
    "git.status",
    "git.diff",
    "git.show_file",
]);

/** R2 write ops (run-scoped: disposable worktree only, never the main checkout). */
export const WRITE_OPS = Object.freeze([
    "write_file",
    "create_file",
    "delete_file",
    "apply_patch",
]);

/** R2 exec ops (structured command, allowlist + tree-kill, never a shell string). */
export const EXEC_OPS = Object.freeze([
    "run_command",
]);

export function isReadOp(op) {
    return READ_OPS.includes(op);
}

export function isWriteOp(op) {
    return WRITE_OPS.includes(op);
}

export function isExecOp(op) {
    return EXEC_OPS.includes(op);
}

export function isRunOp(op) {
    return isReadOp(op) || isWriteOp(op) || isExecOp(op);
}

/** Read-only transport guard — the R1 project /ops surface stays read-only. */
export function prepareOpRequest(op, args) {
    const opName = String(op || "");
    if (!isReadOp(opName)) {
        throw codingError("INVALID_WORKSPACE_OP", `unsupported workspace op: ${opName}`, 400);
    }
    return { op: opName, args: cleanArgs(opName, args) };
}

/**
 * R2 run-scoped transport guard: a coding run may issue read + write + exec ops,
 * but the op effect class is decided by the preset/policy layer, never here.
 */
export function prepareRunOpRequest(op, args) {
    const opName = String(op || "");
    if (!isRunOp(opName)) {
        throw codingError("INVALID_WORKSPACE_OP", `unsupported workspace op: ${opName}`, 400);
    }
    return { op: opName, args: cleanArgs(opName, args) };
}
