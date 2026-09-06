/**
 * Phase 7 / R6 (roadmap #1) — deterministic disposable-repo fixtures.
 *
 * Every benchmark scenario seeds its own tiny git repository from a plain
 * `files` map and ONE fixed seed commit. Author identity and commit timestamps
 * are pinned to `BENCH_GIT_DATE` and content bytes are copied verbatim (git runs
 * with `core.autocrlf=false`), so building the same scenario twice yields the
 * SAME commit SHA — the "fixed repo revision" the R6 DoD requires a benchmark to
 * be reproducible against. The scenario repository is disposable (temp dir) and
 * never touches a real checkout.
 *
 * The repo lives under a caller-provided base so the caller can put it inside
 * `CODING_ALLOWED_ROOTS` (unit/HTTP harness) and provision a disposable worktree
 * under `CODING_WORKTREE_BASE` the same way the coding tests do.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { codingError } from "../../coding/util.js";

/** Pinned committer/author identity + date for every bench seed commit. */
export const BENCH_GIT_DATE = "2026-01-01T00:00:00Z";
export const BENCH_GIT_IDENTITY = { name: "bench-fixture", email: "bench@local.invalid" };

/** Render a `files` map ({relPath: content}) onto `root`, creating dirs. */
export function writeFileTree(root, files = {}) {
    for (const [rel, content] of Object.entries(files || {})) {
        const target = path.join(root, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(content));
    }
}

/** git wrapper with fixed line-ending/commit identity defaults used by benches. */
export function git(cwd, args, { env = {}, timeoutMs = 60_000 } = {}) {
    return execFileSync(
        "git",
        ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args],
        { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, env: { ...process.env, ...env } },
    );
}

function commitIdentityArgs() {
    return ["-c", `user.name=${BENCH_GIT_IDENTITY.name}`, "-c", `user.email=${BENCH_GIT_IDENTITY.email}`];
}

/** Stage + commit all files under `root` at the fixed bench date. */
export function commitBenchSeed(root, message = "seed") {
    git(root, ["init", "-q"]);
    git(root, ["add", "-A"]);
    execFileSync(
        "git",
        [...commitIdentityArgs(), "commit", "-q", "-m", message],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_DATE: BENCH_GIT_DATE, GIT_COMMITTER_DATE: BENCH_GIT_DATE } },
    );
    return repoHeadSha(root);
}

/** HEAD sha of a git repo (fixed-revision anchor). */
export function repoHeadSha(root) {
    return String(git(root, ["rev-parse", "HEAD"]).trim());
}

/** Commit a NEW change on top of the seed with the pinned identity but a NEW date. */
export function commitBenchChange(root, message = "change", date = "2026-01-02T00:00:00Z") {
    git(root, ["add", "-A"]);
    execFileSync(
        "git",
        [...commitIdentityArgs(), "commit", "-q", "-m", message],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
    );
    return repoHeadSha(root);
}

/**
 * Build a fresh disposable scenario repo from `files` inside `baseDir`.
 * Returns the absolute repo dir (a `repo` subdir) + the fixed seed HEAD sha.
 */
export function buildBenchRepo(baseDir, files = {}, { name = "repo" } = {}) {
    if (!baseDir) throw codingError("BENCH_NO_BASE_DIR", "a bench repo base directory is required", 400);
    const repoDir = path.join(baseDir, name);
    fs.mkdirSync(repoDir, { recursive: true });
    writeFileTree(repoDir, files);
    const headSha = commitBenchSeed(repoDir, "bench seed");
    return { repoDir, headSha };
}

/** Create a caller-managed disposable temp directory under a bench namespace. */
export function makeBenchDir(prefix = "agentevo-bench-") {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Remove a disposable tree best-effort (temp cleanup helper). */
export function rmBenchDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
}

/** `git status --porcelain` relative to `cwd` (empty string = clean tree). */
export function porcelainStatus(cwd) {
    return String(git(cwd, ["status", "--porcelain"])).trim();
}
