/**
 * Phase 7 / R5 — roadmap R5 #4: Stdio MCP tool run-scope unit tests.
 *
 * Exercises classification (table-driven, local ↔ agent-evo-local equivalence),
 * preset×effect policy, the feature-flag gate, capabilityView filtering and the
 * full call → approve → execute / deny / timeout / auto lifecycle against a real
 * per-file DB (initDB + direct coding_runs insert, mirroring the approvals suite
 * pattern) with a STUB registry (no real MCP process, no network, no LLM SDK).
 * All routes reuse the R2 ApprovalService action/approval rows + existing event
 * types; no new event types are introduced.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import db, { createUser, initDB } from "../db/index.js";
import { clearExtensibilityFlags, mcpRunScopeEnabled } from "../extensibility/flags.js";
import { defaultApprovalService } from "../coding/approvals.js";
import { defaultEventStore } from "../coding/events.js";
import { PRESETS } from "../coding/presets.js";
import {
    LOCAL_TOOL_EFFECT,
    MCP_EFFECTS,
    SERVER_TOOL_RULES,
    classifyToolEffect,
    createMcpRunScope,
    mcpEffectPolicy,
    resolveEffectPolicy,
} from "./runScope.js";

const MCP_FLAG = "MCP_RUN_SCOPE_ENABLED";
const EVENT_FLAG = "CODING_EVENT_LOG_ENABLED";

const readOk = async () => "file-contents-123";
const writeOk = async () => JSON.stringify({ ok: true, path: "src/a.ts" });
const networkOk = async () => "page-body";
const never = () => new Promise(() => { /* never settles — for timeout tests */ });
const boom = async () => {
    const err = new Error("backend exploded: Authorization: Bearer abcDEFgh123456789");
    err.code = "MCP_UPSTREAM";
    throw err;
};

/** Minimal structured-tool stub registry (implements the registry surface only). */
function makeRegistry(serverDefs) {
    const serverNames = [];
    const serverTools = new Map();
    const fns = new Map();
    const invocations = [];
    for (const def of serverDefs) {
        serverNames.push(def.name);
        serverTools.set(def.name, def.tools.map((t) => ({ name: t.name, description: t.description || "" })));
        for (const t of def.tools) fns.set(t.name, t.fn || readOk);
    }
    return {
        invocations,
        getMCPServerNames: () => serverNames,
        getMCPServerTools: (serverName) => serverTools.get(serverName) || [],
        getTool: () => null,
        hasTool: () => false,
        async invokeTool(name, input, config = {}) {
            invocations.push({ name, input, config });
            const fn = fns.get(String(name));
            if (!fn) {
                const err = new Error(`tool "${name}" unavailable`);
                err.code = "TOOL_NOT_FOUND";
                throw err;
            }
            return fn(input, config);
        },
    };
}

// Shared read/exec/network registry (stateless fns; invocation log is per-instance).
function readExecRegistry() {
    return makeRegistry([
        { name: "fileserver", tools: [{ name: "fileserver/read_file", fn: readOk }] },
        { name: "shellserver", tools: [{ name: "shellserver/run_build", fn: networkOk }] },
    ]);
}
function networkRegistry() {
    return makeRegistry([
        { name: "fetch", tools: [{ name: "fetch/web_fetch", fn: networkOk }] },
    ]);
}

let ALICE;
let BOB;
let aliceScope;
let bobScope;
let runCounter = 0;

/** Insert a coding run row directly (preset-independent of CODING_*_ENABLED). */
function makeRun(owner = aliceScope, { preset = "observe", status = "created", runId = null } = {}) {
    runCounter += 1;
    const id = runId || `run_scope_${runCounter}`;
    db.prepare(
        `INSERT INTO coding_runs (id, owner_user_id, tenant_id, status, mode, preset, snapshot_json, event_seq, cancelled)
         VALUES (?, ?, ?, ?, ?, ?, '{}', 0, 0)`,
    ).run(id, owner.userId, owner.tenantId, status, preset, preset);
    return id;
}

function actionCount(runId, owner = aliceScope) {
    const row = db.prepare(
        "SELECT COUNT(*) AS n FROM coding_actions WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ?",
    ).get(runId, owner.userId, owner.tenantId);
    return Number(row.n);
}
function approvalCount(runId, owner = aliceScope) {
    const row = db.prepare(
        "SELECT COUNT(*) AS n FROM coding_approvals WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ?",
    ).get(runId, owner.userId, owner.tenantId);
    return Number(row.n);
}
function getActionRow(actionId) {
    return db.prepare("SELECT * FROM coding_actions WHERE id = ?").get(actionId);
}

