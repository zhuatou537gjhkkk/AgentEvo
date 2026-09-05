#!/usr/bin/env node
/**
 * Child-process harness that drives the real durable upload-quota adapter
 * against the DB_PATH database. Used by uploadQuotaDurable.test.js to prove
 * restart persistence (a fresh process reopens the file) and cross-process
 * accounting (concurrent processes on distinct owners).
 *
 * Usage (from backend/): node scripts/quota-worker.mjs <ownerUserId> <tenantId> <uploadKey> <sizeBytes>
 * Reads DB_PATH from the environment; reserves chunk 0 (sizeBytes) then settles
 * sizeBytes. Prints one JSON line to stdout; exit code 0 on success.
 */
import { createUploadQuotaStore } from "../src/services/uploadQuotaStore.js";

const [ownerRaw, tenantRaw, keyRaw, sizeRaw] = process.argv.slice(2);
const owner = Number(ownerRaw);
const size = Number(sizeRaw);
if (!Number.isInteger(owner) || owner <= 0 || !tenantRaw || !keyRaw || !Number.isInteger(size) || size < 0) {
    process.stderr.write(`usage: quota-worker.mjs <ownerUserId> <tenantId> <uploadKey> <sizeBytes>\n`);
    process.exit(2);
}
const scope = { userId: owner, tenantId: tenantRaw };

try {
    const store = createUploadQuotaStore({ durable: true });
    const reserved = store.reserveUploadChunk(scope, keyRaw, 0, size);
    const settled = store.settleUploadReservation(scope, keyRaw, size);
    process.stdout.write(`${JSON.stringify({
        ok: true,
        owner,
        tenant: tenantRaw,
        key: keyRaw,
        reservedBytes: reserved.reservedBytes,
        settled: Boolean(settled),
    })}\n`);
} catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, owner, key: keyRaw, error: error.message })}\n`);
    process.exit(1);
}
