import { beforeEach, describe, expect, it } from "vitest";
import { createUploadQuotaStore } from "./uploadQuotaStore.js";
import { resetUploadQuotaState } from "./uploadQuota.js";

const scope = { userId: 1, tenantId: "user:1" };

beforeEach(() => {
    resetUploadQuotaState();
});

describe("upload quota store", () => {
    it("keeps the compatibility adapter scoped and delta based", () => {
        const store = createUploadQuotaStore({ durable: false });
        expect(store.reserveUploadChunk(scope, "file-a", 0, 10).delta).toBe(10);
        expect(store.reserveUploadChunk(scope, "file-a", 0, 4).delta).toBe(-6);
        expect(store.getUploadReservation(scope, "file-a").bytes).toBe(4);
        expect(store.getUploadReservation({ userId: 2, tenantId: "user:2" }, "file-a")).toBeNull();
    });

    it("exposes cleanup and close lifecycle hooks", () => {
        const store = createUploadQuotaStore({ durable: false });
        expect(store.health()).toEqual({ ok: true, durable: false });
        expect(() => store.close()).not.toThrow();
        expect(store.cleanupExpiredUploadReservations()).toBe(0);
    });
});
