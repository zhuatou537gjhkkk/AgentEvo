import { afterEach, describe, expect, it, vi } from "vitest";
import {
    AppError,
    classifyError,
    toErrorEnvelope,
    toPublicError,
    withRetry,
} from "./resilience.js";

afterEach(() => vi.restoreAllMocks());

describe("resilience", () => {
    it("retries transient failures and passes attempt plus signal", async () => {
        const signal = new AbortController().signal;
        const operation = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error("busy"), { statusCode: 503 }))
            .mockResolvedValue("ok");
        await expect(withRetry(operation, { retries: 1, baseDelayMs: 0, maxDelayMs: 0, signal })).resolves.toBe("ok");
        expect(operation).toHaveBeenCalledTimes(2);
        expect(operation.mock.calls[0][0]).toBe(0);
        expect(operation.mock.calls[0][1]).toBe(signal);
    });

    it("does not retry validation or authentication errors", async () => {
        const operation = vi.fn().mockRejectedValue(Object.assign(new Error("bad input"), { statusCode: 400 }));
        await expect(withRetry(operation, { retries: 3, baseDelayMs: 0 })).rejects.toMatchObject({ statusCode: 400 });
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("stops promptly when aborted during backoff", async () => {
        const controller = new AbortController();
        const operation = vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
        const pending = withRetry(operation, { retries: 3, baseDelayMs: 1000, signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("provides a public error without provider details", () => {
        const error = new AppError("provider secret /var/run/key", { code: "UPSTREAM_UNAVAILABLE", statusCode: 503, retryable: true });
        expect(toPublicError(error, "req-1")).toMatchObject({
            type: "error", errorCode: "UPSTREAM_UNAVAILABLE", requestId: "req-1", retryable: true,
            message: "上游服务暂时不可用，请稍后重试",
        });
        expect(toErrorEnvelope(error, "req-1").message).not.toContain("provider secret");
        expect(classifyError(error)).toBe(error);
    });

    it("classifies SDK timeouts without status/code as retryable", () => {
        const error = Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });
        const classified = classifyError(error);
        expect(classified.code).toBe("UPSTREAM_UNAVAILABLE");
        expect(classified.retryable).toBe(true);
    });

    it("walks the cause chain for transport codes (undici fetch failure)", () => {
        const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        const error = Object.assign(new TypeError("fetch failed"), { cause });
        const classified = classifyError(error);
        expect(classified.retryable).toBe(true);
        expect(classified.code).toBe("UPSTREAM_UNAVAILABLE");
    });

    it("finds nested cause codes several levels deep", () => {
        const inner = Object.assign(new Error("t"), { code: "ETIMEDOUT" });
        const mid = new Error("mid", { cause: inner });
        const top = Object.assign(new TypeError("fetch failed"), { cause: mid });
        expect(classifyError(top).retryable).toBe(true);
    });

    it("keeps a 4xx non-retryable even when it hides a network cause", () => {
        const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        const error = Object.assign(new Error("bad request"), { statusCode: 400, cause });
        const classified = classifyError(error);
        expect(classified.retryable).toBe(false);
        expect(classified.statusCode).toBe(400);
    });

    it("retries a 429 and consults retryAfter with the classified error", async () => {
        const retryAfter = vi.fn(() => 0);
        const operation = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
            .mockResolvedValue("ok");
        await expect(withRetry(operation, {
            retries: 1, baseDelayMs: 0, maxDelayMs: 0, retryAfter,
        })).resolves.toBe("ok");
        expect(operation).toHaveBeenCalledTimes(2);
        expect(retryAfter).toHaveBeenCalledTimes(1);
        expect(retryAfter.mock.calls[0][0]).toMatchObject({ statusCode: 429, retryable: true });
    });

    it("exhausts retries and rethrows the classified upstream error", async () => {
        const operation = vi.fn().mockRejectedValue(Object.assign(new Error("boom"), { statusCode: 503 }));
        const promise = withRetry(operation, { retries: 2, baseDelayMs: 0, maxDelayMs: 0 });
        await expect(promise).rejects.toMatchObject({ statusCode: 503, code: "UPSTREAM_UNAVAILABLE", retryable: true });
        expect(operation).toHaveBeenCalledTimes(3);
    });

    it("throws RETRY_DEADLINE_EXCEEDED when the deadline elapses before a retry", async () => {
        const operation = vi.fn().mockRejectedValue(Object.assign(new Error("transient"), { statusCode: 503 }));
        const seq = [1000, 1000, 1000];
        let i = 0;
        const now = () => seq[Math.min(i++, seq.length - 1)];
        const promise = withRetry(operation, { retries: 5, baseDelayMs: 0, maxDelayMs: 0, deadlineMs: 5000, now });
        await expect(promise).rejects.toMatchObject({ code: "RETRY_DEADLINE_EXCEEDED", statusCode: 504, retryable: true });
        expect(operation).toHaveBeenCalledTimes(1);
    });
});
