import { afterEach, describe, expect, it } from "vitest";
import { createRateLimit, isAdminUser, requireAdmin, resetRateLimitState, getRateLimitStateSize } from "./access.js";

const originalEnv = { ...process.env };
afterEach(() => {
    process.env = { ...originalEnv };
    resetRateLimitState();
});

describe("access policy", () => {
    it("requires configured admin identity in production", () => {
        process.env.NODE_ENV = "production";
        process.env.ADMIN_USER_IDS = "7";
        expect(isAdminUser({ id: 7, username: "owner" })).toBe(true);
        expect(isAdminUser({ id: 8, username: "other" })).toBe(false);
    });

    it("rejects non-admin requests", () => {
        process.env.NODE_ENV = "production";
        process.env.ADMIN_USER_IDS = "7";
        const res = { status: (code) => ({ json: (body) => ({ code, body }) }) };
        expect(requireAdmin({ user: { id: 8 } }, res, () => true)).toMatchObject({ code: 403 });
    });

    it("limits repeated requests and returns a stable envelope", () => {
        const middleware = createRateLimit({ scope: "test", max: 1, windowMs: 60_000 });
        const req = { ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" }, headers: {}, requestId: "req-1", app: { get: () => false } };
        const res = { setHeader() {}, status: (code) => ({ json: (body) => ({ code, body }) }) };
        expect(middleware(req, res, () => "ok")).toBe("ok");
        expect(middleware(req, res, () => "unexpected")).toMatchObject({ code: 429, body: { errorCode: "RATE_LIMITED", requestId: "req-1", retryable: true } });
    });

    it("does not trust forwarded address without explicit proxy configuration", () => {
        const middleware = createRateLimit({ scope: "proxy", max: 1, windowMs: 60_000 });
        const req = { socket: { remoteAddress: "10.0.0.4" }, ip: "203.0.113.10", headers: { "x-forwarded-for": "203.0.113.10" }, app: { get: () => false } };
        const keys = [];
        middleware(req, { setHeader() {}, status: () => ({ json() {} }) }, () => keys.push("first"));
        middleware({ ...req, socket: { remoteAddress: "10.0.0.5" } }, { setHeader() {}, status: () => ({ json() {} }) }, () => keys.push("second"));
        expect(keys).toEqual(["first", "second"]);
    });

    it("caps bucket state", () => {
        const middleware = createRateLimit({ scope: "bounded", max: 10, windowMs: 60_000 });
        for (let i = 0; i < 10_050; i += 1) {
            middleware({ socket: { remoteAddress: `10.0.0.${i % 255}` }, app: { get: () => false } }, { setHeader() {}, status: () => ({ json() {} }) }, () => {});
        }
        expect(getRateLimitStateSize()).toBeLessThanOrEqual(10_000);
    });
});
