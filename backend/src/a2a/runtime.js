/**
 * Phase 7 / R5 (roadmap #7) — same-instance A2A task runtime (a2a/runtime.js).
 *
 * Runs A2A tasks against LOCAL trusted agent cards by deterministic injected
 * executors only — no LLM / no network / no filesystem / no MCP spawn. The whole
 * runtime is DEFAULT OFF: `delegateTask` answers 403 A2A_DISABLED while
 * A2A_ENABLED is unset (flag read at call time via flags.a2aEnabled()).
 *
 * Authorization model (roadmap R5 #7 "delegation 只传 capability 子集"):
 *   1. resolve the target card (server-declared, trust:"explicit");
 *   2. `capabilitySubset(card, callerAllowSet)` → the grant (intersection, never wider);
 *   3. `withinCapability(grant, taskClaims)` → refuse any effect/agent outside the grant;
 *   4. the stored task.capability is exactly the granted subset.
 *
 * State lives per owner (userId:tenantId). Executors are async functions
 * `({ scope, task, signal }) => artifact | { artifact } | { error }`. delegate
 * awaits the executor so same-instance callers see a completed/terminal task
 * deterministically; `cancelTask` aborts a running executor through its signal.
 * Audit is a secret-free `[a2a]` console line when a runId is provided — no
 * coding/events.js type is added and messages are attributable via requestId/
 * taskId/runId on the returned task and diagnostics.
 */
import { randomUUID } from "node:crypto";
import { codingError, requireCodingScope, cleanText } from "../coding/util.js";
import { capabilitySubset, withinCapability } from "../protocol/agentCard.js";
import { a2aEnabled } from "../extensibility/flags.js";
import {
    ALLOWED_TRANSITIONS,
    transitionTask,
    createA2ATask,
    addArtifact,
    sanitizeTask,
    toWireStatus,
    cleanErrorCode,
} from "./task.js";
import { createA2ARegistry, localTrustedCards } from "./registry.js";

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_ARTIFACT_PREVIEW = 500;

/** Secret-free, bounded human text for error metadata (never a raw throw). */
function safeErrorText(value, max = 200) {
    return cleanText(value, max);
}

function safePreview(value) {
    let text = "";
    try {
        text = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        text = String(value || "");
    }
    return cleanText(text, MAX_ARTIFACT_PREVIEW);
}

/** Default read-only status executor (registered for local-status). */
async function localStatusExecutor() {
    return { artifact: { ok: true, summary: "local-status (read-only) ok", checkedAt: new Date().toISOString() } };
}

