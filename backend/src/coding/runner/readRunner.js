/**
 * Phase 7 / R1 — WorkspaceReadRunner: the read-only runner boundary.
 *
 * Even though R1 exposes only reads, every operation is dispatched through this
 * runner (roadmap R1-1: "即使只读操作也通过 runner boundary"). A request arrives
 * as a structured `{ op, args }` (protocol.js); the runner then, per op:
 *
 *   1. re-resolves the project root (trust/terminal/allowed-roots/exists — never
 *      trusts a cached resolution), and
 *   2. resolves each subpath fresh through pathSecurity (canonical realpath +
 *      containment) so symlink/junction escapes are caught at access time, and
 *   3. enforces the op's hard limits, and finally
 *   4. emits a structured audit line.
 *
 * Nothing here writes files or spawns a shell; R2 write/exec ops will sit in a
 * sibling runner sharing the same protocol + path spine.
 */
import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import { codingError } from "../util.js";
import { gitRepoInfo, gitStatus, gitDiff, gitShowFile } from "./git.js";
import { resolveProjectRoot, resolveSubpath } from "./pathSecurity.js";
import { prepareOpRequest, WORKSPACE_LIMITS } from "./protocol.js";

const SKIP_LIST_DIRS = new Set([".git", ".hg", ".svn", "node_modules"]);
const SEARCH_SKIP_DIRS = new Set([".git", ".hg", ".svn", "node_modules", "dist", "build", ".next", ".cache", ".venv", "__pycache__"]);

function audit(projectId, op, rel, extra = "") {
    console.log(`[coding][workspace] op=${op} project=${projectId} rel=${rel || "."}${extra ? ` ${extra}` : ""}`);
}

/** Git ops operate repo-relative; only allow them when the project root IS the repo top-level. */
function isRepoTopLevel(canonicalRoot, git) {
    if (!git || !git.isRepo || !git.toplevel) return false;
    const a = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
    const b = process.platform === "win32" ? git.toplevel.toLowerCase() : git.toplevel;
    return a === b;
}

function notGitRepoError() {
    return codingError("NOT_GIT_REPO", "project root is not a git working tree (must be the repository top level)", 422);
}

// ── read by line range with hard char budget (handles huge files safely) ──
async function probeText(filePath) {
    const handle = await fs.promises.open(filePath, "r");
    try {
        const buffer = Buffer.alloc(8192);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 0) {
            const head = buffer.subarray(0, bytesRead);
            if (head.includes(0) || looksBinary(head.toString("utf8"))) {
                throw codingError("FILE_IS_BINARY", "file is not a text file", 422);
            }
        }
    } finally {
        await handle.close();
    }
}

async function readLineRange(filePath, startLine, maxLines) {
    await probeText(filePath);
    const lines = [];
    let truncated = false;
    let charsRead = 0;
    const endLine = startLine + maxLines - 1;
    const input = createReadStream(filePath, { encoding: "utf8" });
    try {
        const rl = readline.createInterface({ input, crlfDelay: Infinity });
        let lineIndex = 0;
        for await (const line of rl) {
            lineIndex += 1;
            if (lineIndex < startLine) continue;
            if (lineIndex > endLine) {
                // The file continues past the requested window -> mark truncated
                // only when there really is more content (not when we hit EOF).
                truncated = true;
                break;
            }
            charsRead += line.length + 1;
            lines.push(line.length > WORKSPACE_LIMITS.textLineMax ? line.slice(0, WORKSPACE_LIMITS.textLineMax) : line);
            if (charsRead > WORKSPACE_LIMITS.readCharBudget) {
                truncated = true;
                break;
            }
        }
        rl.close();
    } finally {
        input.destroy();
    }
    return { lines, truncated };
}

function listDirectoryTree(rootAbs, baseRel, depth) {
    const result = { entries: [], counts: { dirs: 0, files: 0, links: 0 }, truncated: false };
    const total = { value: 0 };

    function walk(dirAbs, dirRel, remaining) {
        if (remaining <= 0 || total.value >= WORKSPACE_LIMITS.listEntryCap) {
            if (total.value >= WORKSPACE_LIMITS.listEntryCap) result.truncated = true;
            return;
        }
        let dirents;
        try {
            dirents = fs.readdirSync(dirAbs, { withFileTypes: true });
        } catch {
            return; // unreadable dirs are skipped silently (still bounded)
        }
        dirents.sort((a, b) => {
            const aDir = a.isDirectory() ? 0 : 1;
            const bDir = b.isDirectory() ? 0 : 1;
            if (aDir !== bDir) return aDir - bDir;
            return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });
        let dirListed = 0;
        for (const entry of dirents) {
            if (total.value >= WORKSPACE_LIMITS.listEntryCap) { result.truncated = true; break; }
            if (dirListed >= WORKSPACE_LIMITS.listDirEntryCap) { result.truncated = true; break; }
            if (SKIP_LIST_DIRS.has(entry.name)) continue;
            const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
            const abs = path.join(dirAbs, entry.name);
            if (entry.isSymbolicLink()) {
                total.value += 1; dirListed += 1; result.counts.links += 1;
                result.entries.push({ name: entry.name, rel, type: "link" });
            } else if (entry.isDirectory()) {
                total.value += 1; dirListed += 1; result.counts.dirs += 1;
                const node = { name: entry.name, rel, type: "dir" };
                result.entries.push(node);
                walk(abs, rel, remaining - 1);
            } else if (entry.isFile()) {
                total.value += 1; dirListed += 1; result.counts.files += 1;
                let size = null;
                try { size = fs.statSync(abs).size; } catch { /* broken */ }
                result.entries.push({ name: entry.name, rel, type: "file", size });
            }
        }
    }

    walk(rootAbs, baseRel, depth);
    return result;
}

