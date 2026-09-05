import { getRequestContext } from "../services/requestContext.js";

/**
 * Build an immutable resource scope from server-authenticated identity.
 * Callers must never populate owner/tenant fields from request body or model input.
 */
export function createResourceScope(identity = null) {
    const source = identity || getRequestContext() || {};
    const userId = Number(source.userId ?? source.id);
    const tenantId = String(source.tenantId || `user:${userId}`);
    if (!Number.isInteger(userId) || userId <= 0 || !/^[-a-zA-Z0-9_:]{1,128}$/.test(tenantId)) {
        throw new Error("authenticated resource scope is required");
    }
    return Object.freeze({ userId, tenantId });
}

export function scopeFromRequest(req) {
    return createResourceScope({
        userId: req?.user?.id,
        tenantId: req?.user?.tenantId || req?.requestContext?.tenantId,
    });
}

export function sameResourceScope(left, right) {
    return Boolean(left && right)
        && Number(left.userId) === Number(right.userId)
        && String(left.tenantId) === String(right.tenantId);
}

export function notFoundResource(res, message = "resource not found") {
    return res.status(404).json({
        ok: false,
        error: "NOT_FOUND",
        message,
        retryable: false,
    });
}