export class A2ARuntime {
    /**
     * @param {{ registry?: object, now?: () => number }} [options]
     *   registry — a2a registry instance; defaults to the 3 local trusted cards.
     *   now      — clock fn returning epoch ms (Date.now default) for timestamps.
     */
    constructor({ registry = createA2ARegistry({ cards: localTrustedCards() }), now = Date.now } = {}) {
        this.registry = registry;
        this.now = typeof now === "function" ? now : () => now;
        /** @type {Map<string, Map<string, object>>} ownerKey → taskId → task */
        this.tasks = new Map();
        /** @type {Map<string, Map<string, AbortController>>} ownerKey → taskId → controller */
        this.controllers = new Map();
        /** @type {Map<string, Map<string, number>>} ownerKey → taskId → transition count */
        this.counts = new Map();
        /** @type {Map<string, Function>} agent name → async executor */
        this.executors = new Map();
        this.executors.set("local-status", localStatusExecutor);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    _ts() {
        return new Date(this.now()).toISOString();
    }

    _ownerKey(scope) {
        const s = requireCodingScope(scope, "a2a");
        return `${s.userId}:${s.tenantId}`;
    }

    _bucket(key) {
        if (!this.tasks.has(key)) {
            this.tasks.set(key, new Map());
            this.controllers.set(key, new Map());
            this.counts.set(key, new Map());
        }
        return this.tasks.get(key);
    }

    _audit(task) {
        if (task && task.runId) {
            console.log(`[a2a] task=${task.id} agent=${task.agent || "-"} status=${task.status} runId=${task.runId}`);
        }
    }

    _get(key, taskId) {
        return this.tasks.get(key)?.get(taskId) || null;
    }

    /** Strict transition (throws on illegal step) + counter bump + audit. */
    _transition(key, taskId, to) {
        const bucket = this.tasks.get(key);
        const current = bucket?.get(taskId);
        if (!current) throw codingError("A2A_TASK_NOT_FOUND", `a2a task "${taskId}" not found`, 404);
        const next = transitionTask(current, to, { at: this._ts() });
        bucket.set(taskId, next);
        const counters = this.counts.get(key);
        if (counters) counters.set(taskId, (counters.get(taskId) || 0) + 1);
        this._audit(next);
        return next;
    }

    /** Apply a transition only when legal (used after abort/race where the
     * authoritative transition may already have happened). */
    _tryTransition(key, taskId, to) {
        const current = this._get(key, taskId);
        const allowed = (current && ALLOWED_TRANSITIONS[current.status]) || [];
        if (!allowed.includes(to)) return current;
        return this._transition(key, taskId, to);
    }

    /**
     * Attach a failed status + safe error metadata to the current stored task.
     * The state machine reaches `failed` only from `running`, so a task that is
     * still created/queued (e.g. executor-unavailable before dispatch) is first
     * walked through queued → running.
     */
    _fail(key, taskId, errorCode, message) {
        const current = this._get(key, taskId);
        if (current) {
            if (current.status === "created") this._tryTransition(key, taskId, "queued");
            if (["created", "queued"].includes(current.status)) this._tryTransition(key, taskId, "running");
        }
        const failed = this._tryTransition(key, taskId, "failed");
        const code = cleanErrorCode(errorCode);
        const withError = { ...failed, error: { errorCode: code, message: safeErrorText(message) } };
        this.tasks.get(key).set(taskId, withError);
        this._audit(withError);
        return withError;
    }

    // ── public surface ──────────────────────────────────────────────────────

    listCards() {
        return this.registry.listCards();
    }

    registerCard(card) {
        return this.registry.registerCard(card);
    }

    registerExecutor(agent, fn) {
        const name = String(agent || "").trim();
        if (!name) throw codingError("INVALID_EXECUTOR", "agent name is required", 400);
        if (typeof fn !== "function") throw codingError("INVALID_EXECUTOR", "executor must be a function", 400);
        this.executors.set(name, fn);
        return this;
    }

    listExecutors() {
        return Array.from(this.executors.keys());
    }

    /**
     * Delegate a task to a local trusted agent. Default OFF; narrowing happens
     * as described in the module header. Executes the registered executor when
     * present and awaits its outcome (timeout → failed), otherwise fails
     * synchronously with AGENT_EXECUTOR_UNAVAILABLE.
     *
     * @returns {Promise<object>} sanitized terminal/in-flight task view.
     */
    async delegateTask(scope, {
        agent = null,
        goal = "",
        input = {},
        capability = { effects: null, agents: null },
        requestId = null,
        runId = null,
        timeoutMs = DEFAULT_TIMEOUT_MS,
    } = {}) {
        if (!a2aEnabled()) throw codingError("A2A_DISABLED", "a2a is disabled", 403);
        const ownerKey = this._ownerKey(scope);
        const agentName = String(agent || "").trim();
        if (!agentName) throw codingError("A2A_AGENT_REQUIRED", "agent is required", 400);

        const card = this.registry.getCard(agentName);
        if (!card) throw codingError("A2A_AGENT_NOT_FOUND", `agent "${agentName}" is not a registered local agent`, 404);
        const declaredEffects = card.capabilities?.effects || [];
        const declaredAgents = card.capabilities?.agents || [];
        if (declaredEffects.length === 0 && declaredAgents.length === 0) {
            throw codingError("A2A_AGENT_NO_CAPABILITY", `agent "${agentName}" declares no capability`, 403);
        }

        // Delegation is always a narrowing (capabilitySubset) + a refusal when a
        // claim exceeds the granted surface (withinCapability).
        const allowEffects = capability.effects == null ? null : capability.effects;
        const allowAgents = capability.agents == null ? null : capability.agents;
        const granted = capabilitySubset(card, { effects: allowEffects, agents: allowAgents });
        withinCapability(granted, {
            effects: Array.isArray(capability.effects) ? capability.effects : [],
            agents: Array.isArray(capability.agents) ? capability.agents : [],
        });

        const task = createA2ATask({
            id: `a2a_${randomUUID()}`,
            agent: granted.name,
            goal,
            input,
            capability: { effects: granted.capabilities.effects, agents: granted.capabilities.agents },
            parentTaskId: null,
            requestId,
            runId,
        });
        const bucket = this._bucket(ownerKey);
        bucket.set(task.id, task);
        this.counts.get(ownerKey).set(task.id, 0);
        this._audit(task);
        this._transition(ownerKey, task.id, "queued");

        const executor = this.executors.get(granted.name);
        if (!executor) {
            // Synchronous, deterministic executor-unavailable failure.
            const failed = this._fail(
                ownerKey,
                task.id,
                "AGENT_EXECUTOR_UNAVAILABLE",
                `no executor registered for agent "${granted.name}"`,
            );
            return sanitizeTask(failed);
        }

        const finalTask = await this._run(ownerKey, scope, task.id, executor, { timeoutMs });
        return sanitizeTask(finalTask);
    }

    /** Await the executor (abort-aware), fold the outcome into the stored task. */
    async _run(ownerKey, scope, taskId, executor, { timeoutMs }) {
        const running = this._transition(ownerKey, taskId, "running");
        const controller = new AbortController();
        this.controllers.get(ownerKey).set(taskId, controller);

        let timer = null;
        let outcome = null;
        try {
            const execPromise = Promise.resolve().then(() => executor({
                scope: requireCodingScope(scope, "a2a"),
                task: running,
                signal: controller.signal,
            }));
            let settle;
            const finished = new Promise((resolve) => { settle = resolve; });
            const onAbort = () => settle({ kind: "aborted" });
            controller.signal.addEventListener("abort", onAbort, { once: true });
            if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
                timer = setTimeout(() => settle({ kind: "timeout" }), Number(timeoutMs));
            }
            execPromise.then(
                (value) => settle({ kind: "ok", value }),
                (error) => settle({ kind: "error", error }),
            );
            outcome = await finished;
            controller.signal.removeEventListener("abort", onAbort);
        } finally {
            if (timer) clearTimeout(timer);
            const map = this.controllers.get(ownerKey);
            if (map) map.delete(taskId);
        }

        if (!outcome) return this._get(ownerKey, taskId);

        if (outcome.kind === "ok") {
            const value = outcome.value && typeof outcome.value === "object" ? outcome.value : {};
            if (value && typeof value.error !== "undefined") {
                const code = cleanErrorCode(value.error?.errorCode ?? value.error?.code);
                return this._fail(ownerKey, taskId, code, value.error?.message ? safeErrorText(value.error.message) : "executor reported failure");
            }
            const done = this._tryTransition(ownerKey, taskId, "succeeded");
            if (done && done.status === "succeeded") {
                const payload = value.artifact !== undefined ? value.artifact : value;
                const withArtifact = addArtifact(done, {
                    name: String(done.agent || "artifact"),
                    contentPreview: safePreview(payload),
                });
                this.tasks.get(ownerKey).set(taskId, withArtifact);
                this._audit(withArtifact);
            }
            return this._get(ownerKey, taskId);
        }

        if (outcome.kind === "aborted") {
            const cancelled = this._tryTransition(ownerKey, taskId, "cancelled");
            if (cancelled) this._audit(cancelled);
            return this._get(ownerKey, taskId);
        }

        if (outcome.kind === "timeout") {
            return this._fail(ownerKey, taskId, "A2A_EXECUTION_TIMEOUT", "executor timed out");
        }

        // kind === "error"
        const code = cleanErrorCode(outcome.error && (outcome.error.code ?? outcome.error.errorCode));
        return this._fail(ownerKey, taskId, code, "executor failed");
    }

