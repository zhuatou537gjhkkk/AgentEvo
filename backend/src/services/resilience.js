const RETRYABLE_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UPSTREAM_UNAVAILABLE", "MCP_TRANSPORT_ERROR"]);

export class AppError extends Error {
    constructor(message, { code = "INTERNAL_ERROR", statusCode = 500, retryable = false, cause } = {}) {
        super(message, { cause });
        this.name = "AppError";
        this.code = code;
        this.statusCode = statusCode;
        this.retryable = retryable;
    }
}

export function classifyError(error) {
    if (error instanceof AppError) return error;
    const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
    const code = String(error?.code || "").toUpperCase();
    const retryable = status === 408 || status === 425 || status === 429 || status >= 500 || RETRYABLE_CODES.has(code);
    return new AppError(error?.message || "Request failed", {
        code: retryable ? "UPSTREAM_UNAVAILABLE" : (code || "INTERNAL_ERROR"),
        statusCode: status >= 400 && status < 600 ? status : 500,
        retryable,
        cause: error,
    });
}

export function createRetryableError(message, code = "UPSTREAM_UNAVAILABLE") {
    return new AppError(message, { code, statusCode: 503, retryable: true });
}

export function isAbortError(error, signal) {
    return Boolean(signal?.aborted) || error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

export async function withRetry(operation, {
    retries = 2,
    baseDelayMs = 200,
    maxDelayMs = 3000,
    deadlineMs = null,
    signal,
    shouldRetry,
    onRetry,
    retryAfter,
    random = Math.random,
    now = () => Date.now(),
} = {}) {
    const startedAt = now();
    let attempt = 0;
    const abortError = () => {
        const reason = signal?.reason;
        if (reason instanceof AppError) return reason;
        return new AppError("Request aborted", { code: "ABORTED", statusCode: 499, cause: reason });
    };
    const remainingMs = () => deadlineMs == null ? Infinity : Math.max(0, Number(deadlineMs) - (now() - startedAt));

    while (true) {
        if (signal?.aborted) throw abortError();
        if (deadlineMs != null && remainingMs() <= 0) {
            throw new AppError("Retry deadline exceeded", { code: "RETRY_DEADLINE_EXCEEDED", statusCode: 504, retryable: true });
        }
        try {
            // The signal is deliberately a second argument for compatibility
            // with existing callbacks that only consume the attempt number.
            return await operation(attempt, signal);
        } catch (error) {
            const classified = classifyError(error);
            if (isAbortError(error, signal)) {
                throw abortError();
            }
            if (attempt >= retries || !(shouldRetry ? shouldRetry(classified) : classified.retryable)) {
                throw classified;
            }

            const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
            const retryAfterMs = typeof retryAfter === "function"
                ? Number(retryAfter(classified, attempt))
                : Number(retryAfter);
            const requestedDelay = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
                ? Math.max(exponential, retryAfterMs)
                : exponential;
            const delay = requestedDelay * (0.8 + random() * 0.4);
            const boundedDelay = Math.min(delay, remainingMs());
            if (deadlineMs != null && boundedDelay <= 0) {
                throw new AppError("Retry deadline exceeded", { code: "RETRY_DEADLINE_EXCEEDED", statusCode: 504, retryable: true, cause: classified });
            }
            await onRetry?.(classified, attempt, boundedDelay);
            await new Promise((resolve, reject) => {
                let settled = false;
                const timer = setTimeout(() => {
                    settled = true;
                    if (signal) signal.removeEventListener("abort", abort);
                    resolve();
                }, boundedDelay);
                const abort = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", abort);
                    reject(abortError());
                };
                if (signal) {
                    if (signal.aborted) abort();
                    else signal.addEventListener("abort", abort, { once: true });
                }
            });
            attempt += 1;
        }
    }
}

function publicMessage(classified) {
    if (classified.statusCode === 400) return "请求参数无效";
    if (classified.statusCode === 401) return "未授权";
    if (classified.statusCode === 403) return "禁止访问";
    if (classified.statusCode === 404) return "资源不存在";
    if (classified.statusCode === 409) return "请求冲突";
    if (classified.statusCode === 413) return "上传内容超过限制";
    if (classified.statusCode === 429) return "请求过于频繁，请稍后重试";
    if (classified.code === "ABORTED") return "请求已取消";
    if (classified.retryable) return "上游服务暂时不可用，请稍后重试";
    return "请求处理失败，请稍后重试";
}

export function toErrorEnvelope(error, requestId = null) {
    const classified = classifyError(error);
    return {
        ok: false,
        error: classified.code,
        errorCode: classified.code,
        message: publicMessage(classified),
        requestId: requestId || null,
        retryable: Boolean(classified.retryable),
    };
}

/** Public-facing SSE/HTTP error: keep provider details out of the client. */
export function toPublicError(error, requestId = null) {
    return {
        type: "error",
        ...toErrorEnvelope(error, requestId),
    };
}

export function respondPublicError(req, res, error, fallback = {}) {
    const source = error instanceof Error ? error : Object.assign(new Error(fallback.message || "Request failed"), fallback);
    const statusCode = Number(source.statusCode || source.status || fallback.statusCode || 500);
    return res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500)
        .json(toErrorEnvelope(source, req?.requestId));
}
