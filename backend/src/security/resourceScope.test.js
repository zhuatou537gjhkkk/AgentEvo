import { describe, expect, it } from "vitest";
import { createResourceScope, sameResourceScope } from "./resourceScope.js";

describe("resource scope", () => {
    it("derives a stable personal tenant without accepting arbitrary input", () => {
        const scope = createResourceScope({ userId: 7 });
        expect(scope).toEqual({ userId: 7, tenantId: "user:7" });
        expect(Object.isFrozen(scope)).toBe(true);
    });

    it("rejects missing or invalid authenticated identity", () => {
        expect(() => createResourceScope()).toThrow();
        expect(() => createResourceScope({ userId: 0 })).toThrow();
        expect(() => createResourceScope({ userId: 7, tenantId: "bad tenant" })).toThrow();
    });

    it("compares both owner and tenant", () => {
        expect(sameResourceScope({ userId: 1, tenantId: "user:1" }, { userId: 1, tenantId: "user:1" })).toBe(true);
        expect(sameResourceScope({ userId: 1, tenantId: "user:1" }, { userId: 2, tenantId: "user:2" })).toBe(false);
    });
});
