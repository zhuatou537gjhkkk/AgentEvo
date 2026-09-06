/**
 * Phase 7 / R5 — roadmap R5 #4: Stdio MCP tools under a coding-run scope.
 *
 * RunScope is the server-side gate between an MCP tool call and the underlying
 * transport. Every stdio-origin tool that reaches the gateway is classified to a
 * deterministic EFFECT (read|write|exec|network|external), intersected with the
 * coding run's PRESET policy (observe|edit|trusted), then either:
 *   - executed directly   (read → always; write under trusted = auto; etc.),
 *   - paused for owner    (approve) — reusing the R2 ApprovalService pipeline
 *     (action + approval rows + the existing action.* and approval.* event
 *     types — no new event types), resumed exactly once via `execute`, or
 *   - denied / disabled   (deny / MCP_RUN_SCOPE_DISABLED).
 *
 * Everything that enters an envelope or the DB is scrubbed + truncated: provider
 * errors, secret-like tokens, control bytes and oversized outputs never reach a
 * result or a durable row. The whole facility is dark by default (flag read at
 * call time via ../extensibility/flags.js); with the flag off the raw tool path
 * is untouched and this module answers MCP_RUN_SCOPE_DISABLED.
 */
import db, { initDB } from "../db/index.js";
import { PRESETS, normalizePreset } from "../coding/presets.js";
import { codingError, requireCodingScope } from "../coding/util.js";
import { mcpRunScopeEnabled } from "../extensibility/flags.js";
import { defaultApprovalService } from "../coding/approvals.js";
import { toolRegistry } from "./registry.js";

// Transport-level retryable codes (mirror of services/resilience.js — not an
// exported constant there, so we keep a local copy for envelope retryable flags).
const RETRYABLE_TOOL_CODES = new Set([
    "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UPSTREAM_UNAVAILABLE",
    "MCP_TRANSPORT_ERROR", "UPSTREAM_TIMEOUT",
]);

let ensuredSchema = false;
function ensureSchema() {
    if (!ensuredSchema) {
        initDB();
        ensuredSchema = true;
    }
}

export const MCP_EFFECTS = Object.freeze(["read", "write", "exec", "network", "external"]);

/**
 * Deterministic effect map for our own LOCAL tools (names confirmed from
 * mcp/tools.js agentTools). A bare local name may also arrive namespaced under
 * the self-connect server "agent-evo-local/<tool>" — classification falls back
 * to this table for that server too (see classifyToolEffect).
 */
export const LOCAL_TOOL_EFFECT = Object.freeze({
    web_search: "network",
    search_knowledge_base: "read",
    get_system_time: "read",
    get_db_message_count: "read",
    update_todo: "write",
    ask_user_question: "read",
    memory: "write",
});

/**
 * Known self-connect servers that re-expose OUR local tools. Their tools are
 * classified exactly like the local bare names (never the generic keyword rules —
 * a local "memory" is a user-memory WRITE, not an unknown effect).
 */
const SELF_CONNECT_SERVERS = new Set(["agent-evo-local", "local"]);

/**
 * Built-in keyword → effect rules for `server/tool` MCP tool names
 * (roadmap R5 #4). Longest matching keyword prefix wins, so `search_web`
 * (network) beats `search` (read) and `web` (network). Anything that does not
 * start with a known keyword is conservatively `external` (→ always denied).
 *
 * @type {Record<string,string>}
 */
export const SERVER_TOOL_RULES = Object.freeze({
    // file-system / knowledge read family
    read: "read", list: "read", search: "read", stat: "read", get: "read",
    // mutation family
    write: "write", edit: "write", create: "write", rename: "write",
    move: "write", delete: "write", mkdir: "write", rm: "write",
    // command execution family
    run: "exec", exec: "exec", execute: "exec", command: "exec", bash: "exec",
    // network family (longest-match: search_web > search)
    search_web: "network", fetch: "network", http: "network", url: "network", web: "network",
});

