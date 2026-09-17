import { beforeEach, describe, expect, it } from "vitest";
import { clearRagFlags } from "./flags.js";
import { retrieveUploadedKnowledge } from "./uploadRetrieval.js";
import { UPLOAD_DOC_PROJECT } from "./projectIds.js";
import { queryKnowledgeBase } from "./index.js";
import { insertDocumentRevision } from "./knowledgeStore.js";
import { clearDurableStoreCache } from "./vectorStoreAdapter.js";

const scope = { userId: 1, tenantId: "team:1" };

function makeStore(rows) {
    return {
        getActiveChunks(requestScope, projectId, { filePath = null } = {}) {
            expect(requestScope).toEqual(scope);
            expect(projectId).toBe(UPLOAD_DOC_PROJECT);
            return rows.filter((row) => filePath == null || row.file_path === filePath);
        },
        getParentChunks() {
            return [{ id: 91, content: "Product handbook parent context", headingPath: ["Guide"], pageStart: 3, pageEnd: 4 }];
        },
    };
}

function makeVectorStore(rows) {
    return {
        similaritySearch(vector, limit, filter) {
            expect(vector).toEqual([1, 0]);
            return rows
                .filter((row) => !filter || filter({ filePath: row.file_path }))
                .slice(0, limit)
                .map((row) => ({
                    chunkId: row.id,
                    documentId: row.document_id,
                    filePath: row.file_path,
                    fileName: row.file_name,
                    content: row.content,
                    parentChunkId: row.parent_chunk_id,
                    pageStart: row.page_start,
                    pageEnd: row.page_end,
                    headingPath: row.headingPath,
                    score: 0.92,
                }));
        },
    };
}

const rows = [
    {
        id: 1,
        document_id: "doc-a",
        file_path: "guide.md",
        file_name: "guide.md",
        chunk_level: "leaf",
        parent_chunk_id: 91,
        page_start: 3,
        page_end: 4,
        headingPath: ["Guide", "Setup"],
        content: "部署 AgentEvo 时使用 durable hybrid retrieval。",
        symbols: "",
        start_line: null,
        end_line: null,
    },
    {
        id: 2,
        document_id: "doc-b",
        file_path: "faq.md",
        file_name: "faq.md",
        chunk_level: "leaf",
        parent_chunk_id: null,
        page_start: 8,
        page_end: 8,
        headingPath: ["FAQ"],
        content: "常见问题与部署说明。",
        symbols: "",
        start_line: null,
        end_line: null,
    },
];

beforeEach(() => clearRagFlags());

