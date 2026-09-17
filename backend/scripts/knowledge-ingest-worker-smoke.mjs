/**
 * K13 single-host multi-process smoke.
 * Creates a temporary SQLite database, races two external workers against one
 * native text job, then verifies fencing, lease reclaim, generation and stale
 * revision filtering. It never touches the development DB_PATH.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentevo-k13-"));
const dbPath = path.join(root, "agent_data.db");
const storageRoot = path.join(root, "storage");
await fs.mkdir(storageRoot, { recursive: true });
const env = {
    ...process.env,
    DB_PATH: dbPath,
    KNOWLEDGE_INGEST_STORAGE_ROOT: storageRoot,
    KNOWLEDGE_INGEST_V2: "true",
    KNOWLEDGE_INGEST_WORKER_MODE: "external",
};
// The parent verifier must use the same disposable DB as its children. This
// is set before any project DB module is imported; the development DB is never
// opened by this smoke.
process.env.DB_PATH = dbPath;
process.env.KNOWLEDGE_INGEST_STORAGE_ROOT = storageRoot;
process.env.KNOWLEDGE_INGEST_V2 = "true";
process.env.KNOWLEDGE_INGEST_WORKER_MODE = "external";

function runWorker() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["scripts/knowledge-ingest-worker.mjs", "--once"], {
            cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const timeout = setTimeout(() => child.kill(), 15_000);
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() });
        });
    });
}

try {
    const dbModule = await import("../src/db/index.js");
    const { initDB, createUser } = dbModule;
    const db = dbModule.default;
    const { createIngestJob, claimNextIngestJob, transitionIngestJob, completeIngestJob, getIngestJob } = await import("../src/rag/ingestStore.js");
    const { getKnowledgeIndexGeneration, getActiveChunks, insertDocumentRevision, activateDocumentRevision } = await import("../src/rag/knowledgeStore.js");
    initDB();
    const owner = createUser(`k13_smoke_owner_${crypto.randomUUID()}`, "not-a-real-password");
    const userId = Number(owner.id || owner.lastInsertRowid || owner);
    const scope = { userId, tenantId: `user:${userId}` };
    const jobId = `ing_${crypto.randomUUID()}`;
    const sourceKey = `jobs/${jobId}/source.txt`;
    await fs.mkdir(path.join(storageRoot, `jobs/${jobId}`), { recursive: true });
    await fs.writeFile(path.join(storageRoot, sourceKey), "K13 generation smoke\nold revision\n", "utf8");
    const job = createIngestJob({
        scope, id: jobId, projectId: "k13-upload", fileName: "source.txt", storageKey: sourceKey,
        mimeType: "text/plain", fileHash: crypto.randomUUID().replaceAll("-", ""), sizeBytes: 34,
    });
    const workers = await Promise.all([runWorker(), runWorker()]);
    const ready = workers.filter((item) => item.code === 0 && /"status":"ready"/.test(item.stdout));
    const idle = workers.filter((item) => item.code === 0 && /"status":"idle"/.test(item.stdout));
    if (ready.length !== 1 || idle.length !== 1) throw new Error(`exactly_once_failed:${JSON.stringify({ workers, mode: env.KNOWLEDGE_INGEST_WORKER_MODE, v2: env.KNOWLEDGE_INGEST_V2 })}`);
    const completed = getIngestJob(scope, job.id);
    if (completed?.status !== "ready" || Number(completed.attempt_count) !== 1) throw new Error("job_not_completed_exactly_once");

    const fenced = createIngestJob({
        scope, id: `ing_${crypto.randomUUID()}`, projectId: "k13-upload", fileName: "fence.txt",
        storageKey: "jobs/fence.txt", mimeType: "text/plain", fileHash: crypto.randomUUID().replaceAll("-", ""), sizeBytes: 1,
    });
    const first = claimNextIngestJob({ holderToken: "k13-holder-a", leaseSeconds: 30 });
    if (!first || first.id !== fenced.id) throw new Error("fence_first_claim_failed");
    db.prepare("UPDATE knowledge_ingest_jobs SET lease_expires_at = datetime('now', '-1 second') WHERE id = ?").run(fenced.id);
    const second = claimNextIngestJob({ holderToken: "k13-holder-b", leaseSeconds: 30 });
    if (!second || transitionIngestJob(fenced.id, "k13-holder-a", "parsing") !== false) throw new Error("stale_holder_not_fenced");
    if (!completeIngestJob(fenced.id, "k13-holder-b", { resultMeta: { smoke: true } })) throw new Error("reclaimed_holder_cannot_complete");
    const reclaimed = getIngestJob(scope, fenced.id);
    if (Number(reclaimed.reclaim_count) !== 1) throw new Error("lease_reclaim_not_counted");

    const project = "k13-generation";
    const old = insertDocumentRevision({ scope, projectId: project, filePath: "guide.md", fileName: "guide.md", fileHash: "old", status: "indexing", chunks: [{ content: "old revision", chunkIndex: 0 }] });
    if (!activateDocumentRevision(scope, old.documentId)) throw new Error("old_revision_activation_failed");
    const generationBefore = getKnowledgeIndexGeneration(scope, project);
    const fresh = insertDocumentRevision({ scope, projectId: project, filePath: "guide.md", fileName: "guide.md", fileHash: "new", status: "indexing", previous: { id: old.documentId, revision: 1 }, chunks: [{ content: "new revision", chunkIndex: 0 }] });
    if (!activateDocumentRevision(scope, fresh.documentId, { previousDocumentId: old.documentId })) throw new Error("new_revision_activation_failed");
    const active = getActiveChunks(scope, project);
    if (getKnowledgeIndexGeneration(scope, project) <= generationBefore || active.length !== 1 || active[0].content !== "new revision") {
        throw new Error("generation_or_stale_filter_failed");
    }
    console.log(JSON.stringify({ ok: true, checks: ["exactly_once", "stale_holder_fencing", "lease_reclaim", "generation_visible", "old_revision_excluded"], generation: getKnowledgeIndexGeneration(scope, project) }));
} finally {
    try {
        const dbModule = await import("../src/db/index.js");
        dbModule.closeDB?.();
    } catch { /* best-effort cleanup */ }
    await fs.rm(root, { recursive: true, force: true });
}
