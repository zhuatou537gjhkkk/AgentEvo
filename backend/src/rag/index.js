import fs from "fs";
import multer from "multer";
import path from "path";
import { OpenAIEmbeddings } from "@langchain/openai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { FaissStore } from "@langchain/community/vectorstores/faiss";
import { withRetry } from "../services/resilience.js";

const tenantStores = new Map();

function pruneTenantStores() {
    const maxEntries = Math.max(1, Number(process.env.RAG_MAX_TENANT_STORES) || 100);
    while (tenantStores.size > maxEntries) {
        tenantStores.delete(tenantStores.keys().next().value);
    }
}

function getTenantStore(userId = null) {
    const tenantId = Number(userId);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
        throw new Error("knowledge base requires an authenticated user");
    }
    if (!tenantStores.has(tenantId)) {
        tenantStores.set(tenantId, {
            vectorStore: null,
            latestUploadedSource: null,
            activeLargeFile: null,
            knowledgeChunks: [],
            knowledgeMetadatas: [],
            indexedFiles: new Set(),
        });
        pruneTenantStores();
    }
    return tenantStores.get(tenantId);
}

export function getActiveLargeFile(userId = null) {
    if (userId == null) throw new Error("knowledge base requires an authenticated user");
    return getTenantStore(userId).activeLargeFile;
}

// Legacy compatibility snapshot; authenticated request paths must use getActiveLargeFile(userId).
export let activeLargeFile = null;
const LARGE_FILE_THRESHOLD_BYTES = 500 * 1024;
const DEFAULT_TOP_K = 5;
const DEFAULT_RETURN_K = 3;
const DEFAULT_MAX_SCORE = Number(
    process.env.RAG_MAX_SCORE ?? Number.POSITIVE_INFINITY
);
const DEFAULT_EMBED_BATCH_SIZE = 25;
const MAX_EMBED_BATCH_SIZE = 25;
const EMBED_BATCH_SIZE = Math.min(
    Number(process.env.RAG_EMBED_BATCH_SIZE) || DEFAULT_EMBED_BATCH_SIZE,
    MAX_EMBED_BATCH_SIZE
);
const SUPPORTED_FILE_EXTENSIONS = new Set([".txt", ".md"]);

function getFileExtension(fileName) {
    return path.extname(String(fileName || "")).toLowerCase();
}

export function isSupportedKnowledgeFileName(fileName) {
    return SUPPORTED_FILE_EXTENSIONS.has(getFileExtension(fileName));
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (isSupportedKnowledgeFileName(file?.originalname)) {
            cb(null, true);
            return;
        }

        cb(new Error("仅支持上传 .txt 或 .md 文件"));
    }
});

// C1 预算统一（W4-R3/R5）：LangChain/OpenAI SDK 内建 maxRetries 置 0，
// withRetry 是唯一的重试预算层 —— 否则 SDK 默认 2 次重试会与下方 withRetry 叠乘。
const embeddings = new OpenAIEmbeddings({
    modelName: process.env.OPENAI_EMBEDDING_MODEL || "qwen3.7-text-embedding",
    model: process.env.OPENAI_EMBEDDING_MODEL || "qwen3.7-text-embedding",
    batchSize: EMBED_BATCH_SIZE,
    maxRetries: 0,
    configuration: {
        apiKey: process.env.OPENAI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || process.env.DASHSCOPE_API_KEY,
        baseURL: process.env.OPENAI_EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || process.env.DASHSCOPE_BASE_URL
    }
});

export const uploadMiddleware = upload.single("file");

export function getLatestUploadedSource(userId) {
    return getTenantStore(userId).latestUploadedSource;
}

async function processAndStoreText(text, fileName, userId, sizeBytes) {
    const store = getTenantStore(userId);
    const normalizedText = String(text || "").trim();
    if (!normalizedText) throw new Error("empty document");

    store.latestUploadedSource = fileName;
    const documentSize = Number.isInteger(sizeBytes) ? sizeBytes : Buffer.byteLength(normalizedText, "utf8");

    if (documentSize > LARGE_FILE_THRESHOLD_BYTES) {
        store.indexedFiles.add(fileName);
        store.activeLargeFile = {
            fileName,
            content: normalizedText,
            sizeBytes: documentSize,
            updatedAt: new Date().toISOString()
        };
        activeLargeFile = store.activeLargeFile;
        return { fileName, mode: "long_context", sizeBytes: documentSize, totalFiles: store.indexedFiles.size };
    }

    store.activeLargeFile = null;
    activeLargeFile = null;
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 500, chunkOverlap: 50 });
    const chunks = await splitter.splitText(normalizedText);
    if (chunks.length === 0) throw new Error("document cannot be split into valid chunks");

    const metadata = chunks.map(() => ({
        source: fileName,
        uploadedAt: new Date().toISOString(),
        cwdExists: fs.existsSync(process.cwd())
    }));
    store.knowledgeChunks.push(...chunks);
    store.knowledgeMetadatas.push(...metadata);
    store.indexedFiles.add(fileName);
    const documents = chunks.map((chunk, index) => ({ pageContent: chunk, metadata: metadata[index] }));
    // W4-R5 (T1)：索引期 embedding 推理是网络调用，包 withRetry（预算层唯一，见上方
    // embeddings maxRetries:0）。耗尽后异常上抛 → 上传路径按失败处理（清理临时文件并
    // 释放 reservation），provider 细节不会离开本模块的调用方错误封装。
    if (!store.vectorStore) {
        store.vectorStore = await withRetry(
            () => FaissStore.fromTexts(chunks, metadata, embeddings),
            { retries: 2 }
        );
    } else {
        await withRetry(
            () => store.vectorStore.addDocuments(documents),
            { retries: 2 }
        );
    }
    return { fileName, mode: "vector", chunkCount: chunks.length, totalChunks: store.knowledgeChunks.length, totalFiles: store.indexedFiles.size };
}

