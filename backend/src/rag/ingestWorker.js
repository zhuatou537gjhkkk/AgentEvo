import fs from "node:fs/promises";
import path from "node:path";
import { classifyError, createRetryableError } from "../services/resilience.js";
import { knowledgeIngestV2Enabled, ragFaissEnabled } from "./flags.js";
import { getFaissVectorStore, safeFaissErrorCode } from "./faissVectorStore.js";
import { createMineruClient } from "./mineruClient.js";
import { normalizeMineruOutput, readMineruArchive } from "./mineruOutput.js";
import { parseNativeTextFile } from "./nativeTextParser.js";
import { chunkParsedDocument, chunkStats } from "./documentChunk.js";
import {
    claimNextIngestJob,
    completeIngestJob,
    failIngestJob,
    getIngestJob,
    renewIngestLease,
    transitionIngestJob,
    updateIngestProvider,
} from "./ingestStore.js";
import {
    getActiveDocumentByPath,
    insertDocumentRevision,
    activateDocumentRevision,
    failDocumentRevision,
} from "./knowledgeStore.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_EMBED_BATCH_CHARS = 12_000;

const workerHealth = {
    enabled: false,
    mode: "inline",
    status: "not_started",
    startedAt: null,
    lastTickAt: null,
    lastResult: null,
    lastErrorCode: null,
    activeJobId: null,
};

function publicEmbeddingFailure(error) {
    const classified = classifyError(error);
    const status = Number(classified?.statusCode || error?.status || 0);
    if (classified?.code === "ABORTED" || error?.name === "AbortError") return { code: "EMBEDDING_ABORTED", retryable: true };
    if (status === 401 || status === 403) return { code: "EMBEDDING_AUTH_FAILED", retryable: false };
    if (status === 429) return { code: "EMBEDDING_RATE_LIMITED", retryable: true };
    if (status >= 500 || classified?.retryable) return { code: "EMBEDDING_UPSTREAM_UNAVAILABLE", retryable: true };
    if (status >= 400) return { code: "EMBEDDING_INVALID_REQUEST", retryable: false };
    if (classified?.code === "EMBEDDING_RESPONSE_MISMATCH") return { code: "EMBEDDING_INVALID_RESPONSE", retryable: false };
    return { code: "EMBEDDING_FAILED", retryable: false };
}

function safeWorkerErrorCode(error) {
    const code = String(error?.code || "");
    if (/^(?:ABORTED|MINERU_[A-Z0-9_]+|INGEST_[A-Z0-9_]+|KNOWLEDGE_[A-Z0-9_]+|EMBEDDING_[A-Z0-9_]+)$/.test(code)) return code;
    return "INGEST_FAILED";
}

