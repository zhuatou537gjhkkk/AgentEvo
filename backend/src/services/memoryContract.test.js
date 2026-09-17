import { afterEach, describe, expect, it } from "vitest";
import {
    buildProjectMemoryProvenance,
    buildProjectRetrievalProvenance,
    buildUserMemoryProvenance,
    normalizeContextMetadata,
    normalizeMemoryStatus,
    normalizeProvenance,
} from "./memoryContract.js";
import { clearMemoryFlags } from "./memoryFlags.js";
import { ContextPacket } from "./contextBuilder.js";
import { MemoryService } from "./memory.js";
import { ProjectMemoryService } from "./projectMemory.js";
import { initDB } from "../db/index.js";
import { fuseResults } from "../rag/retrieval.js";

afterEach(() => {
    clearMemoryFlags();
});

describe("M8 shared memory/context contract", () => {
    it("normalizes lifecycle states without losing invalidation meaning", () => {
        expect(normalizeMemoryStatus({ status: "pending" })).toBe("pending");
        expect(normalizeMemoryStatus({ invalidated: true })).toBe("invalidated");
        expect(normalizeMemoryStatus({ stale: true })).toBe("stale");
        expect(normalizeMemoryStatus({ status: "unknown" })).toBe("active");
    });

    it("keeps canonical provenance fields and legacy citation aliases together", () => {
        const provenance = normalizeProvenance({
            sourceType: "repo",
            sourceId: "chunk-1",
            ownerUserId: 7,
            tenantId: "team-a",
            projectId: "agent-evo",
            path: "src/app.js",
            startLine: 10,
            endLine: 18,
            commit: "abcdef123",
        });
        expect(provenance).toMatchObject({
            sourceType: "repo",
            sourceId: "chunk-1",
            ownerUserId: 7,
            tenantId: "team-a",
            projectId: "agent-evo",
            path: "src/app.js",
            file: "src/app.js",
            lineStart: 10,
            lineEnd: 18,
            startLine: 10,
            endLine: 18,
            commit: "abcdef123",
        });
    });

    it("builds separate user and project provenance scopes", () => {
        const user = buildUserMemoryProvenance({ memoryId: 3, ownerUserId: 7, sessionId: 9, source: "llm" });
        const project = buildProjectMemoryProvenance({ id: 4, ownerUserId: 7, tenantId: "team-a", projectId: "p1" });
        expect(user).toMatchObject({ sourceType: "user_memory", sourceId: "3", ownerUserId: 7, sessionId: 9 });
        expect(user.projectId).toBeNull();
        expect(project).toMatchObject({ sourceType: "project_memory", sourceId: "4", tenantId: "team-a", projectId: "p1" });
        expect(project.sessionId).toBeNull();
    });

    it("normalizes ContextPacket metadata while preserving selector fields", () => {
        process.env.MEMORY_CONTRACT_V2 = "true";
        const packet = new ContextPacket({
            content: "project fact",
            metadata: { type: "memory", projectMemory: true, projectId: "p1", ownerUserId: 7, confidence: 0.8 },
        });
        expect(packet.metadata).toMatchObject({
            type: "memory",
            projectMemory: true,
            sourceType: "project_memory",
            status: "active",
            confidence: 0.8,
            scope: { ownerUserId: 7, projectId: "p1" },
            provenance: { sourceType: "project_memory", projectId: "p1", ownerUserId: 7 },
        });
    });

    it("enriches both storage services additively when the flag is enabled", () => {
        process.env.MEMORY_CONTRACT_V2 = "true";
        initDB();
        const userMemory = new MemoryService(1);
        const userId = userMemory.add("用户偏好简洁回答", "semantic", 0.8, { extraction_method: "explicit" });
        const user = userMemory.list(20).find((item) => item.id === userId);
        expect(user).toMatchObject({ contractVersion: "memory-context-v2", source: "manual", status: "active" });
        expect(user.provenance).toMatchObject({ sourceType: "user_memory", sourceId: String(userId), ownerUserId: 1 });

        const projectMemory = new ProjectMemoryService({ scope: { userId: 1, tenantId: "team-a" } });
        const projectId = projectMemory.add({ projectId: "p-contract", content: "项目使用 SQLite", layer: "semantic", confidence: 0.9 });
        const project = projectMemory.list({ projectId: "p-contract" }).find((item) => item.id === projectId);
        expect(project).toMatchObject({ contractVersion: "memory-context-v2", sourceType: "project_memory", status: "active" });
        expect(project.provenance).toMatchObject({ sourceType: "project_memory", sourceId: String(projectId), tenantId: "team-a", projectId: "p-contract" });
        expect(project.provenance).not.toHaveProperty("sessionId", expect.any(Number));
    });

    it("adds project scope to code retrieval provenance without changing citation aliases", () => {
        process.env.MEMORY_CONTRACT_V2 = "true";
        const [retrieved] = fuseResults([
            { item: { chunkId: "c1", filePath: "src/a.js", startLine: 1, endLine: 3, content: "export const a = 1;" }, lexRank: 1, embRank: null },
        ], 1, { scope: { ownerUserId: 7, tenantId: "team-a" }, projectId: "p1" });
        expect(retrieved.provenance).toMatchObject({ sourceType: "project_memory", projectId: "p1", file: "src/a.js" });

        const provenance = buildProjectRetrievalProvenance({
            scope: { ownerUserId: 7, tenantId: "team-a" },
            projectId: "p1",
            item: { chunkId: "c1", filePath: "src/a.js", startLine: 1, endLine: 3, commit: "abc" },
        });
        expect(provenance).toMatchObject({
            sourceType: "project_memory",
            sourceId: "c1",
            ownerUserId: 7,
            tenantId: "team-a",
            projectId: "p1",
            file: "src/a.js",
            startLine: 1,
            endLine: 3,
            commit: "abc",
        });
    });
});