function enableMcp() { process.env[MCP_FLAG] = "true"; }
function disableMcp() { delete process.env[MCP_FLAG]; }

beforeAll(() => {
    initDB();
    process.env[EVENT_FLAG] = "true"; // assert action/approval events alongside rows
    ALICE = { id: createUser("Scope Alice", "hash-sa") };
    BOB = { id: createUser("Scope Bob", "hash-sb") };
    aliceScope = { userId: ALICE.id, tenantId: `user:${ALICE.id}` };
    bobScope = { userId: BOB.id, tenantId: `user:${BOB.id}` };
});

afterEach(() => {
    vi.restoreAllMocks();
    disableMcp();
});

afterAll(() => {
    delete process.env[EVENT_FLAG];
    clearExtensibilityFlags();
});

describe("classifyToolEffect — deterministic effect table", () => {
    it("maps every local tool name exactly (bare names)", () => {
        expect(LOCAL_TOOL_EFFECT).toEqual({
            web_search: "network",
            search_knowledge_base: "read",
            get_system_time: "read",
            get_db_message_count: "read",
            update_todo: "write",
            ask_user_question: "read",
            memory: "write",
        });
        for (const [name, effect] of Object.entries(LOCAL_TOOL_EFFECT)) {
            expect(classifyToolEffect(name)).toBe(effect);
        }
    });

    it("classifies filesystem read/list/search family under server/tool", () => {
        expect(classifyToolEffect("filesystem/read_file")).toBe("read");
        expect(classifyToolEffect("filesystem/list_directory")).toBe("read");
        expect(classifyToolEffect("filesystem/stat")).toBe("read");
        expect(classifyToolEffect("filesystem/get_metadata")).toBe("read");
        expect(classifyToolEffect("amap/search")).toBe("read"); // keyword "search" → read
        expect(classifyToolEffect("search/web_fetch")).toBe("network"); // tool prefix "web"
    });

    it("classifies write/mutation family under server/tool", () => {
        expect(classifyToolEffect("filesystem/write_file")).toBe("write");
        expect(classifyToolEffect("filesystem/create_file")).toBe("write");
        expect(classifyToolEffect("filesystem/delete_file")).toBe("write");
        expect(classifyToolEffect("filesystem/mkdir")).toBe("write");
        expect(classifyToolEffect("notes/edit_note")).toBe("write");
        expect(classifyToolEffect("filesystem/rename")).toBe("write");
        expect(classifyToolEffect("filer/move_item")).toBe("write");
    });

    it("classifies command-execution family under server/tool", () => {
        expect(classifyToolEffect("shell/run_command")).toBe("exec");
        expect(classifyToolEffect("shell/execute_script")).toBe("exec");
        expect(classifyToolEffect("shell/exec")).toBe("exec");
        expect(classifyToolEffect("shell/bash")).toBe("exec");
        expect(classifyToolEffect("tools/command_run")).toBe("exec");
    });

    it("classifies network family under server/tool with longest keyword precedence", () => {
        expect(classifyToolEffect("http/http_get")).toBe("network");
        expect(classifyToolEffect("web/web_fetch")).toBe("network");
        expect(classifyToolEffect("fetch/fetch_url")).toBe("network");
        expect(classifyToolEffect("search/search_web_france")).toBe("network"); // search_web(10) > search(6)
        expect(classifyToolEffect("any/http_request")).toBe("network");
    });

    it("classifies anything unknown as external (bare and namespaced)", () => {
        expect(classifyToolEffect("totally_unknown")).toBe("external");
        expect(classifyToolEffect("")).toBe("external");
        expect(classifyToolEffect("srv/what_is_this")).toBe("external");
        expect(classifyToolEffect("mystery_tool", { server: "srv" })).toBe("external");
        expect(classifyToolEffect("opaque/db_query_arbitrary")).toBe("external");
    });

    it("falls back to the LOCAL_TOOL_EFFECT table for self-connect servers", () => {
        expect(classifyToolEffect("agent-evo-local/web_search")).toBe("network");
        expect(classifyToolEffect("agent-evo-local/memory")).toBe("write");
        expect(classifyToolEffect("agent-evo-local/search_knowledge_base")).toBe("read");
        expect(classifyToolEffect("local/web_search", { server: "local" })).toBe("network");
        // A local tool re-exposed under a NON-self server follows generic keywords,
        // never the local write map (a foreign "memory" is not our user memory).
        expect(classifyToolEffect("srv/memory")).toBe("external");
    });

    it("classifies an explicit-server bare tool by that server (capabilityView path)", () => {
        expect(classifyToolEffect("read_file", { server: "filesystem" })).toBe("read");
        expect(classifyToolEffect("run_build", { server: "shell" })).toBe("exec");
        expect(classifyToolEffect("run_build")).toBe("external"); // no server context
    });
});

