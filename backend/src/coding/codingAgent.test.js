import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { initDB, createUser, createSession } from "../db/index.js";
import { clearCodingFlags } from "./flags.js";
import { defaultProjectService } from "./projects.js";
import { defaultRunService } from "./runs.js";
import { defaultApprovalService } from "./approvals.js";
import { setCommandAllowlistOverride, clearCommandAllowlistOverride } from "./runner/commandRunner.js";
import { defaultCodingAgentService, resolveCodingRunTask } from "./codingAgent.js";
import { codeAgentNode, runCodingAgentNode } from "../services/chatGraph.js";

/**
 * Phase 7 / R2 — bounded CodeAgentService + server /chat gate + code_agent thin adapter.
 *
 * The bounded loop (context→plan→action→observe→verify→summary) is driven by an
 * INJECTED decider (LLM-agnostic): the tests script the decider, so the DoD path —
 * fix a deterministic bug in a disposable worktree, pause for an owner-approved
 * targeted command, resume, summarize — is reproducible without a model. Every
 * write/exec op goes through the run-scoped runner, so the worktree is the only
 * mutated tree and the main checkout stays byte-identical.
 */
const OWNER = { name: "coding_agent_owner", username: "caowner" };
const tmp = [];
let allowedBase = "";
let repoDir = "";
let worktreeBase = "";
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

function registerTrustedRepo(userId, rootPath, name) {
    const created = defaultProjectService.register({ userId }, { name, rootPath });
    defaultProjectService.update({ userId }, created.id, { trusted: true });
    return created.id;
}

async function setFlags(on = true) {
    process.env.CODING_WORKSPACE_ENABLED = String(on);
    process.env.CODING_WRITE_TOOLS_ENABLED = String(on);
    process.env.CODING_COMMAND_TOOLS_ENABLED = String(on);
    process.env.CODING_ALLOWED_ROOTS = allowedBase;
    process.env.CODING_WORKTREE_BASE = worktreeBase;
}

beforeAll(async () => {
    initDB();
    OWNER.id = createUser(OWNER.name, "hash-ca");
    createSession(OWNER.id, "coding agent session");

    allowedBase = tmpDir("agentevo-ca-allowed-");
    worktreeBase = tmpDir("agentevo-ca-wtbase-");
    repoDir = path.join(allowedBase, "repo");
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(
        path.join(repoDir, "src", "calc.js"),
        "// intent: return a + b\nexport function add(a, b) {\n  return a - b; // BUG: wrong sign\n}\n",
    );
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["-c", "user.name=T", "-c", "user.email=t@local", "commit", "-q", "-m", "seed"]);

    await setFlags(true);
    projectId = registerTrustedRepo(OWNER.id, repoDir, "agent repo");
});

