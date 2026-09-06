import { randomUUID } from "node:crypto";
import db, { getUserScope, initDB } from "../db/index.js";
import {
    reserveUploadChunk as reserveMemoryChunk,
    rollbackUploadChunk as rollbackMemoryChunk,
    settleUploadReservation as settleMemoryReservation,
    releaseUploadReservation as releaseMemoryReservation,
    getUploadReservation as getMemoryReservation,
    cleanupExpiredUploadReservations as cleanupMemoryReservations,
    withUploadLock as withMemoryUploadLock,
} from "./uploadQuota.js";

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_DAILY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ACTIVE_UPLOADS = 3;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function getLimits() {
    return {
        maxFileBytes: Math.max(1, Number(process.env.UPLOAD_MAX_FILE_BYTES) || DEFAULT_MAX_FILE_BYTES),
        maxDailyBytes: Math.max(1, Number(process.env.UPLOAD_MAX_DAILY_BYTES) || DEFAULT_MAX_DAILY_BYTES),
        maxActiveUploads: Math.max(1, Number(process.env.UPLOAD_MAX_ACTIVE_UPLOADS) || DEFAULT_MAX_ACTIVE_UPLOADS),
        ttlMs: Math.max(1_000, Number(process.env.UPLOAD_RESERVATION_TTL_MS) || DEFAULT_TTL_MS),
    };
}

function quotaError(code, message, statusCode = 413) {
    return Object.assign(new Error(message), { code, statusCode });
}

