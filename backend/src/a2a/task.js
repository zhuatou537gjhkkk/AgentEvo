/**
 * Phase 7 / R5 (roadmap #7) — same-instance A2A task model (a2a/task.js).
 *
 * The runtime-facing, transport-neutral A2A task record. Everything here is a
 * pure deterministic transform (create / transition / artifact / message /
 * sanitize) — no DB, no network, no LLM, no flags. The statuses deliberately
 * mirror the internal AgentTask TASK_STATUS vocabulary so the main-Graph and A2A
 * adapters share one notion of "running work", while `toWireStatus` /
 * `fromWireStatus` translate to the A2A wire vocabulary only at the boundary.
 *
 * Cleanup policy (roadmap R5 DoD): every free-text field is stripped of control
 * bytes and truncated; `input` is deep-cleaned so credential-like keys are never
 * kept; `sanitizeTask` is the last-line guarantee for anything that leaves for
 * HTTP/frontend and never emits a secret.
 */
import { randomUUID } from "node:crypto";
import { codingError } from "../coding/util.js";
import { TASK_STATUS, EFFECT_TYPES, KNOWN_AGENT_TYPES } from "../agenttask/agentTask.js";

/** Internal A2A statuses — identical set to the internal AgentTask. */
export const A2A_TASK_STATUS = Object.freeze([...TASK_STATUS]);

/** A2A wire vocabulary (created | working | input-required | completed | canceled | failed | unknown). */
export const A2A_WIRE_STATUS = Object.freeze({
    created: "created",
    queued: "working",
    running: "working",
    waiting_input: "input-required",
    succeeded: "completed",
    failed: "failed",
    cancelled: "canceled",
});

const WIRE_TO_INTERNAL = Object.freeze({
    created: "created",
    working: "running",
    "input-required": "waiting_input",
    completed: "succeeded",
    failed: "failed",
    canceled: "cancelled",
    unknown: "created",
});

/** Internal → wire. Anything outside the known internal set reads as unknown. */
export function toWireStatus(internal) {
    return A2A_WIRE_STATUS[internal] || "unknown";
}

/** Wire → internal. Anything unrecognised maps back to a fresh `created`. */
export function fromWireStatus(wire) {
    return WIRE_TO_INTERNAL[String(wire || "").trim()] || "created";
}

/** Legal single-step internal transitions. Terminal states are immutable. */
export const ALLOWED_TRANSITIONS = Object.freeze({
    created: ["queued", "cancelled"],
    queued: ["running", "cancelled"],
    running: ["succeeded", "failed", "cancelled", "waiting_input"],
    waiting_input: ["running", "cancelled"],
    succeeded: [],
    failed: [],
    cancelled: [],
});

function cleanString(value, max = 500) {
    if (value == null) return "";
    let out = "";
    for (const ch of String(value)) {
        const code = ch.charCodeAt(0);
        if (code === 9 || code === 10 || code === 13) { out += ch; continue; }
        if (code < 32 || code === 127) continue;
        out += ch;
    }
    return out.slice(0, max).trim();
}

const FORBIDDEN_KEY = /(secret|token|passwd|password|authorization|auth|cookie|api[_-]?key|credential|private[_-]?key|access[_-]?key|bearer)/i;

/**
 * Deep-clean an arbitrary JSON-ish value for storage in a task: credential-like
 * keys dropped at any depth, control bytes stripped, non-serialisable values
 * removed, strings truncated. Pure — mirrors coding/util sanitizeStored without
 * its DB/byte-limit concerns.
 */
