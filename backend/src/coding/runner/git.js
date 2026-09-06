/**
 * Phase 7 / R1 — Safe, read-only Git access for the workspace runner.
 *
 * Every command runs through `spawn("git", ["-C", <cwd>, ...fixedArgs])` with
 * `shell:false`, a scrubbed environment (no credential/API-key vars leak to the
 * child), a hard output cap (we kill the child and mark `truncated` when the
 * stream overruns), and a timeout. Argument order is always under our control:
 * user input only ever arrives as a validated repo-relative path (from
 * pathSecurity) or a validated `ref`, never as flags.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { codingError } from "../util.js";
import { canonicalExisting } from "./pathSecurity.js";

const SECRET_ENV = /(api[_-]?key|secret|token|passwd|password|authorization|credential|bearer|private[_-]?key)/i;
const GIT_TIMEOUT_MS = 8_000;
const STDOUT_DEFAULT = 1 << 20; // 1 MiB
const STDERR_CAP = 64 * 1024;

function scrubbedEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (SECRET_ENV.test(key)) delete env[key];
    }
    return env;
}

/**
 * Run a git command with cwd-relative fixed args. Resolves on exit (never
 * rejects on non-zero): inspect `code`. Throws only on spawn/timeout failure.
 */
export function runGit(cwd, args, { maxBytes = STDOUT_DEFAULT, timeoutMs = GIT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn("git", ["-C", cwd, ...args], {
                env: scrubbedEnv(),
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (error) {
            reject(codingError("GIT_UNAVAILABLE", "git could not be started", 422));
            return;
        }
        let stdout = Buffer.alloc(0);
        let truncated = false;
        let stderr = "";
        const cap = Math.max(64 * 1024, maxBytes | 0);

        child.stdout.on("data", (chunk) => {
            if (stdout.length < cap) {
                const room = cap - stdout.length;
                stdout = Buffer.concat([stdout, chunk.length > room ? chunk.subarray(0, room) : chunk]);
                if (chunk.length > room) truncated = true;
            } else {
                truncated = true;
            }
        });
        child.stderr.on("data", (chunk) => {
            if (stderr.length < STDERR_CAP) stderr += chunk.toString("utf8").slice(0, STDERR_CAP - stderr.length);
        });
        const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
            reject(codingError("GIT_TIMEOUT", "git command timed out", 422));
        }, Math.max(1000, timeoutMs | 0));

        child.on("error", (error) => {
            clearTimeout(timer);
            reject(codingError("GIT_UNAVAILABLE", `git failed to start: ${String(error.code || error.message).slice(0, 120)}`, 422));
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({
                code: code == null ? -1 : code,
                stdout: stdout.toString("utf8"),
                stderr: stderr.trim(),
                truncated,
            });
        });
    });
}

function notGit() {
    return codingError("NOT_GIT_REPO", "project root is not a git working tree", 422);
}

/**
 * Lightweight repo facts. Never throws for missing repo/commit — those surface as
 * `isRepo:false` / nulls so callers decide.
 */
export async function gitRepoInfo(cwd) {
    const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return { isRepo: false, toplevel: null, commit: null, branch: null };
    const toplevel = canonicalExisting(top.stdout.trim()) || path.resolve(top.stdout.trim());
    let commit = null;
    let branch = null;
    const head = await runGit(cwd, ["rev-parse", "HEAD"]);
    if (head.code === 0) commit = head.stdout.trim().slice(0, 40) || null;
    const sym = await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (sym.code === 0 && sym.stdout.trim()) branch = sym.stdout.trim();
    return { isRepo: true, toplevel, commit, branch };
}

/** True only when the project root IS the git working-tree top-level. */
export async function isGitTopLevel(cwd, canonicalRoot) {
    const info = await gitRepoInfo(cwd);
    if (!info.isRepo || !info.toplevel) return false;
    const left = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
    const right = process.platform === "win32" ? info.toplevel.toLowerCase() : info.toplevel;
    return left === right;
}

