import { toErrorEnvelope } from "../services/resilience.js";

/**
 * Per-request dependency resolution shared by factory registrars.
 *
 * Factory instances (`createApp`) attach an instance-local dependency bag on
 * `req.locals`. The production singleton `app` sets `app.locals.dependencies`
 * to the module defaults, so a registrar mounted on either surface resolves the
 * same way: bag → app.locals → explicit error.
 */
export function dependencyBag(req) {
    return req?.locals?.dependencies || req?.app?.locals?.dependencies || {};
}

export function requireDep(req, group, name) {
    const value = dependencyBag(req)?.[group]?.[name];
    if (value === undefined || value === null) {
        throw Object.assign(new Error(`missing dependency: ${group}.${name}`), {
            code: "DEPENDENCY_UNAVAILABLE",
            statusCode: 503,
        });
    }
    return value;
}

/** Database function from the `db` bag. */
export const dbFn = (req, name) => requireDep(req, "db", name);

/** Service function/instance from the `services` bag. */
export const svcFn = (req, name) => requireDep(req, "services", name);

/** Uniform JSON error envelope so routes never leak raw provider errors. */
export function sendError(res, requestId, error, { code = "REQUEST_FAILED", status = 500 } = {}) {
    if (res.headersSent) return;
    const statusCode = Number(error?.statusCode) || Number(error?.status) || status;
    const finalStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    return res.status(finalStatus).json(toErrorEnvelope(
        Object.assign(new Error(error?.message || "request failed"), {
            code: error?.code || code,
            statusCode: finalStatus,
            retryable: finalStatus >= 500,
        }),
        requestId
    ));
}
