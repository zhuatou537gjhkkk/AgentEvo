import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { knowledgeIngestV2Enabled, mineruParserEnabled } from "./flags.js";
import {
    createIngestJob,
    findDuplicateIngestJob,
    getIngestJob,
    cancelIngestJob,
    retryIngestJob,
} from "./ingestStore.js";

const NATIVE_EXTENSIONS = new Set([".txt", ".md"]);
const MINERU_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);

function storageRoot(explicitRoot) {
    return path.resolve(explicitRoot || process.env.KNOWLEDGE_INGEST_STORAGE_ROOT || path.join(process.cwd(), "tmp", "knowledge-ingest"));
}

function safeFileName(fileName) {
    const base = path.basename(String(fileName || "")).replace(/[\u0000-\u001f]/g, "_").trim();
    if (!base || base === "." || base === "..") {
        const error = new Error("file name is required");
        error.code = "INGEST_FILE_NAME_INVALID";
        throw error;
    }
    return base.slice(0, 240);
}

function ext(fileName) {
    return path.extname(fileName).toLowerCase();
}

function chooseParser(fileName) {
    const extension = ext(fileName);
    if (NATIVE_EXTENSIONS.has(extension)) return { parser: "native", parserVersion: "native-v1" };
    if (MINERU_EXTENSIONS.has(extension)) {
        if (!mineruParserEnabled()) {
            const error = new Error("MinerU parser is disabled");
            error.code = "MINERU_PARSER_DISABLED";
            error.statusCode = 403;
            throw error;
        }
        return { parser: "mineru", parserVersion: "mineru-api-v4" };
    }
    const error = new Error("unsupported knowledge file type");
    error.code = "INGEST_FILE_TYPE_UNSUPPORTED";
    error.statusCode = 400;
    throw error;
}

async function hashFile(filePath) {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
}

function resolveStoragePath(root, storageKey) {
    const rootPath = path.resolve(root);
    const target = path.resolve(rootPath, String(storageKey || ""));
    const relative = path.relative(rootPath, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        const error = new Error("ingest storage path escapes configured root");
        error.code = "INGEST_STORAGE_PATH_INVALID";
        throw error;
    }
    return target;
}

export async function createKnowledgeIngestJob({
    scope,
    sourcePath,
    fileName,
    mimeType = "application/octet-stream",
    fileHash = null,
    sizeBytes = null,
    projectId = "uploaded-documents",
    sourceSessionId = null,
    options = {},
    storageRoot: rootOverride,
} = {}) {
    if (!knowledgeIngestV2Enabled()) {
        const error = new Error("knowledge ingest v2 is disabled");
        error.code = "KNOWLEDGE_INGEST_DISABLED";
        error.statusCode = 403;
        throw error;
    }
    const safeName = safeFileName(fileName);
    const selected = chooseParser(safeName);
    const root = storageRoot(rootOverride);
    const source = path.resolve(String(sourcePath || ""));
    const stat = await fsp.stat(source);
    if (!stat.isFile()) {
        const error = new Error("ingest source is not a regular file");
        error.code = "INGEST_SOURCE_INVALID";
        throw error;
    }
    const hash = String(fileHash || "").trim() || await hashFile(source);
    const bytes = sizeBytes == null ? stat.size : Number(sizeBytes);
    const duplicate = findDuplicateIngestJob(scope, { projectId, fileHash: hash, parser: selected.parser, options });
    if (duplicate) return { job: duplicate, unchanged: duplicate.status === "ready", deduplicated: true };

    const tempId = crypto.randomUUID();
    const tempKey = `.staging/${tempId}.upload`;
    const tempPath = resolveStoragePath(root, tempKey);
    await fsp.mkdir(path.dirname(tempPath), { recursive: true });
    await fsp.copyFile(source, tempPath);
    const jobId = `ing_${crypto.randomUUID()}`;
    const storageKey = `jobs/${jobId}/source${ext(safeName)}`;
    const finalPath = resolveStoragePath(root, storageKey);
    try {
        await fsp.mkdir(path.dirname(finalPath), { recursive: true });
        await fsp.rename(tempPath, finalPath);
        const job = createIngestJob({
            scope, id: jobId, projectId, sourceSessionId, fileName: safeName,
            storageKey, mimeType, fileHash: hash, sizeBytes: Math.max(0, bytes) || stat.size,
            parser: selected.parser, parserVersion: selected.parserVersion, options,
        });
        return { job, unchanged: false, deduplicated: false };
    } catch (error) {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        await fsp.rm(finalPath, { force: true }).catch(() => {});
        throw error;
    }
}

export function getKnowledgeIngestJob(scope, jobId) {
    return getIngestJob(scope, jobId);
}

export function cancelKnowledgeIngestJob(scope, jobId, options) {
    return cancelIngestJob(scope, jobId, options);
}

export function retryKnowledgeIngestJob(scope, jobId) {
    return retryIngestJob(scope, jobId);
}

export function getIngestStoragePath(job, { storageRoot: rootOverride } = {}) {
    return resolveStoragePath(storageRoot(rootOverride), job?.storage_key || job?.storageKey);
}

export function getIngestStorageRoot(rootOverride) {
    return storageRoot(rootOverride);
}

export default { createKnowledgeIngestJob, getKnowledgeIngestJob, cancelKnowledgeIngestJob, retryKnowledgeIngestJob, getIngestStoragePath, getIngestStorageRoot };
