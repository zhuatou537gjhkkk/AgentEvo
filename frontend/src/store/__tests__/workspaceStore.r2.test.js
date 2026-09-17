/**
 * Phase 7 / R2 — workspaceStore write-run control 单元测试.
 *
 * node 环境（无 jsdom），镜像 chatStore.observability.test.js 的模式：mock
 * `globalThis.fetch` 而不 mock store 模块内部。覆盖：
 *   - 写 run 创建按 capabilities.writeTools 门控；
 *   - awaiting_approval → 批准并执行 → 用与提交时一致的 op/args 走 execute；
 *   - 命令操作审批后执行，live stdout/stderr 被记住（digest 不落库、参数仅存内存）；
 *   - 拒绝审批只记录 denial 并清除该 action 的 live args；
 *   - 重连刷新（refreshRunDetail）只读重拉，不重复执行已批准 action；
 *   - artifacts/changed-files 由 store 数据派生（file artifact → 变更路径，命令 artifact 排除）。
 *
 * 运行: npx vitest run src/store/__tests__/workspaceStore.r2.test.js
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useWorkspaceStore } from "../workspaceStore";
import { artifactChangedFiles, isCommandArtifact } from "../../utils/workspaceModel";

const getState = () => useWorkspaceStore.getState();

const originalFetch = globalThis.fetch;

// ── server fixtures (shapes mirror backend codingRoutes/approvals/artifacts) ──
const PROJECT = { id: "proj_1", name: "proj-1", status: "trusted", trusted: true, rootPath: "C:/repo" };
const CAPS_ALL = { workspace: true, eventLog: true, runner: true, writeTools: true, commandTools: true };

function makeRun(over) {
    return {
        id: "run_1",
        projectId: "proj_1",
        sessionId: null,
        status: "created",
        mode: "edit",
        preset: "edit",
        snapshot: {},
        eventSeq: 0,
        cancelled: false,
        errorCode: null,
        worktreePath: null,
        worktreeBranch: null,
        baseBranch: null,
        baseCommit: null,
        worktreeStatus: "none",
        provisionedAt: null,
        createdAt: "2026-09-06 10:00:00",
        startedAt: null,
        completedAt: null,
        updatedAt: "2026-09-06 10:00:00",
        ...over,
    };
}

const RUN_CREATED = makeRun({});

function actionRow(over) {
    return {
        id: "act_1", runId: "run_1", seq: 1, type: "write", tool: "write_file",
        input: { op: "write_file", path: "a.txt", bytes: 2 },
        status: "requested", timeoutMs: null, approvalId: "appr_1", errorCode: null,
        createdAt: "2026-09-06 10:00:00", updatedAt: "2026-09-06 10:00:00",
        ...over,
    };
}

function approvalRow(over) {
    return {
        id: "appr_1", runId: "run_1", actionId: "act_1", status: "requested",
        policy: { preset: "edit", effect: "write", write: "approve", exec: "deny" },
        requestedBy: null, decidedBy: null, reason: "coding write op: write_file",
        requestedAt: "2026-09-06 10:00:00", decidedAt: null, expiresAt: null,
        ...over,
    };
}

function artifactRow(over) {
    return {
        id: "art_1", runId: "run_1", actionId: "act_1", kind: "file.write", path: "a.txt",
        digest: "d0d0", sizeBytes: 2, storageRef: "worktree://run_1/a.txt",
        meta: { beforeDigest: "b0b0" }, createdAt: "2026-09-06 10:00:00",
        ...over,
    };
}

// A fake Response-like the transport expects (`.ok` + `.clone().json()/.text()`).
function jsonResponse(status, body) {
    const make = () => ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
        clone: () => make(),
    });
    return make();
}

let server; // mutable "server-side" state per test

function pathnameOf(url) {
    return String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
}

// The op→tool mapping the executor records for an awaiting/executed op.
function toolForOp(op) {
    if (op === "run_command") return "run_command";
    return op;
}

function executeDataFor(serverState, op, bodyArgs) {
    if (op === "run_command") {
        return {
            code: 0, stdout: "运行完成", stderr: "", timedOut: false, cancelled: false, truncated: false,
            executable: bodyArgs?.executable || "node", args: bodyArgs?.args || [], cwdRelative: bodyArgs?.cwdRelative || "",
        };
    }
    return {
        op, path: bodyArgs?.path || "a.txt", existed: true,
        beforeDigest: "b0b0", afterDigest: "d0d0", sizeBytes: 2, kind: "file.write",
    };
}

function route(method, url, opts = {}) {
    const m = String(method || "GET").toUpperCase();
    const p = pathnameOf(url);
    const body = opts.body ? JSON.parse(opts.body) : {};

    // runs create / list / single
    if (p === "/coding/runs" && m === "POST") {
        server.run = makeRun({ status: "created", mode: body.mode, preset: body.mode });
        return { ok: true, run: server.run };
    }
    if (p === "/coding/runs" && m === "GET") {
        return { ok: true, runs: [server.run], count: 1 };
    }
    if (p === "/coding/runs/run_1" && m === "GET") {
        return { ok: true, run: server.run };
    }
    if (p === "/coding/runs/run_1/start" && m === "POST") {
        server.run = makeRun({ status: "running", mode: server.run.mode, preset: server.run.preset });
        return { ok: true, run: server.run, runtime: { active: true } };
    }
    if (p === "/coding/runs/run_1/provision" && m === "POST") {
        server.run = makeRun({
            status: server.run.status, mode: server.run.mode, preset: server.run.preset,
            worktreeStatus: "ready", worktreePath: "C:/wt/run_1", worktreeBranch: "coding/run-run_1",
            baseBranch: "main", baseCommit: "aa11bb22",
        });
        return { ok: true, run: server.run };
    }
    if (p === "/coding/runs/run_1/teardown" && m === "POST") {
        server.run = { ...server.run, worktreeStatus: "removed" };
        return { ok: true, run: server.run };
    }
    if (p === "/coding/runs/run_1/land" && m === "POST") {
        server.run = makeRun({ status: "completed", mode: "trusted", preset: "trusted", worktreeStatus: "ready" });
        return { ok: true, applied: true, method: "working_tree", files: [{ path: "b.txt", status: "A" }], counts: { added: 1, modified: 0, deleted: 0, changed: 1 } };
    }
    // main-project read surface (used by loadTree / loadGitStatus after landing)
    if (p === "/coding/projects/proj_1/ops" && m === "POST") {
        const { op } = body;
        if (op === "list_tree") {
            return { ok: true, op, data: { entries: [{ rel: "b.txt", type: "file", size: 3 }], counts: { dirs: 0, files: 1 }, truncated: false } };
        }
        if (op === "git.status") {
            return { ok: true, op, data: { isRepo: true, commit: "aa11bb22", branch: "main", clean: false, entries: [{ x: "", y: "M", path: "a.txt" }, { x: "?", y: "?", path: "b.txt" }], truncated: false } };
        }
        throw new Error(`unexpected project op ${op}`);
    }

    // transcripts
    if (p === "/coding/runs/run_1/actions" && m === "GET") {
        return { ok: true, actions: server.actions, count: server.actions.length };
    }
    if (p === "/coding/runs/run_1/approvals" && m === "GET") {
        return { ok: true, approvals: server.approvals, count: server.approvals.length };
    }
    if (p === "/coding/runs/run_1/artifacts" && m === "GET") {
        return { ok: true, artifacts: server.artifacts, count: server.artifacts.length };
    }
    if (p === "/coding/runs/run_1/events" && m === "GET") {
        return { ok: true, runId: "run_1", events: server.events, count: server.events.length, last_seq: server.events.length };
    }

    // run-scoped ops: reads dispatch to effect read; write/exec go through policy
    if (p === "/coding/runs/run_1/ops" && m === "POST") {
        const { op, args } = body;
        if (op === "git.status") {
            const entries = server.gitStatusEntries !== undefined ? server.gitStatusEntries : [{ x: "", y: "M", path: "a.txt" }];
            return { ok: true, effect: "read", op, data: { isRepo: true, commit: "aa11bb22", branch: "coding/run-run_1", clean: entries.length === 0, entries, truncated: false } };
        }
        if (op === "git.diff") {
            const target = args && args.path ? args.path : "a.txt";
            return { ok: true, effect: "read", op, data: { diff: `diff --git a/${target} b/${target}\n`, filesChanged: [target], truncated: false, byteLength: 24, commit: "aa11bb22" } };
        }
        if (op === "read_file") {
            const lines = Array.isArray(server.readFileLines) ? server.readFileLines : ["hi"];
            return { ok: true, effect: "read", op, data: { path: args.path, startLine: 1, endLine: lines.length, lineCount: lines.length, lines, truncated: false, byteLength: 2 } };
        }
        // write/exec
        if (server.policy === "execute" || (server.policy === "auto" && toolForOp(op) !== "run_command")) {
            const executedAction = actionRow({ status: "executed", tool: toolForOp(op), input: { op, path: args.path || null } });
            const artifact = op === "run_command"
                ? artifactRow({ kind: "command.output", path: null, digest: "sha", sizeBytes: 12, meta: { executable: args.executable, exitCode: 0, args: args.args, cwdRelative: args.cwdRelative || null } })
                : artifactRow({ kind: "file.write", path: args.path });
            server.actions.push(executedAction);
            server.artifacts.push(artifact);
            server.run = makeRun({ status: "running", mode: "trusted", preset: "trusted", worktreeStatus: "ready" });
            return { ok: true, status: "executed", run: server.run, action: executedAction, approval: null, artifact, data: executeDataFor(server, op, args) };
        }
        // edit preset / command → pause for approval
        const action = actionRow({ status: "requested", tool: toolForOp(op), input: { op, path: args.path || null, executable: args.executable || null, args: args.args || null } });
        const approval = approvalRow({ status: "requested", actionId: action.id });
        server.actions.push(action);
        server.approvals.push(approval);
        server.run = makeRun({ status: "waiting_approval", mode: "edit", preset: "edit", worktreeStatus: "ready" });
        return { ok: true, status: "awaiting_approval", run: server.run, action, approval, artifact: null };
    }

    // decision
    if (/^\/coding\/approvals\//.test(p) && m === "POST") {
        const approve = body.approve === true;
        const next = approve ? "approved" : "denied";
        const approval = server.approvals.find((a) => a.id === p.split("/")[3]) || approvalRow({});
        approval.status = next;
        const action = server.actions.find((a) => a.id === approval.actionId);
        if (action) action.status = approve ? "approved" : "denied";
        return { ok: true, approval, action: action || actionRow({}) };
    }

    // resume approved action with live args (args NOT persisted server-side)
    if (/^\/coding\/runs\/run_1\/actions\/[^/]+\/execute$/.test(p) && m === "POST") {
        const actionId = p.split("/")[5];
        const action = server.actions.find((a) => a.id === actionId) || actionRow({});
        action.status = "executed";
        const data = executeDataFor(server, body.op, body.args);
        const artifact = body.op === "run_command"
            ? artifactRow({ kind: "command.output", path: null, meta: { executable: body.args?.executable, exitCode: data.code } })
            : artifactRow({ kind: "file.write", path: body.args?.path });
        server.artifacts.push(artifact);
        server.run = makeRun({ status: "running", mode: "edit", preset: "edit", worktreeStatus: "ready" });
        return { ok: true, status: "executed", run: server.run, action, approval: null, artifact, data };
    }

    throw new Error(`unexpected fetch: ${m} ${p}`);
}

function resetStoreState() {
    useWorkspaceStore.setState({
        capabilities: { ...CAPS_ALL },
        capabilitiesLoaded: true,
        capabilitiesError: null,
        projects: [PROJECT],
        projectsLoading: false,
        selectedProjectId: "proj_1",
        workspace: { isRepo: true, branch: "main", commit: "aa11bb22", rootPath: "C:/repo" },
        runs: { items: [RUN_CREATED], loading: false, error: null },
        runEvents: { runId: null, events: [], afterSeq: 0, loading: false, error: null },
        runActionId: null,
        // R2
        selectedRunId: null,
        runDetail: null,
        runDetailLoading: false,
        runDetailError: null,
        runOpsBusy: false,
        runActions: { items: [], loading: false, error: null },
        runApprovals: { items: [], loading: false, error: null },
        runArtifacts: { items: [], loading: false, error: null },
        runGit: { status: null, loading: false, error: null },
        runDiff: { text: "", filesChanged: [], truncated: false, byteLength: null, loading: false, error: null },
        runChanges: { runId: null, files: [], loading: false, error: null },
        runFileView: { path: null, lines: [], startLine: 1, lineCount: 0, truncated: false, loading: false, error: null },
        pendingRunOps: {},
        lastCommandOutputs: [],
        toastKind: null,
        toastText: null,
    });
}

beforeEach(() => {
    resetStoreState();
    server = {
        run: makeRun({}),
        actions: [],
        approvals: [],
        artifacts: [],
        events: [],
        policy: "await", // await | execute | auto
    };
    globalThis.fetch = vi.fn((url, opts = {}) => {
        const m = String(opts.method || "GET").toUpperCase();
        const body = route(m, url, opts);
        return Promise.resolve(jsonResponse(m === "POST" ? 201 : 200, body));
    });
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

/** All fetch calls whose URL contains `part`, as parsed JSON bodies. */
function bodiesFor(part) {
    return fetch.mock.calls
        .filter(([url, opts]) => String(url).includes(part) && opts && opts.body)
        .map(([, opts]) => JSON.parse(opts.body));
}

