/**
 * Durable upload-quota production acceptance tests (A1).
 *
 * These drive the real SQLite-backed adapter (createUploadQuotaStore({durable:true}))
 * against the per-worker isolated temp DB provided by vitest.setup.js, so no
 * dev database is ever touched. The durable adapter binds the module-level
 * better-sqlite3 connection, so tests query the same connection directly to
 * assert persisted rows.
 *
 * Coverage:
 *   it1-2  reserve→settle / reserve→release byte accounting
 *   it3-4  PK-reuse regressions: settle-then-re-upload and inline-expiry
 *          immediate retry (both crashed before the UPSERT fix)
 *   it5    usage is booked onto the reservation's original UTC usage_day
 *   it6    expiry cleanup zeroes reserved usage and keeps a tombstone
 *   it7    restart persistence — an independent child process reopens the same
 *          file and reads the committed row (no in-worker close/reopen exists)
 *   it8    cross-process accounting — two child processes reserve/settle on
 *          distinct owners concurrently; both persist and integrity stays ok
 *
 * Child-process tests are the slow path, so they get explicit long timeouts.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db, { initDB, createUser } from "../db/index.js";
import { createUploadQuotaStore } from "./uploadQuotaStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const WORKER_SCRIPT = path.join(BACKEND_ROOT, "scripts", "quota-worker.mjs");

const utcToday = () => new Date().toISOString().slice(0, 10);
const scopeOf = (userId) => ({ userId, tenantId: `user:${userId}` });
const scope1 = scopeOf(1);

const store = createUploadQuotaStore({ durable: true });

// ── persistence query helpers (same module-level connection the adapter uses) ──
const reservationRows = (scope, key) => db.prepare(
    "SELECT status, reserved_bytes, usage_day FROM upload_reservations WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ?"
).all(scope.userId, scope.tenantId, key);
const usageRow = (scope, day) => db.prepare(
    "SELECT committed_bytes, reserved_bytes FROM upload_quota_usage WHERE owner_user_id = ? AND tenant_id = ? AND usage_day = ?"
).get(scope.userId, scope.tenantId, day);
const chunkCount = (scope, key) => Number(db.prepare(
    "SELECT COUNT(*) AS c FROM upload_reservation_chunks WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ?"
).get(scope.userId, scope.tenantId, key).c);
const backdate = (key) => {
    db.prepare("UPDATE upload_reservations SET expires_at = datetime('now', '-1 second') WHERE upload_key = ?").run(key);
};

beforeAll(() => {
    initDB(); // bootstraps full schema + demo user (id 1)
    createUser("durable-worker-2", "smoke"); // id 2, tenant user:2 (used by it8)
});

beforeEach(() => {
    // FK-safe wipe order: children → reservations → usage. Users are FK parents
    // and are kept for the whole file.
    db.prepare("DELETE FROM upload_reservation_chunks").run();
    db.prepare("DELETE FROM upload_reservations").run();
    db.prepare("DELETE FROM upload_quota_usage").run();
});

/** Reopen the same file in a fresh child process (restart / cross-process view). */
function runWorker(args, { timeoutMs = 60_000 } = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [WORKER_SCRIPT, ...args], {
            cwd: BACKEND_ROOT,
            env: { ...process.env, DB_PATH: process.env.DB_PATH, NODE_ENV: "test" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr += d; });
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

function parseWorker(stdout) {
    try {
        return JSON.parse(stdout);
    } catch {
        return { parseError: true, raw: stdout.slice(0, 400) };
    }
}

describe("durable upload quota adapter (production acceptance A1)", () => {
    it("reserve→settle persists committed bytes on the reservation's day", () => {
        const reserved = store.reserveUploadChunk(scope1, "k1", 0, 10);
        expect(reserved).toMatchObject({ reservedBytes: 10, delta: 10 });
        expect(usageRow(scope1, utcToday())).toMatchObject({ committed_bytes: 0, reserved_bytes: 10 });

        const settled = store.settleUploadReservation(scope1, "k1", 7);
        expect(settled).toMatchObject({ actualBytes: 7, dailyBytes: 7 });

        const rows = reservationRows(scope1, "k1");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: "committed", reserved_bytes: 0 });
        expect(usageRow(scope1, utcToday())).toMatchObject({ committed_bytes: 7, reserved_bytes: 0 });
        expect(chunkCount(scope1, "k1")).toBe(0);
        expect(store.getUploadReservation(scope1, "k1")).toBeNull();
    });

    it("reserve→release deducts reserved usage and leaves a released tombstone", () => {
        const reserved = store.reserveUploadChunk(scope1, "k2", 0, 25);
        expect(reserved.reservedBytes).toBe(25);
        expect(usageRow(scope1, utcToday())).toMatchObject({ committed_bytes: 0, reserved_bytes: 25 });

        expect(store.releaseUploadReservation(scope1, "k2")).toMatchObject({ releasedBytes: 25 });
        const rows = reservationRows(scope1, "k2");
        expect(rows[0]).toMatchObject({ status: "released", reserved_bytes: 0 });
        expect(chunkCount(scope1, "k2")).toBe(0);
        expect(usageRow(scope1, utcToday())).toMatchObject({ committed_bytes: 0, reserved_bytes: 0 });
    });

    it("re-upload of the same content hash reactivates a committed tombstone (PK reuse)", () => {
        store.reserveUploadChunk(scope1, "k3", 0, 10);
        store.settleUploadReservation(scope1, "k3", 10);
        expect(usageRow(scope1, utcToday())).toMatchObject({ committed_bytes: 10, reserved_bytes: 0 });

        // upload_key is the content sha256, so identical bytes re-enters the same
        // row. Before the UPSERT fix the bare INSERT collided on the PRIMARY KEY.
        expect(() => store.reserveUploadChunk(scope1, "k3", 0, 10)).not.toThrow();

        const rows = reservationRows(scope1, "k3");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: "active", reserved_bytes: 10, usage_day: utcToday() });
        expect(chunkCount(scope1, "k3")).toBe(1);
        expect(usageRow(scope1, utcToday())).toMatchObject({ committed_bytes: 10, reserved_bytes: 10 });
    });

    it("inline-expired reservation can be retried immediately in the same flow (PK reuse)", () => {
        store.reserveUploadChunk(scope1, "k4", 0, 10);
        expect(usageRow(scope1, utcToday())).toMatchObject({ committed_bytes: 0, reserved_bytes: 10 });
        backdate("k4");

        // The active reservation expired mid-flow; the next reserve call must roll
        // the old reservation back and re-arm it without hitting the PK.
        expect(() => store.reserveUploadChunk(scope1, "k4", 0, 10)).not.toThrow();

        const rows = reservationRows(scope1, "k4");
        expect(rows[0]).toMatchObject({ status: "active", reserved_bytes: 10 });
        // Old reservation was deducted first, then the fresh one booked again:
        // exactly one reservation of 10 bytes, no double count.
        expect(usageRow(scope1, utcToday())).toMatchObject({ committed_bytes: 0, reserved_bytes: 10 });
        expect(chunkCount(scope1, "k4")).toBe(1);
    });

    it("settle books committed bytes onto the reservation's original UTC usage_day", () => {
        const yesterday = "2026-09-04";
        // Preset an active reservation whose accounting day is already yesterday.
        db.prepare("INSERT INTO upload_quota_usage (owner_user_id, tenant_id, usage_day, committed_bytes, reserved_bytes) VALUES (?, ?, ?, ?, ?)")
            .run(scope1.userId, scope1.tenantId, yesterday, 100, 50);
        db.prepare("INSERT INTO upload_reservations (owner_user_id, tenant_id, upload_key, status, reserved_bytes, expires_at, usage_day) VALUES (?, ?, ?, 'active', ?, datetime('now', '+1 hour'), ?)")
            .run(scope1.userId, scope1.tenantId, "old", 50, yesterday);

        store.settleUploadReservation(scope1, "old", 30);

        expect(usageRow(scope1, yesterday)).toMatchObject({ committed_bytes: 130, reserved_bytes: 0 });
        // Today's usage must not absorb yesterday's reservation.
        expect(usageRow(scope1, utcToday())).toBeUndefined();
        expect(reservationRows(scope1, "old")[0].status).toBe("committed");
    });

    it("expiry cleanup zeroes reserved usage and keeps an expired tombstone", () => {
        store.reserveUploadChunk(scope1, "k6", 0, 20);
        backdate("k6");

        expect(store.cleanupExpiredUploadReservations(new Date(Date.now() + 10_000))).toBe(1);

        const rows = reservationRows(scope1, "k6");
        expect(rows[0]).toMatchObject({ status: "expired", reserved_bytes: 0 });
        expect(usageRow(scope1, utcToday())).toMatchObject({ committed_bytes: 0, reserved_bytes: 0 });
        expect(chunkCount(scope1, "k6")).toBe(0);
        expect(store.getUploadReservation(scope1, "k6")).toBeNull();
    });

    it("committed rows survive a restart (independent connection reopens the file)", { timeout: 60_000 }, () => {
        store.reserveUploadChunk(scope1, "k7", 0, 33);
        store.settleUploadReservation(scope1, "k7", 33);

        const child = spawnSync(process.execPath, ["-e", `
            const D = require("better-sqlite3");
            const conn = new D(process.env.DB_PATH);
            const res = conn.prepare("SELECT status, reserved_bytes FROM upload_reservations WHERE upload_key = 'k7'").all();
            const usage = conn.prepare("SELECT committed_bytes, reserved_bytes FROM upload_quota_usage WHERE owner_user_id = 1").all();
            const chunks = conn.prepare("SELECT COUNT(*) AS c FROM upload_reservation_chunks WHERE upload_key = 'k7'").get().c;
            conn.close();
            process.stdout.write(JSON.stringify({ res, usage, chunks }));
        `], {
            cwd: BACKEND_ROOT,
            env: { ...process.env, DB_PATH: process.env.DB_PATH, NODE_ENV: "test" },
            encoding: "utf8",
            timeout: 60_000,
        });

        expect(child.status).toBe(0);
        const state = JSON.parse(child.stdout);
        expect(state.res).toHaveLength(1);
        expect(state.res[0]).toMatchObject({ status: "committed", reserved_bytes: 0 });
        expect(state.usage).toHaveLength(1);
        expect(state.usage[0]).toMatchObject({ committed_bytes: 33, reserved_bytes: 0 });
        expect(state.chunks).toBe(0);
    });

    it("two processes accounting on distinct owners persist concurrently", { timeout: 90_000 }, async () => {
        const scope2 = scopeOf(2);
        const [a, b] = await Promise.all([
            runWorker(["1", "user:1", "par-k1", "100"]),
            runWorker(["2", "user:2", "par-k2", "100"]),
        ]);

        expect(a.code).toBe(0);
        expect(b.code).toBe(0);
        expect(parseWorker(a.stdout).ok).toBe(true);
        expect(parseWorker(b.stdout).ok).toBe(true);

        expect(usageRow(scope1, utcToday())).toMatchObject({ committed_bytes: 100, reserved_bytes: 0 });
        expect(usageRow(scope2, utcToday())).toMatchObject({ committed_bytes: 100, reserved_bytes: 0 });
        expect(reservationRows(scope1, "par-k1")[0].status).toBe("committed");
        expect(reservationRows(scope2, "par-k2")[0].status).toBe("committed");
        expect(Number(db.prepare("SELECT COUNT(*) AS c FROM upload_reservations WHERE status = 'active'").get().c)).toBe(0);
        expect(db.pragma("integrity_check").map((r) => r.integrity_check)).toEqual(["ok"]);
    });
});
