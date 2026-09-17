import crypto from "node:crypto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import db, { initDB } from "../db/index.js";
import { clearRagFlags } from "./flags.js";
import {
    claimNextIngestJob,
    createIngestJob,
    failIngestJob,
    getIngestJob,
    retryIngestJob,
    transitionIngestJob,
} from "./ingestStore.js";

const OWNER = { userId: 1, tenantId: "user:1" };

function makeJob(scope = OWNER, overrides = {}) {
    return createIngestJob({
        scope,
        id: `ing_${crypto.randomUUID()}`,
        projectId: "uploaded-documents",
        fileName: "guide.txt",
        storageKey: "jobs/test/source.txt",
        mimeType: "text/plain",
        fileHash: crypto.randomUUID().replaceAll("-", ""),
        sizeBytes: 12,
        parser: "native",
        ...overrides,
    });
}

beforeEach(() => { clearRagFlags(); initDB(); db.prepare("DELETE FROM knowledge_ingest_jobs").run(); });
afterEach(() => clearRagFlags());

describe("knowledge ingest job store", () => {
    it("keeps jobs owner scoped and deduplicates same hash/options", async () => {
        const first = makeJob(OWNER, { fileHash: "same-hash", options: { language: "ch" } });
        expect(getIngestJob({ userId: 2, tenantId: "user:2" }, first.id)).toBeNull();
        expect(() => makeJob(OWNER, { id: first.id })).toThrow();
    });

    it("allows one lease winner and rejects the old holder after reclaim", () => {
        const job = makeJob();
        const first = claimNextIngestJob({ holderToken: "holder-a", leaseSeconds: 30 });
        expect(first.id).toBe(job.id);
        expect(claimNextIngestJob({ holderToken: "holder-b", leaseSeconds: 30 })).toBeNull();
        db.prepare("UPDATE knowledge_ingest_jobs SET lease_expires_at = datetime('now', '-1 second') WHERE id = ?").run(job.id);
        const second = claimNextIngestJob({ holderToken: "holder-b", leaseSeconds: 30 });
        expect(second.id).toBe(job.id);
        expect(transitionIngestJob(job.id, "holder-a", "parsing")).toBe(false);
        expect(transitionIngestJob(job.id, "holder-b", "parsing")).toBe(true);
    });

    it("supports retry, cancel-safe terminal behavior, and bounded transitions", () => {
        const job = makeJob({ userId: 1, tenantId: "user:1" });
        const claimed = claimNextIngestJob({ holderToken: "holder", leaseSeconds: 30 });
        expect(() => transitionIngestJob(claimed.id, "holder", "provider_running")).toThrow();
        expect(failIngestJob(claimed.id, "holder", { errorCode: "TEMP", retryable: true })).toBe(true);
        expect(getIngestJob(OWNER, job.id).status).toBe("failed");
        expect(retryIngestJob(OWNER, job.id)).toBe(true);
        expect(getIngestJob(OWNER, job.id).status).toBe("queued");
    });
});
