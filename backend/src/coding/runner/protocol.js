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
        default:
            throw codingError("INVALID_WORKSPACE_OP", `unsupported workspace op: ${op}`, 400);
    }
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

export function isReadOp(op) {
    return READ_OPS.includes(op);
}

export function prepareOpRequest(op, args) {
    const opName = String(op || "");
    if (!isReadOp(opName)) {
        throw codingError("INVALID_WORKSPACE_OP", `unsupported workspace op: ${opName}`, 400);
    }
    return { op: opName, args: cleanArgs(opName, args) };
}