afterAll(async () => {
    clearCommandAllowlistOverride();
    clearCodingFlags();
    for (const dir of tmp) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

function mainStatus() {
    return execFileSync("git", ["-c", "core.autocrlf=false", "status", "--porcelain"], {
        cwd: repoDir, encoding: "utf8",
    });
}

describe("resolveCodingRunTask — server /chat coding-execution gate", () => {
    it("refuses without an explicit run id", async () => {
        const out = await resolveCodingRunTask({}, { userId: OWNER.id }, { runId: null });
        expect(out.active).toBe(false);
        expect(out.reason).toBe("no_run_id");
    });

    it("refuses when the coding/write capabilities are disabled", async () => {
        const run = defaultRunService.createRun({ userId: OWNER.id }, { projectId, mode: "trusted" });
        delete process.env.CODING_WRITE_TOOLS_ENABLED;
        delete process.env.CODING_WORKSPACE_ENABLED;
        try {
            const out = await resolveCodingRunTask({}, { userId: OWNER.id }, { runId: run.id });
            expect(out.active).toBe(false);
            expect(out.reason).toBe("coding_disabled");
        } finally {
            await setFlags(true);
        }
    });

    it("an observe run can never enable execution (reason 'observe')", async () => {
        const run = defaultRunService.createRun({ userId: OWNER.id }, { projectId, mode: "observe" });
        const out = await resolveCodingRunTask({}, { userId: OWNER.id }, { runId: run.id });
        expect(out.active).toBe(false);
        expect(out.reason).toBe("observe");
    });

    it("a write-enabled run on an UNTRUSTED project is refused", async () => {
        const untrustedRoot = path.join(allowedBase, "untrusted-repo");
        fs.mkdirSync(untrustedRoot, { recursive: true });
        const untrustedId = defaultProjectService.register({ userId: OWNER.id }, { name: "untrusted", rootPath: untrustedRoot }).id;
        const run = defaultRunService.createRun({ userId: OWNER.id }, { projectId: untrustedId, mode: "edit" });
        const out = await resolveCodingRunTask({}, { userId: OWNER.id }, { runId: run.id });
        expect(out.active).toBe(false);
        expect(out.reason).toBe("project_not_trusted");
    });

    it("an explicit trusted edit run on a trusted project passes the gate", async () => {
        const run = defaultRunService.createRun({ userId: OWNER.id }, { projectId, mode: "edit" });
        const out = await resolveCodingRunTask({}, { userId: OWNER.id }, { runId: run.id, goal: "fix calc" });
        expect(out.active).toBe(true);
        expect(out.reason).toBeNull();
        expect(out.scope.userId).toBe(OWNER.id);
        expect(out.run.id).toBe(run.id);
        expect(out.project.id).toBe(projectId);
        expect(out.preset).toBe("edit");
        expect(out.goal).toBe("fix calc");
    });
});

describe("CodeAgentService — bounded, resumable coding loop over a disposable worktree", () => {
    it("fixes a deterministic bug in the worktree, pauses for an approved command, resumes and summarizes", async () => {
        setCommandAllowlistOverride(["node"]);
        try {
            const run = defaultRunService.createRun({ userId: OWNER.id }, { projectId, mode: "trusted" });
            const FIXED = "// intent: return a + b\nexport function add(a, b) {\n  return a + b;\n}\n";
            const script = [
                { type: "op", op: "read_file", args: { path: "src/calc.js" }, note: "observe the buggy file" },
                { type: "op", op: "write_file", args: { path: "src/calc.js", content: FIXED }, note: "fix the wrong sign" },
                { type: "op", op: "run_command", args: { executable: "node", args: ["-e", "console.log(2+2)"] }, note: "targeted verification command" },
                { type: "done", summary: "fixed calc.js and verified add() returns the sum" },
            ];
            let i = 0;
            const decider = async () => script[Math.min(i++, script.length - 1)];

            const session = defaultCodingAgentService.begin({ userId: OWNER.id }, {
                run,
                project: defaultProjectService.get({ userId: OWNER.id }, projectId),
                goal: "fix calc.js wrong sign",
                decide: decider,
                budget: { maxTurns: 8, maxActions: 12 },
            });

            // First pass: read + trusted auto-write land; the command needs owner approval → pause.
            const snap = await defaultCodingAgentService.run(session);
            expect(snap.phase).toBe("awaiting_owner_decision");
            expect(snap.pending.actionId).toBeTruthy();
            expect(snap.pending.op).toBe("run_command");

            // The worktree already holds the fixed file (write was auto-approved) and
            // the main checkout is untouched. A durable approval row is open for the command.
            const runFresh = defaultRunService.getRun({ userId: OWNER.id }, run.id);
            expect(runFresh.worktreeStatus).toBe("ready");
            const worktreeFile = path.join(runFresh.worktreePath, "src", "calc.js");
            expect(fs.readFileSync(worktreeFile, "utf8")).toContain("return a + b;");
            expect(mainStatus()).toBe("");
            const open = defaultApprovalService.listApprovals({ userId: OWNER.id }, { runId: run.id, status: "requested" });
            expect(open.length).toBeGreaterThan(0);
            const approval = open[0];

            // Owner approves; resume re-supplies the IDENTICAL op/args → executes once.
            defaultApprovalService.decide({ userId: OWNER.id }, approval.id, {
                approve: true, decidedBy: OWNER.id, reason: "owner approves verification",
            });
            const finalSnap = await defaultCodingAgentService.resume(session, {
                op: "run_command",
                args: { executable: "node", args: ["-e", "console.log(2+2)"] },
            });

            expect(finalSnap.phase).toBe("done");
            expect(finalSnap.summary).toContain("fixed calc.js");
            expect(finalSnap.result).toBeTruthy();
            expect(finalSnap.result.codeResults).toContain("fixed calc.js");
            // Graph-compatible shape preserved for the Synthesizer:
            expect(finalSnap.result.planResults).toBeTruthy();
            expect(Array.isArray(finalSnap.result.subTasks)).toBe(true);
            expect(finalSnap.result.subTasks[0].status).toBe("completed");
            expect(finalSnap.result.tokenUsage).toBeNull();
            // Transcript: read + trusted write + owner-approved command resume = 3 steps;
            // the resume step is the one that reports ok:true (approved side effect ran).
            expect(finalSnap.result.stepCount).toBe(3);
            expect(session.steps.filter((s) => s.ok === true).length).toBe(1);
            // Budgets held: 3 ops + 1 resume, well under caps.
            expect(finalSnap.actionCount).toBeLessThanOrEqual(6);
            expect(mainStatus()).toBe(""); // main checkout zero changes
        } finally {
            clearCommandAllowlistOverride();
        }
    });

    it("halts on the repeated-failure budget when the same op keeps failing", async () => {
        const run = defaultRunService.createRun({ userId: OWNER.id }, { projectId, mode: "trusted" });
        const decider = async () => ({ type: "op", op: "read_file", args: { path: "does-not-exist.js" } });
        const session = defaultCodingAgentService.begin({ userId: OWNER.id }, {
            run,
            project: defaultProjectService.get({ userId: OWNER.id }, projectId),
            goal: "boundedness",
            decide: decider,
            budget: { maxTurns: 20 },
        });
        const snap = await defaultCodingAgentService.run(session);
        expect(snap.phase).toBe("budget_halted");
        expect(snap.haltReason).toBe("repeatedFailure");
    });

    it("halts on maxTurns when the decider never finishes", async () => {
        const run = defaultRunService.createRun({ userId: OWNER.id }, { projectId, mode: "observe" });
        const decider = async () => ({ type: "op", op: "list_tree", args: { path: "" } });
        const session = defaultCodingAgentService.begin({ userId: OWNER.id }, {
            run,
            project: defaultProjectService.get({ userId: OWNER.id }, projectId),
            goal: "budget",
            decide: decider,
            budget: { maxTurns: 3, maxActions: 100 },
        });
        const snap = await defaultCodingAgentService.run(session);
        expect(snap.phase).toBe("budget_halted");
        expect(snap.haltReason).toBe("maxTurns");
    });
});

describe("code_agent thin adapter (graph)", () => {
    it("delegates to the bounded coding node when a server coding task is attached — and never calls the LLM", async () => {
        let llmCalled = false;
        const config = {
            configurable: {
                makeLlm: async () => { llmCalled = true; throw new Error("LLM must not be called on the coding branch"); },
                codingTask: {
                    active: true,
                    scope: { userId: OWNER.id },
                    run: { id: "run_stub" },
                    project: { id: "proj_stub" },
                    goal: "summarize only",
                    decider: async () => ({ type: "done", summary: "no ops needed" }),
                },
            },
        };
        const state = { userInput: "summarize only", plan: [], subTasks: [], currentSubTask: null };
        const result = await codeAgentNode(state, config);
        expect(llmCalled).toBe(false);
        expect(result.currentAgent).toBe("code");
        expect(typeof result.codeResults).toBe("string");
        expect(result.codeResults).toContain("no ops needed");
    });

    it("runCodingAgentNode returns a graph-compatible partial (codeResults + planResults + subTasks)", async () => {
        const config = { configurable: {} };
        const state = { userInput: "fix it", plan: [], subTasks: [], currentSubTask: null };
        const result = await runCodingAgentNode(state, config, {
            active: true,
            scope: { userId: OWNER.id },
            run: { id: "run_stub" },
            project: { id: "proj_stub" },
            goal: "fix it",
            decider: async () => ({ type: "done", summary: "fixed in worktree" }),
        });
        expect(result.codeResults).toContain("fixed in worktree");
        expect(result.plan).toEqual([]);
        expect(result.tokenUsage).toBeNull();
    });
});