describe("mcpEffectPolicy / resolveEffectPolicy — preset × effect decisions", () => {
    it("mcpEffectPolicy returns read=allow, PRESETS write/exec, network & external rules", () => {
        const p = mcpEffectPolicy("observe");
        expect(p.preset).toBe("observe");
        expect(p.policy).toEqual({ read: "allow", write: "deny", exec: "deny", network: "deny", external: "deny" });
        expect(PRESETS.observe).toEqual({ write: "deny", exec: "deny" });

        const trusted = mcpEffectPolicy("trusted").policy;
        expect(trusted).toEqual({ read: "allow", write: "auto", exec: "approve", network: "approve", external: "deny" });
    });

    it("read is always allow for every preset (flag on or off)", () => {
        enableMcp();
        for (const preset of ["observe", "edit", "trusted"]) {
            expect(resolveEffectPolicy(preset, "read")).toEqual({ decision: "allow", disabledReason: null, preset, effect: "read" });
        }
    });

    it("network is more conservative than exec: deny observe/edit, approve only trusted", () => {
        enableMcp();
        expect(resolveEffectPolicy("observe", "network").decision).toBe("deny");
        expect(resolveEffectPolicy("edit", "network").decision).toBe("deny");
        expect(resolveEffectPolicy("trusted", "network").decision).toBe("approve");
    });

    it("write/exec follow PRESETS: write deny(observe) approve(edit) auto(trusted); exec approve(trusted)", () => {
        enableMcp();
        expect(resolveEffectPolicy("observe", "write").decision).toBe("deny");
        expect(resolveEffectPolicy("edit", "write").decision).toBe("approve");
        expect(resolveEffectPolicy("trusted", "write").decision).toBe("auto");
        expect(resolveEffectPolicy("edit", "exec").decision).toBe("deny");
        expect(resolveEffectPolicy("trusted", "exec").decision).toBe("approve");
    });

    it("external is denied under every preset and unknown effects normalize to external", () => {
        enableMcp();
        for (const preset of ["observe", "edit", "trusted"]) {
            expect(resolveEffectPolicy(preset, "external").decision).toBe("deny");
            expect(resolveEffectPolicy(preset, "teleport").effect).toBe("external");
            expect(resolveEffectPolicy(preset, "teleport").decision).toBe("deny");
        }
    });

    it("falls back to deny + MCP_RUN_SCOPE_DISABLED for gated effects while the flag is off", () => {
        disableMcp();
        expect(mcpRunScopeEnabled()).toBe(false);
        const write = resolveEffectPolicy("trusted", "write");
        expect(write).toEqual({ decision: "deny", disabledReason: "MCP_RUN_SCOPE_DISABLED", preset: "trusted", effect: "write" });
        expect(resolveEffectPolicy("trusted", "network").decision).toBe("deny");
        // read is never gated
        expect(resolveEffectPolicy("trusted", "read").decision).toBe("allow");
        expect(MCP_EFFECTS).toEqual(["read", "write", "exec", "network", "external"]);
    });

    it("DoD local/MCP interchangeability: local web_search == agent-evo-local/web_search across presets", () => {
        enableMcp();
        const local = "web_search";
        const mcp = "agent-evo-local/web_search";
        expect(classifyToolEffect(local)).toBe(classifyToolEffect(mcp));
        expect(classifyToolEffect(local)).toBe("network");
        for (const preset of ["observe", "edit", "trusted"]) {
            const a = resolveEffectPolicy(preset, classifyToolEffect(local));
            const b = resolveEffectPolicy(preset, classifyToolEffect(mcp));
            expect(a.decision).toBe(b.decision);
            expect(a.effect).toBe(b.effect);
        }
        expect(resolveEffectPolicy("trusted", classifyToolEffect(local)).decision).toBe("approve");
        expect(resolveEffectPolicy("observe", classifyToolEffect(local)).decision).toBe("deny");
        expect(SERVER_TOOL_RULES.search_web).toBe("network");
    });
});

