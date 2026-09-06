/**
 * CodingRuntimeRegistry — instance-local, in-process runtime handles.
 *
 * One backend process can hold at most ONE runtime per (owner, run). The registry
 * is a process-local lock + subscriber hub: acquireStart is single-winner (a
 * second start while a runtime is live is rejected → 409), any number of
 * subscribers can attach to a live runtime, cancel fans out to all subscribers,
 * and idle runtimes are evicted/reaped after `idleMs`. It deliberately holds no
 * DB state — run lifecycle facts live in coding_runs; the registry only tracks
 * live in-process handles (AbortController/runner connection/SSE subscribers in
 * later phases). Scope is server-authenticated; a token guards release/heartbeat.
 */
import { codingError, newId, requireCodingScope } from "./util.js";

function keyOf(userId, tenantId, runId) {
    return `${userId}:${tenantId}:${runId}`;
}

export class CodingRuntimeRegistry {
    /**
     * @param {object} [options]
     * @param {number} [options.idleMs] idle before eviction (default 15 min)
     * @param {number} [options.sweepIntervalMs] background sweep cadence (default 60s)
     * @param {(entry: object) => void} [options.onEvict] reconcile hook on eviction
     */
    constructor({ idleMs = 15 * 60 * 1000, sweepIntervalMs = 60_000, onEvict = null } = {}) {
        this.idleMs = Math.max(1_000, Number(idleMs) || 15 * 60 * 1000);
        this.sweepIntervalMs = Math.max(200, Number(sweepIntervalMs) || 60_000);
        this.onEvict = onEvict;
        /** @type {Map<string, object>} key → entry */
        this.entries = new Map();
        /** @type {Map<string, string>} token → key */
        this.byToken = new Map();
        this._sweeper = null;
        this._disposed = false;
    }

    _key(scope, runId) {
        const { userId, tenantId } = requireCodingScope(scope, "runtime");
        return keyOf(userId, tenantId, String(runId));
    }

    _ensureSweeper() {
        if (this._sweeper || this._disposed) return;
        this._sweeper = setInterval(() => {
            try { this.evictIdle(); } catch { /* best-effort sweep */ }
        }, this.sweepIntervalMs);
        this._sweeper.unref?.();
    }

    _stopSweeperIfIdle() {
        if (this._sweeper && this.entries.size === 0) {
            clearInterval(this._sweeper);
            this._sweeper = null;
        }
    }

    /**
     * Single-winner claim for a run start. Returns an opaque token, or null when a
     * runtime for the same run is already live (concurrent start → 409).
     */
    acquireStart(scope, runId) {
        if (this._disposed) throw codingError("REGISTRY_DISPOSED", "runtime registry is disposed", 503);
        const { userId, tenantId } = requireCodingScope(scope, "runtime");
        const key = keyOf(userId, tenantId, String(runId));
        if (this.entries.has(key)) return null;
        const now = Date.now();
        const token = newId("rt_");
        const entry = {
            key,
            token,
            userId,
            tenantId,
            runId: String(runId),
            status: "active",
            startedAt: now,
            lastActiveAt: now,
            cancelRequested: false,
            subscribers: new Set(),
        };
        this.entries.set(key, entry);
        this.byToken.set(token, key);
        this._ensureSweeper();
        return token;
    }

    isActive(scope, runId) {
        return this.entries.has(this._key(scope, runId));
    }

    getEntry(scope, runId) {
        return this.entries.get(this._key(scope, runId)) || null;
    }

    /** Attach a subscriber (e.g. an SSE client) to a live runtime. */
    attachSubscriber(scope, runId, subscriber) {
        const entry = this.getEntry(scope, runId);
        if (!entry) throw codingError("NOT_FOUND", "no active runtime for this run", 404);
        if (typeof subscriber !== "function") throw codingError("INVALID_SUBSCRIBER", "subscriber must be a function", 400);
        entry.subscribers.add(subscriber);
        return () => entry.subscribers.delete(subscriber);
    }

    /** Push an event to every subscriber of a live runtime. */
    broadcast(scope, runId, event) {
        const entry = this.getEntry(scope, runId);
        if (!entry) return 0;
        entry.lastActiveAt = Date.now();
        for (const subscriber of entry.subscribers) {
            try { subscriber(event); } catch { /* isolate a bad subscriber */ }
        }
        return entry.subscribers.size;
    }

    /**
     * Request cancellation of a live runtime; fans out to subscribers.
     * Returns a summary. Does not remove the entry (cleanup may still be
     * running); callers finish with releaseRun.
     */
    cancel(scope, runId, { reason = null } = {}) {
        const entry = this.getEntry(scope, runId);
        if (!entry) return { hadRuntime: false, subscriberCount: 0 };
        entry.cancelRequested = true;
        const count = this.broadcast(scope, runId, {
            type: "run.cancelled", runId: String(runId), reason,
            at: new Date().toISOString(),
        });
        return { hadRuntime: true, subscriberCount: count };
    }

    /** Owner-scoped release. Token optional but guards against cross-actor release. */
    releaseRun(scope, runId, { token = null } = {}) {
        const key = this._key(scope, runId);
        const entry = this.entries.get(key);
        if (!entry) return false;
        if (token != null && entry.token !== token) {
            throw codingError("RUNTIME_TOKEN_MISMATCH", "runtime token does not match", 403);
        }
        this.entries.delete(key);
        this.byToken.delete(entry.token);
        entry.subscribers.clear();
        this._stopSweeperIfIdle();
        return true;
    }

    /** Heartbeat by token: keeps a runtime from being idle-evicted. */
    heartbeat(token) {
        const key = this.byToken.get(String(token));
        const entry = key ? this.entries.get(key) : null;
        if (!entry) return false;
        entry.lastActiveAt = Date.now();
        return true;
    }

    /** Evict runtimes idle longer than `idleMs`. Deterministic for tests. */
    evictIdle(nowMs = Date.now()) {
        const evicted = [];
        for (const [key, entry] of this.entries.entries()) {
            if (entry.lastActiveAt + this.idleMs < nowMs) {
                const count = entry.subscribers.size;
                for (const subscriber of entry.subscribers) {
                    try {
                        subscriber({ type: "run.cancelled", runId: entry.runId, reason: "idle-evicted", at: new Date().toISOString() });
                    } catch { /* isolate */ }
                }
                this.entries.delete(key);
                this.byToken.delete(entry.token);
                entry.subscribers.clear();
                if (this.onEvict) { try { this.onEvict(entry); } catch { /* isolate */ } }
                evicted.push({ runId: entry.runId, subscriberCount: count });
            }
        }
        if (evicted.length) this._stopSweeperIfIdle();
        return evicted;
    }

    stats() {
        return { active: this.entries.size, idleMs: this.idleMs };
    }

    dispose() {
        this._disposed = true;
        if (this._sweeper) {
            clearInterval(this._sweeper);
            this._sweeper = null;
        }
        this.entries.clear();
        this.byToken.clear();
    }
}

export const defaultRuntimeRegistry = new CodingRuntimeRegistry();
export default defaultRuntimeRegistry;