export function planEmbeddingBatches(chunks = [], { maxCount = 25, maxChars = DEFAULT_EMBED_BATCH_CHARS } = {}) {
    const countLimit = Math.max(1, Math.min(100, Number(maxCount) || 25));
    const charLimit = Math.max(1_000, Math.min(50_000, Number(maxChars) || DEFAULT_EMBED_BATCH_CHARS));
    const batches = [];
    let current = [];
    let chars = 0;
    for (const chunk of chunks || []) {
        const nextChars = String(chunk?.content || "").length;
        if (current.length > 0 && (current.length >= countLimit || chars + nextChars > charLimit)) {
            batches.push(current);
            current = [];
            chars = 0;
        }
        current.push(chunk);
        chars += nextChars;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

function scopeFor(job) {
    return { userId: Number(job.owner_user_id), tenantId: String(job.tenant_id) };
}

function storageRoot(explicitRoot) {
    return path.resolve(explicitRoot || process.env.KNOWLEDGE_INGEST_STORAGE_ROOT || path.join(process.cwd(), "tmp", "knowledge-ingest"));
}

function resolveStoragePath(root, storageKey) {
    const base = path.resolve(root);
    const target = path.resolve(base, String(storageKey || ""));
    const relative = path.relative(base, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        const error = new Error("ingest storage path escapes configured root");
        error.code = "INGEST_STORAGE_PATH_INVALID";
        throw error;
    }
    return target;
}

function stageDirectory(root, jobId) {
    return resolveStoragePath(root, `jobs/${jobId}`);
}

function sourcePath(root, job) {
    return resolveStoragePath(root, job.storage_key);
}

function resultPath(root, job) {
    return resolveStoragePath(root, `jobs/${job.id}/mineru-result.zip`);
}

function providerState(state) {
    if (state === "waiting-file" || state === "pending") return "provider_pending";
    if (state === "running") return "provider_running";
    if (state === "converting") return "provider_converting";
    return null;
}

async function exists(filePath) {
    try { await fs.access(filePath); return true; } catch { return false; }
}

function ensureLease(renewed, errorCode = "INGEST_LEASE_LOST") {
    if (!renewed) {
        const error = new Error("ingest lease is no longer owned");
        error.code = errorCode;
        error.retryable = true;
        throw error;
    }
}

export function createIngestWorker({
    store = {},
    client = createMineruClient(),
    outputReader = readMineruArchive,
    outputNormalizer = normalizeMineruOutput,
    nativeParser = parseNativeTextFile,
    embedder = null,
    faissStore = null,
    batchEmbedSize = 25,
    knowledgeStore = {},
    storageRoot: rootOverride,
    pollIntervalMs = Number(process.env.MINERU_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS,
    leaseSeconds = Number(process.env.KNOWLEDGE_INGEST_LEASE_SECONDS) || DEFAULT_LEASE_SECONDS,
    sleep = (ms, signal) => new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (signal) {
            const abort = () => { clearTimeout(timer); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
        }
    }),
    now = () => Date.now(),
} = {}) {
    const deps = {
        claimNextIngestJob,
        completeIngestJob,
        failIngestJob,
        getIngestJob,
        renewIngestLease,
        transitionIngestJob,
        updateIngestProvider,
        ...store,
    };
    const root = storageRoot(rootOverride);
    let timer = null;
    let active = null;
    let running = false;
    let stopping = false;
    let controller = null;
    let ticking = false;
    const documentStore = {
        getActiveDocumentByPath,
        insertDocumentRevision,
        activateDocumentRevision,
        failDocumentRevision,
        ...knowledgeStore,
    };

    function buildFaiss(scope, projectId) {
        if (!ragFaissEnabled() && !faissStore) return { status: "disabled" };
        const target = faissStore?.name === "faiss"
            ? faissStore
            : getFaissVectorStore({ scope, projectId, store: documentStore });
        try {
            if (typeof target.ensureIndex === "function") target.ensureIndex();
            else if (typeof target.buildIndex === "function") target.buildIndex();
            else return { status: "disabled" };
            const stats = typeof target.stats === "function" ? target.stats({ ensure: false }) : {};
            return {
                status: "ready",
                generation: Number.isSafeInteger(Number(stats?.generation)) ? Number(stats.generation) : null,
                chunkCount: Math.max(0, Number(stats?.chunkCount) || 0),
            };
        } catch (error) {
            // A derived-index problem must not turn a committed ingest into a
            // failed job; lexical and durable linear fallback remain available.
            return { status: "fallback", fallbackCode: safeFaissErrorCode(error) };
        }
    }

    async function pollProvider(job, holderToken, signal) {
        let current = job;
        while (!signal?.aborted) {
            ensureLease(deps.renewIngestLease(current.id, holderToken, { leaseSeconds }), "INGEST_LEASE_LOST");
            const result = await client.getBatchResult({ batchId: current.provider_batch_id, signal });
            if (result.traceId) deps.updateIngestProvider(current.id, holderToken, { traceId: result.traceId });
            const target = providerState(result.state);
            if (target && current.status !== target) {
                ensureLease(deps.transitionIngestJob(current.id, holderToken, target, { progressUnit: "provider" }), "INGEST_LEASE_LOST");
                current = { ...current, status: target };
            }
            if (result.state === "done") return result;
            await sleep(Math.max(250, Number(current.options?.pollIntervalMs) || pollIntervalMs), signal);
            current = deps.getIngestJob(scopeFor(current), current.id) || current;
        }
        throw Object.assign(new Error("ingest polling aborted"), { name: "AbortError", code: "ABORTED" });
    }

    async function submitMineru(job, holderToken, signal) {
        if (job.status !== "submitting") {
            ensureLease(deps.transitionIngestJob(job.id, holderToken, "submitting", { progressUnit: "stage", progressCurrent: 1, progressTotal: 6 }), "INGEST_LEASE_LOST");
        }
        const slot = await client.requestUploadSlot({ fileName: job.file_name, dataId: job.id, options: job.options, signal });
        ensureLease(deps.updateIngestProvider(job.id, holderToken, { batchId: slot.batchId, traceId: slot.traceId }), "INGEST_LEASE_LOST");
        ensureLease(deps.transitionIngestJob(job.id, holderToken, "provider_uploading", { progressCurrent: 2 }), "INGEST_LEASE_LOST");
        await client.uploadFile({ uploadUrl: slot.uploadUrl, filePath: sourcePath(root, job), signal });
        ensureLease(deps.renewIngestLease(job.id, holderToken, { leaseSeconds }), "INGEST_LEASE_LOST");
        ensureLease(deps.transitionIngestJob(job.id, holderToken, "provider_pending", { progressCurrent: 3 }), "INGEST_LEASE_LOST");
        return deps.getIngestJob(scopeFor(job), job.id);
    }

    async function ensureMineruZip(job, holderToken, signal) {
        let current = deps.getIngestJob(scopeFor(job), job.id) || job;
        if (current.status === "parsing" || current.status === "indexing") return resultPath(root, current);
        if (current.status === "provider_uploading") {
            throw createRetryableError("MinerU upload stage needs a fresh signed URL", "MINERU_UPLOAD_LEASE_RECOVERY");
        }
        let result = await pollProvider(current, holderToken, signal);
        const zip = resultPath(root, current);
        if (current.status !== "downloading") {
            ensureLease(deps.transitionIngestJob(current.id, holderToken, "downloading", { progressCurrent: 4 }), "INGEST_LEASE_LOST");
        }
        if (!(await exists(zip))) {
            await client.downloadResult({ resultUrl: result.resultUrl, targetPath: zip, signal });
        }
        ensureLease(deps.transitionIngestJob(current.id, holderToken, "parsing", { progressCurrent: 5 }), "INGEST_LEASE_LOST");
        return zip;
    }

    async function parseJob(job, holderToken, signal) {
        const current = deps.getIngestJob(scopeFor(job), job.id) || job;
        if (current.parser === "native") {
            if (current.status !== "parsing") {
                ensureLease(deps.transitionIngestJob(current.id, holderToken, "parsing", { progressCurrent: 1, progressTotal: 3, progressUnit: "stage" }), "INGEST_LEASE_LOST");
            }
            return nativeParser(sourcePath(root, current), { fileName: current.file_name, mimeType: current.mime_type, parserVersion: current.parser_version });
        }
        const zip = await ensureMineruZip(current, holderToken, signal);
        const entries = await outputReader(zip);
        return outputNormalizer({ entries, fileName: current.file_name, mimeType: current.mime_type, parserVersion: current.parser_version });
    }

    async function indexJob(job, holderToken, parsed) {
        ensureLease(deps.transitionIngestJob(job.id, holderToken, "indexing", { progressCurrent: 6, progressTotal: 6, progressUnit: "stage" }), "INGEST_LEASE_LOST");
        const scope = scopeFor(job);
        const previous = documentStore.getActiveDocumentByPath(scope, job.project_id, job.file_name);
        if (previous && String(previous.file_hash) === String(job.file_hash)) {
            const faiss = buildFaiss(scope, job.project_id);
            ensureLease(deps.completeIngestJob(job.id, holderToken, {
                documentId: previous.id,
                resultMeta: { parser: parsed.parser, blocks: parsed.blocks.length, chars: parsed.stats.chars, pages: parsed.stats.pages, unchanged: true, faiss },
            }), "INGEST_LEASE_LOST");
            return previous.id;
        }
        const chunks = chunkParsedDocument(parsed, job.options?.chunking || {});
        const leafChunks = chunks.filter((chunk) => chunk.chunkLevel === "leaf");
        let embeddingErrors = 0;
        let embeddingCount = 0;
        let embeddingDimension = null;
        let embeddingRetryable = false;
        const embeddingFailureCodes = new Set();
        const effectiveBatchSize = Math.max(1, Math.min(25, Number(job.options?.batchEmbedSize) || Number(batchEmbedSize) || 25));
        const effectiveBatchChars = Math.max(1_000, Math.min(50_000, Number(process.env.RAG_EMBED_BATCH_MAX_CHARS) || DEFAULT_EMBED_BATCH_CHARS));
        if (embedder && typeof embedder.embed === "function") {
            const batches = planEmbeddingBatches(leafChunks, { maxCount: effectiveBatchSize, maxChars: effectiveBatchChars });
            for (const batch of batches) {
                try {
                    const vectors = await embedder.embed(batch.map((chunk) => chunk.content));
                    if (!Array.isArray(vectors) || vectors.length !== batch.length) {
                        throw Object.assign(new Error("embedding response count mismatch"), { code: "EMBEDDING_RESPONSE_MISMATCH" });
                    }
                    batch.forEach((chunk, index) => {
                        const vector = vectors[index];
                        const valid = Array.isArray(vector) && vector.length > 0 && vector.every((value) => Number.isFinite(Number(value)));
                        if (!valid || (embeddingDimension != null && vector.length !== embeddingDimension)) {
                            embeddingErrors += 1;
                            embeddingFailureCodes.add("EMBEDDING_INVALID_RESPONSE");
                            return;
                        }
                        embeddingDimension ||= vector.length;
                        chunk.embedding = vector;
                        embeddingCount += 1;
                    });
                } catch (error) {
                    const failure = publicEmbeddingFailure(error);
                    embeddingFailureCodes.add(failure.code);
                    embeddingRetryable ||= failure.retryable;
                    embeddingErrors += batch.length;
                    console.warn(`[rag][ingest] embedding batch failed code=${failure.code} chunks=${batch.length}`);
                }
            }
        }

        const embeddingStatus = !embedder ? "disabled" : embeddingErrors === 0 ? "complete" : embeddingCount > 0 ? "partial" : "failed";
        const embeddingMeta = {
            status: embeddingStatus,
            attempted: Boolean(embedder),
            count: embeddingCount,
            errors: embeddingErrors,
            dimension: embeddingDimension,
            failureCodes: [...embeddingFailureCodes].slice(0, 4),
        };
        if (embedder && leafChunks.length > 0 && embeddingCount === 0) {
            const error = new Error("all embedding batches failed");
            error.code = "EMBEDDING_ALL_BATCHES_FAILED";
            error.retryable = embeddingRetryable;
            error.resultMeta = { embedding: embeddingMeta, embeddingErrors };
            throw error;
        }

        let inserted = null;
        try {
            inserted = documentStore.insertDocumentRevision({
                scope,
                projectId: job.project_id,
                filePath: job.file_name,
                fileName: job.file_name,
                docType: "uploaded_document",
                fileHash: job.file_hash,
                sizeBytes: job.size_bytes,
                sourceSessionId: job.source_session_id,
                status: "indexing",
                meta: {
                    parser: parsed.parser,
                    parserVersion: parsed.parserVersion,
                    pages: parsed.stats.pages,
                    warnings: parsed.warnings,
                    chunkStats: chunkStats(chunks),
                    embeddingErrors,
                    embedding: embeddingMeta,
                },
                chunks,
                previous,
            });
            const activated = documentStore.activateDocumentRevision(scope, inserted.documentId, {
                previousDocumentId: previous?.id || null,
            });
            if (!activated) {
                const error = new Error("staged knowledge revision could not be activated");
                error.code = "KNOWLEDGE_REVISION_ACTIVATION_FAILED";
                throw error;
            }
        } catch (error) {
            if (inserted?.documentId && typeof documentStore.failDocumentRevision === "function") {
                documentStore.failDocumentRevision(scope, inserted.documentId, { reason: error?.code || "indexing-failed" });
            }
            throw error;
        }
        const faiss = buildFaiss(scope, job.project_id);
        ensureLease(deps.completeIngestJob(job.id, holderToken, {
            documentId: inserted.documentId,
            resultMeta: {
                parser: parsed.parser,
                blocks: parsed.blocks.length,
                chars: parsed.stats.chars,
                pages: parsed.stats.pages,
                chunkCount: inserted.chunkCount,
                ...chunkStats(chunks),
                embeddingErrors,
                embedding: embeddingMeta,
                faiss,
            },
        }), "INGEST_LEASE_LOST");
        return inserted.documentId;
    }

    async function cleanSuccessFiles(job) {
        await fs.rm(stageDirectory(root, job.id), { recursive: true, force: true });
    }

    async function processClaimedJob(job, holderToken, signal) {
        let current = deps.getIngestJob(scopeFor(job), job.id) || job;
        if (current.parser === "mineru") {
            if (["queued", "failed", "submitting"].includes(current.status)) {
                current = await submitMineru(current, holderToken, signal);
            }
            if (["provider_pending", "provider_running", "provider_converting", "downloading"].includes(current.status)) {
                // ensureMineruZip polls again when a restart left the job at a
                // provider stage; signed URLs are never persisted.
                if (current.status !== "downloading") await ensureMineruZip(current, holderToken, signal);
                current = deps.getIngestJob(scopeFor(current), current.id) || current;
            }
        }
        const parsed = await parseJob(current, holderToken, signal);
        ensureLease(deps.renewIngestLease(current.id, holderToken, { leaseSeconds }), "INGEST_LEASE_LOST");
        const refreshed = deps.getIngestJob(scopeFor(current), current.id) || current;
        await indexJob(refreshed, holderToken, parsed);
        await cleanSuccessFiles(refreshed);
        return true;
    }

    async function runOnce({ signal = null } = {}) {
        if (!knowledgeIngestV2Enabled() || stopping) return { status: "disabled" };
        const effectiveSignal = signal || controller?.signal || null;
        const holderToken = `worker_${now()}_${Math.random().toString(36).slice(2)}`;
        const job = deps.claimNextIngestJob({ leaseSeconds, holderToken });
        if (!job) return { status: "idle" };
        active = { jobId: job.id, holderToken };
        try {
            await processClaimedJob(job, holderToken, effectiveSignal);
            return { status: "ready", jobId: job.id };
        } catch (error) {
            const retryable = Boolean(error?.retryable) || ["MINERU_TIMEOUT", "MINERU_TRANSPORT_ERROR", "MINERU_PROVIDER_RETRYABLE", "ABORTED"].includes(error?.code);
            const errorCode = safeWorkerErrorCode(error);
            deps.failIngestJob(job.id, holderToken, { errorCode, retryable, resultMeta: { stage: job.status, ...(error?.resultMeta || {}) } });
            workerHealth.lastErrorCode = errorCode;
            if (error?.name === "AbortError" || error?.code === "ABORTED") return { status: "aborted", jobId: job.id };
            return { status: "failed", jobId: job.id, errorCode, retryable };
        } finally {
            active = null;
        }
    }

    function start() {
        if (running || stopping || !knowledgeIngestV2Enabled()) return false;
        running = true;
        controller = new AbortController();
        workerHealth.enabled = true;
        workerHealth.status = "running";
        workerHealth.startedAt = new Date().toISOString();
        const tick = async () => {
            if (!running || stopping || ticking) return;
            ticking = true;
            workerHealth.lastTickAt = new Date().toISOString();
            try {
                const result = await runOnce({ signal: controller.signal });
                workerHealth.lastResult = result?.status || null;
                workerHealth.activeJobId = result?.jobId || null;
            } catch (error) {
                workerHealth.lastErrorCode = safeWorkerErrorCode(error);
                console.warn(`[rag][ingest] worker tick failed code=${workerHealth.lastErrorCode}`);
            }
            finally { ticking = false; }
        };
        timer = setInterval(tick, 250);
        void tick();
        return true;
    }

    async function stop() {
        stopping = true;
        running = false;
        if (timer) clearInterval(timer);
        timer = null;
        controller?.abort();
        controller = null;
        workerHealth.status = "stopped";
        workerHealth.activeJobId = null;
        return { stopped: true, activeJobId: active?.jobId || null };
    }

    return { start, stop, runOnce, processClaimedJob, get activeJob() { return active; } };
}

export function startKnowledgeIngestWorker(options = {}) {
    const worker = createIngestWorker(options);
    workerHealth.mode = "inline";
    worker.start();
    return worker;
}

export function getKnowledgeIngestWorkerHealth() {
    return { ...workerHealth, activeJobId: workerHealth.activeJobId || null };
}

export default { createIngestWorker, startKnowledgeIngestWorker, getKnowledgeIngestWorkerHealth, planEmbeddingBatches };