// ═══════════════════════════════════════════════════════════
// 写 run 创建按 capabilities 门控
// ═══════════════════════════════════════════════════════════

describe("createWriteRun capability gate", () => {
    it("returns null + error toast when writeTools is off (no request sent)", async () => {
        useWorkspaceStore.setState({ capabilities: { ...CAPS_ALL, writeTools: false } });
        const run = await getState().createWriteRun("edit");
        expect(run).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
        expect(getState().toastText).toContain("未启用");
    });

    it("creates an edit run and opens its detail when writeTools is on", async () => {
        const run = await getState().createWriteRun("edit");
        expect(run).not.toBeNull();
        expect(run.id).toBe("run_1");
        const createBodies = bodiesFor("/coding/runs");
        expect(createBodies.some((b) => b.mode === "edit")).toBe(true);
        expect(getState().selectedRunId).toBe("run_1");
        expect(getState().runDetail?.id).toBe("run_1");
    });

    it("rejects an unknown mode without creating", async () => {
        const run = await getState().createWriteRun("observe");
        expect(run).toBeNull();
        expect(getState().toastText).toContain("edit");
    });
});

// ═══════════════════════════════════════════════════════════
// awaiting_approval → 批准并执行 → 同一 op/args 走 execute
// ═══════════════════════════════════════════════════════════

