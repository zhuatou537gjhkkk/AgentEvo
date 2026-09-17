import { afterEach, describe, expect, it } from "vitest";
import {
    clearRagFlags,
    durableRagEnabled,
    durableRagReadCanary,
    knowledgeIngestV2Enabled,
    mineruParserEnabled,
    projectMemoryEnabled,
    projectRagEnabled,
    ragContextCompressionEnabled,
    ragCrossSourceCoordinatorEnabled,
    ragContextualQueryRewriteEnabled,
    ragFaissEnabled,
    ragFaissReadEnabled,
    ragFaissCompareEnabled,
    ragQueryRewriteEnabled,
    ragRerankEnabled,
    knowledgeIngestWorkerMode,
    RAG_FLAG_NAMES,
} from "./flags.js";

afterEach(() => {
    clearRagFlags();
});

describe("RAG feature flags", () => {
    it("defaults every legacy and K0 flag to disabled", () => {
        clearRagFlags();

        expect(durableRagEnabled()).toBe(false);
        expect(durableRagReadCanary()).toBe(false);
        expect(projectRagEnabled()).toBe(false);
        expect(projectMemoryEnabled()).toBe(false);
        expect(knowledgeIngestV2Enabled()).toBe(false);
        expect(mineruParserEnabled()).toBe(false);
        expect(ragRerankEnabled()).toBe(false);
        expect(ragQueryRewriteEnabled()).toBe(false);
        expect(ragContextualQueryRewriteEnabled()).toBe(false);
        expect(ragContextCompressionEnabled()).toBe(false);
        expect(ragCrossSourceCoordinatorEnabled()).toBe(false);
        expect(ragFaissEnabled()).toBe(false);
        expect(ragFaissReadEnabled()).toBe(false);
        expect(ragFaissCompareEnabled()).toBe(false);
        expect(knowledgeIngestWorkerMode()).toBe("inline");
    });

    it("reads flags at call time and accepts the supported truthy spellings", () => {
        process.env.KNOWLEDGE_INGEST_V2 = "YES";
        process.env.MINERU_PARSER_ENABLED = "1";
        process.env.RAG_RERANK_ENABLED = "true";
        process.env.RAG_QUERY_REWRITE_ENABLED = "YES";
        process.env.RAG_CONTEXTUAL_QUERY_REWRITE_ENABLED = "1";
        process.env.RAG_CONTEXT_COMPRESSION_ENABLED = "TRUE";
        process.env.RAG_CROSS_SOURCE_COORDINATOR_ENABLED = "1";
        process.env.RAG_FAISS_ENABLED = "YES";
        process.env.RAG_FAISS_READ_ENABLED = "1";
        process.env.RAG_FAISS_COMPARE_ENABLED = "true";

        expect(knowledgeIngestV2Enabled()).toBe(true);
        expect(mineruParserEnabled()).toBe(true);
        expect(ragRerankEnabled()).toBe(true);
        expect(ragQueryRewriteEnabled()).toBe(true);
        expect(ragContextualQueryRewriteEnabled()).toBe(true);
        expect(ragContextCompressionEnabled()).toBe(true);
        expect(ragCrossSourceCoordinatorEnabled()).toBe(true);
        expect(ragFaissEnabled()).toBe(true);
        expect(ragFaissReadEnabled()).toBe(true);
        expect(ragFaissCompareEnabled()).toBe(true);

        process.env.KNOWLEDGE_INGEST_V2 = "false";
        expect(knowledgeIngestV2Enabled()).toBe(false);
    });

    it("clears all declared flags without touching unrelated environment", () => {
        process.env.RAG_DURABLE_ENABLED = "true";
        process.env.KNOWLEDGE_INGEST_V2 = "true";
        process.env.OPENAI_API_KEY = "test-only-sentinel";

        clearRagFlags();

        for (const name of RAG_FLAG_NAMES) {
            expect(process.env[name]).toBeUndefined();
        }
        expect(process.env.OPENAI_API_KEY).toBe("test-only-sentinel");
        delete process.env.OPENAI_API_KEY;
    });

    it("normalizes the external worker mode and safely falls back for invalid values", () => {
        process.env.KNOWLEDGE_INGEST_WORKER_MODE = "external";
        expect(knowledgeIngestWorkerMode()).toBe("external");
        process.env.KNOWLEDGE_INGEST_WORKER_MODE = "unexpected";
        expect(knowledgeIngestWorkerMode()).toBe("inline");
    });
});
