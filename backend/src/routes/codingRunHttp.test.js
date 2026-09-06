/**
 * Phase 7 / R2 — coding run HTTP contract (real app, real DB, native HTTP).
 *
 * Two users ALICE/BOB mirror routes/codingWorkspaceHttp.test.js fixture style.
 * Proves the R2 run surface over the wire:
 *   - feature/flag gates (dark gate; write-enabled runs need the write flag);
 *   - createRun validation (project required, mode whitelist, cross-owner 404);
 *   - provision identity (worktree ready, branch/baseCommit, main untouched);
 *   - trusted HTTP write loop (auto-exec create_file + apply_patch + git.diff,
 *     artifact ledger, main checkout clean);
 *   - edit-mode approval loop over HTTP (await → decide → execute → settled);
 *   - run_command allowlist (approve+execute code 0; non-allowlisted 403 before
 *     any action row);
 *   - out-of-bounds command cwd → 403 PATH_TRAVERSAL;
 *   - two-user isolation (BOB cannot read/ops/teardown ALICE's run);
 *   - teardown (worktreeStatus removed, dir gone, main clean/HEAD unchanged);
 *   - untrusted project writes denied (PROJECT_NOT_TRUSTED);
 *   - observe-mode reads still work at the main checkout (backward compat).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createApp } from "../app.js";
import { issueAuthToken } from "../auth.js";
import { createSession, createUser, initDB } from "../db/index.js";
import { clearCodingFlags } from "../coding/flags.js";

const ALICE = { name: "run_alice", username: "runalice" };
const BOB = { name: "run_bob", username: "runbob" };

const servers = [];
let base = "";
let allowedBase = "";
let worktreeBase = "";

let aliceRepo = "";
let bobRepo = "";
let untrustedRepo = "";
let aliceProjId = "";
let bobProjId = "";
let untrustedProjId = "";
let aliceHead = ""; // main checkout HEAD of ALICE's repo (must never change)
const trackedRuns = []; // { owner: "alice"|"bob", id } for afterAll teardown

const ORIGINAL_APP = "export const app = 'original';\n";

function open(app) {
    return new Promise((resolve) => {
        const server = createServer(app);
        server.listen(0, "127.0.0.1", () => {
            servers.push(server);
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });
}

function headers(user) {
    return {
        Authorization: `Bearer ${issueAuthToken({ id: user.id, username: user.username })}`,
        "Content-Type": "application/json",
    };
}

async function request(method, reqPath, user, body) {
    const response = await fetch(`${base}${reqPath}`, {
        method,
        headers: headers(user),
        body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: response.status, body: json, text };
}

function git(cwd, args) {
    return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
}

function gitCommitAll(cwd, message) {
    git(cwd, ["add", "-A"]);
    git(cwd, ["-c", "user.name=HTTP Run", "-c", "user.email=run@test.local", "commit", "-q", "-m", message]);
}

function sha256File(abs) {
    return createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}

/** A deterministic single-hunk bug-fix patch against src/math.js (subtract → add). */
function mathBugfixPatch() {
    return [
        "--- a/src/math.js",
        "+++ b/src/math.js",
        "@@ -1,3 +1,3 @@",
        " export function add(a, b) {",
        "-  return a - b;",
        "+  return a + b;",
        " }",
    ].join("\n");
}

function expectMainUnchanged(repo, head) {
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(head);
}

async function registerAndTrust(owner, name, root) {
    const created = await request("POST", "/coding/projects", owner, { name, root_path: root });
    expect(created.status).toBe(201);
    const trusted = await request("PATCH", `/coding/projects/${created.body.project.id}`, owner, { trusted: true });
    expect(trusted.status).toBe(200);
    expect(trusted.body.project.trusted).toBe(true);
    return created.body.project.id;
}

async function createRun(mode, projectId) {
    const res = await request("POST", "/coding/runs", ALICE, { project_id: projectId, mode });
    expect(res.status).toBe(201);
    trackedRuns.push({ owner: "alice", id: res.body.run.id });
    return res.body.run;
}