/** Heuristic binary/control-heavy detection over the first chars of a file. */
function looksBinary(text) {
    const sample = String(text || "").slice(0, 4096);
    for (const ch of sample) {
        const code = ch.charCodeAt(0);
        if (code === 0 || (code > 0 && code < 9) || (code > 13 && code < 32)) return true;
    }
    return false;
}

function buildSearchRegex(query) {
    try {
        return new RegExp(query, "i");
    } catch {
        throw codingError("INVALID_WORKSPACE_ARGS", "invalid search regular expression", 400);
    }
}

async function searchText(rootAbs, baseRel, query, useRegex) {
    const regex = useRegex ? buildSearchRegex(query) : null;
    const needle = query.toLowerCase();
    const out = { matches: [], filesScanned: 0, filesSkippedLarge: 0, filesWithMatches: 0, truncated: false, timedOut: false };
    const deadline = Date.now() + WORKSPACE_LIMITS.searchTimeoutMs;
    let stop = false;

    function walk(dirAbs, dirRel) {
        if (stop || out.matches.length >= WORKSPACE_LIMITS.searchMaxMatches) {
            if (out.matches.length >= WORKSPACE_LIMITS.searchMaxMatches) out.truncated = true;
            stop = true;
            return;
        }
        if (Date.now() > deadline) { out.timedOut = true; stop = true; return; }
        let dirents;
        try { dirents = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
        dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of dirents) {
            if (stop) return;
            if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
            const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
            const abs = path.join(dirAbs, entry.name);
            if (entry.isDirectory()) {
                walk(abs, rel);
            } else if (entry.isFile()) {
                if (out.filesScanned >= WORKSPACE_LIMITS.searchMaxFiles) { out.truncated = true; stop = true; return; }
                if (Date.now() > deadline) { out.timedOut = true; stop = true; return; }
                out.filesScanned += 1;
                let size;
                try { size = fs.statSync(abs).size; } catch { continue; }
                if (size > WORKSPACE_LIMITS.searchMaxFileBytes) { out.filesSkippedLarge += 1; continue; }
                let text;
                try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
                if (looksBinary(text)) continue; // skip binary / control-heavy files
                const rawLines = text.split(/\r?\n/);
                let fileMatched = false;
                let matchesInFile = 0;
                for (let i = 0; i < rawLines.length && !stop; i++) {
                    const raw = rawLines[i];
                    let hit = false;
                    if (regex) {
                        if (Date.now() > deadline) { out.timedOut = true; stop = true; break; }
                        // Bound the regex input so catastrophic backtracking cannot
                        // spin on an unbounded line; the deadline is the outer guard.
                        hit = regex.test(raw.length > 2000 ? raw.slice(0, 2000) : raw);
                    } else {
                        hit = raw.toLowerCase().includes(needle);
                    }
                    if (!hit) continue;
                    if (out.matches.length >= WORKSPACE_LIMITS.searchMaxMatches) { out.truncated = true; stop = true; break; }
                    matchesInFile += 1;
                    out.matches.push({
                        path: rel,
                        line: i + 1,
                        text: raw.length > WORKSPACE_LIMITS.searchMaxLineText ? raw.slice(0, WORKSPACE_LIMITS.searchMaxLineText) : raw,
                    });
                    if (!fileMatched) { fileMatched = true; out.filesWithMatches += 1; }
                    if (matchesInFile >= 20) break; // don't let one file flood the result
                    if (out.filesWithMatches >= WORKSPACE_LIMITS.searchMaxMatchFiles) { out.truncated = true; stop = true; break; }
                }
            }
        }
    }

    walk(rootAbs, baseRel);
    return out;
}

export class WorkspaceReadRunner {
    /** Full boundary entry: validate op + re-resolve root + dispatch. Async. */
    /**
     * Fetch repo facts only when a git op actually needs them; file ops
     * (list/read/search) skip the subprocess cost entirely.
     */
    async gitAtTopLevel(canonicalRoot) {
        const git = await gitRepoInfo(canonicalRoot);
        if (!isRepoTopLevel(canonicalRoot, git)) throw notGitRepoError();
        return git;
    }

