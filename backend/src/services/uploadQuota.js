const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_DAILY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ACTIVE_UPLOADS = 3;

const stateByUser = new Map();
const locksByUpload = new Map();
const reservationTimestamps = new Map();

function limits() {
    return {
        maxFileBytes: Math.max(1, Number(process.env.UPLOAD_MAX_FILE_BYTES) || DEFAULT_MAX_FILE_BYTES),
        maxDailyBytes: Math.max(1, Number(process.env.UPLOAD_MAX_DAILY_BYTES) || DEFAULT_MAX_DAILY_BYTES),
        maxActiveUploads: Math.max(1, Number(process.env.UPLOAD_MAX_ACTIVE_UPLOADS) || DEFAULT_MAX_ACTIVE_UPLOADS),
    };
}

function getUserState(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) throw new Error("upload owner is required");
    if (!stateByUser.has(id)) {
        const today = new Date().toISOString().slice(0, 10);
        stateByUser.set(id, {
            active: new Map(),
            dailyBytes: 0,
            day: today,
            // Keep usage by UTC day so an active reservation cannot subtract
            // from (or disappear into) the next day's counter at midnight.
            usageByDay: new Map([[today, 0]]),
        });
    }
    const state = stateByUser.get(id);
    const today = new Date().toISOString().slice(0, 10);
    if (state.day !== today) {
        state.day = today;
        state.usageByDay ||= new Map();
        state.usageByDay.set(today, Number(state.usageByDay.get(today) || 0));
        state.dailyBytes = Number(state.usageByDay.get(today) || 0);
    }
    return state;
}

function quotaError(code, message, statusCode = 413) {
    return Object.assign(new Error(message), { code, statusCode });
}

function normalizedKey(uploadKey) {
    const key = String(uploadKey || "").trim();
    if (!key || key.length > 240) throw quotaError("INVALID_UPLOAD_RESERVATION", "invalid upload reservation", 400);
    return key;
}

/**
 * Reserve only the byte delta for a chunk. Re-uploading the same chunk is
 * therefore idempotent, and replacing it with a smaller chunk releases bytes.
 */
export function reserveUploadChunk(userId, uploadKey, chunkIndex, byteLength) {
    const state = getUserState(userId);
    const key = normalizedKey(uploadKey);
    const index = Number(chunkIndex);
    const size = Number(byteLength);
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(size) || size < 0) {
        throw quotaError("INVALID_UPLOAD_RESERVATION", "invalid upload reservation", 400);
    }

    const { maxFileBytes, maxDailyBytes, maxActiveUploads } = limits();
    let upload = state.active.get(key);
    const created = !upload;
    if (!upload) {
        if (state.active.size >= maxActiveUploads) {
            throw quotaError("UPLOAD_CONCURRENCY_LIMIT", "too many active uploads", 429);
        }
        upload = { bytes: 0, chunks: new Map(), committed: false, usageDay: state.day };
        state.active.set(key, upload);
        reservationTimestamps.set(`${Number(userId)}:${key}`, Date.now());
    }

    const previousSize = upload.chunks.get(index) || 0;
    const delta = size - previousSize;
    const nextBytes = upload.bytes + delta;
    const usageDay = upload.usageDay || state.day;
    const nextDailyBytes = Number(state.usageByDay.get(usageDay) || 0) + delta;
    if (nextBytes > maxFileBytes || nextDailyBytes > maxDailyBytes || nextBytes < 0 || nextDailyBytes < 0) {
        if (created) {
            state.active.delete(key);
            reservationTimestamps.delete(`${Number(userId)}:${key}`);
        }
        throw quotaError("UPLOAD_QUOTA_EXCEEDED", "upload quota exceeded", 413);
    }

    upload.chunks.set(index, size);
    upload.bytes = nextBytes;
    state.usageByDay.set(usageDay, nextDailyBytes);
    state.dailyBytes = Number(state.usageByDay.get(state.day) || 0);
    return {
        reservedBytes: upload.bytes,
        dailyBytes: state.dailyBytes,
        previousSize,
        delta,
    };
}

export function getUploadReservation(userId, uploadKey) {
    const state = getUserState(userId);
    const upload = state.active.get(String(uploadKey || ""));
    return upload ? { bytes: upload.bytes, chunks: new Map(upload.chunks) } : null;
}

