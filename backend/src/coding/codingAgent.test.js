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
import { CodeAgentService, defaultCodingAgentService, resolveCodingRunTask } from "./codingAgent.js";
import { createOpScheduler } from "./opScheduler.js";
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
    it("uses safe defaults when the resolver supplies a null budget", () => {
        const service = new CodeAgentService();
        const session = service.begin({ userId: OWNER.id }, {
            run: { id: "run_null_budget", projectId },
            project: { id: projectId },
            goal: "smoke",
            decide: async () => ({ type: "done", summary: "ok" }),
            budget: null,
        });
        expect(session.budget.maxTurns).toBe(8);
        expect(session.budget.maxActions).toBe(24);
    });

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
            // Transcript: read + trusted write + owner-approved command resume = 3
            // steps. Every EXECUTED op now reports ok:true (read + write + resume),
            // so completion guards / the decider ctx can tell the work actually ran.
            expect(finalSnap.result.stepCount).toBe(3);
            expect(session.steps.filter((s) => s.ok === true).length).toBe(3);
            // Budgets held: 3 ops + 1 resume, well under caps.
            expect(finalSnap.actionCount).toBeLessThanOrEqual(6);
            expect(mainStatus()).toBe(""); // main checkout zero changes
        } finally {
            clearCommandAllowlistOverride();
        }
    });

    it("forces exactly ONE create-file write for the smoke goal even when the decider says done, then completes cleanly", async () => {
        // Regression: the create-file guard (requiredFileWrite) must fire, the write
        // must land ok:true, and the NEXT turn the guard must see it done instead of
        // re-firing the same write until the turn budget halts the session. A decider
        // that would immediately answer `done` proves the guard — not the model —
        // drives the mutation.
        const run = defaultRunService.createRun({ userId: OWNER.id }, { projectId, mode: "trusted" });
        const goal = "请在当前项目根目录创建一个文件 coding-agent-smoke.txt，只写入一行：coding-agent smoke test。不要修改其他文件，也不要执行命令。";
        const decider = async () => ({ type: "done", summary: "already satisfied" });
        const session = defaultCodingAgentService.begin({ userId: OWNER.id }, {
            run,
            project: defaultProjectService.get({ userId: OWNER.id }, projectId),
            goal,
            decide: decider,
            budget: { maxTurns: 8, maxActions: 12 },
        });
        const snap = await defaultCodingAgentService.run(session);

        expect(snap.phase).toBe("done");
        const writes = session.steps.filter((s) => s.op === "create_file");
        expect(writes).toHaveLength(1);
        expect(writes[0].ok).toBe(true);
        // The file actually landed in the run's disposable worktree; main checkout untouched.
        const runFresh = defaultRunService.getRun({ userId: OWNER.id }, run.id);
        const created = path.join(runFresh.worktreePath, "coding-agent-smoke.txt");
        expect(fs.readFileSync(created, "utf8")).toBe("coding-agent smoke test\n");
        expect(mainStatus()).toBe("");
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

    // R3 — batch op scheduler seam (opScheduler.js). The R2 loop above stays strictly
    // sequential; a multi-op `ops` decision only parallelizes ALL-READ sets when the
    // session carries an opScheduler AND CODING_BATCH_READS is enabled. These tests
    // drive the seam through a fake read runner (deterministic concurrency counting)
    // so no worktree/DB mutation is involved.
    function countingReadRunner(maxActiveBox) {
        return {
            async runOp(_scope, { request }) {
                const op = request.op;
                maxActiveBox.active += 1;
                maxActiveBox.max = Math.max(maxActiveBox.max, maxActiveBox.active);
                maxActiveBox.order.push(`start:${op}`);
                await new Promise((resolve) => setTimeout(resolve, 20));
                maxActiveBox.order.push(`end:${op}`);
                maxActiveBox.active -= 1;
                return { ok: true, effect: "read", op, data: { ok: 1 } };
            },
        };
    }

    function batchedDecider(entries) {
        let calls = 0;
        return async () => {
            calls += 1;
            if (calls === 1) return { type: "ops", ops: entries };
            return { type: "done", summary: "batched reads observed" };
        };
    }

    it("runs an all-read 'ops' decision as one parallel wave when CODING_BATCH_READS is on", async () => {
        const box = { active: 0, max: 0, order: [] };
        const service = new CodeAgentService({ runRunner: countingReadRunner(box), opScheduler: createOpScheduler() });
        const session = service.begin({ userId: OWNER.id }, {
            run: { id: "run_batch_on", projectId },
            project: { id: projectId },
            goal: "read three files",
            decide: batchedDecider([
                { op: "read_file", args: { path: "a.js" }, note: "r-a" },
                { op: "read_file", args: { path: "b.js" }, note: "r-b" },
                { op: "read_file", args: { path: "c.js" }, note: "r-c" },
            ]),
            budget: { maxTurns: 6, maxActions: 12 },
        });
        process.env.CODING_BATCH_READS = "true";
        try {
            const snap = await service.run(session);
            expect(snap.phase).toBe("done");
            expect(box.max).toBe(3); // all three reads overlapped → real parallel dispatch
            const ops = session.steps.filter((s) => s.op).map((s) => s.op);
            expect(ops).toEqual(["read_file", "read_file", "read_file"]); // original order kept
            expect(session.steps.filter((s) => s.type === "op")).toHaveLength(3);
        } finally {
            delete process.env.CODING_BATCH_READS;
        }
    });

    it("keeps an all-read 'ops' decision strictly sequential when the flag is off (default)", async () => {
        const box = { active: 0, max: 0, order: [] };
        const service = new CodeAgentService({ runRunner: countingReadRunner(box), opScheduler: createOpScheduler() });
        const session = service.begin({ userId: OWNER.id }, {
            run: { id: "run_batch_off", projectId },
            project: { id: projectId },
            goal: "read three files",
            decide: batchedDecider([
                { op: "read_file", args: { path: "a.js" } },
                { op: "read_file", args: { path: "b.js" } },
                { op: "read_file", args: { path: "c.js" } },
            ]),
            budget: { maxTurns: 6, maxActions: 12 },
        });
        delete process.env.CODING_BATCH_READS; // default-off
        try {
            const snap = await service.run(session);
            expect(snap.phase).toBe("done");
            expect(box.max).toBe(1); // sequential executor path
            expect(session.steps.filter((s) => s.op)).toHaveLength(3);
        } finally {
            delete process.env.CODING_BATCH_READS;
        }
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

describe("R5 — read observation feed (ctx.observations, never durable)", () => {
    it("feeds read content to the decider and shows the WORKTREE state after a write (refresh)", async () => {
        const run = defaultRunService.createRun({ userId: OWNER.id }, { projectId, mode: "trusted" });
        const FIXED = "// intent: return a + b\nexport function add(a, b) {\n  return a + b;\n}\n";
        const seen = []; // [label, [...ctx.observations]]
        let phase = 0;
        const decider = async (ctx) => {
            const obs = Array.isArray(ctx.observations) ? [...ctx.observations] : [];
            if (phase === 0) { phase = 1; seen.push(["read1", obs]); return { type: "op", op: "read_file", args: { path: "src/calc.js" }, note: "read bug" }; }
            if (phase === 1) { phase = 2; seen.push(["beforeWrite", obs]); return { type: "op", op: "write_file", args: { path: "src/calc.js", content: FIXED }, note: "fix sign" }; }
            if (phase === 2) { phase = 3; seen.push(["read2", obs]); return { type: "op", op: "read_file", args: { path: "src/calc.js" }, note: "read fixed" }; }
            seen.push(["done", obs]); return { type: "done", summary: "confirmed calc.js fixed in worktree" };
        };

        const session = defaultCodingAgentService.begin({ userId: OWNER.id }, {
            run,
            project: defaultProjectService.get({ userId: OWNER.id }, projectId),
            goal: "fix calc.js",
            decide: decider,
            budget: { maxTurns: 8, maxActions: 12 },
        });
        const snap = await defaultCodingAgentService.run(session);
        expect(snap.phase).toBe("done");

        // ctx.observations reach the decision layer WITHOUT file content ever being
        // persisted to a step note / transcript.
        const seenMap = Object.fromEntries(seen);
        // First read (main checkout — worktree not provisioned yet) saw the buggy line.
        expect(seenMap.beforeWrite.join("")).toContain("return a - b; // BUG");
        // Second read (after the write) saw the FIXED line → _refreshRunState re-pinned
        // capabilityRoot to the freshly-provisioned worktree.
        expect(seenMap.done.join("")).toContain("return a + b;");
        expect(session.observations.length).toBeGreaterThanOrEqual(2);

        // Observations live ONLY on the session — steps keep just the decider note.
        for (const step of session.steps) {
            const text = `${step.note || ""} ${step.summary || ""}`;
            expect(text).not.toContain("return a + b;");
            expect(text).not.toContain("// BUG");
        }
        expect(mainStatus()).toBe(""); // main checkout zero changes
    });

    it("does not count observation snippets toward the transcript budget", async () => {
        const run = defaultRunService.createRun({ userId: OWNER.id }, { projectId, mode: "trusted" });
        const decider = async (ctx) => {
            if (ctx.turn === 1) return { type: "op", op: "read_file", args: { path: "src/calc.js" }, note: "n" };
            return { type: "done", summary: "d" };
        };
        const session = defaultCodingAgentService.begin({ userId: OWNER.id }, {
            run,
            project: defaultProjectService.get({ userId: OWNER.id }, projectId),
            goal: "observe",
            decide: decider,
            budget: { maxTurns: 4 },
        });
        const snap = await defaultCodingAgentService.run(session);
        expect(snap.phase).toBe("done");
        const obsChars = session.observations.join("").length;
        expect(obsChars).toBeGreaterThan(0);
        // transcriptChars tracks ONLY step notes/summaries — never the obs snippets.
        expect(session.transcriptChars).toBeLessThan(obsChars);
    });
});

describe("R5 — graph adapter + run lifecycle (real run → completed)", () => {
    it("runCodingAgentNode completes the run row when the bounded loop finishes", async () => {
        const run = defaultRunService.createRun({ userId: OWNER.id }, { projectId, mode: "trusted" });
        const FIXED = "// intent: return a + b\nexport function add(a, b) {\n  return a + b;\n}\n";
        const steps = [
            { type: "op", op: "read_file", args: { path: "src/calc.js" }, note: "read bug" },
            { type: "op", op: "write_file", args: { path: "src/calc.js", content: FIXED }, note: "fix sign" },
            { type: "op", op: "git.diff", args: {}, note: "confirm" },
            { type: "done", summary: "fixed calc.js in the worktree (auto-decider mode)" },
        ];
        let i = 0;
        const decider = async () => steps[Math.min(i++, steps.length - 1)];
        const state = { userInput: "fix calc", plan: [], subTasks: [], currentSubTask: null };
        const result = await runCodingAgentNode(state, { configurable: {} }, {
            active: true,
            scope: { userId: OWNER.id },
            run,
            project: defaultProjectService.get({ userId: OWNER.id }, projectId),
            preset: "trusted",
            goal: "fix calc",
            budget: { maxTurns: 8, maxActions: 12 },
            runService: defaultRunService,
            lifecycle: true, // ← node must converge the durable run row
            decider,
        });
        expect(result.codeResults).toContain("fixed calc.js");
        // Durable run is now terminal/completed.
        const fresh = defaultRunService.getRun({ userId: OWNER.id }, run.id);
        expect(fresh.status).toBe("completed");
        // The write landed in the worktree (never the main checkout), and the diff is
        // reviewable via the run's git.diff read op.
        const worktreeFile = path.join(fresh.worktreePath, "src", "calc.js");
        expect(fs.readFileSync(worktreeFile, "utf8")).toContain("return a + b;");
        expect(mainStatus()).toBe("");
    });

    it("converges a loop that halts on a budget to failed — never dangles", async () => {
        const run = defaultRunService.createRun({ userId: OWNER.id }, { projectId, mode: "trusted" });
        const decider = async () => ({ type: "op", op: "read_file", args: { path: "no-such-file.js" } });
        const state = { userInput: "boom", plan: [], subTasks: [], currentSubTask: null };
        await runCodingAgentNode(state, { configurable: {} }, {
            active: true,
            scope: { userId: OWNER.id },
            run,
            project: defaultProjectService.get({ userId: OWNER.id }, projectId),
            preset: "trusted",
            goal: "boom",
            budget: { maxTurns: 20, maxActions: 20 },
            runService: defaultRunService,
            lifecycle: true,
            decider,
        });
        const fresh = defaultRunService.getRun({ userId: OWNER.id }, run.id);
        expect(fresh.status).toBe("failed");
        expect(mainStatus()).toBe("");
    });
});