describe("uploaded knowledge K5 retrieval facade", () => {
    it("uses lexical + vector evidence and emits page/heading citations", async () => {
        const result = await retrieveUploadedKnowledge({
            scope,
            query: "durable retrieval",
            deps: {
                store: makeStore(rows),
                embedder: { embed: async () => [[1, 0]] },
                vectorStore: makeVectorStore(rows),
            },
        });

        expect(result.status).toBe("ok");
        expect(result.mode).toBe("hybrid");
        expect(result.items[0].fileName).toBe("guide.md");
        expect(result.items[0].parentContent).toContain("parent context");
        expect(result.text).toContain("[1] guide.md p.3-4 · Guide > Setup");
    });

    it("emits the persisted PDF page range without fabricating a zero page", async () => {
        const pdfRows = rows.map((row) => row.id === 1
            ? { ...row, file_path: "guide.pdf", file_name: "guide.pdf" }
            : row);
        const result = await retrieveUploadedKnowledge({
            scope,
            query: "durable retrieval",
            deps: {
                store: makeStore(pdfRows),
                embedder: null,
                vectorStore: null,
            },
        });

        expect(result.status).toBe("ok");
        expect(result.text).toContain("[1] guide.pdf p.3-4 · Guide > Setup");
        expect(result.text).not.toContain("0-0");
    });

    it("falls back to lexical evidence when vector search fails", async () => {
        const result = await retrieveUploadedKnowledge({
            scope,
            query: "durable retrieval",
            deps: {
                store: makeStore(rows),
                embedder: { embed: async () => [[1, 0]] },
                vectorStore: { similaritySearch: () => { throw Object.assign(new Error("vector down"), { code: "VECTOR_DOWN" }); } },
            },
        });

        expect(result.status).toBe("ok");
        expect(result.mode).toBe("lexical");
        expect(result.metrics.embeddingError).toBe("VECTOR_DOWN");
        expect(result.items[0].lexicalScore).toBeGreaterThan(0);
    });

    it("applies preferred source as a bounded server-side document filter", async () => {
        const result = await retrieveUploadedKnowledge({
            scope,
            query: "部署说明",
            preferredSource: "C:\\uploads\\faq.md",
            deps: {
                store: makeStore(rows),
                embedder: null,
                vectorStore: null,
            },
        });

        expect(result.metrics.preferredSource).toBe("faq.md");
        expect(result.items.every((item) => item.filePath === "faq.md")).toBe(true);
    });

    it("returns no_match when candidates do not carry raw evidence", async () => {
        const result = await retrieveUploadedKnowledge({
            scope,
            query: "missing term",
            deps: {
                store: makeStore(rows),
                embedder: { embed: async () => [[1, 0]] },
                vectorStore: { similaritySearch: async () => [{ chunkId: 99, filePath: "ghost.md", content: "unrelated", score: 0.1 }] },
            },
        });

        expect(result.status).toBe("no_match");
        expect(result.items).toHaveLength(0);
        expect(result.metrics.rawEvidenceRequired).toBe(true);
    });

    it("serves the durable upload path through queryKnowledgeBase when the canary is on", async () => {
        insertDocumentRevision({
            scope: { userId: 1, tenantId: "user:1" },
            projectId: UPLOAD_DOC_PROJECT,
            docType: "upload",
            filePath: "durable-guide.md",
            fileName: "durable-guide.md",
            fileHash: "k5-test-hash",
            chunks: [{
                chunkIndex: 0,
                content: "durable restart retrieval guide",
                contentHash: "k5-chunk-hash",
                embedding: [1, 0],
                pageStart: 2,
                pageEnd: 2,
                headingPath: ["Guide"],
            }],
        });
        clearDurableStoreCache();
        process.env.RAG_DURABLE_ENABLED = "true";
        process.env.DURABLE_RAG_READ = "true";

        const response = await queryKnowledgeBase("restart retrieval", 1);
        const parsed = JSON.parse(response);
        expect(parsed.status).toBe("ok");
        expect(parsed.source).toBe("durable");
        expect(parsed.text).toContain("[1] durable-guide.md p.2 · Guide");
    });

    it("applies K6 rerank and compression only when their flags are enabled", async () => {
        process.env.RAG_RERANK_ENABLED = "true";
        process.env.RAG_CONTEXT_COMPRESSION_ENABLED = "true";
        const result = await retrieveUploadedKnowledge({
            scope,
            query: "部署",
            deps: {
                store: makeStore(rows),
                embedder: null,
                vectorStore: null,
                reranker: async ({ candidates }) => candidates
                    .slice()
                    .reverse()
                    .map((item, index) => ({ chunkId: String(item.chunkId), relevance: 1 - index * 0.1 })),
            },
            opts: { perChunkChars: 32, totalContextChars: 40 },
        });

        expect(result.metrics.rerankEnabled).toBe(true);
        expect(result.metrics.rerankApplied).toBe(true);
        expect(result.metrics.compression.enabled).toBe(true);
        expect(result.items[0].chunkId).toBe(2);
        expect(result.items[0].compressedContent.length).toBeLessThanOrEqual(32);
    });

    it("keeps the original query while adding one injected rewrite", async () => {
        process.env.RAG_QUERY_REWRITE_ENABLED = "true";
        let rewriteCalls = 0;
        const result = await retrieveUploadedKnowledge({
            scope,
            query: "怎么部署",
            deps: {
                store: makeStore(rows),
                embedder: null,
                vectorStore: null,
                queryRewriter: async ({ query }) => {
                    rewriteCalls += 1;
                    expect(query).toBe("怎么部署");
                    return { rewrite: "AgentEvo durable hybrid retrieval" };
                },
            },
        });

        expect(rewriteCalls).toBe(1);
        expect(result.metrics.rewrite).toMatchObject({ applied: true, calls: 1 });
        expect(result.metrics.queryCount).toBe(2);
        expect(result.status).toBe("ok");
    });
});