function deepClean(value, depth = 0) {
    if (depth > 8) return undefined;
    if (value == null) return null;
    const type = typeof value;
    if (type === "boolean") return value;
    if (type === "number") return Number.isFinite(value) ? value : null;
    if (type === "string") return cleanString(value, 2000);
    if (type === "bigint" || type === "symbol" || type === "function") return undefined;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) {
        const out = [];
        for (const item of value) {
            const clean = deepClean(item, depth + 1);
            if (clean !== undefined) out.push(clean);
            if (out.length >= 100) break;
        }
        return out;
    }
    if (type === "object") {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (FORBIDDEN_KEY.test(key)) continue;
            const clean = deepClean(item, depth + 1);
            if (clean !== undefined) out[key] = clean;
        }
        // A wholly-stripped object (every key forbidden/unsafe) is dropped rather
        // than left as an empty {} so secret-only payloads vanish entirely.
        if (Object.keys(value).length > 0 && Object.keys(out).length === 0) return undefined;
        return out;
    }
    return undefined;
}

function cleanEffects(value) {
    if (value == null) return [];
    const list = Array.isArray(value) ? value : [value];
    const seen = new Set();
    for (const item of list) {
        const e = cleanString(item, 32);
        if (EFFECT_TYPES.includes(e) && !seen.has(e)) seen.add(e);
    }
    return EFFECT_TYPES.filter((e) => seen.has(e));
}

function cleanAgents(value) {
    if (value == null) return [];
    const list = Array.isArray(value) ? value : [value];
    const seen = new Set();
    for (const item of list) {
        const a = cleanString(item, 32);
        if (KNOWN_AGENT_TYPES.includes(a) && !seen.has(a)) seen.add(a);
    }
    return seen.size ? KNOWN_AGENT_TYPES.filter((a) => seen.has(a)) : [];
}

/** Capability intersection — always a subset of the known vocabulary. */
function cleanCapability(capability) {
    return {
        effects: cleanEffects(capability?.effects),
        agents: cleanAgents(capability?.agents),
    };
}

function cleanParts(parts) {
    if (!Array.isArray(parts)) return [];
    const out = [];
    for (const part of parts) {
        if (part == null) continue;
        if (typeof part === "string") {
            const s = cleanString(part, 4000);
            if (s) out.push(s);
        } else if (typeof part === "object") {
            const cleaned = deepClean(part);
            if (cleaned && Object.keys(cleaned).length) out.push(cleaned);
        }
        if (out.length >= 64) break;
    }
    return out;
}

/**
 * Build a canonical A2A task. `id` defaults to a random uuid when omitted;
 * optional fields get safe defaults. input/strings are cleaned at write time so
 * the stored task never holds secrets or control bytes.
 */
export function createA2ATask({
    id = null,
    agent = null,
    goal = "",
    input = {},
    capability = null,
    parentTaskId = null,
    requestId = null,
    runId = null,
} = {}) {
    const nowIso = new Date().toISOString();
    return {
        id: id == null ? randomUUID() : cleanString(id, 128),
        kind: "a2a.task",
        agent: agent == null ? null : cleanString(agent, 64),
        goal: cleanString(goal, 4000),
        input: deepClean(input, 0) || {},
        capability: cleanCapability(capability || {}),
        status: "created",
        artifacts: [],
        messages: [],
        parentTaskId: parentTaskId == null ? null : cleanString(parentTaskId, 128),
        requestId: requestId == null ? null : cleanString(requestId, 128),
        runId: runId == null ? null : cleanString(runId, 128),
        createdAt: nowIso,
        updatedAt: nowIso,
        meta: {},
    };
}

function requireTask(task) {
    if (!task || typeof task !== "object" || !String(task?.id || "")) {
        throw codingError("INVALID_A2A_TASK", "a2a task is required", 400);
    }
    return task;
}

/**
 * Validate + apply a single internal transition. Throws
 * INVALID_TASK_TRANSITION (409) for illegal steps; terminal states are immutable.
 */
export function transitionTask(task, to, { at = null } = {}) {
    const t = requireTask(task);
    const target = cleanString(to, 16);
    if (!A2A_TASK_STATUS.includes(target)) {
        throw codingError("INVALID_TASK_TRANSITION", `"${target}" is not a known a2a task status`, 409);
    }
    const from = t.status;
    const allowed = ALLOWED_TRANSITIONS[from] || [];
    if (!allowed.includes(target)) {
        throw codingError(
            "INVALID_TASK_TRANSITION",
            `a2a task ${t.id} cannot transition ${from} → ${target}`,
            409,
        );
    }
    const nowIso = at ? String(at) : new Date().toISOString();
    return { ...t, status: target, updatedAt: nowIso };
}

