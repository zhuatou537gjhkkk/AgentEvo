/**
 * Shared coding-domain helpers: scope validation + stored-payload sanitization.
 *
 * R0 DoD — secrets/raw env/provider errors are never persisted. Every write path
 * funnels JSON through `sanitizeStored` so forbidden keys, non-serializable
 * values, oversized payloads, and NUL/control bytes are stripped before the row
 * is written. Scope comes only from the authenticated request (resourceScope).
 */
import { randomUUID } from "node:crypto";

const FORBIDDEN_KEY = /(secret|token|passwd|password|authorization|auth|cookie|api[_-]?key|credential|private[_-]?key|access[_-]?key|bearer|session[_-]?id)/i;
export const MAX_STORED_JSON_BYTES = 12 * 1024;

export function codingError(code, message, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}

/** Owner scope from the authenticated request surface; never from body/model. */
export function requireCodingScope(scope, label = "coding resource") {
    const userId = Number(scope?.userId ?? scope?.ownerUserId ?? scope?.owner_user_id);
    const explicitTenant = scope?.tenantId ?? scope?.tenant_id;
    const tenantId = String(
        explicitTenant || (Number.isInteger(userId) && userId > 0 ? `user:${userId}` : ""),
    );
    if (!Number.isInteger(userId) || userId <= 0 || !/^[-a-zA-Z0-9_:]{1,128}$/.test(tenantId)) {
        throw codingError("INVALID_CODING_SCOPE", `${label} ownership is required`, 400);
    }
    return { userId, tenantId };
}

export function newId(prefix = "") {
    return `${prefix}${randomUUID()}`;
}

function looksForbidden(key) {
    return FORBIDDEN_KEY.test(key);
}

/** Keep tab/lf/cr; drop other control chars (incl. NUL) so payloads stay UTF-8 clean. */
function stripControl(value) {
    let out = "";
    for (const ch of String(value)) {
        const code = ch.charCodeAt(0);
        if (code === 9 || code === 10 || code === 13) { out += ch; continue; }
        if (code < 32 || code === 127) continue;
        out += ch;
    }
    return out.slice(0, 4000);
}

function sanitizeValue(value, depth) {
    if (depth > 6) return undefined;
    if (value == null) return null;
    const type = typeof value;
    if (type === "boolean") return value;
    if (type === "number") return Number.isFinite(value) ? value : null;
    if (type === "string") return stripControl(value);
    if (type === "bigint" || type === "symbol" || type === "function") return undefined;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) {
        const out = [];
        for (const item of value) {
            const clean = sanitizeValue(item, depth + 1);
            if (clean !== undefined) out.push(clean);
        }
        return out;
    }
    if (type === "object") {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (looksForbidden(key)) continue; // never persist credential-like keys
            const clean = sanitizeValue(item, depth + 1);
            if (clean !== undefined) out[key] = clean;
        }
        return out;
    }
    return undefined;
}

/**
 * Return a JSON string safe for durable storage.
 * @param {unknown} value
 * @param {{ maxBytes?: number }} [options]
 */
export function sanitizeStored(value, { maxBytes = MAX_STORED_JSON_BYTES } = {}) {
    let parsed;
    if (typeof value === "string") {
        try { parsed = JSON.parse(value); } catch { parsed = { note: String(value).slice(0, 500) }; }
    } else {
        parsed = value;
    }
    if (parsed === undefined || parsed === null || typeof parsed !== "object") parsed = {};
    const clean = sanitizeValue(parsed, 0) || {};
    const text = JSON.stringify(clean);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) {
        throw codingError("PAYLOAD_TOO_LARGE", `stored payload exceeds ${maxBytes} bytes`, 413);
    }
    return text;
}

export function nowSql(date = new Date()) {
    return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/** Free-text sanitization (keeps line breaks; drops control chars, NUL, overlong). */
export function cleanText(value, max = 500) {
    let out = "";
    for (const ch of String(value ?? "")) {
        const code = ch.charCodeAt(0);
        if (code === 9 || code === 10 || code === 13) { out += ch; continue; }
        if (code < 32 || code === 127) continue;
        out += ch;
    }
    return out.slice(0, max);
}
