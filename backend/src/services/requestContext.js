import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

const storage = new AsyncLocalStorage();

/**
 * Request-scoped identity.  The context is deliberately not writable from
 * model/tool input; it is established by the authenticated HTTP request.
 */
export function createRequestContext({ userId, tenantId = null, sessionId = null, username = "", requestId = null } = {}) {
    const safeUserId = Number(userId);
    if (!Number.isInteger(safeUserId) || safeUserId <= 0) {
        throw new Error("request context requires a valid userId");
    }

    return Object.freeze({
        userId: safeUserId,
        tenantId: String(tenantId || `user:${safeUserId}`),
        sessionId: sessionId == null ? null : Number(sessionId),
        username: String(username || ""),
        requestId: String(requestId || crypto.randomUUID()),
    });
}

export function runWithRequestContext(context, callback) {
    return storage.run(context, callback);
}

export function getRequestContext() {
    return storage.getStore() || null;
}

export function getRequestUserId(fallback = null) {
    const userId = getRequestContext()?.userId;
    return Number.isInteger(userId) && userId > 0 ? userId : fallback;
}

export function getRequestId() {
    return getRequestContext()?.requestId || null;
}

export function withSessionContext(sessionId, callback) {
    const current = getRequestContext();
    if (!current) return callback();
    return storage.run(Object.freeze({ ...current, sessionId: Number(sessionId) }), callback);
}

export function runWithAuthenticatedContext({ userId, tenantId, sessionId, username = "", requestId } = {}, callback) {
    return runWithRequestContext(createRequestContext({ userId, tenantId, sessionId, username, requestId }), callback);
}
