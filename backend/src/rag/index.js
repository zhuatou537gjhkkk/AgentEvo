import fs from "fs";
import multer from "multer";
import path from "path";
import { OpenAIEmbeddings } from "@langchain/openai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { FaissStore } from "@langchain/community/vectorstores/faiss";

let vectorStore = null;
let latestUploadedSource = null;
export let activeLargeFile = null;
const knowledgeChunks = [];
const knowledgeMetadatas = [];
const indexedFiles = new Set();
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
    fileFilter: (req, file, cb) => {
        if (isSupportedKnowledgeFileName(file?.originalname)) {
            cb(null, true);
            return;
        }

        cb(new Error("仅支持上传 .txt 或 .md 文件"));
    }
});

const embeddings = new OpenAIEmbeddings({
    modelName: process.env.OPENAI_EMBEDDING_MODEL || "qwen3.7-text-embedding",
    model: process.env.OPENAI_EMBEDDING_MODEL || "qwen3.7-text-embedding",
    batchSize: EMBED_BATCH_SIZE,
    configuration: {
        apiKey: process.env.OPENAI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || process.env.DASHSCOPE_API_KEY,
        baseURL: process.env.OPENAI_EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || process.env.DASHSCOPE_BASE_URL
    }
});

export const uploadMiddleware = upload.single("file");

export function getLatestUploadedSource() {
    return latestUploadedSource;
}

export async function processAndStoreDocument(fileBuffer, fileName) {
    if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
        throw new Error("invalid file buffer");
    }

    if (!isSupportedKnowledgeFileName(fileName)) {
        throw new Error("仅支持上传 .txt 或 .md 文件");
    }

    const text = fileBuffer.toString("utf-8").trim();

    if (!text) {
        throw new Error("empty document");
    }

    latestUploadedSource = fileName;

    if (fileBuffer.length > LARGE_FILE_THRESHOLD_BYTES) {
        indexedFiles.add(fileName);
        activeLargeFile = {
            fileName,
            content: text,
            sizeBytes: fileBuffer.length,
            updatedAt: new Date().toISOString()
        };

        return {
            fileName,
            mode: "long_context",
            sizeBytes: fileBuffer.length,
            totalFiles: indexedFiles.size
        };
    }

    activeLargeFile = null;

    const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 500,
        chunkOverlap: 50
    });

    const chunks = await splitter.splitText(text);

    if (chunks.length === 0) {
        throw new Error("document cannot be split into valid chunks");
    }

    const metadata = chunks.map(() => ({
        source: fileName,
        uploadedAt: new Date().toISOString(),
        cwdExists: fs.existsSync(process.cwd())
    }));

    knowledgeChunks.push(...chunks);
    knowledgeMetadatas.push(...metadata);
    indexedFiles.add(fileName);

    const documents = chunks.map((chunk, index) => ({
        pageContent: chunk,
        metadata: metadata[index]
    }));

    if (!vectorStore) {
        vectorStore = await FaissStore.fromTexts(
            chunks,
            metadata,
            embeddings
        );
    } else {
        await vectorStore.addDocuments(documents);
    }

    return {
        fileName,
        mode: "vector",
        chunkCount: chunks.length,
        totalChunks: knowledgeChunks.length,
        totalFiles: indexedFiles.size
    };
}

export async function queryKnowledgeBase(query) {
    const evidence = await retrieveKnowledgeEvidence(query);

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
    if (!vectorStore) {
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
    const docsWithScore = await vectorStore.similaritySearchWithScore(query, searchTopK);

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
