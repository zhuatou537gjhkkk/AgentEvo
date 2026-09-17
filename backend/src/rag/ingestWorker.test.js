import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDB } from "../db/index.js";
import db from "../db/index.js";
import { clearRagFlags } from "./flags.js";
import { createKnowledgeIngestJob } from "./ingestService.js";
import { getIngestJob } from "./ingestStore.js";
import { createIngestWorker, planEmbeddingBatches } from "./ingestWorker.js";
import { getActiveChunks, getActiveDocumentByPath, getLatestDocumentByPath, getParentChunks } from "./knowledgeStore.js";

const OWNER = { userId: 1, tenantId: "user:1" };
let root;

beforeEach(async () => {
    clearRagFlags();
    process.env.KNOWLEDGE_INGEST_V2 = "true";
    initDB();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "agentevo-ingest-"));
});

afterEach(async () => {
    clearRagFlags();
    await fs.rm(root, { recursive: true, force: true });
});

async function sourceFile(name, content) {
    const filePath = path.join(root, name);
    await fs.writeFile(filePath, content);
    return filePath;
}

async function runCreatedJob(worker, jobId) {
    db.prepare("UPDATE knowledge_ingest_jobs SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL WHERE id <> ? AND status IN ('queued','failed','submitting','provider_uploading','provider_pending','provider_running','provider_converting','downloading','parsing','indexing')").run(jobId);
    db.prepare("UPDATE knowledge_ingest_jobs SET next_attempt_at = datetime('now', '-1 second') WHERE id = ?").run(jobId);
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const result = await worker.runOnce();
        if (result.jobId === jobId) return result;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`worker did not claim ${jobId}`);
}

