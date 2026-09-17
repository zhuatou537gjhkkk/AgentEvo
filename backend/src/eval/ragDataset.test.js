import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRagManifest, validateRagManifest, readRagDocuments } from "./ragDataset.js";

const base = (overrides = {}) => ({
    datasetVersion: "test-v1",
    documents: [{ id: "manual", path: "manual.md" }],
    cases: [{ id: "case-1", query: "如何重启？", relevantDocumentIds: ["manual"], relevantChunkIds: ["manual#1"], expectedPages: [2], expectedFacts: ["重启"] }],
    ...overrides,
});

describe("K9 RAG manifest", () => {
    it("validates a bounded manifest and resolves relative paths", () => {
        const result = validateRagManifest(base(), { manifestDir: "D:/datasets/rag" });
        expect(result.ok).toBe(true);
        expect(result.documents[0].resolvedPath).toBe(path.resolve("D:/datasets/rag/manual.md"));
    });

    it("rejects traversal, duplicate IDs, invalid pages, and no-answer conflicts", () => {
        expect(validateRagManifest(base({ documents: [{ id: "manual", path: "../manual.md" }] }), { manifestDir: "D:/datasets/rag" }).code).toBe("RAG_MANIFEST_PATH_TRAVERSAL");
        expect(validateRagManifest(base({ documents: [{ id: "manual", path: "manual.md" }, { id: "manual", path: "other.md" }] }), { manifestDir: "D:/datasets/rag" }).code).toBe("RAG_MANIFEST_DUPLICATE_DOCUMENT_ID");
        expect(validateRagManifest(base({ cases: [{ ...base().cases[0], expectedPages: [0] }] }), { manifestDir: "D:/datasets/rag" }).code).toBe("RAG_MANIFEST_CASE_FIELDS_INVALID");
        expect(validateRagManifest(base({ cases: [{ id: "negative", query: "x", relevantDocumentIds: ["manual"], noAnswer: true }] }), { manifestDir: "D:/datasets/rag" }).code).toBe("RAG_MANIFEST_NO_ANSWER_CONFLICT");
    });

    it("loads only bounded text documents from a manifest", async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rag-manifest-test-"));
        try {
            await fs.writeFile(path.join(directory, "manual.md"), "hello", "utf8");
            await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(base()), "utf8");
            const manifest = await loadRagManifest(path.join(directory, "manifest.json"));
            const documents = await readRagDocuments(manifest);
            expect(documents[0].content).toBe("hello");
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("reports a missing document with a public error code", async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rag-missing-test-"));
        try {
            await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(base()), "utf8");
            const manifest = await loadRagManifest(path.join(directory, "manifest.json"));
            await expect(readRagDocuments(manifest)).rejects.toMatchObject({ code: "RAG_MANIFEST_DOCUMENT_NOT_FOUND" });
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
});