describe("approve-and-execute resume (identical live args)", () => {
    it("write_file awaiting → 批准并执行 sends the identical op+args", async () => {
        server.policy = "await";
        const submitted = await getState().submitRunOp("run_1", "write_file", { path: "a.txt", content: "hi" });
        expect(submitted.status).toBe("awaiting_approval");

        const held = getState().pendingRunOps["run_1"];
        expect(held).toMatchObject({
            actionId: "act_1",
            approvalId: "appr_1",
            op: "write_file",
            args: { path: "a.txt", content: "hi" },
        });

        const result = await getState().approveAndExecuteRunOp("run_1", held.actionId);
        expect(result.ok).toBe(true);
        expect(result.status).toBe("executed");

        // approve recorded
        const decisionBodies = bodiesFor("/coding/approvals/appr_1/decision");
        expect(decisionBodies.length).toBeGreaterThan(0);
        expect(decisionBodies[decisionBodies.length - 1].approve).toBe(true);

        // execute re-sends the IDENTICAL op/args from memory (never reconstructed)
        const executeBodies = bodiesFor("/coding/runs/run_1/actions/act_1/execute");
        expect(executeBodies.length).toBe(1);
        expect(executeBodies[0]).toEqual({
            op: "write_file",
            args: { path: "a.txt", content: "hi" },
        });

        // live args are dropped once the action is settled
        expect(getState().pendingRunOps["run_1"]).toBeUndefined();
    });

    it("run_command awaiting → approve → execute records stdout/stderr from the response", async () => {
        server.policy = "await";
        const submitted = await getState().submitRunOp("run_1", "run_command", {
            executable: "node", args: ["-v"], cwdRelative: "src",
        });
        expect(submitted.status).toBe("awaiting_approval");

        const held = getState().pendingRunOps["run_1"];
        expect(held).toMatchObject({ op: "run_command", actionId: "act_1" });

        const result = await getState().approveAndExecuteRunOp("run_1", held.actionId);
        expect(result.ok).toBe(true);

        const executeBodies = bodiesFor("/coding/runs/run_1/actions/act_1/execute");
        expect(executeBodies[executeBodies.length - 1]).toEqual({
            op: "run_command",
            args: { executable: "node", args: ["-v"], cwdRelative: "src" },
        });

        const outputs = getState().lastCommandOutputs;
        expect(outputs.length).toBeGreaterThan(0);
        expect(outputs[0]).toMatchObject({ executable: "node", code: 0, stdout: "运行完成" });
    });
});

