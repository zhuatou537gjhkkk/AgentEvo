/**
 * Phase 7 / R2 — CodingActionExecutor end-to-end (unit level, real worktree).
 *
 * Drives the REAL default services (no HTTP, no mocks) against a real disposable
 * git worktree provisioned from a trusted, allowed git fixture repo. Proves the
 * R2 execution rules:
 *   - trusted write ops auto-execute ([policy:preset]) into the run worktree;
 *     the MAIN checkout is byte-identical (git status --porcelain empty, HEAD
 *     unchanged);
 *   - edit-mode writes pause for owner approval (file NOT written), resume
 *     exactly once via executeApproved, and a second resume reports
 *     { data: { settled: true } } with no duplicate side effect;
 *   - two concurrent executeApproved resumes race safely — exactly one executes;
 *   - exec ops still require owner approval on trusted presets, honor the
 *     command allowlist (EXEC_NOT_ALLOWLISTED before any action/approval row),
 *     record a command.output artifact (digest only, never output bytes), and
 *     honor an external abort (whole-tree kill → cancelled).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createUser, initDB } from "../db/index.js";
import { defaultProjectService } from "./projects.js";
import { defaultRunService } from "./runs.js";
import { defaultApprovalService } from "./approvals.js";
import { defaultArtifactService } from "./artifacts.js";
import { defaultWorktreeService, setWorktreeBaseOverride, clearWorktreeBaseOverride } from "./worktrees.js";
import { defaultActionExecutor } from "./actionExecutor.js";
import { prepareRunOpRequest } from "./runner/protocol.js";
import { setCommandAllowlistOverride, clearCommandAllowlistOverride } from "./runner/commandRunner.js";
import { clearCodingFlags } from "./flags.js";

const executor = defaultActionExecutor;
const approvals = defaultApprovalService;
const artifacts = defaultArtifactService;
const worktrees = defaultWorktreeService;

const cleanup = [];
const createdRuns = []; // { run, project } for afterEach teardown

function tmpDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanup.push(dir);
    return dir;
}

function git(cwd, args) {
    return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
}

function gitCommitAll(cwd, message) {
    git(cwd, ["add", "-A"]);
    git(cwd, ["-c", "user.name=Action Exec", "-c", "user.email=exec@test.local", "commit", "-q", "-m", message]);
}

let scope;
let userId;
let project;     // registered + trusted allowed git fixture repo
let mainRepo;    // path of the main checkout (must never change)
let mainHead;    // rev-parse HEAD before any run

beforeAll(() => {
    initDB();
    userId = createUser("Action Exec Alice", "hash-aea");
    scope = { userId, tenantId: `user:${userId}` };

    const allowedRoot = tmpDir("agentevo-ae-allowed-");
    const worktreeBase = tmpDir("agentevo-ae-wtbase-");
    process.env.CODING_ALLOWED_ROOTS = allowedRoot;
    process.env.CODING_WORKSPACE_ENABLED = "true";
    process.env.CODING_WRITE_TOOLS_ENABLED = "true";
    process.env.CODING_COMMAND_TOOLS_ENABLED = "true";
    process.env.CODING_EVENT_LOG_ENABLED = "true";
    // Env fallback + explicit test override both point at the temp worktree base.
    process.env.CODING_WORKTREE_BASE = worktreeBase;
    setWorktreeBaseOverride(worktreeBase);

    mainRepo = path.join(allowedRoot, "main-repo");
    fs.mkdirSync(path.join(mainRepo, "src"), { recursive: true });
    git(mainRepo, ["init", "-q"]);
    // Repo-local line-ending policy: the R2 provisioner's `git worktree add`
    // (runner/git.js) does not carry `-c core.autocrlf=false`, so pin the repo
    // config itself to LF to keep checked-out files deterministic on Windows.
    git(mainRepo, ["config", "core.autocrlf", "false"]);
    git(mainRepo, ["config", "core.eol", "lf"]);
    fs.writeFileSync(path.join(mainRepo, "README.md"), "# Main repo\n");
    fs.writeFileSync(path.join(mainRepo, "src", "app.js"), "export const app = 'original';\n");
    gitCommitAll(mainRepo, "seed");
    mainHead = git(mainRepo, ["rev-parse", "HEAD"]).trim();
    expect(mainHead).toMatch(/^[0-9a-f]{40}$/);

    project = defaultProjectService.register(scope, { name: "ae main", rootPath: mainRepo });
    project = defaultProjectService.update(scope, project.id, { trusted: true });
    expect(project.trusted).toBe(true);
});

afterEach(async () => {
    clearCommandAllowlistOverride();
    // Tear down every run's disposable worktree (best-effort) so the main repo
    // accumulates no worktree registrations and nothing leaks between tests.
    while (createdRuns.length) {
        const { run, project: p } = createdRuns.pop();
        try {
            await worktrees.teardown(scope, { project: p, run });
        } catch { /* best-effort */ }
    }
});