export async function processAndStoreDocument(fileBuffer, fileName, userId) {
    if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) throw new Error("invalid file buffer");
    if (!isSupportedKnowledgeFileName(fileName)) throw new Error("仅支持上传 .txt 或 .md 文件");
    return processAndStoreText(fileBuffer.toString("utf-8"), fileName, userId, fileBuffer.length);
}

/**
 * File-path compatibility entry used by chunked merge. The file is decoded
 * incrementally, so the HTTP handler never materializes a second full Buffer.
 * The current splitter/vector store still retains document text in memory.
 */
export async function processAndStoreDocumentFile(filePath, fileName, userId, { sizeBytes } = {}) {
    if (!isSupportedKnowledgeFileName(fileName)) throw new Error("仅支持上传 .txt 或 .md 文件");
    const stream = fs.createReadStream(filePath);
    const parts = [];
    await new Promise((resolve, reject) => {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => parts.push(chunk));
        stream.once("error", reject);
        stream.once("end", resolve);
    });
    return processAndStoreText(parts.join(""), fileName, userId, Number(sizeBytes));
}

export async function queryKnowledgeBase(query, userId = null) {
    if (userId == null) throw new Error("knowledge base requires an authenticated user");
    const evidence = await retrieveKnowledgeEvidence(query, { userId });

    if (evidence.status === "empty") {
        return "当前知识库为空";
    }

    if (evidence.status === "no_match") {
        return "未检索到相关知识片段";
    }

    return JSON.stringify({
        status: "ok",
        items: evidence.items
    });
}

export async function retrieveKnowledgeEvidence(
    query,
    options = {}
) {
    const store = getTenantStore(options.userId);
    if (!store.vectorStore) {
        return {
            status: "empty",
            items: []
        };
    }

    const topK = options.topK ?? DEFAULT_TOP_K;
    const returnK = options.returnK ?? DEFAULT_RETURN_K;
    const maxScore = options.maxScore ?? DEFAULT_MAX_SCORE;
    const preferredSource = String(options.preferredSource || "").trim();
    const searchTopK = preferredSource
        ? Math.max(topK, DEFAULT_TOP_K * 4)
        : topK;
    // W4-R5 (T1)：similaritySearch 会触发 embedding 推理（网络调用），包 withRetry 使
    // 请求路径上的瞬态上游故障自动重试；耗尽后异常上抛，由调用方（search_knowledge_base
    // 工具 / knowledgeAgent 节点）按既有降级路径转成"知识库检索出错"类公开结果。
    const docsWithScore = await withRetry(
        () => store.vectorStore.similaritySearchWithScore(query, searchTopK),
        { retries: 2 }
    );

    const scorePreview = docsWithScore
        .map(([, score]) => Number(score))
        .filter((score) => Number.isFinite(score))
        .slice(0, searchTopK)
        .map((score) => score.toFixed(4));
    console.log(
        `[rag][scores] query=${JSON.stringify(query)} top=${scorePreview.join(", ")} maxScore=${maxScore} preferredSource=${preferredSource || "none"}`
    );

    const normalized = docsWithScore
        .map(([doc, score]) => ({
            source: doc?.metadata?.source || "unknown",
            content: doc?.pageContent || "",
            score: Number(score)
        }))
        .filter((item) => item.content && Number.isFinite(item.score))
        .sort((a, b) => a.score - b.score);

    const preferredItems = preferredSource
        ? normalized.filter((item) => item.source === preferredSource)
        : normalized;
    const candidateItems = preferredItems.length > 0
        ? preferredItems
        : normalized;

    const filtered = Number.isFinite(maxScore)
        ? candidateItems
            .filter((item) => item.score <= maxScore)
            .slice(0, returnK)
        : candidateItems.slice(0, returnK);

    if (filtered.length === 0) {
        return {
            status: "no_match",
            items: []
        };
    }

    return {
        status: "ok",
        items: filtered
    };
}