describe("createMcpRunScope — feature-flag gate + capabilityView", () => {
    it("enabled() reflects the call-time flag; call is dark → MCP_RUN_SCOPE_DISABLED envelope with no DB writes", async () => {
        disableMcp();
        const runId = makeRun();
        const scope = createMcpRunScope({ scope: aliceScope, runId, preset: "observe", registry: readExecRegistry() });
        expect(scope.enabled()).toBe(false);
        const res = await scope.call({ tool: "fileserver/read_file" });
        expect(res.ok).toBe(false);
        expect(res.status).toBe("disabled");
        expect(res.errorCode).toBe("MCP_RUN_SCOPE_DISABLED");
        expect(res.retryable).toBe(false);
        expect(res.diagnostics.source).toBe("run-scope-mcp");
        expect(actionCount(runId)).toBe(0);
        expect(approvalCount(runId)).toBe(0);
        // capabilityView never throws while dark (empty registry-safe too)
        const empty = createMcpRunScope({ scope: aliceScope, runId, preset: "observe", registry: makeRegistry([]) });
        expect(() => empty.capabilityView()).not.toThrow();
        expect(empty.capabilityView().mcpServerCount).toBe(0);
    });

    it("capabilityView exposes preset policy and mcpServerCount", async () => {
        enableMcp();
        const runId = makeRun();
        const view = createMcpRunScope({ scope: aliceScope, runId, preset: "observe", registry: readExecRegistry() }).capabilityView();
        expect(view.preset).toBe("observe");
        expect(view.policy.read).toBe("allow");
        expect(view.policy.network).toBe("deny");
        expect(view.mcpServerCount).toBe(2);
        expect(view.allowed).toEqual([{ name: "fileserver/read_file", effect: "read" }]);
        expect(view.denied).toEqual([
            { name: "shellserver/run_build", effect: "exec", reason: `effect "exec" denied by preset "observe" policy` },
        ]);
    });

    it("capabilityView prefers namespaced names and skips bare duplicates + re-exposed local tools", async () => {
        enableMcp();
        const runId = makeRun();
        const registry = makeRegistry([
            { name: "fileserver", tools: [{ name: "fileserver/read_file", fn: readOk }, { name: "read_file", fn: readOk }] },
            { name: "agent-evo-local", tools: [{ name: "agent-evo-local/web_search", fn: readOk }, { name: "agent-evo-local/memory", fn: readOk }] },
        ]);
        const view = createMcpRunScope({ scope: aliceScope, runId, preset: "observe", registry }).capabilityView();
        expect(view.allowed.map((t) => t.name)).toEqual(["fileserver/read_file"]); // bare dup skipped, local re-exposed skipped
        expect(view.allowed.every((t) => t.effect === "read")).toBe(true);
        expect(view.mcpServerCount).toBe(2);
    });
});