/** Keywords sorted longest-first so the first prefix hit is the longest match. */
const SERVER_KEYWORD_ENTRIES = Object.freeze(
    Object.entries(SERVER_TOOL_RULES).sort((a, b) => b[0].length - a[0].length),
);

/**
 * Rare per-server explicit overrides that take precedence over the generic
 * keyword table (roadmap: "server 名本身有映射则优先", e.g. filesystem read/write).
 */
const SERVER_TOOL_OVERRIDES = Object.freeze({
    filesystem: Object.freeze({ read_file: "read", write_file: "write" }),
});

const TERMINAL_RUN_STATUS = new Set(["completed", "failed", "cancelled"]);

// ── effect classification ────────────────────────────────────────────────

function keywordEffect(toolName) {
    for (const [keyword, effect] of SERVER_KEYWORD_ENTRIES) {
        if (toolName.startsWith(keyword)) return effect;
    }
    return null;
}

/**
 * Classify a tool name to one of MCP_EFFECTS — deterministic + table driven.
 *
 * @param {string} name            bare tool name or "server/tool"
 * @param {{ server?: string|null, meta?: object|null }} [options]
 *   `server`: explicit owning server (used by capabilityView for bare MCP names).
 * @returns {"read"|"write"|"exec"|"network"|"external"}
 */
export function classifyToolEffect(name, { server = null, meta = null } = {}) {
    const raw = String(name ?? "").trim();
    if (!raw) return "external";
    const slash = raw.indexOf("/");
    let owner = server ? String(server) : null;
    let toolName = raw;
    if (slash >= 0) {
        if (!owner) owner = raw.slice(0, slash) || null;
        toolName = raw.slice(slash + 1);
    }

    // No server context: only exact local names map; everything else is external.
    if (!owner) {
        if (Object.prototype.hasOwnProperty.call(LOCAL_TOOL_EFFECT, raw)) return LOCAL_TOOL_EFFECT[raw];
        return "external";
    }

    // Self-connect servers reuse the LOCAL_TOOL_EFFECT table on the tool part.
    if (SELF_CONNECT_SERVERS.has(owner)) {
        if (Object.prototype.hasOwnProperty.call(LOCAL_TOOL_EFFECT, toolName)) return LOCAL_TOOL_EFFECT[toolName];
        return "external";
    }

    // Explicit per-server override table wins over generic keywords.
    const overrides = SERVER_TOOL_OVERRIDES[owner];
    if (overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, toolName)) return overrides[toolName];
        const direct = keywordEffect(toolName);
        if (direct) return direct; // generic keyword within an overridden server
    }

    return keywordEffect(toolName) || "external";
}

// ── preset × effect policy ───────────────────────────────────────────────

function normalizeEffect(effect) {
    const raw = String(effect ?? "").trim().toLowerCase();
    return MCP_EFFECTS.includes(raw) ? raw : "external";
}

/**
 * Server-decided policy table for MCP effects under a run preset. Local PRESETS
 * (coding/presets.js) already govern write/exec; network is stricter than exec by
 * default (observe/edit deny, only trusted may ask the owner) and external (an
 * effect we cannot classify) is ALWAYS denied — never silently auto-approved.
 *
 * @param {string} preset
 * @returns {{ preset: string, policy: Record<string, "allow"|"deny"|"approve"|"auto"> }}
 */
export function mcpEffectPolicy(preset) {
    const key = normalizePreset(preset);
    const base = PRESETS[key] || {};
    return {
        preset: key,
        policy: {
            read: "allow",
            write: base.write || "deny",
            exec: base.exec || "deny",
            network: key === "trusted" ? "approve" : "deny",
            external: "deny",
        },
    };
}

/**
 * Resolve the decision for ONE effect right now (flag read at call time).
 *
 * read is always allowed. Non-read effects require the run-scope capability to be
 * ON — with MCP_RUN_SCOPE_ENABLED dark, an approve/auto/allow decision would
 * otherwise contradict the disabled gateway, so we fall back to deny
 * (disabledReason = MCP_RUN_SCOPE_DISABLED). The gateway already short-circuits
 * before this; the check here is a second boundary.
 *
 * @returns {{ decision: "allow"|"approve"|"auto"|"deny",
 *             disabledReason: string|null, preset: string, effect: string }}
 */
