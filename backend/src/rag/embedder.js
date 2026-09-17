/**
 * Phase 7 / R4 — embedder seam (roadmap R4 checklist #6).
 *
 * Retrievers and the indexer never construct a provider embedding client
 * directly; they consume the seam returned here:
 *
 *   { dimension: number|null, embed(texts) → number[][], embedOne(text) }
 *
 * Two implementations:
 *   - createFakeEmbedder — deterministic, content-sensitive pseudo-embeddings
 *     used in unit tests / offline drills. Vectors are a bag of hashed
 *     character n-grams (FNV-1a) normalised to unit length, so texts sharing
 *     substrings land closer together and cosine similarity ranks meaningfully
 *     with zero network.
 *   - createOpenAiEmbedder — lazily builds an @langchain/openai
 *     OpenAIEmbeddings instance mirroring src/rag/index.js configuration
 *     (apiKey/baseURL fallback chain, maxRetries: 0) and wraps each embed with
 *     withRetry as the single retry layer (C1 budget rule). Never constructed
 *     in unit tests; `dimension` stays null until a real client reports it.
 */
import { OpenAIEmbeddings } from "@langchain/openai";
import { withRetry } from "../services/resilience.js";

const OPENAI_EMBEDDING_MODEL = "qwen3.7-text-embedding";
const DEFAULT_MAX_BATCH_CHARS = 12_000;
const DEFAULT_EMBED_TIMEOUT_MS = 30_000;

function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

function hashVector(text, dimension) {
    const v = new Array(dimension).fill(0);
    const s = String(text ?? "").toLowerCase();
    if (s.length === 0) return v;
    // word-level features (identifier-like tokens)
    for (const m of s.matchAll(/[a-z0-9]{2,}/g)) {
        v[fnv1a(m[0]) % dimension] += 1;
    }
    // overlapping trigram features capture substring sharing
    for (let i = 0; i + 3 <= s.length; i += 1) {
        v[fnv1a(s.slice(i, i + 3)) % dimension] += 1;
    }
    // character bigrams catch short shared fragments
    for (let i = 0; i + 2 <= s.length; i += 1) {
        v[fnv1a(s.slice(i, i + 2)) % dimension] += 1;
    }
    const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0)) || 1;
    for (let i = 0; i < v.length; i += 1) v[i] = v[i] / norm;
    return v;
}

/**
 * Deterministic offline embedder. Same text → identical vector on every call
 * and across processes (FNV-1a + pure arithmetic); n-gram sharing → higher
 * cosine. `hashDimension` controls whether n-grams are modulo-hashed into the
 * requested dimension (true, default — vector length always equals dimension)
 * or compacted to the number of distinct n-grams actually observed (false —
 * still deterministic per text, but length varies by vocabulary size).
 */
export function createFakeEmbedder({ dimension = 16, hashDimension = true } = {}) {
    const dim = Math.max(2, Math.trunc(Number(dimension) || 16));
    function embedOne(text) {
        if (hashDimension === false) {
            const s = String(text ?? "").toLowerCase();
            const features = [];
            for (const m of s.matchAll(/[a-z0-9]{2,}/g)) features.push(m[0]);
            for (let i = 0; i + 3 <= s.length; i += 1) features.push(s.slice(i, i + 3));
            const counts = new Map();
            for (const f of features) counts.set(f, (counts.get(f) || 0) + 1);
            const arr = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            const len = arr.length;
            const v = new Array(len).fill(0);
            let index = 0;
            for (const f of arr) v[index++] = f[1];
            const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0)) || 1;
            return v.map((x) => x / norm);
        }
        return hashVector(text, dim);
    }
    return {
        dimension: hashDimension === false ? null : dim,
        async embed(texts) {
            const list = Array.isArray(texts) ? texts : [texts];
            return list.map((t) => embedOne(t));
        },
        async embedOne(text) {
            return embedOne(text);
        },
    };
}

function resolveApiKey() {
    return process.env.OPENAI_EMBEDDING_API_KEY
        || process.env.OPENAI_API_KEY
        || process.env.DASHSCOPE_API_KEY;
}

function resolveBaseUrl() {
    return process.env.OPENAI_EMBEDDING_BASE_URL
        || process.env.OPENAI_BASE_URL
        || process.env.DASHSCOPE_BASE_URL;
}

/**
 * Lazy OpenAI-compatible embedder. The client is constructed on first embed()
 * so importing this module (and unit tests that only use the fake) never
 * touches the network or provider config.
 */
export function createOpenAiEmbedder({
    modelName = process.env.OPENAI_EMBEDDING_MODEL || OPENAI_EMBEDDING_MODEL,
    batchSize = 25,
    maxBatchChars = Number(process.env.RAG_EMBED_BATCH_MAX_CHARS) || DEFAULT_MAX_BATCH_CHARS,
    timeoutMs = Number(process.env.RAG_EMBED_TIMEOUT_MS) || DEFAULT_EMBED_TIMEOUT_MS,
} = {}) {
    const name = String(modelName || OPENAI_EMBEDDING_MODEL);
    const size = Math.max(1, Math.min(100, Number(batchSize) || 25));
    const charLimit = Math.max(1_000, Math.min(50_000, Number(maxBatchChars) || DEFAULT_MAX_BATCH_CHARS));
    const safeTimeout = Math.max(1_000, Math.min(120_000, Number(timeoutMs) || DEFAULT_EMBED_TIMEOUT_MS));
    let client = null;
    const ensureClient = () => {
        if (client) return client;
        // C1 budget rule: SDK-internal maxRetries is 0, withRetry below is the
        // single retry layer (mirrors src/rag/index.js configuration chain).
        client = new OpenAIEmbeddings({
            modelName: name,
            model: name,
            batchSize: size,
            maxRetries: 0,
            configuration: {
                apiKey: resolveApiKey(),
                baseURL: resolveBaseUrl(),
            },
            timeout: safeTimeout,
        });
        return client;
    };
    return {
        dimension: null,
        async embed(texts) {
            const list = (Array.isArray(texts) ? texts : [texts]).map(String);
            const vectors = [];
            for (let start = 0; start < list.length;) {
                let end = start;
                let chars = 0;
                while (end < list.length && (end === start || (end - start < size && chars + list[end].length <= charLimit))) {
                    chars += list[end].length;
                    end += 1;
                }
                const batch = list.slice(start, end);
                const result = await withRetry(
                    () => ensureClient().embedDocuments(batch),
                    { retries: 2, deadlineMs: safeTimeout },
                );
                if (!Array.isArray(result) || result.length !== batch.length) {
                    throw Object.assign(new Error("embedding response count mismatch"), { code: "EMBEDDING_RESPONSE_MISMATCH" });
                }
                vectors.push(...result);
                start = end;
            }
            return vectors;
        },
        async embedOne(text) {
            const [vector] = await this.embed([text]);
            return vector;
        },
    };
}

export { DEFAULT_MAX_BATCH_CHARS, DEFAULT_EMBED_TIMEOUT_MS };
export default { createFakeEmbedder, createOpenAiEmbedder, fnv1a };
