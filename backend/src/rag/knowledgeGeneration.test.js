import { beforeEach, describe, expect, it } from "vitest";
import db, { createUser, initDB } from "../db/index.js";
import {
    activateDocumentRevision,
    getActiveChunks,
    getKnowledgeIndexGeneration,
    insertDocumentRevision,
} from "./knowledgeStore.js";
import { clearDurableStoreCache, DurableVectorStore } from "./vectorStoreAdapter.js";

function uniqueScope() {
    const id = createUser(`k13_generation_${Date.now()}_${Math.random().toString(36).slice(2)}`, "test-hash");
    return { userId: Number(id), tenantId: `user:${id}` };
}

beforeEach(() => {
    initDB();
    clearDurableStoreCache();
});

describe("K13 knowledge index generations", () => {
    it("reloads a durable vector cache after another revision activates", () => {
        const scope = uniqueScope();
        const projectId = `k13-generation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const oldRevision = insertDocumentRevision({
            scope, projectId, filePath: "guide.md", fileName: "guide.md", fileHash: "old", status: "indexing",
            chunks: [{ content: "old revision", chunkIndex: 0, embedding: [1, 0] }],
        });
        expect(activateDocumentRevision(scope, oldRevision.documentId)).toBe(true);
        const firstGeneration = getKnowledgeIndexGeneration(scope, projectId);
        const store = new DurableVectorStore({ scope, projectId });
        expect(store.similaritySearch([1, 0], 5).map((row) => row.content)).toEqual(["old revision"]);

        const newRevision = insertDocumentRevision({
            scope, projectId, filePath: "guide.md", fileName: "guide.md", fileHash: "new", status: "indexing",
            previous: { id: oldRevision.documentId, revision: 1 },
            chunks: [{ content: "new revision", chunkIndex: 0, embedding: [1, 0] }],
        });
        expect(activateDocumentRevision(scope, newRevision.documentId, { previousDocumentId: oldRevision.documentId })).toBe(true);
        expect(getKnowledgeIndexGeneration(scope, projectId)).toBeGreaterThan(firstGeneration);

        // No invalidate() call: the generation check is the multi-process path.
        expect(store.similaritySearch([1, 0], 5).map((row) => row.content)).toEqual(["new revision"]);
        expect(getActiveChunks(scope, projectId).map((row) => row.content)).toEqual(["new revision"]);
        expect(db.prepare("SELECT COUNT(*) AS c FROM knowledge_index_generations WHERE owner_user_id = ? AND project_id = ?").get(scope.userId, projectId).c).toBe(1);
    });
});