describe("createMcpRunScope — call/execute lifecycle (real DB, stub registry)", () => {
    it("deny path: exec tool under observe → TOOL_EFFECT_DENIED, no action/approval rows", async () => {
        enableMcp();
        const runId = makeRun(aliceScope, { preset: "observe" });
        const registry = readExecRegistry();
        const runScope = createMcpRunScope({ scope: aliceScope, runId, preset: "observe", registry });
        const res = await runScope.call({ tool: "shellserver/run_build", input: { args: [] } });
        expect(res.ok).toBe(false);
        expect(res.status).toBe("denied");
        expect(res.errorCode).toBe("TOOL_EFFECT_DENIED");
        expect(res.message).toBe("effect exec is not permitted for preset observe");
        expect(res.retryable).toBe(false);
        expect(res.diagnostics.effect).toBe("exec");
        expect(registry.invocations).toHaveLength(0);
        expect(actionCount(runId)).toBe(0);
        expect(approvalCount(runId)).toBe(0);
    });

    it("approve path: network tool under trusted pauses for owner approval then execute runs exactly once", async () => {
        enableMcp();
        const runId = makeRun(aliceScope, { preset: "trusted" });
        const registry = networkRegistry();
        const runScope = createMcpRunScope({ scope: aliceScope, runId, preset: "trusted", registry });

        const wait = await runScope.call({ tool: "fetch/web_fetch", input: { url: "https://example.com" }, requestedBy: ALICE.id });
        expect(wait.ok).toBe(true);
        expect(wait.status).toBe("needs_approval");
        expect(wait.message).toBe("awaiting owner approval");
        expect(wait.approvalId).toMatch(/^appr_/);
        expect(wait.actionId).toMatch(/^act_/);
        expect(wait.data).toBeNull();
        expect(wait.diagnostics.decision).toBe("approve");
        expect(registry.invocations).toHaveLength(0); // approval never equals execution

        const action = getActionRow(wait.actionId);
        expect(action.status).toBe("requested");
        expect(action.type).toBe("network");
        expect(action.tool).toBe("fetch/web_fetch");
        expect(JSON.parse(action.input_json)).toEqual({ url: "https://example.com" });
        expect(approvalCount(runId)).toBe(1);

        const decided = defaultApprovalService.decide(aliceScope, wait.approvalId, { approve: true, decidedBy: ALICE.id });
        expect(decided.action.status).toBe("approved");

        const done = await runScope.execute({ actionId: wait.actionId });
        expect(done.ok).toBe(true);
        expect(done.status).toBe("executed");
        expect(done.data).toBe("page-body");
        expect(done.errorCode).toBeNull();
        expect(done.actionId).toBe(wait.actionId);
        expect(registry.invocations).toHaveLength(1);
        expect(registry.invocations[0].name).toBe("fetch/web_fetch");
        expect(registry.invocations[0].config.scope).toEqual(aliceScope);
        expect(registry.invocations[0].config.signal).toBeTruthy();

        expect(getActionRow(wait.actionId).status).toBe("executed");
        const types = defaultEventStore.listEvents(aliceScope, runId, { afterSeq: 0 }).map((e) => e.type);
        expect(types).toEqual(expect.arrayContaining([
            "action.requested", "approval.requested", "approval.approved",
            "action.decided", "action.executing", "action.executed",
        ]));
    });

    it("decide(false) → execute reports denied and the tool is never invoked", async () => {
        enableMcp();
        const runId = makeRun(aliceScope, { preset: "trusted" });
        const registry = networkRegistry();
        const runScope = createMcpRunScope({ scope: aliceScope, runId, preset: "trusted", registry });
        const wait = await runScope.call({ tool: "fetch/web_fetch", input: {} });
        defaultApprovalService.decide(aliceScope, wait.approvalId, { approve: false, reason: "blocked host" });
        const res = await runScope.execute({ actionId: wait.actionId });
        expect(res.ok).toBe(false);
        expect(res.status).toBe("denied");
        expect(res.errorCode).toBe("ACTION_DECISION_DENIED");
        expect(registry.invocations).toHaveLength(0);
        expect(getActionRow(wait.actionId).status).toBe("denied");
    });

    it("at-most-once claim: a second execute after success is already_settled", async () => {
        enableMcp();
        const runId = makeRun(aliceScope, { preset: "trusted" });
        const registry = networkRegistry();
        const runScope = createMcpRunScope({ scope: aliceScope, runId, preset: "trusted", registry });
        const wait = await runScope.call({ tool: "fetch/web_fetch", input: {} });
        defaultApprovalService.decide(aliceScope, wait.approvalId, { approve: true });
        const first = await runScope.execute({ actionId: wait.actionId });
        expect(first.status).toBe("executed");
        const second = await runScope.execute({ actionId: wait.actionId });
        expect(second.ok).toBe(false);
        expect(second.status).toBe("already_settled");
        expect(second.errorCode).toBe("ACTION_ALREADY_SETTLED");
        expect(registry.invocations).toHaveLength(1); // side effect ran exactly once
    });

    it("timeout on a direct allow call → TOOL_TIMEOUT retryable", async () => {
        enableMcp();
        const runId = makeRun(aliceScope, { preset: "observe" });
        const registry = makeRegistry([{ name: "fileserver", tools: [{ name: "fileserver/read_file", fn: never }] }]);
        const runScope = createMcpRunScope({ scope: aliceScope, runId, preset: "observe", registry });
        const res = await runScope.call({ tool: "fileserver/read_file", input: {}, timeoutMs: 20 });
        expect(res.ok).toBe(false);
        expect(res.status).toBe("timeout");
        expect(res.errorCode).toBe("TOOL_TIMEOUT");
        expect(res.retryable).toBe(true);
        expect(res.diagnostics.decision).toBe("allow");
        expect(res.data).toBeNull();
    });

    it("timeout on an approved execution settles the action failed with TOOL_TIMEOUT", async () => {
        enableMcp();
        const runId = makeRun(aliceScope, { preset: "trusted" });
        const registry = makeRegistry([{ name: "fetch", tools: [{ name: "fetch/web_fetch", fn: never }] }]);
        const runScope = createMcpRunScope({ scope: aliceScope, runId, preset: "trusted", registry });
        const wait = await runScope.call({ tool: "fetch/web_fetch", input: {} });
        defaultApprovalService.decide(aliceScope, wait.approvalId, { approve: true });
        const res = await runScope.execute({ actionId: wait.actionId, timeoutMs: 20 });
        expect(res.ok).toBe(false);
        expect(res.status).toBe("timeout");
        expect(res.errorCode).toBe("TOOL_TIMEOUT");
        expect(res.retryable).toBe(true);
        expect(getActionRow(wait.actionId).status).toBe("failed");
        expect(getActionRow(wait.actionId).error_code).toBe("TOOL_TIMEOUT");
    });

    it("allow path executes directly and logs a [run-scope] audit line", async () => {
        enableMcp();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const runId = makeRun(aliceScope, { preset: "observe" });
        const registry = readExecRegistry();
        const runScope = createMcpRunScope({ scope: aliceScope, runId, preset: "observe", registry });
        const res = await runScope.call({ tool: "fileserver/read_file", input: { path: "/tmp/a.txt" } });
        expect(res.ok).toBe(true);
        expect(res.status).toBe("executed");
        expect(res.errorCode).toBeNull();
        expect(res.retryable).toBe(false);
        expect(res.data).toBe("file-contents-123");
        expect(res.diagnostics.effect).toBe("read");
        expect(res.diagnostics.decision).toBe("allow");
        expect(log).toHaveBeenCalled();
        const lines = log.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(lines).toContain("[run-scope] executed tool=fileserver/read_file effect=read decision=allow preset=observe");
        expect(registry.invocations).toHaveLength(1);
    });

    it("auto path (write under trusted) executes without any approval/action row", async () => {
        enableMcp();
        const runId = makeRun(aliceScope, { preset: "trusted" });
        const registry = makeRegistry([{ name: "fileserver", tools: [{ name: "fileserver/write_file", fn: writeOk }] }]);
        const runScope = createMcpRunScope({ scope: aliceScope, runId, preset: "trusted", registry });
        const res = await runScope.call({ tool: "fileserver/write_file", input: { path: "src/a.ts" } });
        expect(res.ok).toBe(true);
        expect(res.status).toBe("executed");
        expect(res.diagnostics.decision).toBe("auto");
        expect(actionCount(runId)).toBe(0);
        expect(approvalCount(runId)).toBe(0);
    });

    it("provider errors are scrubbed and never leak the raw message or secrets", async () => {
        enableMcp();
        const runId = makeRun(aliceScope, { preset: "observe" });
        const registry = makeRegistry([{ name: "fileserver", tools: [{ name: "fileserver/read_file", fn: boom }] }]);
        const runScope = createMcpRunScope({ scope: aliceScope, runId, preset: "observe", registry });
        const res = await runScope.call({ tool: "fileserver/read_file", input: {} });
        expect(res.ok).toBe(false);
        expect(res.status).toBe("failed");
        expect(res.errorCode).toBe("MCP_UPSTREAM");
        expect(res.data).toBeNull();
        expect(res.message).not.toContain("abcDEFgh123456789");
        expect(res.message).not.toContain("Authorization: Bearer");
        expect(res.retryable).toBe(false);
    });

    it("runId is required → MCP_RUN_SCOPE_NEEDS_RUN before any policy work", async () => {
        enableMcp();
        const runScope = createMcpRunScope({ scope: aliceScope, runId: null, preset: "observe", registry: readExecRegistry() });
        await expect(runScope.call({ tool: "fileserver/read_file", input: {} })).rejects.toThrowError(/runId is required/);
        await expect(runScope.call({ tool: "fileserver/read_file", input: {} })).rejects.toMatchObject({ code: "MCP_RUN_SCOPE_NEEDS_RUN", statusCode: 400 });
    });

    it("run not found → 404 on the allow path", async () => {
        enableMcp();
        const runScope = createMcpRunScope({ scope: aliceScope, runId: "run_does_not_exist", preset: "observe", registry: readExecRegistry() });
        await expect(runScope.call({ tool: "fileserver/read_file", input: {} })).rejects.toMatchObject({ code: "CODING_RUN_NOT_FOUND", statusCode: 404 });
    });

    it("terminal run → 409 on the approve path", async () => {
        enableMcp();
        const runId = makeRun(aliceScope, { preset: "trusted", status: "completed" });
        const runScope = createMcpRunScope({ scope: aliceScope, runId, preset: "trusted", registry: networkRegistry() });
        await expect(runScope.call({ tool: "fetch/web_fetch", input: {} })).rejects.toMatchObject({ code: "RUN_TERMINAL", statusCode: 409 });
    });

    it("terminal run → 409 on the allow path too", async () => {
        enableMcp();
        const runId = makeRun(aliceScope, { preset: "observe", status: "cancelled" });
        const runScope = createMcpRunScope({ scope: aliceScope, runId, preset: "observe", registry: readExecRegistry() });
        await expect(runScope.call({ tool: "fileserver/read_file", input: {} })).rejects.toMatchObject({ code: "RUN_TERMINAL", statusCode: 409 });
    });

    it("cross-owner: BOB cannot call against ALICE's run (404 at the DB owner filter)", async () => {
        enableMcp();
        const runId = makeRun(aliceScope, { preset: "observe" });
        const runScope = createMcpRunScope({ scope: bobScope, runId, preset: "observe", registry: readExecRegistry() });
        await expect(runScope.call({ tool: "fileserver/read_file", input: {} })).rejects.toMatchObject({ code: "CODING_RUN_NOT_FOUND", statusCode: 404 });
    });

    it("cross-owner: BOB cannot execute ALICE's approved action (404)", async () => {
        enableMcp();
        const runId = makeRun(aliceScope, { preset: "trusted" });
        const registry = networkRegistry();
        const aliceScopeObj = createMcpRunScope({ scope: aliceScope, runId, preset: "trusted", registry });
        const wait = await aliceScopeObj.call({ tool: "fetch/web_fetch", input: {} });
        defaultApprovalService.decide(aliceScope, wait.approvalId, { approve: true });
        const bobScopeObj = createMcpRunScope({ scope: bobScope, runId, preset: "trusted", registry });
        await expect(bobScopeObj.execute({ actionId: wait.actionId })).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
        expect(getActionRow(wait.actionId).status).toBe("approved"); // untouched by BOB
    });

    it("runId missing on a disabled gate still returns disabled (not a run error)", async () => {
        disableMcp();
        const runScope = createMcpRunScope({ scope: aliceScope, runId: null, preset: "observe", registry: readExecRegistry() });
        const res = await runScope.call({ tool: "fileserver/read_file", input: {} });
        expect(res.status).toBe("disabled");
        expect(res.errorCode).toBe("MCP_RUN_SCOPE_DISABLED");
    });

    it("defaults are conservative: missing runId is rejected before any effect policy", async () => {
        enableMcp();
        // runId is required even for an external-classified tool on the default observe preset
        const runScope = createMcpRunScope({ scope: aliceScope, runId: null, preset: "observe", registry: readExecRegistry() });
        await expect(runScope.call({ tool: "opaque/thing", input: {} })).rejects.toMatchObject({ code: "MCP_RUN_SCOPE_NEEDS_RUN", statusCode: 400 });
        // with a real run, the same external tool is denied (never silently executed)
        const runId = makeRun(aliceScope, { preset: "observe" });
        const scoped = createMcpRunScope({ scope: aliceScope, runId, preset: "observe", registry: readExecRegistry() });
        const res = await scoped.call({ tool: "opaque/thing", input: {} });
        expect(res.errorCode).toBe("TOOL_EFFECT_DENIED");
        expect(actionCount(runId)).toBe(0);
    });
});
