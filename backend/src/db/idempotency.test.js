import { afterEach, describe, expect, it } from "vitest";
import {
    completeChatIdempotency,
    failChatIdempotency,
    getChatIdempotency,
    markChatIdempotencyStarted,
    reserveChatIdempotency,
    setChatIdempotencyUserMessage,
} from "./index.js";

const scope = { userId: 1, tenantId: "user:1" };
const key = () => `idempotency-test-${Date.now()}-${Math.random()}`;

afterEach(() => {});

describe("chat idempotency attempt fencing", () => {
    it("claims one attempt and fences stale terminal callbacks", () => {
        const id = key();
        const first = reserveChatIdempotency(scope, id, "hash-a");
        expect(first.status).toBe("reserved");
        expect(first.attemptToken).toBeTruthy();
        expect(reserveChatIdempotency(scope, id, "hash-a").status).toBe("started");
        expect(markChatIdempotencyStarted(scope, id, first.attemptToken)).toBe(true);
        expect(completeChatIdempotency(scope, id, { text: "ok" }, 1, "stale-token")).toBe(false);
        expect(failChatIdempotency(scope, id, "OLD", "stale-token")).toBe(false);
        expect(completeChatIdempotency(scope, id, { text: "ok" }, 1, first.attemptToken)).toBe(true);
        expect(getChatIdempotency(scope, id)).toMatchObject({ status: "completed", response: { text: "ok" } });
    });

    it("rejects a different request hash in the same scope", () => {
        const id = key();
        reserveChatIdempotency(scope, id, "hash-a");
        expect(reserveChatIdempotency(scope, id, "hash-b").status).toBe("conflict");
    });

    it("isolates the same key across owners", () => {
        const id = key();
        const first = reserveChatIdempotency(scope, id, "hash-a");
        const second = reserveChatIdempotency({ userId: 2, tenantId: "user:2" }, id, "hash-a");
        expect(first.status).toBe("reserved");
        expect(second.status).toBe("reserved");
        expect(first.attemptToken).not.toBe(second.attemptToken);
    });
});