export function resolveEffectPolicy(preset, effect) {
    const key = normalizePreset(preset);
    const eff = normalizeEffect(effect);
    const { policy } = mcpEffectPolicy(key);
    let decision = policy[eff];
    let disabledReason = null;
    if (eff !== "read" && !mcpRunScopeEnabled() && decision !== "deny") {
        decision = "deny";
        disabledReason = "MCP_RUN_SCOPE_DISABLED";
    }
    return { decision, disabledReason, preset: key, effect: eff };
}

// ── sanitization helpers ─────────────────────────────────────────────────

const SECRET_LINE_PATTERN = /(\b(?:authorization|api[_-]?key|token|password|passwd|secret|access[_-]?key|bearer)\b)\s*[:=]\s*[^\s,;{"]+/gi;
const BEARER_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_LIKE_PATTERN = /\b(?:sk|pk|ghp|gho|xox[baprs])-[A-Za-z0-9._-]{8,}/g;

/** Redact secret-like tokens, strip control bytes, and truncate to `max`. */
function cleanOutputText(value, max) {
    let text;
    if (typeof value === "string") {
        text = value;
    } else {
        try { text = JSON.stringify(value); } catch { text = String(value); }
    }
    text = String(text ?? "");
    text = text.replace(BEARER_PATTERN, "[redacted]")
        .replace(KEY_LIKE_PATTERN, "[redacted]")
        .replace(SECRET_LINE_PATTERN, "$1=[redacted]");
    let out = "";
    for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (code === 9 || code === 10 || code === 13) { out += ch; continue; }
        if (code < 32 || code === 127) continue;
        out += ch;
    }
    const limit = Math.max(1, Number(max) || 4000);
    if (out.length > limit) return `${out.slice(0, limit)}…[truncated]`;
    return out;
}

function sanitizeErrorMessage(err, max = 200) {
    const raw = err instanceof Error ? (err.message ?? "") : String(err ?? "tool call failed");
    return cleanOutputText(raw, max);
}

function sanitizeCode(code) {
    return String(code ?? "TOOL_INVOKE_FAILED").slice(0, 128);
}

// ── timeout helper (distinct from resilience withRetry) ──────────────────

function toolTimeoutError(timeoutMs) {
    const err = codingError("TOOL_TIMEOUT", `MCP tool call exceeded ${timeoutMs}ms timeout`, 504);
    err.retryable = true;
    return err;
}

/**
 * Race a promise factory against a wall-clock deadline. On timeout the inner
 * AbortController is aborted (so a well-behaved transport cancels too) and we
 * reject with a retryable `{ code: 'TOOL_TIMEOUT', retryable: true }` error.
 * The outer `signal` is forwarded by aborting the inner controller; a hung
 * factory that never observes the signal still loses the race.
 *
 * @param {(signal: AbortSignal) => Promise<unknown>} promiseFactory
 * @param {number} timeoutMs
 * @param {{ signal?: AbortSignal|null }} [options]
 */
export function withTimeoutMs(promiseFactory, timeoutMs, { signal = null } = {}) {
    const timeout = Math.max(1, Number(timeoutMs) || 1000);
    const controller = new AbortController();
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (signal) signal.removeEventListener("abort", onOuterAbort);
    };
    const onOuterAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            controller.abort();
            cleanup();
            reject(toolTimeoutError(timeout));
        }, timeout);
        Promise.resolve()
            .then(() => promiseFactory(controller.signal))
            .then(
                (value) => { clearTimeout(timer); cleanup(); resolve(value); },
                (err) => { clearTimeout(timer); cleanup(); reject(err); },
            );
    });
}

// ── scope / run open checks ──────────────────────────────────────────────

