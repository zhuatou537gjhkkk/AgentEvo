/**
 * Phase 7 / R2 — Minimal, strict unified-diff applier (pure, no fs/child_process).
 *
 * Applies a strict subset of `git diff`-style unified diff text to in-memory
 * file content. Deliberately conservative: no fuzzy matching, no partial
 * application, no context drift tolerance. Every hunk must match an exact,
 * contiguous run of lines in the evolving document or the whole apply throws
 * `APPLY_PATCH_FAILED` and nothing is returned (the input is never mutated —
 * oldText is a string and all edits happen on a working copy of its lines).
 *
 * Design notes:
 *   - Newlines are normalized to LF. `oldText` is split on `/\r?\n/` (so CRLF
 *     input's `\r` is consumed as part of the separator) and rejoined with
 *     `\n`; a trailing newline is re-appended only if the input had one. CRLF
 *     files therefore come back LF-normalized — an accepted simplification.
 *   - Hunk pre/post images are matched byte-for-byte against the document.
 *     Search biases toward the hunk's declared `oldStart-1` first, then falls
 *     back to a linear scan starting at the end of the previously applied hunk
 *     (git hunks are ordered and non-overlapping, so a later hunk's content can
 *     only sit at/after the region the previous hunk just rewrote).
 */
import { codingError } from "../util.js";

export const PATCH_LIMITS = Object.freeze({
    maxPatchBytes: 256 * 1024,
    maxHunks: 50,
    maxHunkLines: 2000,
    maxFileBytes: 2 * 1024 * 1024,
});

// Convenience alias for the writeOps layer: the largest patch text this module
// will accept (bytes). Anything larger is refused before parsing.
export const VALIDATE_PATCH_MAX_CHARS = PATCH_LIMITS.maxPatchBytes;

// Leading per-file metadata git prints before the first hunk. These carry no
// content and are ignored. `@@` belongs to hunks, `--- ` / `+++ ` are handled
// separately (they must carry a path, e.g. `a/f.txt` or `/dev/null`).
const FILE_HEADER_PREFIXES = [
    "diff --git ",
    "index ",
    "new file mode ",
    "deleted file mode ",
    "old mode ",
    "new mode ",
    "similarity index ",
    "dissimilarity index ",
    "rename from ",
    "rename to ",
    "copy from ",
    "copy to ",
];

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/** `--- `/`+++ ` before hunks are file headers (path ignored, must be non-empty). */
function isFileHeader(line) {
    return (line.startsWith("--- ") || line.startsWith("+++ ")) && line.length > 4;
}