function utcDay(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function resolveDurableScope(scopeOrUserId) {
    if (scopeOrUserId && typeof scopeOrUserId === "object") {
        const userId = Number(scopeOrUserId.userId ?? scopeOrUserId.ownerUserId);
        if (Number.isInteger(userId) && userId > 0) {
            return { userId, tenantId: String(scopeOrUserId.tenantId || `user:${userId}`) };
        }
    }
    const userId = Number(scopeOrUserId);
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("upload owner is required");
    return getUserScope(userId) || { userId, tenantId: `user:${userId}` };
}

function normalizedUploadKey(value) {
    const key = String(value || "").trim();
    if (!key || key.length > 240) throw quotaError("INVALID_UPLOAD_RESERVATION", "invalid upload reservation", 400);
    return key;
}

function ensureQuotaSchema() {
    initDB();
}

function durableCleanupExpired(now = new Date()) {
    ensureQuotaSchema();
    const cutoff = now.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    const transaction = db.transaction(() => {
        const expired = db.prepare(`SELECT owner_user_id, tenant_id, upload_key, reserved_bytes,
                substr(created_at, 1, 10) AS usage_day
            FROM upload_reservations WHERE status = 'active' AND expires_at <= ?`).all(cutoff);
        const updateUsage = db.prepare(`UPDATE upload_quota_usage SET reserved_bytes = MAX(0, reserved_bytes - ?), updated_at = CURRENT_TIMESTAMP
            WHERE owner_user_id = ? AND tenant_id = ? AND usage_day = ?`);
        const mark = db.prepare(`UPDATE upload_reservations SET status = 'expired', reserved_bytes = 0, updated_at = CURRENT_TIMESTAMP
            WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND status = 'active'`);
        const removeChunks = db.prepare(`DELETE FROM upload_reservation_chunks WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ?`);
        for (const row of expired) {
            updateUsage.run(Number(row.reserved_bytes) || 0, row.owner_user_id, row.tenant_id, row.usage_day || utcDay(now));
            if (mark.run(row.owner_user_id, row.tenant_id, row.upload_key).changes > 0) {
                removeChunks.run(row.owner_user_id, row.tenant_id, row.upload_key);
            }
        }
        return expired.length;
    });
    return transaction();
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Durable same-key advisory lock (W4-R5-S1) — upload_key_locks lease rows.
 *
 * The merge/chunk critical section (file assembly + FAISS embed/index + quota
 * settle) is long-running file work, so SQLite's per-write serialization alone
 * cannot keep two processes from racing on the same (owner, upload_key). Each
 * actor instead holds an explicit lease row: INSERT OR IGNORE wins the key, or
 * an atomic UPDATE reclaims it when the previous lease has expired. SQLite
 * serializes those write transactions, so exactly one process holds a live
 * lease at a time. The holder renews while its section runs and deletes only
 * its own row (holder_token guard) on exit; a crashed holder's lease expires
 * and the next acquire reclaims it — the key can never be wedged permanently.
 */
function acquireUploadKeyLock(scope, key, holderToken, ttlSeconds) {
    const insert = db.prepare(`INSERT OR IGNORE INTO upload_key_locks
        (owner_user_id, tenant_id, upload_key, holder_token, acquired_at, expires_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now', ?))`)
        .run(scope.userId, scope.tenantId, key, holderToken, `+${ttlSeconds} seconds`);
    if (insert.changes === 1) return true;
    // PK exists — win it only if the previous holder's lease has expired. The
    // expiry predicate + SQLite write serialization make concurrent reclaims
    // single-winner (the loser's UPDATE matches 0 rows once the winner renewed).
    return db.prepare(`UPDATE upload_key_locks SET
            holder_token = ?, acquired_at = datetime('now'), expires_at = datetime('now', ?)
        WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ?
          AND (expires_at IS NULL OR expires_at <= datetime('now'))`)
        .run(holderToken, `+${ttlSeconds} seconds`, scope.userId, scope.tenantId, key).changes === 1;
}

function renewUploadKeyLock(scope, key, holderToken, ttlSeconds) {
    return db.prepare(`UPDATE upload_key_locks SET expires_at = datetime('now', ?)
        WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND holder_token = ?`)
        .run(`+${ttlSeconds} seconds`, scope.userId, scope.tenantId, key, holderToken).changes === 1;
}

function releaseUploadKeyLock(scope, key, holderToken) {
    db.prepare(`DELETE FROM upload_key_locks
        WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND holder_token = ?`)
        .run(scope.userId, scope.tenantId, key, holderToken);
}

async function withDurableUploadLock(scopeOrUserId, uploadKey, operation, options = {}) {
    const scope = resolveDurableScope(scopeOrUserId);
    const key = normalizedUploadKey(uploadKey);
    ensureQuotaSchema();
    const ttlMs = Math.max(2_000, Number(options.ttlMs) || 60_000);
    const busyTimeoutMs = Math.max(200, Number(options.busyTimeoutMs) || 30_000);
    const pollMs = Math.max(5, Math.min(200, Number(options.pollMs) || 25));
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    const holderToken = randomUUID();
    const deadline = Date.now() + busyTimeoutMs;

    for (;;) {
        if (acquireUploadKeyLock(scope, key, holderToken, ttlSeconds)) break;
        if (Date.now() >= deadline) {
            throw quotaError("UPLOAD_LOCK_TIMEOUT", "upload is busy, try again shortly", 429);
        }
        await sleepMs(pollMs);
    }

    // Renew the lease while the critical section runs so a slow merge doesn't
    // lose its lock mid-flight to a waiter or a stale reclaim.
    const renewTimer = setInterval(() => {
        try { renewUploadKeyLock(scope, key, holderToken, ttlSeconds); } catch { /* release path still runs */ }
    }, Math.max(250, Math.floor(ttlMs / 3)));
    renewTimer.unref?.();
    try {
        return await operation();
    } finally {
        clearInterval(renewTimer);
        try { releaseUploadKeyLock(scope, key, holderToken); } catch { /* best-effort */ }
    }
}

function createDurableAdapter() {
    return {
        durable: true,
        reserveUploadChunk(scopeOrUserId, uploadKey, chunkIndex, byteLength) {
            const scope = resolveDurableScope(scopeOrUserId);
            const key = normalizedUploadKey(uploadKey);
            const index = Number(chunkIndex);
            const size = Number(byteLength);
            if (!Number.isInteger(index) || index < 0 || !Number.isInteger(size) || size < 0) {
                throw quotaError("INVALID_UPLOAD_RESERVATION", "invalid upload reservation", 400);
            }
            const { maxFileBytes, maxDailyBytes, maxActiveUploads, ttlMs } = getLimits();
            ensureQuotaSchema();
            return db.transaction(() => {
                const day = utcDay();
                db.prepare(`INSERT OR IGNORE INTO upload_quota_usage
                    (owner_user_id, tenant_id, usage_day) VALUES (?, ?, ?)`).run(scope.userId, scope.tenantId, day);
                const existing = db.prepare(`SELECT status, reserved_bytes, usage_day FROM upload_reservations
                    WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ?`)
                    .get(scope.userId, scope.tenantId, key);
                if (existing?.status === "active") {
                    const expired = db.prepare(`SELECT expires_at <= datetime('now') AS expired
                        FROM upload_reservations WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ?`)
                        .get(scope.userId, scope.tenantId, key)?.expired;
                    if (expired) {
                        db.prepare(`UPDATE upload_quota_usage SET reserved_bytes = MAX(0, reserved_bytes - ?), updated_at = CURRENT_TIMESTAMP
                            WHERE owner_user_id = ? AND tenant_id = ? AND usage_day = ?`)
                            .run(Number(existing.reserved_bytes) || 0, scope.userId, scope.tenantId, existing.usage_day || day);
                        db.prepare(`DELETE FROM upload_reservation_chunks WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ?`)
                            .run(scope.userId, scope.tenantId, key);
                        db.prepare(`UPDATE upload_reservations SET status = 'expired', reserved_bytes = 0, updated_at = CURRENT_TIMESTAMP
                            WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND status = 'active'`)
                            .run(scope.userId, scope.tenantId, key);
                    }
                }
                const reservation = db.prepare(`SELECT status, reserved_bytes FROM upload_reservations
                    WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ?`)
                    .get(scope.userId, scope.tenantId, key);
                if (!reservation || reservation.status !== "active") {
                    const active = db.prepare(`SELECT COUNT(*) AS count FROM upload_reservations
                        WHERE owner_user_id = ? AND tenant_id = ? AND status = 'active'`).get(scope.userId, scope.tenantId);
                    if (Number(active?.count) >= maxActiveUploads) {
                        throw quotaError("UPLOAD_CONCURRENCY_LIMIT", "too many active uploads", 429);
                    }
                    // Tombstone rows keep their PK after settle/release/expiry (they
                    // are never deleted), and upload_key is the content hash, so a
                    // re-upload of the same bytes (or an inline-expiry retry in this
                    // same transaction) must resurrect the row, not collide on it.
                    // Tombsstones always have reserved_bytes=0 and their reservation
                    // already deducted from usage, so resetting to a fresh active
                    // reservation on today's usage_day leaks nothing.
                    db.prepare(`INSERT INTO upload_reservations
                        (owner_user_id, tenant_id, upload_key, status, reserved_bytes, expires_at, usage_day)
                        VALUES (?, ?, ?, 'active', 0, datetime('now', ?), ?)
                        ON CONFLICT(owner_user_id, tenant_id, upload_key) DO UPDATE SET
                            status = 'active',
                            reserved_bytes = 0,
                            expires_at = excluded.expires_at,
                            usage_day = excluded.usage_day,
                            updated_at = CURRENT_TIMESTAMP`)
                        .run(scope.userId, scope.tenantId, key, `+${Math.ceil(ttlMs / 1000)} seconds`, day);
                }
                const previous = db.prepare(`SELECT byte_length FROM upload_reservation_chunks
                    WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND chunk_index = ?`)
                    .get(scope.userId, scope.tenantId, key, index);
                const previousSize = Number(previous?.byte_length) || 0;
                const reservationRow = db.prepare(`SELECT reserved_bytes, usage_day FROM upload_reservations
                    WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ?`).get(scope.userId, scope.tenantId, key);
                const reservationBytes = Number(reservationRow?.reserved_bytes) || 0;
                const usageDay = reservationRow?.usage_day || day;
                db.prepare(`INSERT OR IGNORE INTO upload_quota_usage (owner_user_id, tenant_id, usage_day) VALUES (?, ?, ?)`).run(scope.userId, scope.tenantId, usageDay);
                const usage = db.prepare(`SELECT committed_bytes, reserved_bytes FROM upload_quota_usage
                    WHERE owner_user_id = ? AND tenant_id = ? AND usage_day = ?`).get(scope.userId, scope.tenantId, usageDay);
                const delta = size - previousSize;
                const nextBytes = reservationBytes + delta;
                const nextDaily = Number(usage?.committed_bytes || 0) + Number(usage?.reserved_bytes || 0) + delta;
                if (nextBytes > maxFileBytes || nextDaily > maxDailyBytes || nextBytes < 0 || nextDaily < 0) {
                    throw quotaError("UPLOAD_QUOTA_EXCEEDED", "upload quota exceeded", 413);
                }
                db.prepare(`INSERT INTO upload_reservation_chunks
                    (owner_user_id, tenant_id, upload_key, chunk_index, byte_length)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(owner_user_id, tenant_id, upload_key, chunk_index)
                    DO UPDATE SET byte_length = excluded.byte_length, updated_at = CURRENT_TIMESTAMP`)
                    .run(scope.userId, scope.tenantId, key, index, size);
                db.prepare(`UPDATE upload_reservations SET reserved_bytes = ?, expires_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP
                    WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND status = 'active'`)
                    .run(nextBytes, `+${Math.ceil(ttlMs / 1000)} seconds`, scope.userId, scope.tenantId, key);
                db.prepare(`UPDATE upload_quota_usage SET reserved_bytes = reserved_bytes + ?, updated_at = CURRENT_TIMESTAMP
                    WHERE owner_user_id = ? AND tenant_id = ? AND usage_day = ?`)
                    .run(delta, scope.userId, scope.tenantId, usageDay);
                return { reservedBytes: nextBytes, dailyBytes: nextDaily, previousSize, delta };
            })();
        },
        rollbackUploadChunk(scopeOrUserId, uploadKey, chunkIndex, previousSize = 0, expectedSize = null) {
            const scope = resolveDurableScope(scopeOrUserId);
            const key = normalizedUploadKey(uploadKey);
            ensureQuotaSchema();
            return db.transaction(() => {
                const current = db.prepare(`SELECT byte_length FROM upload_reservation_chunks
                    WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND chunk_index = ?`)
                    .get(scope.userId, scope.tenantId, key, Number(chunkIndex));
                const reservationDay = db.prepare(`SELECT usage_day FROM upload_reservations
                    WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND status = 'active'`)
                    .get(scope.userId, scope.tenantId, key)?.usage_day;
                if (!current || !reservationDay || (expectedSize != null && Number(current.byte_length) !== Number(expectedSize))) return false;
                const previous = Number(previousSize) || 0;
                const delta = previous - Number(current.byte_length);
                db.prepare(`UPDATE upload_reservations SET reserved_bytes = MAX(0, reserved_bytes + ?), updated_at = CURRENT_TIMESTAMP
                    WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND status = 'active'`)
                    .run(delta, scope.userId, scope.tenantId, key);
                db.prepare(`UPDATE upload_quota_usage SET reserved_bytes = MAX(0, reserved_bytes + ?), updated_at = CURRENT_TIMESTAMP
                    WHERE owner_user_id = ? AND tenant_id = ? AND usage_day = ?`)
                    .run(delta, scope.userId, scope.tenantId, reservationDay);
                if (previous === 0) db.prepare(`DELETE FROM upload_reservation_chunks WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND chunk_index = ?`).run(scope.userId, scope.tenantId, key, Number(chunkIndex));
                else db.prepare(`UPDATE upload_reservation_chunks SET byte_length = ?, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND chunk_index = ?`).run(previous, scope.userId, scope.tenantId, key, Number(chunkIndex));
                return true;
            })();
        },
        settleUploadReservation(scopeOrUserId, uploadKey, actualBytes) {
            const scope = resolveDurableScope(scopeOrUserId);
            const key = normalizedUploadKey(uploadKey);
            const actual = Number(actualBytes);
            if (!Number.isInteger(actual) || actual < 0) throw quotaError("INVALID_UPLOAD_RESERVATION", "invalid upload size", 400);
            const { maxFileBytes, maxDailyBytes } = getLimits();
            ensureQuotaSchema();
            return db.transaction(() => {
                const row = db.prepare(`SELECT reserved_bytes, usage_day FROM upload_reservations WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND status = 'active'`).get(scope.userId, scope.tenantId, key);
                if (!row) return false;
                const usageDay = row.usage_day || utcDay();
                db.prepare(`INSERT OR IGNORE INTO upload_quota_usage (owner_user_id, tenant_id, usage_day) VALUES (?, ?, ?)`).run(scope.userId, scope.tenantId, usageDay);
                const usage = db.prepare(`SELECT committed_bytes, reserved_bytes FROM upload_quota_usage WHERE owner_user_id = ? AND tenant_id = ? AND usage_day = ?`).get(scope.userId, scope.tenantId, usageDay);
                const nextCommitted = Number(usage?.committed_bytes || 0) + actual;
                const nextReserved = Math.max(0, Number(usage?.reserved_bytes || 0) - Number(row.reserved_bytes || 0));
                if (actual > maxFileBytes || nextCommitted + nextReserved > maxDailyBytes) throw quotaError("UPLOAD_QUOTA_EXCEEDED", "upload quota exceeded", 413);
                db.prepare(`UPDATE upload_quota_usage SET committed_bytes = ?, reserved_bytes = ?, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND tenant_id = ? AND usage_day = ?`).run(nextCommitted, nextReserved, scope.userId, scope.tenantId, usageDay);
                db.prepare(`UPDATE upload_reservations SET status = 'committed', reserved_bytes = 0, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND status = 'active'`).run(scope.userId, scope.tenantId, key);
                db.prepare(`DELETE FROM upload_reservation_chunks WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ?`).run(scope.userId, scope.tenantId, key);
                return { actualBytes: actual, dailyBytes: nextCommitted + nextReserved };
            })();
        },
        releaseUploadReservation(scopeOrUserId, uploadKey, { reason = "released" } = {}) {
            const scope = resolveDurableScope(scopeOrUserId);
            const key = normalizedUploadKey(uploadKey);
            ensureQuotaSchema();
            return db.transaction(() => {
                const row = db.prepare(`SELECT reserved_bytes, usage_day FROM upload_reservations WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND status = 'active'`).get(scope.userId, scope.tenantId, key);
                if (!row) return false;
                db.prepare(`UPDATE upload_quota_usage SET reserved_bytes = MAX(0, reserved_bytes - ?), updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND tenant_id = ? AND usage_day = ?`).run(Number(row.reserved_bytes) || 0, scope.userId, scope.tenantId, row.usage_day || utcDay());
                db.prepare(`UPDATE upload_reservations SET status = 'released', reserved_bytes = 0, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND status = 'active'`).run(scope.userId, scope.tenantId, key);
                db.prepare(`DELETE FROM upload_reservation_chunks WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ?`).run(scope.userId, scope.tenantId, key);
                return { releasedBytes: Number(row.reserved_bytes) || 0, reason: String(reason) };
            })();
        },
        getUploadReservation(scopeOrUserId, uploadKey) {
            const scope = resolveDurableScope(scopeOrUserId);
            const key = normalizedUploadKey(uploadKey);
            ensureQuotaSchema();
            const row = db.prepare(`SELECT reserved_bytes FROM upload_reservations WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ? AND status = 'active'`).get(scope.userId, scope.tenantId, key);
            if (!row) return null;
            const chunks = db.prepare(`SELECT chunk_index, byte_length FROM upload_reservation_chunks WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ?`).all(scope.userId, scope.tenantId, key);
            return { bytes: Number(row.reserved_bytes) || 0, chunks: new Map(chunks.map((item) => [Number(item.chunk_index), Number(item.byte_length)])) };
        },
        cleanupExpiredUploadReservations(now = new Date()) {
            return durableCleanupExpired(now);
        },
        // W4-R5-S1 — the same-key lock is now lease-backed in upload_key_locks
        // (see withDurableUploadLock): mutual exclusion holds across processes
        // on the same DB file, not just within this process. The in-process
        // memory lock remains the non-durable adapter's rollback path.
        withUploadLock: withDurableUploadLock,
        close() {},
        health() { return { ok: true, durable: true }; },
    };
}

function resolveScope(scopeOrUserId) {
    if (scopeOrUserId && typeof scopeOrUserId === "object") {
        const userId = Number(scopeOrUserId.userId ?? scopeOrUserId.ownerUserId);
        if (Number.isInteger(userId) && userId > 0) {
            return { userId, tenantId: String(scopeOrUserId.tenantId || `user:${userId}`) };
        }
    }
    const userId = Number(scopeOrUserId);
    if (!Number.isInteger(userId) || userId <= 0) throw new Error("upload owner is required");
    return getUserScope(userId) || { userId, tenantId: `user:${userId}` };
}

function useDurableByDefault() {
    return process.env.DURABLE_UPLOAD_QUOTA === "true";
}

/**
 * Compatibility facade for the upload quota implementation. The memory
 * adapter remains the default rollback path; durable mode is deliberately
 * opt-in until the SQLite repository is configured by the application.
 */
export function createUploadQuotaStore({ durable = useDurableByDefault(), memory = null } = {}) {
    const fallback = memory || {
        reserveUploadChunk: reserveMemoryChunk,
        rollbackUploadChunk: rollbackMemoryChunk,
        settleUploadReservation: settleMemoryReservation,
        releaseUploadReservation: releaseMemoryReservation,
        getUploadReservation: getMemoryReservation,
        cleanupExpiredUploadReservations: cleanupMemoryReservations,
        withUploadLock: withMemoryUploadLock,
    };

    // Keep one explicit boundary so callers can switch to a durable
    // repository without changing route signatures or trusting request data.
    if (durable) {
        return createDurableAdapter();
    }

    return {
        durable: false,
        reserveUploadChunk(scope, key, index, bytes) {
            return fallback.reserveUploadChunk(resolveScope(scope).userId, key, index, bytes);
        },
        rollbackUploadChunk(scope, key, index, previous, expected) {
            return fallback.rollbackUploadChunk(resolveScope(scope).userId, key, index, previous, expected);
        },
        settleUploadReservation(scope, key, bytes) {
            return fallback.settleUploadReservation(resolveScope(scope).userId, key, bytes);
        },
        releaseUploadReservation(scope, key, options) {
            return fallback.releaseUploadReservation(resolveScope(scope).userId, key, options);
        },
        getUploadReservation(scope, key) {
            return fallback.getUploadReservation(resolveScope(scope).userId, key);
        },
        cleanupExpiredUploadReservations(now) {
            return fallback.cleanupExpiredUploadReservations(now);
        },
        withUploadLock(scope, key, operation) {
            return fallback.withUploadLock(resolveScope(scope).userId, key, operation);
        },
        close() {},
        health() { return { ok: true, durable: false }; },
    };
}

export function getUploadQuotaStore(options = {}) {
    return createUploadQuotaStore(options);
}

export const uploadQuotaStore = createUploadQuotaStore({
    durable: process.env.DURABLE_UPLOAD_QUOTA === "true",
});

// Backward-compatible function exports let existing route handlers switch to
// the durable implementation without changing their public signatures.
export const reserveUploadChunk = (...args) => uploadQuotaStore.reserveUploadChunk(...args);
export const rollbackUploadChunk = (...args) => uploadQuotaStore.rollbackUploadChunk(...args);
export const settleUploadReservation = (...args) => uploadQuotaStore.settleUploadReservation(...args);
export const releaseUploadReservation = (...args) => uploadQuotaStore.releaseUploadReservation(...args);
export const getUploadReservation = (...args) => uploadQuotaStore.getUploadReservation(...args);
export const cleanupExpiredUploadReservations = (...args) => uploadQuotaStore.cleanupExpiredUploadReservations(...args);
export const withUploadLock = (...args) => uploadQuotaStore.withUploadLock(...args);

export function startUploadQuotaCleanup({ intervalMs = null, onExpire = null } = {}) {
    const delay = Math.max(1_000, Number(intervalMs) || Math.min(
        60_000,
        Math.max(1_000, Number(process.env.UPLOAD_RESERVATION_TTL_MS) || DEFAULT_TTL_MS)
    ));
    const timer = setInterval(() => {
        const released = uploadQuotaStore.cleanupExpiredUploadReservations();
        if (released && typeof onExpire === "function") onExpire(released);
    }, delay);
    timer.unref?.();
    return () => clearInterval(timer);
}