function assertRunOpen(scope, runId) {
    ensureSchema();
    const row = db.prepare(
        "SELECT status FROM coding_runs WHERE id = ? AND owner_user_id = ? AND tenant_id = ?",
    ).get(String(runId), scope.userId, scope.tenantId);
    if (!row) throw codingError("CODING_RUN_NOT_FOUND", "coding run not found", 404);
    if (TERMINAL_RUN_STATUS.has(row.status)) {
        throw codingError("RUN_TERMINAL", `run is already ${row.status}`, 409);
    }
}

// ── envelope builders ────────────────────────────────────────────────────

function envelope({ ok, status, data = null, errorCode = null, message = null, retryable = false, effect, decision, tool, latencyMs = 0, approvalId = null, actionId = null, artifacts = null }) {
    return {
        ok,
        status,
        data,
        errorCode,
        message,
        retryable,
        artifacts,
        diagnostics: {
            effect: effect == null ? null : String(effect),
            decision: String(decision ?? "unknown"),
            latencyMs,
            tool: String(tool ?? ""),
            source: "run-scope-mcp",
        },
        approvalId,
        actionId,
    };
}

function disabledEnvelope(tool) {
    return envelope({
        ok: false, status: "disabled", errorCode: "MCP_RUN_SCOPE_DISABLED",
        message: "MCP run-scope is disabled (set MCP_RUN_SCOPE_ENABLED)",
        retryable: false, effect: null, decision: "disabled", tool,
    });
}

function deniedEnvelope(effect, preset, tool) {
    return envelope({
        ok: false, status: "denied", errorCode: "TOOL_EFFECT_DENIED",
        message: `effect ${effect} is not permitted for preset ${preset}`,
        retryable: false, effect, decision: "deny", tool,
    });
}

function invalidToolEnvelope(tool) {
    return envelope({
        ok: false, status: "invalid", errorCode: "INVALID_TOOL_NAME",
        message: "tool name is required",
        retryable: false, effect: null, decision: "invalid", tool,
    });
}

function claimDeniedEnvelope(reason, tool, actionId) {
    const codeMap = {
        not_approved: "ACTION_NOT_APPROVED",
        denied: "ACTION_DECISION_DENIED",
        already_settled: "ACTION_ALREADY_SETTLED",
    };
    return envelope({
        ok: false, status: reason || "not_claimed",
        errorCode: codeMap[reason] || "ACTION_NOT_CLAIMED",
        message: `action could not be claimed for execution: ${reason || "not_claimed"}`,
        retryable: false, effect: null, decision: reason || "not_claimed", tool,
        actionId,
    });
}

// ── the run-scope factory ────────────────────────────────────────────────

/**
 * Build a coding-run-scoped MCP gateway for one run.
 *
 * @param {object} options
 * @param {object} options.scope                 owner scope { userId, tenantId }
 * @param {string|null} options.runId            coding run the tools belong to
 * @param {"observe"|"edit"|"trusted"} [options.preset="observe"]
 * @param {object} [options.registry=toolRegistry]
 * @param {object} [options.approvalService=defaultApprovalService]
 * @param {number} [options.defaultTimeoutMs=30000]
 * @param {number} [options.maxOutputChars=4000]
 */