// ═══════════════════════════════════════════════════════════
// 拒绝审批只记录 denial 并清除 live args
// ═══════════════════════════════════════════════════════════

describe("deny approval", () => {
    it("records the denial and drops the paused live args", async () => {
        server.policy = "await";
        await getState().submitRunOp("run_1", "write_file", { path: "a.txt", content: "hi" });
        expect(getState().pendingRunOps["run_1"]).toBeDefined();

        const result = await getState().decideRunApproval("run_1", "appr_1", false, "不要改这个文件");
        expect(result.ok).toBe(true);
        expect(result.approval.status).toBe("denied");

        const decisionBodies = bodiesFor("/coding/approvals/appr_1/decision");
        expect(decisionBodies[decisionBodies.length - 1].approve).toBe(false);
        expect(getState().pendingRunOps["run_1"]).toBeUndefined();

        // approved-but-not-executed is impossible after deny → execute is a no-op hint
        const execute = await getState().executePendingRunOp("run_1", "act_1");
        expect(execute.ok).toBe(false);
        expect(execute.reason).toBe("no_pending_args");
    });
});

// ═══════════════════════════════════════════════════════════
// 重连刷新只读重拉，不重复执行
// ═══════════════════════════════════════════════════════════

describe("reconnect refresh (refreshRunDetail)", () => {
    it("does not re-execute an approved-but-unexecuted action and keeps live args gone", async () => {
        server.actions = [actionRow({ status: "approved" })];
        server.approvals = [approvalRow({ status: "approved" })];
        server.artifacts = [];
        server.run = makeRun({ status: "waiting_approval", worktreeStatus: "ready" });
        server.events = [{ id: 1, runId: "run_1", seq: 1, type: "approval.approved", actor: "system", actionId: "act_1", payload: {}, at: "2026-09-06 10:00:00" }];
        // reconnect: the live args are gone (client restarted) — only server state remains
        useWorkspaceStore.setState({ pendingRunOps: {}, selectedRunId: "run_1", runDetail: makeRun({ status: "waiting_approval" }) });

        await getState().refreshRunDetail("run_1");

        expect(getState().runActions.items[0].status).toBe("approved");
        expect(getState().runApprovals.items[0].status).toBe("approved");
        expect(getState().runDetail.status).toBe("waiting_approval");
        expect(getState().pendingRunOps["run_1"]).toBeUndefined();

        // the refresh must never POST to the execute endpoint (no duplicate side effects)
        const executePosts = fetch.mock.calls.filter(([url, opts]) => String(opts?.method || "GET").toUpperCase() === "POST" && /\/actions\/[^/]+\/execute$/.test(pathnameOf(url)));
        expect(executePosts).toHaveLength(0);

        // an approved action without live args cannot be resumed → hint only
        const resume = await getState().executePendingRunOp("run_1", "act_1");
        expect(resume.ok).toBe(false);
        expect(resume.reason).toBe("no_pending_args");
    });
});