    async invoke(project, op, args) {
        const canonicalRoot = resolveProjectRoot(project);
        return this.invokeAtRoot(canonicalRoot, project, op, args);
    }

    /**
     * Read-op dispatch against an EXPLICIT canonical root (R2 run-scoped reads
     * target the run's disposable worktree; project reads target the registered
     * root). `project` is only used for owner-agnostic audit labels — capability
     * (trust/terminal/allowed-roots) is resolved by the caller before this is
     * reached (resolveProjectRoot for project mode, WorktreeManager for run mode).
     */
    async invokeAtRoot(canonicalRoot, project, op, args) {
        const { op: cleanOp, args: clean } = prepareOpRequest(op, args);

        let data;
        switch (cleanOp) {
            case "list_tree": {
                const target = resolveSubpath(canonicalRoot, clean.path);
                let stat;
                try { stat = fs.statSync(target.abs); } catch { throw codingError("WORKSPACE_PATH_NOT_FOUND", "path does not exist", 404); }
                if (!stat.isDirectory()) throw codingError("PATH_NOT_DIRECTORY", "path is not a directory", 400);
                const tree = listDirectoryTree(target.abs, target.rel, clean.depth);
                data = { path: clean.path || "", depth: clean.depth, ...tree };
                audit(project.id, cleanOp, target.rel, `depth=${clean.depth}`);
                break;
            }
            case "read_file": {
                const target = resolveSubpath(canonicalRoot, clean.path);
                let stat;
                try { stat = fs.statSync(target.abs); } catch { throw codingError("WORKSPACE_PATH_NOT_FOUND", "path does not exist", 404); }
                if (!stat.isFile()) throw codingError("PATH_NOT_FILE", "path is not a file", 400);
                const { lines, truncated } = await readLineRange(target.abs, clean.startLine, clean.maxLines);
                data = {
                    path: target.rel,
                    startLine: clean.startLine,
                    endLine: clean.startLine + lines.length - 1,
                    lineCount: lines.length,
                    lines,
                    truncated,
                    byteLength: stat.size,
                };
                audit(project.id, cleanOp, target.rel, `lines=${lines.length} start=${clean.startLine}`);
                break;
            }
            case "search_text": {
                const target = resolveSubpath(canonicalRoot, clean.path);
                let stat;
                try { stat = fs.statSync(target.abs); } catch { throw codingError("WORKSPACE_PATH_NOT_FOUND", "path does not exist", 404); }
                if (!stat.isDirectory()) throw codingError("PATH_NOT_DIRECTORY", "search base is not a directory", 400);
                const found = await searchText(target.abs, target.rel, clean.query, clean.regex);
                data = { base: clean.path || "", query: clean.query, regex: clean.regex, ...found };
                audit(project.id, cleanOp, target.rel, `files=${found.filesScanned} matches=${found.matches.length}`);
                break;
            }
            case "git.status": {
                await this.gitAtTopLevel(canonicalRoot);
                const rel = clean.path ? resolveSubpath(canonicalRoot, clean.path).rel : null;
                const status = await gitStatus(canonicalRoot, { relPath: rel });
                data = status;
                audit(project.id, cleanOp, rel || "", `clean=${status.clean} entries=${status.entries.length}`);
                break;
            }
            case "git.diff": {
                await this.gitAtTopLevel(canonicalRoot);
                const rel = clean.path ? resolveSubpath(canonicalRoot, clean.path).rel : null;
                const diff = await gitDiff(canonicalRoot, { staged: clean.staged, relPath: rel });
                data = diff;
                audit(project.id, cleanOp, rel || "", `staged=${clean.staged} bytes=${diff.byteLength}`);
                break;
            }
            case "git.show_file": {
                await this.gitAtTopLevel(canonicalRoot);
                const target = resolveSubpath(canonicalRoot, clean.path);
                const shown = await gitShowFile(canonicalRoot, { relPath: target.rel, ref: clean.ref });
                data = shown;
                audit(project.id, cleanOp, target.rel, `ref=${clean.ref} bytes=${shown.byteLength}`);
                break;
            }
            default:
                throw codingError("INVALID_WORKSPACE_OP", `unsupported workspace op: ${cleanOp}`, 400);
        }
        return { ok: true, op: cleanOp, data };
    }

    /** One-shot project-open: trust + containment + repo facts (for the panel). */
    async open(project) {
        const canonicalRoot = resolveProjectRoot(project);
        const git = await gitRepoInfo(canonicalRoot);
        return {
            projectId: project.id,
            name: project.name,
            rootPath: canonicalRoot,
            isRepo: git.isRepo,
            isRepoTopLevel: isRepoTopLevel(canonicalRoot, git),
            commit: git.commit,
            branch: git.branch,
            capabilities: { write: false, exec: false }, // R1 is read-only
        };
    }
}

export const defaultWorkspaceRunner = new WorkspaceReadRunner();
export default defaultWorkspaceRunner;
