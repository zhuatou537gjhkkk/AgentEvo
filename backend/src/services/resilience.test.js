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
});
