/**
 * User-memory vector recall.
 *
 * This is deliberately separate from project/document RAG storage. User
 * memories keep their owner and lifecycle boundary in agent_memory; this
 * module only adds an optional cosine candidate source for active rows.
 */
import { createHash } from "node:crypto";
import { updateMemoryEmbedding } from "../db/index.js";
import { createOpenAiEmbedder } from "../rag/embedder.js";
import { InMemoryVectorStore } from "../rag/vectorStoreAdapter.js";

const DEFAULTS = Object.freeze({
    topK: 8,
    vectorWeight: 0.35,
    model: process.env.OPENAI_EMBEDDING_MODEL || "qwen3.7-text-embedding",
});

const indexCache = new Map();
let defaultEmbedder = null;

function bounded(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

export function memoryVectorRecallConfig(overrides = {}) {
    return {
        topK: Math.round(bounded(overrides.topK ?? process.env.MEMORY_VECTOR_RECALL_TOP_K, DEFAULTS.topK, 1, 50)),
        vectorWeight: bounded(overrides.vectorWeight ?? process.env.MEMORY_VECTOR_RECALL_WEIGHT, DEFAULTS.vectorWeight, 0, 1),
        model: String(overrides.model ?? process.env.MEMORY_VECTOR_RECALL_MODEL ?? DEFAULTS.model),
    };
}

export function memoryContentHash(content) {
    return createHash("sha256").update(String(content || "")).digest("hex");
}

function parseEmbedding(value) {
    if (Array.isArray(value)) return value.map((item) => Number(item) || 0);
    if (typeof value !== "string" || value.trim() === "") return null;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map((item) => Number(item) || 0) : null;
    } catch {
        return null;
    }
}

function normalizeScore(value) {
    const score = Number(value);
    if (!Number.isFinite(score)) return 0;
    // Cosine is [-1, 1]; embeddings normally produce a non-negative score,
    // but mapping the full range keeps the contract stable for test adapters.
    return Math.max(0, Math.min(1, (score + 1) / 2));
}

function getDefaultEmbedder(model) {
    if (!defaultEmbedder || defaultEmbedder.model !== model) {
        defaultEmbedder = { model, value: createOpenAiEmbedder({ modelName: model }) };
    }
    return defaultEmbedder.value;
}

class UserMemoryVectorIndex {
    constructor(userId) {
        this.userId = Number(userId);
        this.store = new InMemoryVectorStore({ projectId: `user-memory:${this.userId}` });
        this.signatures = new Map();
    }

    async sync(rows, { embedder, model }) {
        const activeRows = (Array.isArray(rows) ? rows : [])
            .filter((row) => row?.status === "active" && Number(row.id) > 0 && String(row.content || "").trim());
        const activeIds = new Set(activeRows.map((row) => Number(row.id)));

        for (const [id] of this.signatures) {
            if (!activeIds.has(id)) {
                this.store.removeByDocument(id);
                this.signatures.delete(id);
            }
        }

        const missing = [];
        for (const row of activeRows) {
            const id = Number(row.id);
            const sourceHash = memoryContentHash(row.content);
            const signature = `${sourceHash}:${row.embedding_model || model}`;
            if (this.signatures.get(id) === signature) continue;

            this.store.removeByDocument(id);
            const persisted = parseEmbedding(row.embedding);
            if (persisted && row.embedding_source_hash === sourceHash && row.embedding_model === model) {
                this.store.addVectors([{
                    id,
                    documentId: id,
                    content: row.content,
                    vector: persisted,
                }]);
                this.signatures.set(id, signature);
                continue;
            }
            missing.push({ row, sourceHash, signature });
        }

        if (missing.length > 0) {
            const vectors = await embedder.embed(missing.map(({ row }) => row.content));
            for (let index = 0; index < missing.length; index += 1) {
                const { row, sourceHash, signature } = missing[index];
                const vector = vectors[index];
                if (!Array.isArray(vector) || vector.length === 0) continue;
                this.store.addVectors([{
                    id: row.id,
                    documentId: row.id,
                    content: row.content,
                    vector,
                }]);
                this.signatures.set(Number(row.id), signature);
                updateMemoryEmbedding(this.userId, row.id, vector, model, sourceHash);
            }
        }

        return {
            active: activeRows.length,
            indexed: this.signatures.size,
            embedded: missing.length,
        };
    }

    async search(query, rows, config, embedder) {
        const sync = await this.sync(rows, { embedder, model: config.model });
        const queryVector = await embedder.embedOne(query);
        const hits = this.store.similaritySearch(queryVector, config.topK);
        return {
            hits: hits.map((hit) => ({ id: Number(hit.chunkId), vectorScore: normalizeScore(hit.score) })),
            sync,
        };
    }
}

function getIndex(userId) {
    const key = String(Number(userId));
    if (!indexCache.has(key)) indexCache.set(key, new UserMemoryVectorIndex(userId));
    return indexCache.get(key);
}

/**
 * Return vector candidates for one owner. The caller is responsible for
 * intersecting the result with serialized active memory rows.
 */
export async function retrieveMemoryVectorCandidates({ userId, query, rows = [], options = {} } = {}) {
    const text = String(query || "").trim();
    if (!text || !Array.isArray(rows) || rows.length === 0) {
        return { enabled: true, hits: [], error: null, sync: null, mode: "vector" };
    }

    const config = memoryVectorRecallConfig(options);
    const embedder = options.embedder || getDefaultEmbedder(config.model);
    try {
        const result = await getIndex(userId).search(text, rows, config, embedder);
        return { enabled: true, ...result, error: null, mode: "vector" };
    } catch (error) {
        return {
            enabled: true,
            hits: [],
            sync: null,
            error: error?.code || error?.message || "MEMORY_VECTOR_RECALL_FAILED",
            mode: "vector",
        };
    }
}

export function clearMemoryVectorRecallCache() {
    indexCache.clear();
    defaultEmbedder = null;
}

export default {
    memoryVectorRecallConfig,
    memoryContentHash,
    retrieveMemoryVectorCandidates,
    clearMemoryVectorRecallCache,
};