const VALID_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function validateRef(ref) {
    const value = String(ref == null ? "HEAD" : ref).trim();
    if (!value || !VALID_REF.test(value)) {
        throw codingError("INVALID_GIT_REF", "invalid git ref", 400);
    }
    return value;
}

function toArrayLines(text) {
    return text.split("\n").filter((line) => line.trim() !== "");
}

function unquotePath(raw) {
    const value = String(raw || "").trim();
    if (value.startsWith("\"") && value.endsWith("\"")) {
        try { return JSON.parse(value); } catch { return value; }
    }
    return value;
}

/** Parse `git status --porcelain=v1` (non -z) lines into {x,y,path,renameTo}. */
function parseStatusLines(text) {
    const entries = [];
    for (const line of text.split("\n")) {
        if (line.length < 3 || line[2] !== " ") continue;
        const xy = line.slice(0, 2);
        let rest = line.slice(3).trim();
        let renameTo = null;
        if ((xy[0] === "R" || xy[0] === "C") && rest.includes(" -> ")) {
            const [from, to] = rest.split(" -> ", 2);
            rest = unquotePath(from);
            renameTo = unquotePath(to);
        } else {
            rest = unquotePath(rest);
        }
        if (!rest) continue;
        entries.push({ x: xy[0] === " " ? "" : xy[0], y: xy[1] === " " ? "" : xy[1], path: rest, renameTo });
    }
    return entries;
}

export async function gitStatus(cwd, { relPath = null } = {}) {
    const args = ["status", "--porcelain=v1", "--untracked-files=normal"];
    if (relPath) args.push("--", relPath);
    const result = await runGit(cwd, args, { maxBytes: 512 * 1024 });
    if (result.code !== 0) {
        throw codingError("GIT_FAILED", "git status failed", 422);
    }
    const info = await gitRepoInfo(cwd);
    const entries = parseStatusLines(result.stdout);
    const clean = entries.length === 0;
    return { isRepo: true, commit: info.commit, branch: info.branch, clean, entries, truncated: result.truncated };
}

export async function gitDiff(cwd, { staged = false, relPath = null } = {}) {
    const args = ["diff", "--unified=3"];
    if (staged) args.push("--cached");
    if (relPath) args.push("--", relPath);
    const result = await runGit(cwd, args, { maxBytes: 400 * 1024 });
    if (result.code !== 0) {
        throw codingError("GIT_FAILED", "git diff failed", 422);
    }
    const info = await gitRepoInfo(cwd);
    const fileHeaders = toArrayLines(result.stdout).filter((line) => line.startsWith("diff --git "));
    const filesChanged = fileHeaders.map((line) => {
        const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
        return m ? unquotePath(m[2]) : unquotePath(line.replace("diff --git ", ""));
    });
    return {
        staged,
        commit: info.commit,
        diff: result.stdout,
        truncated: result.truncated,
        byteLength: Buffer.byteLength(result.stdout, "utf8"),
        filesChanged,
    };
}

export async function gitShowFile(cwd, { relPath, ref = "HEAD" }) {
    const safeRef = validateRef(ref);
    const result = await runGit(cwd, ["show", `${safeRef}:${relPath}`], { maxBytes: 512 * 1024 });
    if (result.code !== 0) {
        const stderr = String(result.stderr || "").slice(0, 200);
        if (/does not exist|Invalid object|ambiguous/i.test(stderr)) {
            throw codingError("WORKSPACE_PATH_NOT_FOUND", "path does not exist at this ref", 404);
        }
        throw codingError("GIT_FAILED", "git show failed", 422);
    }
    const info = await gitRepoInfo(cwd);
    return {
        path: relPath,
        ref: safeRef,
        commit: info.commit,
        content: result.stdout,
        truncated: result.truncated,
        byteLength: Buffer.byteLength(result.stdout, "utf8"),
    };
}