function isIgnorableHeader(line) {
    return line === "" || FILE_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/** Short, single-line-ish rendering of a line for an error message. */
function show(line) {
    const text = line.length > 60 ? `${line.slice(0, 60)}…` : line;
    return JSON.stringify(text);
}

/**
 * Parse a unified-diff string into hunks. Returns a tagged object:
 *   { hunks, malformed, error }   (malformed === true  →  error is set)
 * Each hunk is { header:{oldStart,oldCount,newStart,newCount}, pre, post,
 *               addedMarkers, removedMarkers } where `pre`/`post` are content
 * lines (marker stripped) and the counts are what git's header claims.
 *
 * `oldStart`/`newStart` of 0 (new-file / delete-to-empty diffs) are normalized
 * to 1. A missing count defaults to 1. `\ No newline at end of file` body
 * markers are stripped and not counted.
 */
export function parseUnifiedPatch(patchText) {
    const malformed = (error) => ({ hunks: [], malformed: true, error });
    if (typeof patchText !== "string") return malformed("patch text must be a string");

    const raw = patchText.split(/\r?\n/);
    while (raw.length > 0 && raw[raw.length - 1] === "") raw.pop(); // terminal newline noise

    const hunks = [];
    let i = 0;
    let sawHunk = false;

    while (i < raw.length) {
        const line = raw[i];

        if (line.startsWith("@@")) {
            sawHunk = true;
            const m = HUNK_HEADER.exec(line);
            if (!m) return malformed(`malformed hunk header: ${show(line)}`);

            let oldStart = Number(m[1]);
            const oldCount = m[2] === undefined ? 1 : Number(m[2]);
            let newStart = Number(m[3]);
            const newCount = m[4] === undefined ? 1 : Number(m[4]);
            if (oldStart === 0) oldStart = 1; // new file: anchors at the top
            if (newStart === 0) newStart = 1; // delete-to-empty

            i++; // consume the header line; i now points at the first body line
            const pre = [];
            const post = [];
            let addedMarkers = 0;
            let removedMarkers = 0;
            let bad = null;

            for (; i < raw.length; i++) {
                const body = raw[i];
                if (body.startsWith("@@")) break; // next hunk header
                if (body === NO_NEWLINE_MARKER) continue; // strip; not counted
                const marker = body[0];
                if (marker === " ") {
                    pre.push(body.slice(1));
                    post.push(body.slice(1));
                } else if (marker === "-") {
                    pre.push(body.slice(1));
                    removedMarkers++;
                } else if (marker === "+") {
                    post.push(body.slice(1));
                    addedMarkers++;
                } else {
                    bad = body;
                    break;
                }
            }
            if (bad !== null) return malformed(`malformed hunk body line: ${show(bad)}`);

            if (pre.length !== oldCount || post.length !== newCount) {
                return malformed(
                    `hunk count mismatch: pre ${pre.length} vs oldCount ${oldCount}, ` +
                        `post ${post.length} vs newCount ${newCount}`,
                );
            }

            hunks.push({ header: { oldStart, oldCount, newStart, newCount }, pre, post, addedMarkers, removedMarkers });
            continue;
        }

        // Not a hunk header. Only leading file metadata is tolerated; after the
        // first hunk the body parser already consumed everything, so a stray
        // line here is a malformed patch (multi-file diffs are out of scope).
        if (!sawHunk && (isIgnorableHeader(line) || isFileHeader(line))) {
            i++;
            continue;
        }
        return malformed(
            sawHunk ? `unexpected content after hunks: ${show(line)}` : `unexpected line before first hunk: ${show(line)}`,
        );
    }

    return { hunks, malformed: false, error: null };
}

/** True when `pre` exactly matches `lines[index .. index+pre.length)`. */
function matchesAt(lines, index, pre) {
    if (pre.length === 0) return index >= 0 && index <= lines.length;
    if (index < 0 || index + pre.length > lines.length) return false;
    for (let k = 0; k < pre.length; k++) {
        if (lines[index + k] !== pre[k]) return false;
    }
    return true;
}

/**
 * Apply a unified-diff patch to `oldText`. Atomic: either every hunk matches
 * and the full new text is returned, or an error is thrown and `oldText` is
 * left untouched.
 *
 * Returns { ok:true, newText, hunksApplied, added, removed, truncated:false }.
 * Throws codingError("APPLY_PATCH_FAILED", ..., 422) for any parse/match
 * failure and codingError("PATCH_TOO_LARGE", ..., 413) for size-cap violations.
 */
export function applyUnifiedPatch(
    oldText,
    patchText,
    { limits: override = PATCH_LIMITS, offsetSearch = true } = {},
) {
    if (typeof oldText !== "string") {
        throw codingError("APPLY_PATCH_FAILED", "old file text must be a string", 422);
    }
    if (typeof patchText !== "string") {
        throw codingError("APPLY_PATCH_FAILED", "patch text must be a string", 422);
    }
    const limits = { ...PATCH_LIMITS, ...(override || {}) };

    if (Buffer.byteLength(patchText, "utf8") > limits.maxPatchBytes) {
        throw codingError("PATCH_TOO_LARGE", `patch exceeds ${limits.maxPatchBytes} bytes`, 413);
    }
    if (Buffer.byteLength(oldText, "utf8") > limits.maxFileBytes) {
        throw codingError("PATCH_TOO_LARGE", `file exceeds ${limits.maxFileBytes} bytes`, 413);
    }

    const parsed = parseUnifiedPatch(patchText);
    if (parsed.malformed) {
        throw codingError("APPLY_PATCH_FAILED", parsed.error || "malformed patch", 422);
    }
    if (parsed.hunks.length > limits.maxHunks) {
        throw codingError("PATCH_TOO_LARGE", `patch has ${parsed.hunks.length} hunks (max ${limits.maxHunks})`, 413);
    }
    for (const hunk of parsed.hunks) {
        // body lines consumed by the hunk = context + removals + additions.
        if (hunk.pre.length + hunk.addedMarkers > limits.maxHunkLines) {
            throw codingError("PATCH_TOO_LARGE", `hunk exceeds ${limits.maxHunkLines} body lines`, 413);
        }
    }
    if (parsed.hunks.length === 0) {
        return { ok: true, newText: oldText, hunksApplied: 0, added: 0, removed: 0, truncated: false };
    }

    // Line-normalize oldText (LF; CRLF `\r` is consumed by the split).
    const endsWithNewline = oldText.endsWith("\n");
    const lines = oldText === "" ? [] : oldText.split(/\r?\n/);
    if (endsWithNewline) lines.pop(); // drop the empty element left by the trailing newline

    let scanStart = 0; // index where the previous hunk's replacement ended
    let added = 0;
    let removed = 0;
    let applied = 0;

    for (let h = 0; h < parsed.hunks.length; h++) {
        const hunk = parsed.hunks[h];
        const { pre, post } = hunk;
        added += hunk.addedMarkers;
        removed += hunk.removedMarkers;

        const bias = Math.max(0, hunk.header.oldStart - 1);
        const maxStart = lines.length - pre.length;
        let at = -1;
        if (bias >= scanStart && bias <= maxStart && matchesAt(lines, bias, pre)) {
            at = bias;
        } else if (offsetSearch) {
            for (let j = scanStart; j <= maxStart; j++) {
                if (matchesAt(lines, j, pre)) {
                    at = j;
                    break;
                }
            }
        }
        if (at < 0) {
            throw codingError("APPLY_PATCH_FAILED", `hunk ${h + 1} context not found in file`, 422);
        }
        lines.splice(at, pre.length, ...post);
        applied++;
        scanStart = at + post.length;
    }

    let newText = lines.join("\n");
    if (endsWithNewline) newText += "\n";
    return { ok: true, newText, hunksApplied: applied, added, removed, truncated: false };
}

/**
 * Non-throwing convenience: true iff `patchText` fully applies to `oldText`.
 * Implemented by running the real applier against the (immutable) string input
 * and swallowing any failure — a failed apply never mutates its input, so this
 * doubles as a pure dry-run probe.
 */
export function canApplyPatch(oldText, patchText) {
    try {
        applyUnifiedPatch(oldText, patchText);
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Non-throwing, strict single-file adapter (writeOps-facing).
//
// `tryApplyUnifiedPatch(originalText, patch)` never throws. It validates that
// the patch references exactly one plain-text file (rejects binary/mode/rename/
// add/delete file headers and mismatched ---/+++ paths), applies hunks with NO
// offset search (a hunk whose context is not exactly where it claims to be is a
// failure), and returns a plain result object in either case.
// ---------------------------------------------------------------------------

const BANNED_FILE_HEADERS = [
    "new file mode ",
    "deleted file mode ",
    "old mode ",
    "new mode ",
    "similarity index ",
    "dissimilarity index ",
    "rename from ",
    "rename to ",
    "copy from ",
    "copy to ",
    "Binary files ",
    "GIT binary patch",
];

/** Strip git's leading `a/` / `b/` path prefixes from a `--- `/`+++ ` header. */
function stripAB(value) {
    return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
}

/** Returns a reason string when the patch isn't a clean single-file text diff, else null. */
function singleFileIssue(patchText) {
    const lines = patchText.split(/\r?\n/);
    let headerEnd = lines.length;
    for (let k = 0; k < lines.length; k++) {
        if (lines[k].startsWith("@@")) {
            headerEnd = k; // file metadata only exists before the first hunk
            break;
        }
    }
    const header = lines.slice(0, headerEnd);

    let diffHeaders = 0;
    for (const line of lines) if (line.startsWith("diff --git ")) diffHeaders++;
    if (diffHeaders > 1) return "multi-file patches are not supported (exactly one file expected)";

    for (const line of header) {
        for (const prefix of BANNED_FILE_HEADERS) {
            if (line.startsWith(prefix)) return `unsupported file header "${prefix.trim()}": plain-text diffs only`;
        }
    }

    let fromPath = null;
    let toPath = null;
    for (const line of header) {
        if (line.startsWith("--- ")) {
            const p = stripAB(line.slice(4));
            if (fromPath !== null && fromPath !== p) return "multiple old-side (---) file headers";
            fromPath = p;
        } else if (line.startsWith("+++ ")) {
            const p = stripAB(line.slice(4));
            if (toPath !== null && toPath !== p) return "multiple new-side (+++) file headers";
            toPath = p;
        }
    }
    if (fromPath === "/dev/null" || toPath === "/dev/null") return "add/delete diffs are not supported";
    if (fromPath !== null && toPath !== null && fromPath !== toPath) {
        return "patch references different files on its --- and +++ sides";
    }
    return null;
}

/**
 * Non-throwing applier. Returns on success:
 *   { ok:true, text, hunksApplied, matched:true }
 * and on any malformed/oversized/ambiguous/no-exact-match failure:
 *   { ok:false, text:null, matched:false, hunksApplied, reason }
 */
export function tryApplyUnifiedPatch(originalText, patch, { limits = PATCH_LIMITS } = {}) {
    const fail = (reason, hunksApplied = 0) => ({ ok: false, text: null, matched: false, hunksApplied, reason });
    try {
        if (typeof originalText !== "string") return fail("originalText must be a string");
        if (typeof patch !== "string") return fail("patch must be a string");
        const issue = singleFileIssue(patch);
        if (issue) return fail(issue);

        const result = applyUnifiedPatch(originalText, patch, { limits, offsetSearch: false });
        return { ok: true, text: result.newText, hunksApplied: result.hunksApplied, matched: true };
    } catch (error) {
        const message = error && error.message ? String(error.message) : String(error);
        const m = /^hunk (\d+) context not found/.exec(message);
        return fail(message, m ? Number(m[1]) - 1 : 0);
    }
}
