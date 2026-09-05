import { afterEach, describe, expect, it } from "vitest";

const originalEnv = { ...process.env };
import {
    getUploadReservation,
    cleanupExpiredUploadReservations,
    releaseUploadReservation,
    reserveUploadChunk,
    resetUploadQuotaState,
    rollbackUploadChunk,
    settleUploadReservation,
} from "./uploadQuota.js";

afterEach(() => {
    process.env = { ...originalEnv };
    resetUploadQuotaState();
});

describe("upload quota reservation lifecycle", () => {
    it("charges only the delta for duplicate and replacement chunks", () => {
        expect(reserveUploadChunk(1, "hash", 0, 10).reservedBytes).toBe(10);
        expect(reserveUploadChunk(1, "hash", 0, 10).delta).toBe(0);
        expect(reserveUploadChunk(1, "hash", 0, 15).delta).toBe(5);
        expect(reserveUploadChunk(1, "hash", 0, 7).delta).toBe(-8);
        expect(getUploadReservation(1, "hash").bytes).toBe(7);
    });

    it("rolls back a failed write without affecting other chunks", () => {
        reserveUploadChunk(1, "hash", 0, 10);
        reserveUploadChunk(1, "hash", 1, 20);
        expect(rollbackUploadChunk(1, "hash", 1, 0, 20)).toBe(true);
        expect(getUploadReservation(1, "hash")).toMatchObject({ bytes: 10 });
        expect(getUploadReservation(1, "hash").chunks.has(1)).toBe(false);
    });

    it("settles using the actual merged file size", () => {
        reserveUploadChunk(1, "hash", 0, 10);
        reserveUploadChunk(1, "hash", 1, 10);
        expect(settleUploadReservation(1, "hash", 15)).toMatchObject({ actualBytes: 15 });
        expect(getUploadReservation(1, "hash")).toBeNull();
    });

    it("releases an expired reservation", () => {
        reserveUploadChunk(1, "expired", 0, 5);
        process.env.UPLOAD_RESERVATION_TTL_MS = "1000";
        expect(cleanupExpiredUploadReservations(Date.now() + 2000)).toBe(1);
        expect(getUploadReservation(1, "expired")).toBeNull();
    });

    it("keeps users and active upload limits isolated", () => {
        reserveUploadChunk(1, "a", 0, 5);
        reserveUploadChunk(2, "a", 0, 5);
        expect(getUploadReservation(1, "a").bytes).toBe(5);
        expect(getUploadReservation(2, "a").bytes).toBe(5);
        expect(releaseUploadReservation(1, "a")).toBeTruthy();
        expect(getUploadReservation(2, "a").bytes).toBe(5);
    });
});