function cleanArtifact(artifact) {
    return {
        id: artifact?.id == null ? randomUUID() : String(artifact.id).slice(0, 128),
        name: cleanString(artifact?.name, 200) || "artifact",
        uri: artifact?.uri == null ? undefined : cleanString(artifact.uri, 500) || undefined,
        mimeType: artifact?.mimeType == null ? undefined : cleanString(artifact.mimeType, 64) || undefined,
        bytes: Number.isFinite(Number(artifact?.bytes)) && Number(artifact.bytes) >= 0 ? Number(artifact.bytes) : undefined,
        contentPreview: artifact?.contentPreview == null
            ? undefined
            : String(cleanString(artifact.contentPreview, 500)),
    };
}

/** Append an artifact (kept ≤20; older entries dropped when over the cap). */
export function addArtifact(task, artifact = {}) {
    const t = requireTask(task);
    const next = [...(Array.isArray(t.artifacts) ? t.artifacts : []), cleanArtifact(artifact)];
    while (next.length > 20) next.shift();
    return { ...t, artifacts: next, updatedAt: new Date().toISOString() };
}

/** Append a conversational message. `role` must be user|agent. */
export function addMessage(task, { role = "agent", parts = [] } = {}) {
    const t = requireTask(task);
    const cleanRole = cleanString(role, 16);
    if (cleanRole !== "user" && cleanRole !== "agent") {
        throw codingError("INVALID_A2A_MESSAGE_ROLE", "message role must be user or agent", 400);
    }
    const message = { messageId: randomUUID(), role: cleanRole, parts: cleanParts(parts), at: new Date().toISOString() };
    const next = [...(Array.isArray(t.messages) ? t.messages : []), message];
    while (next.length > 64) next.shift();
    return { ...t, messages: next, updatedAt: new Date().toISOString() };
}

/**
 * External/HTTP-safe view of a task: input re-deep-cleaned (no secrets at any
 * depth), artifact previews truncated, failed-task `error.message` dropped (only
 * the sanitised errorCode is exposed). Never leaks a credential-like key.
 */
export function sanitizeTask(task) {
    const t = requireTask(task);
    const error = t.error && typeof t.error === "object"
        ? { errorCode: cleanErrorCode(t.error.errorCode) }
        : undefined;
    return {
        ...t,
        goal: cleanString(t.goal, 4000),
        input: deepClean(t.input, 0) || {},
        artifacts: (Array.isArray(t.artifacts) ? t.artifacts : []).map((a) => ({
            ...a,
            contentPreview: a.contentPreview == null ? undefined : String(a.contentPreview).slice(0, 500),
            uri: a.uri == null ? undefined : String(a.uri).slice(0, 500),
        })),
        messages: (Array.isArray(t.messages) ? t.messages : []).map((m) => ({
            messageId: m?.messageId,
            role: m?.role === "user" ? "user" : "agent",
            parts: cleanParts(m?.parts),
            at: m?.at,
        })),
        ...(error ? { error } : {}),
    };
}

/** Uppercase-alnum/underscore error code allowlist (never a raw exception string). */
export function cleanErrorCode(code) {
    const s = String(code || "").trim();
    return /^[A-Z][A-Z0-9_]{0,63}$/.test(s) ? s : "A2A_EXECUTOR_ERROR";
}

export default {
    A2A_TASK_STATUS,
    A2A_WIRE_STATUS,
    toWireStatus,
    fromWireStatus,
    ALLOWED_TRANSITIONS,
    transitionTask,
    createA2ATask,
    addArtifact,
    addMessage,
    sanitizeTask,
    cleanErrorCode,
};