// ═══════════════════════════════════════════════════════════
// artifacts → changed files 派生
// ═══════════════════════════════════════════════════════════

describe("artifacts / changed files derivation", () => {
    it("stores artifact rows and derives changed files excluding command.output", async () => {
        server.actions = [actionRow({ status: "executed", tool: "write_file" }), actionRow({ id: "act_2", seq: 2, type: "exec", tool: "run_command", status: "executed", approvalId: "appr_2", input: { op: "run_command", executable: "node" } })];
        server.artifacts = [
            artifactRow({ kind: "file.write", path: "a.txt" }),
            artifactRow({ id: "art_2", actionId: "act_2", kind: "command.output", path: null, digest: "sha2", sizeBytes: 11, meta: { executable: "node", exitCode: 0 } }),
        ];
        await getState().reloadRunArtifacts("run_1");

        const items = getState().runArtifacts.items;
        expect(items).toHaveLength(2);
        expect(items.some((a) => isCommandArtifact(a))).toBe(true);
        // file artifacts (with a rel path) become changed files; the digest-only
        // command.output artifact does not
        expect(artifactChangedFiles(items)).toEqual(["a.txt"]);
    });

    it("submitting a trusted write auto-executes and refreshes the artifact ledger", async () => {
        server.policy = "auto";
        useWorkspaceStore.setState({ runDetail: makeRun({ status: "running", mode: "trusted", preset: "trusted", worktreeStatus: "ready" }) });
        const result = await getState().submitRunOp("run_1", "write_file", { path: "a.txt", content: "v2" });
        expect(result.status).toBe("executed");
        expect(getState().runArtifacts.items.some((a) => a.path === "a.txt")).toBe(true);
        expect(getState().pendingRunOps["run_1"]).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════
// run-scoped 读取（git.status / git.diff / read_file）
// ═══════════════════════════════════════════════════════════

describe("run-scoped reads", () => {
    it("loads run git status + diff and reads a worktree file", async () => {
        await getState().refreshRunGit("run_1");
        expect(getState().runGit.status).toBeTruthy();
        expect(getState().runGit.status.clean).toBe(false);
        expect(getState().runDiff.text).toContain("diff --git");
        expect(getState().runDiff.filesChanged).toEqual(["a.txt"]);

        await getState().readRunFile("run_1", "a.txt", 1);
        expect(getState().runFileView.lines).toEqual(["hi"]);
        expect(getState().runFileView.path).toBe("a.txt");
    });
});

// ═══════════════════════════════════════════════════════════
// 落地(land)自动刷新真实工作区 + run 改动清单（loadRunChanges）
// ═══════════════════════════════════════════════════════════

describe("land / run-changes review", () => {
    function opsPosted(part) {
        return fetch.mock.calls
            .filter(([url, opts]) => String(url).includes(part) && opts && opts.body)
            .map(([, opts]) => JSON.parse(opts.body));
    }

    it("loadRunChanges 把 git.status/diff/read 汇成可审阅改动清单（新文件=内容、修改=diff）", async () => {
        server.gitStatusEntries = [
            { x: "?", y: "?", path: "new.txt" },
            { x: "", y: "M", path: "a.txt" },
        ];
        server.readFileLines = ["line one", "line two"];
        await getState().loadRunChanges("run_1");

        const changes = getState().runChanges;
        expect(changes.error).toBeNull();
        expect(changes.runId).toBe("run_1");
        expect(changes.files).toHaveLength(2);
        const added = changes.files.find((f) => f.path === "new.txt");
        expect(added.status).toBe("A");
        expect(added.isNew).toBe(true);
        expect(added.bodyIsDiff).toBe(false);
        expect(added.body).toBe("line one\nline two");
        const modified = changes.files.find((f) => f.path === "a.txt");
        expect(modified.status).toBe("M");
        expect(modified.bodyIsDiff).toBe(true);
        expect(modified.body).toContain("diff --git a/a.txt b/a.txt");
        // the new file's body came from a worktree read, not a (empty) diff
        const reads = opsPosted("run_1/ops").filter((b) => b.op === "read_file" && b.args && b.args.path === "new.txt");
        expect(reads.length).toBeGreaterThan(0);
    });

    it("loadRunChanges 幂等：非 force 命中缓存，force 才重新拉取", async () => {
        server.gitStatusEntries = [{ x: "", y: "M", path: "a.txt" }];
        await getState().loadRunChanges("run_1");
        await getState().loadRunChanges("run_1"); // cached → no new fetch
        expect(opsPosted("run_1/ops").filter((b) => b.op === "git.status")).toHaveLength(1);
        await getState().loadRunChanges("run_1", { force: true });
        expect(opsPosted("run_1/ops").filter((b) => b.op === "git.status")).toHaveLength(2);
    });

    it("landToMain 只做落地动作；真实工作区刷新由 refreshAfterLand 显式完成（重置根目录树）", async () => {
        const body = await getState().landToMain("run_1");
        expect(body).not.toBeNull();
        expect(body.applied).toBe(true);
        expect(body.files).toEqual([{ path: "b.txt", status: "A" }]);
        expect(getState().toastKind).toBe("ok");
        const landed = fetch.mock.calls.some(
            ([url, opts]) => String(opts?.method || "GET").toUpperCase() === "POST" && String(url).includes("/coding/runs/run_1/land"),
        );
        expect(landed).toBe(true);
        // landToMain 本身不碰真实文件树/git（由组件落地后显式调 refreshAfterLand）
        expect(opsPosted("proj_1/ops").length).toBe(0);

        // 落地成功后：即使当前文件树在深层子目录/窄深度，也重置回根 depth2 再刷
        useWorkspaceStore.setState({ treeBase: "src/deep", treeDepth: 4 });
        await getState().refreshAfterLand();

        const projOps = opsPosted("proj_1/ops");
        expect(projOps.some((b) => b.op === "list_tree" && b.args && b.args.path === "")).toBe(true);
        expect(projOps.some((b) => b.op === "git.status")).toBe(true);
        expect(getState().treeBase).toBe("");
        expect(getState().treeDepth).toBe(2);
        // 树里能直接看到落地的新文件，无需手动刷新浏览器
        expect(getState().treeEntries.some((e) => e.rel === "b.txt")).toBe(true);
        // FilesSection 的"工作区改动"条数据源（真实 git 状态）也已刷新
        expect(getState().git.status?.entries.some((e) => e.path === "b.txt")).toBe(true);
    });

    it("落地前清单有错时，landToMain 返回的 files 可作展示兜底（不改 store 状态）", async () => {
        // runChanges 若在 run 完成前没加载成功，展示层还能用 land 返回的 files
        server.gitStatusEntries = [];
        const body = await getState().landToMain("run_1");
        expect(body?.applied).toBe(true);
        expect(Array.isArray(body.files)).toBe(true);
        // 落地不改变 runChanges（那是 worktree 审查数据，force 重拉由组件负责）
        expect(getState().runChanges.runId).toBeNull();
    });
});
