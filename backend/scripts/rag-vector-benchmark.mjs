/**
 * Offline durable-vector benchmark.
 *
 * This intentionally uses local deterministic vectors and a temporary SQLite
 * file. The JavaScript cosine implementation is a reference full scan; the
 * FAISS path calls IndexFlatIP directly and never calls an embedding provider.
 * IndexFlatIP is exact but exhaustive O(N), not HNSW/IVF or another ANN index.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import Database from "better-sqlite3";

const require = createRequire(import.meta.url);

function parseArgs(argv) {
    const values = { chunks: 1000, dimension: 128, queries: 30, topK: 10 };
    for (const arg of argv) {
        const match = /^--(chunks|dimension|queries|topK)=(\d+)$/.exec(arg);
        if (match) values[match[1]] = Number(match[2]);
    }
    values.chunks = Math.max(1, Math.min(1_000_000, Math.trunc(values.chunks)));
    values.dimension = Math.max(1, Math.min(4096, Math.trunc(values.dimension)));
    values.queries = Math.max(1, Math.min(10_000, Math.trunc(values.queries)));
    values.topK = Math.max(1, Math.min(100, Math.trunc(values.topK)));
    return values;
}

function deterministicVector(index, dimension) {
    const vector = new Array(dimension);
    for (let offset = 0; offset < dimension; offset += 1) {
        vector[offset] = Math.sin((index + 1) * (offset + 1) * 0.017)
            + Math.cos((index + 3) * (offset + 5) * 0.013)
            + ((index + offset) % 17) * 0.0001;
    }
    return vector;
}

function normalize(vector) {
    let squared = 0;
    for (const value of vector) squared += value * value;
    const norm = Math.sqrt(squared) || 1;
    return vector.map((value) => value / norm);
}

function cosine(query, vector) {
    let dot = 0;
    let queryNorm = 0;
    let vectorNorm = 0;
    for (let index = 0; index < query.length; index += 1) {
        dot += query[index] * vector[index];
        queryNorm += query[index] * query[index];
        vectorNorm += vector[index] * vector[index];
    }
    return dot / ((Math.sqrt(queryNorm) || 1) * (Math.sqrt(vectorNorm) || 1));
}

function percentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
    return Number(sorted[index].toFixed(3));
}

function linearTopK(vectors, query, topK) {
    const scored = [];
    for (let index = 0; index < vectors.length; index += 1) {
        scored.push({ id: index + 1, score: cosine(query, vectors[index]) });
    }
    scored.sort((a, b) => b.score - a.score || a.id - b.id);
    return scored.slice(0, Math.min(topK, scored.length));
}

function getFaissModule() {
    try {
        const module = require("faiss-node");
        if (typeof module?.IndexFlatIP !== "function") throw new Error("missing IndexFlatIP");
        return module;
    } catch {
        const error = new Error("FAISS_NATIVE_UNAVAILABLE");
        error.code = "FAISS_NATIVE_UNAVAILABLE";
        throw error;
    }
}

function runBenchmark({ chunks, dimension, queries, topK }) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentevo-rag-vector-bench-"));
    const dbPath = path.join(tempRoot, "embeddings.sqlite");
    const indexPath = path.join(tempRoot, "generation-1.faiss");
    let sqlite = null;
    try {
        sqlite = new Database(dbPath);
        sqlite.exec("CREATE TABLE embeddings (id INTEGER PRIMARY KEY, embedding TEXT NOT NULL)");
        const vectors = new Array(chunks);
        const insert = sqlite.prepare("INSERT INTO embeddings (id, embedding) VALUES (?, ?)");
        const insertAll = sqlite.transaction(() => {
            for (let index = 0; index < chunks; index += 1) {
                vectors[index] = deterministicVector(index, dimension);
                insert.run(index + 1, JSON.stringify(vectors[index]));
            }
        });
        insertAll();
        const sqliteEmbeddingBytes = Number(sqlite.prepare("SELECT SUM(length(embedding)) AS bytes FROM embeddings").get()?.bytes || 0);

        const { IndexFlatIP } = getFaissModule();
        const index = new IndexFlatIP(dimension);
        const buildStarted = performance.now();
        for (let start = 0; start < vectors.length; start += 256) {
            const batch = vectors.slice(start, start + 256).map(normalize);
            const flat = [];
            for (const vector of batch) flat.push(...vector);
            index.add(flat);
        }
        index.write(indexPath);
        const buildMs = performance.now() - buildStarted;

        const loadStarted = performance.now();
        const loaded = IndexFlatIP.read(indexPath);
        const loadMs = performance.now() - loadStarted;
        const faissQueryMs = [];
        const linearQueryMs = [];
        const overlapRatios = [];
        let allExact = true;
        let maxScoreDelta = 0;
        for (let queryIndex = 0; queryIndex < queries; queryIndex += 1) {
            const query = deterministicVector((queryIndex * 37) % chunks, dimension);
            const linearStarted = performance.now();
            const linear = linearTopK(vectors, query, topK);
            linearQueryMs.push(performance.now() - linearStarted);

            const faissStarted = performance.now();
            const result = loaded.search(normalize(query), Math.min(topK, chunks));
            faissQueryMs.push(performance.now() - faissStarted);
            const labels = Array.from(result?.labels || []).map((label) => Number(label) + 1);
            const distances = Array.from(result?.distances || []).map(Number);
            const linearIds = linear.map((row) => row.id);
            const overlap = labels.filter((id) => linearIds.includes(id)).length;
            overlapRatios.push(overlap / Math.max(1, linearIds.length));
            if (labels.length !== linearIds.length || labels.some((id, index) => id !== linearIds[index])) allExact = false;
            const linearById = new Map(linear.map((row) => [row.id, row.score]));
            labels.forEach((id, index) => {
                if (linearById.has(id)) maxScoreDelta = Math.max(maxScoreDelta, Math.abs(linearById.get(id) - distances[index]));
            });
        }
        sqlite.close();
        sqlite = null;
        return {
            status: "ok",
            benchmark: "rag-vector",
            chunks,
            dimension,
            queries,
            topK,
            faiss: {
                executed: true,
                engine: "faiss-node IndexFlatIP",
                metric: "inner product over L2-normalized vectors",
                buildMs: Number(buildMs.toFixed(3)),
                persistentLoadMs: Number(loadMs.toFixed(3)),
                queryP50Ms: percentile(faissQueryMs, 0.5),
                queryP95Ms: percentile(faissQueryMs, 0.95),
                indexBytes: fs.statSync(indexPath).size,
            },
            linearReference: {
                fullScan: true,
                queryP50Ms: percentile(linearQueryMs, 0.5),
                queryP95Ms: percentile(linearQueryMs, 0.95),
            },
            topKComparison: {
                exactForEveryQuery: allExact,
                averageOverlap: Number((overlapRatios.reduce((sum, value) => sum + value, 0) / overlapRatios.length).toFixed(6)),
                minimumOverlap: Number(Math.min(...overlapRatios).toFixed(6)),
                maxCosineScoreDelta: Number(maxScoreDelta.toExponential(6)),
            },
            sqliteEmbeddingBytes,
            embeddingCalls: 0,
            notes: [
                "IndexFlatIP is FAISS-native exact exhaustive O(N) search, not HNSW/IVF/ANN.",
                "Timing is recorded for this machine only; no speed threshold is asserted.",
                "This offline benchmark does not establish complete massive-scale production capacity.",
            ],
        };
    } finally {
        try { sqlite?.close(); } catch { /* best-effort */ }
        try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

const options = parseArgs(process.argv.slice(2));
try {
    console.log(JSON.stringify(runBenchmark(options)));
} catch (error) {
    console.log(JSON.stringify({
        status: "blocked",
        benchmark: "rag-vector",
        faissExecuted: false,
        errorCode: error?.code === "FAISS_NATIVE_UNAVAILABLE" ? "FAISS_NATIVE_UNAVAILABLE" : "FAISS_BENCHMARK_FAILED",
        notes: ["FAISS native runtime was not available; no native path was claimed as passing."],
    }));
    process.exitCode = 2;
}