/** Roll back one chunk reservation to its previous size after a failed write. */
export function rollbackUploadChunk(userId, uploadKey, chunkIndex, previousSize = 0, expectedSize = null) {
    const state = getUserState(userId);
    const key = normalizedKey(uploadKey);
    const upload = state.active.get(key);
    if (!upload) return false;
    const index = Number(chunkIndex);
    const previous = Number(previousSize);
    const current = upload.chunks.get(index) || 0;
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(previous) || previous < 0) return false;
    if (expectedSize != null && current !== Number(expectedSize)) return false;

    const delta = previous - current;
    upload.bytes += delta;
    const usageDay = upload.usageDay || state.day;
    state.usageByDay.set(usageDay, Math.max(0, Number(state.usageByDay.get(usageDay) || 0) + delta));
    state.dailyBytes = Number(state.usageByDay.get(state.day) || 0);
    if (previous === 0) upload.chunks.delete(index);
    else upload.chunks.set(index, previous);
    if (upload.chunks.size === 0) {
        state.active.delete(key);
        reservationTimestamps.delete(`${Number(userId)}:${key}`);
    }
    return true;
}

/**
 * Commit a completed upload. Daily usage remains charged, but active bytes are
 * removed. If the final file size differs from chunk reservations, reconcile
 * the daily counter before releasing the active record.
 */
export function settleUploadReservation(userId, uploadKey, actualBytes) {
    const state = getUserState(userId);
    const key = normalizedKey(uploadKey);
    const upload = state.active.get(key);
    if (!upload) return false;
    const actual = Number(actualBytes);
    if (!Number.isInteger(actual) || actual < 0) {
        throw quotaError("INVALID_UPLOAD_RESERVATION", "invalid upload size", 400);
    }
    const { maxFileBytes, maxDailyBytes } = limits();
    if (actual > maxFileBytes || state.dailyBytes - upload.bytes + actual > maxDailyBytes) {
        throw quotaError("UPLOAD_QUOTA_EXCEEDED", "upload quota exceeded", 413);
    }
    const usageDay = upload.usageDay || state.day;
    state.usageByDay.set(usageDay, Math.max(0, Number(state.usageByDay.get(usageDay) || 0) - upload.bytes + actual));
    state.dailyBytes = Number(state.usageByDay.get(state.day) || 0);
    state.active.delete(key);
    reservationTimestamps.delete(`${Number(userId)}:${key}`);
    return { actualBytes: actual, dailyBytes: state.dailyBytes };
}

/** Release all uncommitted bytes for an upload. */
export function releaseUploadReservation(userId, uploadKey, { reason = "released" } = {}) {
    const state = getUserState(userId);
    const key = normalizedKey(uploadKey);
    const upload = state.active.get(key);
    if (!upload) return false;
    const usageDay = upload.usageDay || state.day;
    state.usageByDay.set(usageDay, Math.max(0, Number(state.usageByDay.get(usageDay) || 0) - upload.bytes));
    state.dailyBytes = Number(state.usageByDay.get(state.day) || 0);
    state.active.delete(key);
    reservationTimestamps.delete(`${Number(userId)}:${key}`);
    return { releasedBytes: upload.bytes, reason: String(reason) };
}

/** Serialize operations that mutate one user's upload reservation. */
export async function withUploadLock(userId, uploadKey, operation) {
    const key = `${Number(userId)}:${normalizedKey(uploadKey)}`;
    const previous = locksByUpload.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    locksByUpload.set(key, current);
    await previous;
    try {
        return await operation();
    } finally {
        release();
        if (locksByUpload.get(key) === current) locksByUpload.delete(key);
    }
}

export function cleanupExpiredUploadReservations(now = Date.now()) {
    const ttlMs = Math.max(1_000, Number(process.env.UPLOAD_RESERVATION_TTL_MS) || 30 * 60 * 1000);
    let released = 0;
    for (const [reservationKey, createdAt] of reservationTimestamps) {
        if (now - createdAt <= ttlMs) continue;
        const separator = reservationKey.indexOf(":");
        const userId = Number(reservationKey.slice(0, separator));
        const uploadKey = reservationKey.slice(separator + 1);
        if (releaseUploadReservation(userId, uploadKey, { reason: "expired" })) released += 1;
    }
    return released;
}

export function startUploadQuotaCleanup({ intervalMs = null, onExpire = null } = {}) {
    const delay = Math.max(1_000, Number(intervalMs) || Math.min(
        60_000,
        Math.max(1_000, Number(process.env.UPLOAD_RESERVATION_TTL_MS) || 30 * 60 * 1000)
    ));
    const timer = setInterval(() => {
        const released = cleanupExpiredUploadReservations();
        if (released && typeof onExpire === "function") onExpire(released);
    }, delay);
    timer.unref?.();
    return () => clearInterval(timer);
}

export function resetUploadQuotaState() {
    stateByUser.clear();
    locksByUpload.clear();
    reservationTimestamps.clear();
}

export const UPLOAD_LIMITS = Object.freeze({ DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_DAILY_BYTES, DEFAULT_MAX_ACTIVE_UPLOADS });