describe("knowledge ingest worker", () => {
    it("splits embedding work by both item count and total characters", () => {
        const batches = planEmbeddingBatches([
            { content: "12345" },
            { content: "12345" },
            { content: "12345" },
        ], { maxCount: 3, maxChars: 10_000 });
        expect(batches).toHaveLength(1);
        const bounded = planEmbeddingBatches([
            { content: "x".repeat(600) },
            { content: "x".repeat(600) },
            { content: "x".repeat(600) },
        ], { maxCount: 25, maxChars: 1_000 });
        expect(bounded.map((batch) => batch.length)).toEqual([1, 1, 1]);
    });

    it("marks a job failed when every embedding batch fails", async () => {
        const fileName = `embed-fail-${crypto.randomUUID()}.md`;
        const sourcePath = await sourceFile(fileName, "# Failure\n\nThis must not become a false ready document.");
        const created = await createKnowledgeIngestJob({ scope: OWNER, sourcePath, fileName, storageRoot: root });
        const worker = createIngestWorker({
            storageRoot: root,
            embedder: { async embed() { throw Object.assign(new Error("upstream rejected"), { status: 400 }); } },
        });
        const result = await runCreatedJob(worker, created.job.id);
        const job = getIngestJob(OWNER, created.job.id);
        expect(result.status).toBe("failed");
        expect(job.status).toBe("failed");
        expect(job.error_code).toBe("EMBEDDING_ALL_BATCHES_FAILED");
        expect(job.resultMeta.embedding.status).toBe("failed");
        expect(job.resultMeta.embedding.errors).toBeGreaterThan(0);
    });

    it("parses native text without provider calls and persists a ready durable document", async () => {
        const fileName = `guide-${crypto.randomUUID()}.md`;
        const sourcePath = await sourceFile(fileName, `# Guide\n\nUse the safe worker ${crypto.randomUUID()}.`);
        const created = await createKnowledgeIngestJob({ scope: OWNER, sourcePath, fileName, mimeType: "text/markdown", storageRoot: root });
        let providerCalls = 0;
        const worker = createIngestWorker({ storageRoot: root, client: { requestUploadSlot: async () => { providerCalls += 1; }, uploadFile: async () => {}, getBatchResult: async () => {}, downloadResult: async () => {} } });
        const result = await runCreatedJob(worker, created.job.id);
        const job = getIngestJob(OWNER, created.job.id);
        expect(result.status).toBe("ready");
        expect(job.status).toBe("ready");
        expect(job.document_id).toMatch(/^kd_/);
        expect(providerCalls).toBe(0);
        expect(getActiveChunks(OWNER, created.job.project_id, { limit: 100 }).every((row) => row.chunk_level === "leaf")).toBe(true);
        expect(getParentChunks(OWNER, job.document_id, { limit: 100 }).length).toBeGreaterThan(0);
        await expect(fs.access(path.join(root, "jobs", job.id))).rejects.toThrow();
    });

    it("keeps the old active revision readable when a staged revision cannot activate", async () => {
        const fileName = `revision-${crypto.randomUUID()}.md`;
        const marker = crypto.randomUUID();
        const sourcePath = await sourceFile(fileName, `# Guide\n\nold revision ${marker}`);
        const first = await createKnowledgeIngestJob({ scope: OWNER, sourcePath, fileName, storageRoot: root });
        await runCreatedJob(createIngestWorker({ storageRoot: root }), first.job.id);
        const old = getActiveDocumentByPath(OWNER, first.job.project_id, fileName);
        expect(old?.status).toBe("active");

        await fs.writeFile(sourcePath, `# Guide\n\nnew revision ${crypto.randomUUID()}`);
        const second = await createKnowledgeIngestJob({ scope: OWNER, sourcePath, fileName, storageRoot: root });
        const worker = createIngestWorker({
            storageRoot: root,
            knowledgeStore: { activateDocumentRevision: () => false },
        });
        const result = await runCreatedJob(worker, second.job.id);
        expect(result.status).toBe("failed");
        expect(getActiveDocumentByPath(OWNER, first.job.project_id, fileName)?.id).toBe(old.id);
        expect(getLatestDocumentByPath(OWNER, second.job.project_id, fileName)?.status).toBe("failed");
        expect(getIngestJob(OWNER, second.job.id)?.status).toBe("failed");
    });

    it("embeds only leaves in bounded batches and keeps lexical fallback on batch failure", async () => {
        const fileName = `large-${crypto.randomUUID()}.md`;
        const marker = crypto.randomUUID();
        const body = Array.from({ length: 180 }, (_, index) => `line ${index} contains K4 embedding batch marker ${marker} and section context.`).join("\n");
        const sourcePath = await sourceFile(fileName, `# Large\n\n${body}`);
        const created = await createKnowledgeIngestJob({
            scope: OWNER,
            sourcePath,
            fileName,
            storageRoot: root,
            options: { batchEmbedSize: 1 },
        });
        let calls = 0;
        const worker = createIngestWorker({
            storageRoot: root,
            batchEmbedSize: 1,
            embedder: {
                async embed(texts) {
                    calls += 1;
                    if (calls % 2 === 0) throw new Error("embedding unavailable");
                    return texts.map(() => [1, 0, 0, 0]);
                },
            },
        });
        const result = await runCreatedJob(worker, created.job.id);
        const job = getIngestJob(OWNER, created.job.id);
        const leaves = getActiveChunks(OWNER, created.job.project_id, { limit: 1000 });
        expect(result.status).toBe("ready");
        expect(job.resultMeta.embeddingErrors).toBeGreaterThan(0);
        expect(calls).toBeGreaterThan(1);
        expect(leaves.some((row) => row.embedding == null)).toBe(true);
        expect(leaves.some((row) => row.embedding != null)).toBe(true);
    });

    it("runs the MinerU submit → poll → download → parse path with fake provider calls", async () => {
        process.env.MINERU_PARSER_ENABLED = "true";
        const fileName = `scan-${crypto.randomUUID()}.pdf`;
        const sourcePath = await sourceFile(fileName, `fake-pdf-${crypto.randomUUID()}`);
        const created = await createKnowledgeIngestJob({ scope: OWNER, sourcePath, fileName, mimeType: "application/pdf", storageRoot: root });
        const calls = [];
        const worker = createIngestWorker({
            storageRoot: root,
            client: {
                requestUploadSlot: async () => { calls.push("slot"); return { batchId: "batch-test", uploadUrl: "https://signed.test/upload", traceId: "trace-safe" }; },
                uploadFile: async () => { calls.push("upload"); },
                getBatchResult: async () => { calls.push("poll"); return { state: "done", resultUrl: "https://signed.test/result.zip", traceId: "trace-safe" }; },
                downloadResult: async ({ targetPath }) => { calls.push("download"); await fs.writeFile(targetPath, "fake"); },
            },
            outputReader: async () => [{
                name: "nested/scan_content_list.json",
                data: JSON.stringify({
                    pages: [
                        { page_idx: 0, blocks: [{ type: "text", text: "OCR result page one" }] },
                        { page_idx: 1, blocks: [{ type: "text", text: "OCR result page two" }] },
                    ],
                }),
            }],
            pollIntervalMs: 1,
        });
        const result = await runCreatedJob(worker, created.job.id);
        const job = getIngestJob(OWNER, created.job.id);
        const chunks = getActiveChunks(OWNER, created.job.project_id, { filePath: fileName, limit: 10 });
        expect(result.status).toBe("ready");
        expect(job.status).toBe("ready");
        expect(job.resultMeta.pages).toBe(2);
        expect(chunks.some((chunk) => chunk.page_start === 1 && chunk.page_end === 2)).toBe(true);
        expect(calls).toEqual(["slot", "upload", "poll", "download"]);
    });

    it("does not allow a second owner to observe or process another owner's job", async () => {
        const sourcePath = await sourceFile("private.txt", "private");
        const created = await createKnowledgeIngestJob({ scope: OWNER, sourcePath, fileName: "private.txt", storageRoot: root });
        expect(getIngestJob({ userId: 2, tenantId: "user:2" }, created.job.id)).toBeNull();
    });
});
