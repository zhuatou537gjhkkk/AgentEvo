import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { initDB, createUser, createSession } from "../db/index.js";
import { clearCodingFlags } from "./flags.js";
import { defaultProjectService } from "./projects.js";
import { defaultRunService } from "./runs.js";
import { defaultWorktreeService } from "./worktrees.js";
import { defaultLandToMainService } from "./landToMain.js";

/**
 * Phase 7 / R7 — landToMain: apply a completed run's disposable-worktree changes
 * onto the REAL project checkout working tree (no commit, no staging on main).
 * The disposable-worktree isolation stays intact while the run executes; this is
 * the owner-invoked bridge that turns a finished run's diff into real file
 * changes. Tests run against a real temp git repo + a real provisioned worktree
 * (same repo, same as production), so landing is verified byte-for-byte.
 */
const OWNER = { name: "land_owner", username: "landowner" };
const tmp = [];
let allowedBase = "";
let worktreeBase = "";
let repoDir = "";
let projectId = "";

function git(cwd, args) {
    return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
}

function tmpDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmp.push(dir);
    return dir;
}

function scope() {
    return { userId: OWNER.id };
}

beforeAll(async () => {
    initDB();
    OWNER.id = createUser(OWNER.name, "hash-land");
    createSession(OWNER.id, "land session");

    allowedBase = tmpDir("agentevo-land-allowed-");
    worktreeBase = tmpDir("agentevo-land-wtbase-");
    repoDir = path.join(allowedBase, "repo");
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(
        path.join(repoDir, "src", "calc.js"),
        "export function add(a, b) {\n  return a - b; // BUG\n}\n",
    );
    git(repoDir, ["init", "-q", "-b", "main"]);
    git(repoDir, ["config", "core.autocrlf", "false"]); // deterministic LF round-trip in tests
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["-c", "user.name=T", "-c", "user.email=t@local", "commit", "-q", "-m", "seed"]);

    process.env.CODING_WORKSPACE_ENABLED = "true";
    process.env.CODING_WRITE_TOOLS_ENABLED = "true";
    process.env.CODING_COMMAND_TOOLS_ENABLED = "true";
    process.env.CODING_ALLOWED_ROOTS = allowedBase;
    process.env.CODING_WORKTREE_BASE = worktreeBase;

    const created = defaultProjectService.register(scope(), { name: "land repo", rootPath: repoDir });
    defaultProjectService.update(scope(), created.id, { trusted: true });
    projectId = created.id;
});

afterAll(async () => {
    clearCodingFlags();
    for (const dir of tmp) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

function mainPorcelain() {
    return execFileSync("git", ["-c", "core.autocrlf=false", "status", "--porcelain"], {
        cwd: repoDir, encoding: "utf8",
    });
}

async function makeCompletedTrustedRunWithChanges() {
    const project = defaultProjectService.get(scope(), projectId);
    const run = defaultRunService.createRun(scope(), { projectId, mode: "trusted" });
    const provisioned = await defaultWorktreeService.provision(scope(), { project, run });
    const wt = provisioned.worktreePath;
    // A brand-new file + a tracked-file modification, exactly what the agent would do.
    fs.writeFileSync(path.join(wt, "coding-agent-smoke.txt"), "coding-agent smoke test\n");
    fs.writeFileSync(
        path.join(wt, "src", "calc.js"),
        "export function add(a, b) {\n  return a + b;\n}\n",
    );
    defaultRunService.completeRun(scope(), run.id);
    return { project, run: defaultRunService.getRun(scope(), run.id) };
}

describe("landToMain — completed run changes onto the real checkout working tree", () => {
    it("lands a new file + a modification into the real repo working tree, WITHOUT committing or staging", async () => {
        const { project, run } = await makeCompletedTrustedRunWithChanges();
        const beforeHead = git(repoDir, ["rev-parse", "HEAD"]).trim();

        const result = await defaultLandToMainService.land(scope(), { run, project });

        expect(result.applied).toBe(true);
        expect(result.method).toBe("working_tree");
        expect(result.counts.changed).toBeGreaterThanOrEqual(2);
        const paths = result.files.map((f) => f.path);
        expect(paths).toContain("coding-agent-smoke.txt");
        expect(paths).toContain("src/calc.js");

        // Real repo files now physically changed.
        expect(fs.readFileSync(path.join(repoDir, "coding-agent-smoke.txt"), "utf8")).toBe("coding-agent smoke test\n");
        expect(fs.readFileSync(path.join(repoDir, "src", "calc.js"), "utf8")).toContain("return a + b;");

        // But nothing was committed and nothing is staged on main.
        const porcelain = mainPorcelain();
        expect(porcelain).toContain("?? coding-agent-smoke.txt");
        expect(porcelain).toContain(" M src/calc.js");
        expect(porcelain.split("\n").some((l) => /^[MADR] /.test(l))).toBe(false); // no staged entries
        expect(git(repoDir, ["rev-parse", "HEAD"]).trim()).toBe(beforeHead);
    });

    it("refuses a run that has not completed", async () => {
        const project = defaultProjectService.get(scope(), projectId);
        const run = defaultRunService.createRun(scope(), { projectId, mode: "trusted" });
        const provisioned = await defaultWorktreeService.provision(scope(), { project, run });
        fs.writeFileSync(path.join(provisioned.worktreePath, "late.txt"), "x\n");
        await expect(
            defaultLandToMainService.land(scope(), { run: defaultRunService.getRun(scope(), run.id), project }),
        ).rejects.toMatchObject({ code: "RUN_NOT_COMPLETED" });
    });
});