    /** Return the owner's stored task (sanitized) or throw 404 A2A_TASK_NOT_FOUND. */
    getTask(scope, taskId) {
        const key = this._ownerKey(scope);
        const task = this._get(key, String(taskId || ""));
        if (!task) throw codingError("A2A_TASK_NOT_FOUND", `a2a task "${taskId}" not found`, 404);
        return sanitizeTask(task);
    }

    /**
     * Cancel a queued/running/waiting task. Terminal tasks are immutable → 409.
     * The running executor (if any) receives `signal.abort()`.
     */
    cancelTask(scope, taskId, { reason = null } = {}) {
        const key = this._ownerKey(scope);
        const id = String(taskId || "");
        const current = this._get(key, id);
        if (!current) throw codingError("A2A_TASK_NOT_FOUND", `a2a task "${taskId}" not found`, 404);
        const allowed = (current && ALLOWED_TRANSITIONS[current.status]) || [];
        if (!allowed.includes("cancelled")) {
            throw codingError(
                "INVALID_TASK_TRANSITION",
                `a2a task ${id} in status ${current.status} cannot be cancelled`,
                409,
            );
        }
        const cancelled = this._transition(key, id, "cancelled");
        if (reason != null) {
            const withReason = { ...cancelled, meta: { ...(cancelled.meta || {}), cancelReason: cleanText(reason, 200) } };
            this.tasks.get(key).set(id, withReason);
        }
        const controller = this.controllers.get(key)?.get(id);
        if (controller) controller.abort();
        return sanitizeTask(this._get(key, id));
    }

    /** List the owner's tasks, newest first, sanitized, capped by `limit`. */
    listTasks(scope, { limit = 50 } = {}) {
        const key = this._ownerKey(scope);
        const bucket = this.tasks.get(key);
        if (!bucket) return [];
        const cap = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 200) : 50;
        // Reverse first so tasks created within the same millisecond (equal
        // createdAt) still surface newest-first after the stable sort below.
        return Array.from(bucket.values())
            .reverse()
            .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
            .slice(0, cap)
            .map((task) => sanitizeTask(task));
    }

    /** Attribution snapshot for a task (requestId/taskId/runId + transition count). */
    taskDiagnostics(scope, taskId) {
        const key = this._ownerKey(scope);
        const id = String(taskId || "");
        const task = this._get(key, id);
        if (!task) throw codingError("A2A_TASK_NOT_FOUND", `a2a task "${taskId}" not found`, 404);
        return {
            taskId: task.id,
            agent: task.agent,
            status: task.status,
            wireStatus: toWireStatus(task.status),
            requestId: task.requestId,
            runId: task.runId,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            transitionCount: this.counts.get(key)?.get(id) || 0,
        };
    }
}

/** Module singleton — constructed WITHOUT reading any flags (methods gate at call time). */
export const defaultA2ARuntime = new A2ARuntime();

export default { A2ARuntime, defaultA2ARuntime };