export function createMcpRunScope({
    scope,
    runId = null,
    preset = "observe",
    registry = toolRegistry,
    approvalService = defaultApprovalService,
    defaultTimeoutMs = 30000,
    maxOutputChars = 4000,
} = {}) {
    const scoped = requireCodingScope(scope, "run-scope-mcp");
    const cleanPreset = normalizePreset(preset);
    const rid = runId == null ? null : String(runId);
    const hardTimeoutMs = Math.max(1, Number(defaultTimeoutMs) || 30000);
    const hardMaxChars = Math.max(256, Number(maxOutputChars) || 4000);

    function policyForEffect(effect) {
        return mcpEffectPolicy(cleanPreset).policy[normalizeEffect(effect)];
    }

    /** True while the feature flag is on (call-time, never import-time). */
    function enabled() {
        return mcpRunScopeEnabled();
    }

    /**
     * Server capability snapshot: every visible MCP tool classified and filtered
     * by the run's policy. Only MCP-sourced tools appear (bare local tools and
     * re-exposed agent-evo-local/local tools are excluded). View is the raw
     * preset contract — it never throws while the feature is dark.
     */
    function capabilityView() {
        ensureSchema();
        const { policy } = mcpEffectPolicy(cleanPreset);
        const allowed = [];
        const denied = [];
        const serverNames = Array.isArray(registry.getMCPServerNames(scoped))
            ? registry.getMCPServerNames(scoped)
            : [];
        const seenSuffix = new Set(); // namespaced wins; bare duplicate skipped

        for (const serverName of serverNames) {
            const tools = registry.getMCPServerTools(serverName, scoped) || [];
            const ns = [];
            const bare = [];
            for (const tool of tools) {
                const rawName = String(tool?.name ?? "").trim();
                if (!rawName) continue;
                if (rawName.includes("/")) ns.push(rawName); else bare.push(rawName);
            }
            for (const full of ns) {
                const suffix = full.slice(full.indexOf("/") + 1);
                if (SELF_CONNECT_SERVERS.has(serverName) && LOCAL_TOOL_EFFECT[suffix]) continue; // local re-exposed
                if (seenSuffix.has(suffix)) continue;
                seenSuffix.add(suffix);
                const effect = classifyToolEffect(suffix, { server: serverName });
                pushDecision(allowed, denied, policy, effect, full, cleanPreset);
            }
            for (const rawName of bare) {
                if (SELF_CONNECT_SERVERS.has(serverName) && LOCAL_TOOL_EFFECT[rawName]) continue;
                if (seenSuffix.has(rawName)) continue; // prefer the namespaced form
                seenSuffix.add(rawName);
                const effect = classifyToolEffect(rawName, { server: serverName });
                pushDecision(allowed, denied, policy, effect, `${serverName}/${rawName}`, cleanPreset);
            }
        }
        return { preset: cleanPreset, policy, allowed, denied, mcpServerCount: serverNames.length };
    }

    function pushDecision(allowed, denied, policy, effect, name, presetName) {
        const decision = policy[effect];
        if (decision === "allow" || decision === "approve" || decision === "auto") {
            allowed.push({ name, effect });
        } else {
            denied.push({ name, effect, reason: `effect "${effect}" denied by preset "${presetName}" policy` });
        }
    }

    /**
     * Execute a tool whose policy is allow/auto (direct) or that was owner-
     * approved (approvedActionId != null). Always returns an envelope — never
     * leaks a provider error; timeout enforced via withTimeoutMs.
     */
    async function executeTool({ effect, decision, tool, input, timeoutMs, signal, approvedActionId = null }) {
        const startedAt = Date.now();
        try {
            const result = await withTimeoutMs(
                (innerSignal) => registry.invokeTool(tool, input, { scope: scoped, signal: innerSignal }),
                timeoutMs,
                { signal },
            );
            const latencyMs = Date.now() - startedAt;
            console.log(`[run-scope] executed tool=${tool} effect=${effect} decision=${decision} preset=${cleanPreset} latencyMs=${latencyMs}`);
            return envelope({
                ok: true, status: "executed", data: cleanOutputText(result, hardMaxChars),
                errorCode: null, retryable: false, effect, decision, tool, latencyMs, actionId: approvedActionId,
            });
        } catch (err) {
            const latencyMs = Date.now() - startedAt;
            if (err?.code === "TOOL_TIMEOUT" || err?.code === "ABORTED") {
                const timeout = err?.code === "TOOL_TIMEOUT";
                return envelope({
                    ok: false, status: timeout ? "timeout" : "failed",
                    errorCode: timeout ? "TOOL_TIMEOUT" : "ABORTED",
                    message: sanitizeErrorMessage(err),
                    retryable: timeout || Boolean(err?.retryable),
                    effect, decision, tool, latencyMs, actionId: approvedActionId,
                });
            }
            const rawCode = String(err?.code || "TOOL_INVOKE_FAILED").slice(0, 128);
            const retryable = Boolean(err?.retryable) || RETRYABLE_TOOL_CODES.has(String(rawCode).toUpperCase());
            return envelope({
                ok: false, status: "failed", errorCode: sanitizeCode(rawCode),
                message: sanitizeErrorMessage(err),
                retryable, effect, decision, tool, latencyMs, actionId: approvedActionId,
            });
        }
    }

    /**
     * Run ONE MCP tool under this run scope.
     *
     * @returns {Promise<object>} unified result envelope
     */
    async function call({ tool, input = {}, signal = null, timeoutMs = hardTimeoutMs, requestedBy = null } = {}) {
        if (!mcpRunScopeEnabled()) return disabledEnvelope(tool ?? "");
        if (!rid) throw codingError("MCP_RUN_SCOPE_NEEDS_RUN", "runId is required (coding run ownership)", 400);
        assertRunOpen(scoped, rid);
        const cleanTool = String(tool ?? "").trim();
        if (!cleanTool) return invalidToolEnvelope(cleanTool);

        const effect = classifyToolEffect(cleanTool);
        const decision = policyForEffect(effect);
        const latencyMs = 0;

        if (decision === "deny") return deniedEnvelope(effect, cleanPreset, cleanTool);
        if (decision === "approve") {
            const { approval, action } = approvalService.requestApproval(scoped, rid, {
                type: effect, tool: cleanTool, input,
                timeoutMs: Math.max(1, Number(timeoutMs) || hardTimeoutMs),
                policy: { preset: cleanPreset, effect },
                requestedBy,
            });
            return envelope({
                ok: true, status: "needs_approval", data: null, errorCode: null,
                message: "awaiting owner approval", retryable: false,
                effect, decision, tool: cleanTool, latencyMs,
                approvalId: approval.id, actionId: action.id,
            });
        }

        // allow / auto → direct execution.
        return executeTool({ effect, decision, tool: cleanTool, input, timeoutMs: clampTimeout(timeoutMs), signal, approvedActionId: null });
    }

    /**
     * Execute an already owner-approved action exactly once (claim is at-most-
     * once). Settles the action row + emits the existing action.executed /
     * action.exec_failed events via ApprovalService.
     */
    async function execute({ actionId, signal = null, timeoutMs = hardTimeoutMs, requestedBy = null } = {}) {
        if (!mcpRunScopeEnabled()) return disabledEnvelope(null);
        if (!actionId) throw codingError("MCP_RUN_SCOPE_NEEDS_ACTION", "actionId is required", 400);
        const action = approvalService.getAction(scoped, String(actionId));
        if (!action) throw codingError("NOT_FOUND", "action not found", 404);
        const claim = approvalService.claimActionExecution(scoped, action.id);
        if (!claim.claimed) {
            return claimDeniedEnvelope(claim.reason, action.tool, action.id);
        }

        const effect = normalizeEffect(action.type);
        const decision = "approved";
        const result = await executeTool({
            effect, decision, tool: action.tool, input: action.input,
            timeoutMs: clampTimeout(timeoutMs), signal, approvedActionId: action.id,
        });
        if (result.ok) {
            approvalService.completeAction(scoped, action.id, { ok: true });
        } else {
            approvalService.completeAction(scoped, action.id, { ok: false, errorCode: result.errorCode || "TOOL_INVOKE_FAILED" });
        }
        return { ...result, actionId: action.id };
    }

    function clampTimeout(value) {
        return Math.max(1, Number(value) || hardTimeoutMs);
    }

    return { enabled, capabilityView, call, execute };
}

export default { MCP_EFFECTS, LOCAL_TOOL_EFFECT, SERVER_TOOL_RULES, classifyToolEffect, mcpEffectPolicy, resolveEffectPolicy, withTimeoutMs, createMcpRunScope };