beforeAll(async () => {
    initDB();
    ALICE.id = createUser(ALICE.name, "hash-runa");
    BOB.id = createUser(BOB.name, "hash-runb");
    createSession(ALICE.id, "alice run session");
    createSession(BOB.id, "bob run session");

    allowedBase = fs.mkdtempSync(path.join(os.tmpdir(), "agentevo-runhttp-allowed-"));
    worktreeBase = fs.mkdtempSync(path.join(os.tmpdir(), "agentevo-runhttp-wtbase-"));
    process.env.CODING_ALLOWED_ROOTS = allowedBase;
    process.env.CODING_WORKTREE_BASE = worktreeBase;
    process.env.CODING_WORKSPACE_ENABLED = "true";
    process.env.CODING_WRITE_TOOLS_ENABLED = "true";
    process.env.CODING_COMMAND_TOOLS_ENABLED = "true";
    process.env.CODING_EVENT_LOG_ENABLED = "true";

    // ALICE's allowed git repo (main checkout must never change across runs)
    aliceRepo = path.join(allowedBase, "alice-repo");
    fs.mkdirSync(path.join(aliceRepo, "src"), { recursive: true });
    git(aliceRepo, ["init", "-q"]);
    git(aliceRepo, ["config", "core.autocrlf", "false"]);
    git(aliceRepo, ["config", "core.eol", "lf"]);
    fs.writeFileSync(path.join(aliceRepo, "README.md"), "# Main repo\n");
    fs.writeFileSync(path.join(aliceRepo, "src", "app.js"), ORIGINAL_APP);
    fs.writeFileSync(path.join(aliceRepo, "src", "math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
    gitCommitAll(aliceRepo, "seed");
    aliceHead = git(aliceRepo, ["rev-parse", "HEAD"]).trim();
    expect(aliceHead).toMatch(/^[0-9a-f]{40}$/);

    // BOB's repo + an untrusted repo (never trusted)
    bobRepo = path.join(allowedBase, "bob-repo");
    fs.mkdirSync(bobRepo, { recursive: true });
    fs.writeFileSync(path.join(bobRepo, "b.txt"), "bob file\n");
    git(bobRepo, ["init", "-q"]);
    git(bobRepo, ["config", "core.autocrlf", "false"]);
    gitCommitAll(bobRepo, "bob seed");

    untrustedRepo = path.join(allowedBase, "untrusted-repo");
    fs.mkdirSync(untrustedRepo, { recursive: true });
    fs.writeFileSync(path.join(untrustedRepo, "u.txt"), "untrusted\n");
    git(untrustedRepo, ["init", "-q"]);
    git(untrustedRepo, ["config", "core.autocrlf", "false"]);
    gitCommitAll(untrustedRepo, "untrusted seed");

    base = await open(createApp());
    aliceProjId = await registerAndTrust(ALICE, "alice repo", aliceRepo);
    bobProjId = await registerAndTrust(BOB, "bob repo", bobRepo);

    const createdUntrusted = await request("POST", "/coding/projects", ALICE, { name: "untrusted repo", root_path: untrustedRepo });
    expect(createdUntrusted.status).toBe(201);
    untrustedProjId = createdUntrusted.body.project.id;
});

afterAll(async () => {
    // Best-effort teardown of any worktrees left by scenarios, then wipe temp dirs.
    for (const { owner, id } of trackedRuns.slice().reverse()) {
        try { await request("POST", `/coding/runs/${id}/teardown`, owner === "alice" ? ALICE : BOB, {}); } catch { /* best-effort */ }
    }
    trackedRuns.length = 0;
    while (servers.length) {
        const server = servers.pop();
        await new Promise((resolve) => server.close(resolve));
    }
    delete process.env.CODING_ALLOWED_ROOTS;
    delete process.env.CODING_WORKTREE_BASE;
    delete process.env.CODING_COMMAND_ALLOWLIST;
    clearCodingFlags();
    for (const dir of [allowedBase, worktreeBase]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

describe("R2 run gates", () => {
    it("answers 403 CODING_FEATURE_DISABLED while the workspace flag is dark", async () => {
        delete process.env.CODING_WORKSPACE_ENABLED;
        try {
            const res = await request("POST", "/coding/runs", ALICE, { project_id: aliceProjId, mode: "observe" });
            expect(res.status).toBe(403);
            expect(res.body.errorCode).toBe("CODING_FEATURE_DISABLED");
        } finally {
            process.env.CODING_WORKSPACE_ENABLED = "true";
        }
    });

    it("refuses write-enabled run modes without the write flag; observe still works", async () => {
        delete process.env.CODING_WRITE_TOOLS_ENABLED;
        try {
            const edit = await request("POST", "/coding/runs", ALICE, { project_id: aliceProjId, mode: "edit" });
            expect(edit.status).toBe(403);
            expect(edit.body.errorCode).toBe("WRITE_TOOLS_DISABLED");

            const observe = await request("POST", "/coding/runs", ALICE, { project_id: aliceProjId, mode: "observe" });
            expect(observe.status).toBe(201);
            expect(observe.body.run.mode).toBe("observe");
            trackedRuns.push({ owner: "alice", id: observe.body.run.id });
        } finally {
            process.env.CODING_WRITE_TOOLS_ENABLED = "true";
        }
    });

    it("validates createRun input: project required, mode whitelist, cross-owner 404", async () => {
        const noProject = await request("POST", "/coding/runs", ALICE, { mode: "edit" });
        expect(noProject.status).toBe(400);
        expect(noProject.body.errorCode).toBe("RUN_REQUIRES_PROJECT");

        const badMode = await request("POST", "/coding/runs", ALICE, { project_id: aliceProjId, mode: "root" });
        expect(badMode.status).toBe(400);
        expect(badMode.body.errorCode).toBe("MODE_NOT_AVAILABLE");

        // BOB cannot bind ALICE's project to a run
        const foreign = await request("POST", "/coding/runs", BOB, { project_id: aliceProjId, mode: "trusted" });
        expect(foreign.status).toBe(404);
        expect(foreign.body.errorCode).toBe("PROJECT_NOT_FOUND");
    });
});

describe("R2 provision — disposable worktree identity, main checkout untouched", () => {
    it("provisions a ready worktree from the main HEAD and leaves the main checkout clean", async () => {
        const run = await createRun("trusted", aliceProjId);
        expect(run.worktreeStatus).toBe("none");

        const prov = await request("POST", `/coding/runs/${run.id}/provision`, ALICE, {});
        expect(prov.status).toBe(200);
        const provisioned = prov.body.run;
        expect(provisioned.worktreeStatus).toBe("ready");
        expect(provisioned.worktreeBranch).toBe(`coding/run-${run.id}`);
        expect(provisioned.baseBranch).toBeTruthy();
        expect(provisioned.baseCommit).toMatch(/^[0-9a-f]{40}$/);
        expect(provisioned.baseCommit).toBe(aliceHead); // branch created from main HEAD
        expect(provisioned.baseBranch).toBe(git(aliceRepo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim());
        expect(provisioned.worktreePath).toBeTruthy();
        expect(fs.existsSync(provisioned.worktreePath)).toBe(true);
        expect(path.dirname(path.resolve(provisioned.worktreePath))).toContain(path.basename(worktreeBase));

        // main checkout byte-identical
        expectMainUnchanged(aliceRepo, aliceHead);
    });

    it("does not mutate the main checkout while a write runs in the worktree", async () => {
        const run = await createRun("trusted", aliceProjId);
        const write = await request("POST", `/coding/runs/${run.id}/ops`, ALICE, {
            op: "create_file", args: { path: "src/generated.txt", content: "made in a worktree\n" },
        });
        expect(write.status).toBe(200);
        expect(write.body.status).toBe("executed");
        expect(write.body.artifact.kind).toBe("file.create");

        expectMainUnchanged(aliceRepo, aliceHead);
    });
});

describe("R2 trusted HTTP loop — auto write + patch + read diff + artifact ledger", () => {
    it("auto-executes create_file + apply_patch in the worktree and reports the diff over /ops", async () => {
        const run = await createRun("trusted", aliceProjId);

        // 1. create_file auto-executes (trusted preset write)
        const created = await request("POST", `/coding/runs/${run.id}/ops`, ALICE, {
            op: "create_file", args: { path: "src/generated.txt", content: "// generated by the run\n" },
        });
        expect(created.status).toBe(200);
        expect(created.body.status).toBe("executed");
        expect(created.body.approval.status).toBe("approved");
        expect(created.body.approval.reason).toContain("[policy:preset]");
        expect(created.body.artifact.kind).toBe("file.create");
        expect(created.body.artifact.digest).toMatch(/^[0-9a-f]{64}$/);

        // 2. apply_patch a deterministic bug fix to a tracked file (digest-bound)
        const patch = mathBugfixPatch();
        const patched = await request("POST", `/coding/runs/${run.id}/ops`, ALICE, {
            op: "apply_patch", args: { path: "src/math.js", patch, digest: sha256File(path.join(aliceRepo, "src", "math.js")) },
        });
        expect(patched.status).toBe(200);
        expect(patched.body.status).toBe("executed");
        expect(patched.body.data.hunksApplied).toBe(1);
        expect(patched.body.artifact.kind).toBe("file.patch");
        expect(patched.body.artifact.path).toBe("src/math.js");

        // 3. the worktree diff (read op, effect read) shows the hunk
        const diff = await request("POST", `/coding/runs/${run.id}/ops`, ALICE, { op: "git.diff", args: { path: "src/math.js" } });
        expect(diff.status).toBe(200);
        expect(diff.body.ok).toBe(true);
        expect(diff.body.effect).toBe("read");
        expect(diff.body.op).toBe("git.diff");
        expect(diff.body.data.diff).toContain("-  return a - b;");
        expect(diff.body.data.diff).toContain("+  return a + b;");
        expect(diff.body.data.filesChanged).toContain("src/math.js");

        // 4. artifact ledger lists both writes with digests. Rows are keyed by a
        //    second-resolution created_at, so order is not guaranteed between two
        //    fast ops — compare as an unordered set.
        const arts = await request("GET", `/coding/runs/${run.id}/artifacts`, ALICE, null);
        expect(arts.status).toBe(200);
        expect(arts.body.artifacts.map((a) => a.kind).sort()).toEqual(["file.create", "file.patch"]);
        expect(arts.body.artifacts.map((a) => a.path).sort()).toEqual(["src/generated.txt", "src/math.js"]);
        expect(arts.body.artifacts.every((a) => a.digest && /^[0-9a-f]{64}$/.test(a.digest))).toBe(true);

        // main checkout still byte-identical
        expectMainUnchanged(aliceRepo, aliceHead);
    });
});

describe("R2 edit-mode approval loop over HTTP", () => {
    it("awaits approval (no write), resumes once on decision, second resume settles", async () => {
        const run = await createRun("edit", aliceProjId);
        const req = { op: "write_file", args: { path: "README.md", content: "# Edited over HTTP\n" } };

        // 1. ops with wait:false → awaiting_approval; file untouched in the worktree
        const awaiting = await request("POST", `/coding/runs/${run.id}/ops`, ALICE, { ...req, wait: false });
        expect(awaiting.status).toBe(200);
        expect(awaiting.body.status).toBe("awaiting_approval");
        expect(awaiting.body.approval.status).toBe("requested");
        expect(awaiting.body.run.worktreeStatus).toBe("ready");
        const worktreePath = awaiting.body.run.worktreePath;
        expect(fs.readFileSync(path.join(worktreePath, "README.md"), "utf8")).toBe("# Main repo\n");
        expect((await request("GET", `/coding/runs/${run.id}/artifacts`, ALICE, null)).body.count).toBe(0);

        const approvalId = awaiting.body.approval.id;
        const actionId = awaiting.body.action.id;

        // 2. owner decides approve (decision alone never executes)
        const decided = await request("POST", `/coding/approvals/${approvalId}/decision`, ALICE, { approve: true });
        expect(decided.status).toBe(200);
        expect(decided.body.approval.status).toBe("approved");
        expect(decided.body.action.status).toBe("approved");

        // 3. resume with the identical request → executed once
        const executed = await request("POST", `/coding/runs/${run.id}/actions/${actionId}/execute`, ALICE, req);
        expect(executed.status).toBe(200);
        expect(executed.body.status).toBe("executed");
        expect(executed.body.artifact.kind).toBe("file.write");
        expect(fs.readFileSync(path.join(worktreePath, "README.md"), "utf8")).toBe("# Edited over HTTP\n");
        expect((await request("GET", `/coding/runs/${run.id}/artifacts`, ALICE, null)).body.count).toBe(1);

        // 4. a second resume settles idempotently — no duplicate write
        const again = await request("POST", `/coding/runs/${run.id}/actions/${actionId}/execute`, ALICE, req);
        expect(again.status).toBe(200);
        expect(again.body.data).toEqual({ settled: true, state: "executed" });
        expect(fs.readFileSync(path.join(worktreePath, "README.md"), "utf8")).toBe("# Edited over HTTP\n");
        expect((await request("GET", `/coding/runs/${run.id}/artifacts`, ALICE, null)).body.count).toBe(1);

        expectMainUnchanged(aliceRepo, aliceHead);
    });
});

describe("R2 run_command over HTTP — allowlist + approval", () => {
    it("approves + executes an allowlisted node command; non-allowlisted exec is refused before any action row", async () => {
        process.env.CODING_COMMAND_ALLOWLIST = "node";
        try {
            // ── allowlisted node command ──
            const run = await createRun("trusted", aliceProjId);
            const cmd = { op: "run_command", args: { executable: "node", args: ["-e", "console.log(1+1)"], timeout_ms: 5000 } };

            const awaiting = await request("POST", `/coding/runs/${run.id}/ops`, ALICE, { ...cmd, wait: false });
            expect(awaiting.status).toBe(200);
            expect(awaiting.body.status).toBe("awaiting_approval");
            expect(awaiting.body.action.type).toBe("exec");

            const decided = await request("POST", `/coding/approvals/${awaiting.body.approval.id}/decision`, ALICE, { approve: true });
            expect(decided.status).toBe(200);

            const executed = await request("POST", `/coding/runs/${run.id}/actions/${awaiting.body.action.id}/execute`, ALICE, cmd);
            expect(executed.status).toBe(200);
            expect(executed.body.data.code).toBe(0);
            expect(executed.body.data.stdout).toContain("2");
            expect(executed.body.artifact.kind).toBe("command.output");
            expect(executed.body.artifact.meta.executable).toBe("node");
            expect(executed.body.artifact.stdout).toBeUndefined();

            // ── non-allowlisted executable (curl) → 403 before any action/approval ──
            const run2 = await createRun("trusted", aliceProjId);
            const rejected = await request("POST", `/coding/runs/${run2.id}/ops`, ALICE, {
                op: "run_command", args: { executable: "curl", args: ["-s", "http://127.0.0.1/"], timeout_ms: 5000 },
                wait: false,
            });
            expect(rejected.status).toBe(403);
            expect(rejected.body.errorCode).toBe("EXEC_NOT_ALLOWLISTED");
            const actions = await request("GET", `/coding/runs/${run2.id}/actions`, ALICE, null);
            expect(actions.body.count).toBe(0);
            const approvalsList = await request("GET", `/coding/runs/${run2.id}/approvals`, ALICE, null);
            expect(approvalsList.body.count).toBe(0);

            expectMainUnchanged(aliceRepo, aliceHead);
        } finally {
            delete process.env.CODING_COMMAND_ALLOWLIST;
        }
    });

    it("rejects an out-of-bounds command cwd with 403 PATH_TRAVERSAL at execution time", async () => {
        process.env.CODING_COMMAND_ALLOWLIST = "node";
        try {
            const run = await createRun("trusted", aliceProjId);
            const cmd = { op: "run_command", args: { executable: "node", args: ["-e", "console.log('cwd')"], cwd_relative: "../../..", timeout_ms: 5000 } };

            // The invalid cwd is only resolved at execution (claim+run), so the
            // op pauses for approval first — then execution refuses the escape.
            const awaiting = await request("POST", `/coding/runs/${run.id}/ops`, ALICE, { ...cmd, wait: false });
            expect(awaiting.status).toBe(200);
            expect(awaiting.body.status).toBe("awaiting_approval");
            await request("POST", `/coding/approvals/${awaiting.body.approval.id}/decision`, ALICE, { approve: true });

            const executed = await request("POST", `/coding/runs/${run.id}/actions/${awaiting.body.action.id}/execute`, ALICE, cmd);
            expect(executed.status).toBe(403);
            expect(executed.body.errorCode).toBe("PATH_TRAVERSAL");
            expectMainUnchanged(aliceRepo, aliceHead);
        } finally {
            delete process.env.CODING_COMMAND_ALLOWLIST;
        }
    });
});

describe("R2 two-user isolation", () => {
    it("BOB cannot read, ops, execute, or teardown ALICE's run (404/owner-filtered-empty)", async () => {
        // Give ALICE a live provisioned run with one executed artifact.
        const aliceRun = await createRun("trusted", aliceProjId);
        await request("POST", `/coding/runs/${aliceRun.id}/provision`, ALICE, {});
        const write = await request("POST", `/coding/runs/${aliceRun.id}/ops`, ALICE, {
            op: "create_file", args: { path: "src/isolation.txt", content: "alice only\n" },
        });
        expect(write.status).toBe(200);
        const aliceActions = (await request("GET", `/coding/runs/${aliceRun.id}/actions`, ALICE, null)).body.actions;

        // hard 404s through fetchRunProject
        expect((await request("GET", `/coding/runs/${aliceRun.id}`, BOB, null)).status).toBe(404);
        expect((await request("GET", `/coding/runs/${aliceRun.id}/artifacts`, BOB, null)).status).toBe(404);
        expect((await request("POST", `/coding/runs/${aliceRun.id}/teardown`, BOB, {})).status).toBe(404);
        expect((await request("POST", `/coding/runs/${aliceRun.id}/ops`, BOB, { op: "git.status", args: {} })).status).toBe(404);
        expect((await request("POST", `/coding/runs/${aliceRun.id}/ops`, BOB, { op: "create_file", args: { path: "x", content: "y" } })).status).toBe(404);
        expect((await request("POST", `/coding/runs/${aliceRun.id}/actions/${aliceActions[0].id}/execute`, BOB, { op: "create_file", args: { path: "src/isolation.txt", content: "alice only\n" } })).status).toBe(404);
        expect((await request("GET", `/coding/runs/${aliceRun.id}/events?after_seq=0`, BOB, null)).status).toBe(404);

        // owner-filtered list endpoints: 200 but BOB sees nothing of ALICE's run
        const bobActions = await request("GET", `/coding/runs/${aliceRun.id}/actions`, BOB, null);
        expect(bobActions.status).toBe(200);
        expect(bobActions.body.count).toBe(0);
        const bobApprovals = await request("GET", `/coding/runs/${aliceRun.id}/approvals`, BOB, null);
        expect(bobApprovals.body.count).toBe(0);

        // BOB cannot decide ALICE's approval
        const bobDecision = await request("POST", `/coding/approvals/${write.body.approval.id}/decision`, BOB, { approve: true });
        expect(bobDecision.status).toBe(404);

        // BOB's own repo/run still works — isolation is scope-based, not global
        const bobRunRes = await request("POST", "/coding/runs", BOB, { project_id: bobProjId, mode: "trusted" });
        expect(bobRunRes.status).toBe(201);
        trackedRuns.push({ owner: "bob", id: bobRunRes.body.run.id });
        const bobWrite = await request("POST", `/coding/runs/${bobRunRes.body.run.id}/ops`, BOB, {
            op: "create_file", args: { path: "b-new.txt", content: "bob wrote this\n" },
        });
        expect(bobWrite.status).toBe(200);
        expect(bobWrite.body.status).toBe("executed");

        expectMainUnchanged(aliceRepo, aliceHead);
    });
});

describe("R2 teardown", () => {
    it("removes the disposable worktree and leaves the main checkout clean at its base commit", async () => {
        const run = await createRun("trusted", aliceProjId);
        const prov = await request("POST", `/coding/runs/${run.id}/provision`, ALICE, {});
        expect(prov.body.run.worktreeStatus).toBe("ready");
        const worktreePath = prov.body.run.worktreePath;
        await request("POST", `/coding/runs/${run.id}/ops`, ALICE, {
            op: "create_file", args: { path: "src/throwaway.txt", content: "to be removed\n" },
        });
        expect(fs.existsSync(path.join(worktreePath, "src", "throwaway.txt"))).toBe(true);

        const down = await request("POST", `/coding/runs/${run.id}/teardown`, ALICE, {});
        expect(down.status).toBe(200);
        expect(down.body.run.worktreeStatus).toBe("removed");
        expect(fs.existsSync(worktreePath)).toBe(false);

        // nothing leaked into the main checkout, and its commit is the base commit
        expectMainUnchanged(aliceRepo, aliceHead);
        expect(down.body.run.baseCommit).toBe(aliceHead);
    });
});

describe("R2 capability enforcement", () => {
    it("denies writes for an edit-mode run on an untrusted project (PROJECT_NOT_TRUSTED)", async () => {
        const res = await request("POST", "/coding/runs", ALICE, { project_id: untrustedProjId, mode: "edit" });
        expect(res.status).toBe(201);
        trackedRuns.push({ owner: "alice", id: res.body.run.id });
        const runId = res.body.run.id;

        const provision = await request("POST", `/coding/runs/${runId}/provision`, ALICE, {});
        expect(provision.status).toBe(403);
        expect(provision.body.errorCode).toBe("PROJECT_NOT_TRUSTED");

        const op = await request("POST", `/coding/runs/${runId}/ops`, ALICE, {
            op: "write_file", args: { path: "README.md", content: "nope" }, wait: false,
        });
        expect(op.status).toBe(403);
        expect(op.body.errorCode).toBe("PROJECT_NOT_TRUSTED");
    });
});

describe("R2 observe-mode reads (backward compat at the main checkout)", () => {
    it("serves read ops on the main checkout without provisioning a worktree", async () => {
        const run = await createRun("observe", aliceProjId);

        const status = await request("POST", `/coding/runs/${run.id}/ops`, ALICE, { op: "git.status", args: {} });
        expect(status.status).toBe(200);
        expect(status.body.ok).toBe(true);
        expect(status.body.effect).toBe("read");
        expect(status.body.data.clean).toBe(true);
        expect(status.body.data.commit).toBe(aliceHead);

        const read = await request("POST", `/coding/runs/${run.id}/ops`, ALICE, { op: "read_file", args: { path: "src/app.js" } });
        expect(read.status).toBe(200);
        expect(read.body.data.lines.join("\n")).toBe("export const app = 'original';");

        // an observe run stays read-only on the main checkout: no worktree identity
        const prov = await request("POST", `/coding/runs/${run.id}/provision`, ALICE, {});
        expect(prov.status).toBe(200);
        expect(prov.body.run.worktreeStatus).toBe("none");

        expectMainUnchanged(aliceRepo, aliceHead);
    });
});
