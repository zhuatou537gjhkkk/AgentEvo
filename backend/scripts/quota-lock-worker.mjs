#!/usr/bin/env node
/**
 * Child-process harness that drives the durable same-key cross-process upload
 * lock (W4-R5-S1) against the DB_PATH database. Used by
 * uploadQuotaLockDurable.test.js to prove the lock serializes two OS
 * processes on the same (owner, upload_key), and that a crashed holder's
 * lease is reclaimed (the key is never wedged).
 *
 * Reads DB_PATH from the environment. Each line on stdout is one JSON object.
 * Modes:
 *   hold  <owner> <tenant> <key> <holdMs> [ttlMs]
 *       Acquire the key, emit ACQUIRED, sleep holdMs inside the critical
 *       section (lease renews while held), then emit OP_DONE + RELEASED.
 *   wait  <owner> <tenant> <key> <budgetMs> [ttlMs]
 *       Acquire with a bounded busy wait. Emit ACQUIRED + DONE on success
 *       (exit 0); emit FAILED {code:"UPLOAD_LOCK_TIMEOUT",...} when the budget
 *       is exhausted (exit 1).
 */
import { createUploadQuotaStore } from "../src/services/uploadQuotaStore.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const [mode, ownerRaw, tenantRaw, keyRaw, msRaw, ttlRaw] = process.argv.slice(2);
const owner = Number(ownerRaw);
const ms = Number(msRaw);
if (!["hold", "wait"].includes(mode) || !Number.isInteger(owner) || owner <= 0 || !tenantRaw || !keyRaw || !Number.isInteger(ms) || ms < 0) {
    process.stderr.write("usage: quota-lock-worker.mjs <hold|wait> <owner> <tenant> <key> <ms> [ttlMs]\n");
    process.exit(2);
}
const scope = { userId: owner, tenantId: tenantRaw };
const ttlMs = Number.isInteger(Number(ttlRaw)) && Number(ttlRaw) > 0 ? Number(ttlRaw) : 60_000;

try {
    const store = createUploadQuotaStore({ durable: true });
    if (mode === "hold") {
        await store.withUploadLock(scope, keyRaw, async () => {
            emit({ event: "ACQUIRED", owner, key: keyRaw });
            if (ms > 0) await sleep(ms);
            emit({ event: "OP_DONE", owner, key: keyRaw });
        }, { ttlMs });
        emit({ event: "RELEASED", owner, key: keyRaw });
    } else {
        try {
            await store.withUploadLock(scope, keyRaw, async () => {
                emit({ event: "ACQUIRED", owner, key: keyRaw });
            }, { ttlMs, busyTimeoutMs: ms });
            emit({ event: "DONE", owner, key: keyRaw });
        } catch (error) {
            emit({ event: "FAILED", owner, key: keyRaw, code: error?.code || "UNKNOWN", message: error?.message || String(error) });
            process.exit(1);
        }
    }
} catch (error) {
    emit({ event: "FATAL", code: error?.code || "UNKNOWN", message: error?.message || String(error) });
    process.exit(1);
}