afterAll(() => {
    clearWorktreeBaseOverride();
    clearCodingFlags();
    delete process.env.CODING_ALLOWED_ROOTS;
    delete process.env.CODING_WORKTREE_BASE;
    for (const dir of cleanup) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

function makeRun(mode) {
    const run = defaultRunService.createRun(scope, { projectId: project.id, mode });
    expect(run.preset).toBe(mode);
    createdRuns.push({ run, project });
    return run;
}

function mainRepoUnchanged() {
    const status = git(mainRepo, ["status", "--porcelain"]);
    expect(status).toBe("");
    expect(git(mainRepo, ["rev-parse", "HEAD"]).trim()).toBe(mainHead);
}

function readUnderWorktree(run, rel) {
    return fs.readFileSync(path.join(run.worktreePath, rel), "utf8");
}

describe("trusted write — auto execution into the disposable worktree", () => {
    it("auto-executes create_file with a [policy:preset] approval and never touches the main checkout", async () => {
        const run = makeRun("trusted");
        const request = prepareRunOpRequest("create_file", { path: "src/new-file.txt", content: "hello worktree\n" });

        const result = await executor.execute(scope, { run, project, request });
        expect(result.status).toBe("executed");
        expect(result.action.status).toBe("executed");
        expect(result.action.tool).toBe("create_file");
        // policy auto-decision reason is server-decided, never model-granted
        expect(result.approval.status).toBe("approved");
        expect(result.approval.reason).toContain("[policy:preset]");
        expect(result.run.worktreeStatus).toBe("ready");
        expect(result.run.worktreePath).toBeTruthy();

        // artifact: durable digest ledger, path + 64-hex digest
        expect(result.artifact.kind).toBe("file.create");
        expect(result.artifact.path).toBe("src/new-file.txt");
        expect(result.artifact.digest).toMatch(/^[0-9a-f]{64}$/);
        expect(result.artifact.storageRef).toContain(`worktree://${run.id}/`);

        // file actually landed in the disposable worktree
        expect(fs.existsSync(path.join(result.run.worktreePath, "src", "new-file.txt"))).toBe(true);
        expect(readUnderWorktree(result.run, "src/new-file.txt")).toBe("hello worktree\n");

        // artifact ledger lists exactly the one write
        const ledger = artifacts.listForRun(scope, run.id);
        expect(ledger).toHaveLength(1);

        // the MAIN checkout is byte-identical
        mainRepoUnchanged();
    });
});

describe("edit-mode write — approval gate, single resume, no duplicate side effect", () => {
    it("pauses awaiting_approval (file untouched), resumes exactly once on approval, settles on a second resume", async () => {
        const run = makeRun("edit");
        const request = prepareRunOpRequest("write_file", {
            path: "src/app.js",
            content: "export const app = 'approved-edit';\n",
        });

        // 1. live op with wait:false → awaiting_approval, nothing written
        const awaiting = await executor.execute(scope, { run, project, request, opts: { wait: false } });
        expect(awaiting.status).toBe("awaiting_approval");
        expect(awaiting.approval.status).toBe("requested");
        expect(awaiting.action.status).toBe("requested");
        // worktree exists (provisioned) but the file was NOT written
        expect(awaiting.run.worktreeStatus).toBe("ready");
        expect(readUnderWorktree(awaiting.run, "src/app.js")).toBe("export const app = 'original';\n");
        expect(artifacts.listForRun(scope, run.id)).toHaveLength(0);

        // 2. owner approves (decision alone never executes)
        const decided = approvals.decide(scope, awaiting.approval.id, { approve: true });
        expect(decided.approval.status).toBe("approved");
        expect(decided.action.status).toBe("approved");

        // 3. resume with live args → executed exactly once
        const resumed = await executor.executeApproved(scope, {
            run: awaiting.run, project, request, actionId: awaiting.action.id,
        });
        expect(resumed.status).toBe("executed");
        expect(resumed.action.status).toBe("executed");
        expect(resumed.artifact.kind).toBe("file.write");
        expect(readUnderWorktree(resumed.run, "src/app.js")).toBe("export const app = 'approved-edit';\n");
        expect(artifacts.listForRun(scope, run.id)).toHaveLength(1);

        // 4. a second resume does NOT re-run the side effect — it settles idempotently
        const again = await executor.executeApproved(scope, {
            run: resumed.run, project, request, actionId: awaiting.action.id,
        });
        expect(again.data).toEqual({ settled: true, state: "executed" });
        expect(readUnderWorktree(resumed.run, "src/app.js")).toBe("export const app = 'approved-edit';\n");
        expect(artifacts.listForRun(scope, run.id)).toHaveLength(1); // still one write on record

        mainRepoUnchanged();
    });

    it("two concurrent resumes race safely — exactly one executes, the other settles", async () => {
        const run = makeRun("edit");
        const request = prepareRunOpRequest("write_file", {
            path: "README.md",
            content: "# Concurrent winner\n",
        });

        const awaiting = await executor.execute(scope, { run, project, request, opts: { wait: false } });
        expect(awaiting.status).toBe("awaiting_approval");
        await approvals.decide(scope, awaiting.approval.id, { approve: true });

        const fire = () => executor.executeApproved(scope, {
            run: awaiting.run, project, request, actionId: awaiting.action.id,
        });
        const settled = await Promise.allSettled([fire(), fire()]);

        // Both promises resolve (never a double-run error, never two executions)
        expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
        const values = settled.map((r) => r.value);
        expect(values.map((v) => v.status)).toEqual(["executed", "executed"]);
        // Exactly one won the atomic claim and wrote; the loser settled idempotently.
        expect(values.filter((v) => v.data && v.data.settled === true)).toHaveLength(1);

        // The file was written exactly once (content deterministic, ledger length 1)
        expect(readUnderWorktree(awaiting.run, "README.md")).toBe("# Concurrent winner\n");
        expect(artifacts.listForRun(scope, run.id)).toHaveLength(1);
        mainRepoUnchanged();
    });
});

describe("run_command (trusted) — exec still needs approval, allowlist enforced", () => {
    it("pauses awaiting_approval, then executes on approval with an allowlisted executable and records a digest-only artifact", async () => {
        setCommandAllowlistOverride(["node"]);
        const run = makeRun("trusted");
        const request = prepareRunOpRequest("run_command", {
            executable: "node",
            args: ["-e", "console.log('hi')"],
            timeout_ms: 5000,
        });

        const awaiting = await executor.execute(scope, { run, project, request, opts: { wait: false } });
        expect(awaiting.status).toBe("awaiting_approval");
        expect(awaiting.approval.status).toBe("requested");
        expect(awaiting.action.type).toBe("exec");

        await approvals.decide(scope, awaiting.approval.id, { approve: true });
        const resumed = await executor.executeApproved(scope, {
            run: awaiting.run, project, request, actionId: awaiting.action.id,
        });
        expect(resumed.status).toBe("executed");
        expect(resumed.data.code).toBe(0);
        expect(resumed.data.stdout).toContain("hi");
        expect(resumed.data.cancelled).toBe(false);

        // command.output artifact: digest-only, never output bytes
        expect(resumed.artifact.kind).toBe("command.output");
        expect(resumed.artifact.path).toBeNull();
        expect(resumed.artifact.digest).toMatch(/^[0-9a-f]{64}$/);
        expect(resumed.artifact.meta.executable).toBe("node");
        expect(resumed.artifact.meta.exitCode).toBe(0);
        expect(resumed.artifact.meta.cancelled).toBe(false);
        // no stdout/stderr content persisted on the row or the object
        expect(resumed.artifact.stdout).toBeUndefined();
        expect(resumed.data.stdout).not.toBe(resumed.artifact.digest);

        mainRepoUnchanged();
    });

    it("rejects a non-allowlisted executable with 403 EXEC_NOT_ALLOWLISTED before any action/approval row", async () => {
        clearCommandAllowlistOverride(); // fail-closed: nothing allowlisted
        const run = makeRun("trusted");
        const request = prepareRunOpRequest("run_command", {
            executable: "notallowed",
            args: ["-e", "console.log('nope')"],
        });

        let thrown = null;
        try {
            await executor.execute(scope, { run, project, request, opts: { wait: false } });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).not.toBeNull();
        expect(thrown.code).toBe("EXEC_NOT_ALLOWLISTED");
        expect(thrown.statusCode).toBe(403);
        // no durable transcript was created for the rejected exec
        expect(approvals.listActions(scope, run.id)).toHaveLength(0);
        expect(approvals.listApprovals(scope, { runId: run.id })).toHaveLength(0);
        expect(run.worktreeStatus).toBe("none"); // not even provisioned

        mainRepoUnchanged();
    });

    it("an external abort kills the running tree and resolves cancelled:true", async () => {
        setCommandAllowlistOverride(["node"]);
        const run = makeRun("trusted");
        const request = prepareRunOpRequest("run_command", {
            executable: "node",
            args: ["-e", "setTimeout(() => {}, 60000)"],
            timeout_ms: 300000,
        });

        const awaiting = await executor.execute(scope, { run, project, request, opts: { wait: false } });
        expect(awaiting.status).toBe("awaiting_approval");
        await approvals.decide(scope, awaiting.approval.id, { approve: true });

        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), 500);
        try {
            const resumed = await executor.executeApproved(scope, {
                run: awaiting.run, project, request, actionId: awaiting.action.id,
                opts: { signal: controller.signal },
            });
            expect(resumed.status).toBe("executed");
            expect(resumed.data.cancelled).toBe(true);
            expect(resumed.data.code).toBeNull();
            expect(resumed.data.timedOut).toBe(false);
            expect(resumed.artifact.kind).toBe("command.output");
            expect(resumed.artifact.meta.cancelled).toBe(true);
        } finally {
            clearTimeout(abortTimer);
        }
        mainRepoUnchanged();
    });
});
