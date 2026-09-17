import { beforeEach, describe, expect, it } from "vitest";
import { createUser, initDB } from "../db/index.js";
import { MemoryService } from "./memory.js";
import {
    canonicalMemoryKey,
    classifyMemoryRelation,
    normalizeMemoryCategory,
} from "./memoryRelations.js";

const USER_ID = 1;

describe("trusted memory M3 relation semantics", () => {
    let memory;

    beforeEach(() => {
        initDB();
        memory = new MemoryService(USER_ID);
        memory.forget("all");
    });

    it("normalizes category and common topic-key aliases", () => {
        expect(normalizeMemoryCategory(null, "episodic", "用户完成了迁移")).toBe("event");
        expect(canonicalMemoryKey("preferred_language", {
            content: "用户偏好 TypeScript",
            category: "preference",
        })).toBe("preferred_programming_language");
        expect(canonicalMemoryKey("theme", {
            content: "用户偏好深色界面",
            category: "preference",
        })).toBe("ui_theme");
    });

    it("updates duplicate evidence instead of inserting another row", () => {
        const existingId = memory.add("用户偏好 TypeScript", "semantic", 0.7, { category: "preference" }, null, {
            status: "active",
            source: "explicit",
            memoryKey: "preferred_language",
        });
        const result = memory.propose({
            content: "我一直喜欢使用 TypeScript",
            memoryType: "semantic",
            importance: 0.8,
            confidence: 0.9,
            memoryKey: "programming_language",
            metadata: { source: "llm_extract", category: "preference" },
        });

        expect(result).toMatchObject({ duplicate: true, relation: "duplicate", id: existingId });
        const rows = memory.list(20);
        expect(rows).toHaveLength(1);
        expect(rows[0].metadata).toMatchObject({ duplicate_count: 1, last_duplicate_source: "llm_extract" });
        expect(rows[0].memory_key).toBe("preferred_programming_language");
    });

    it("keeps same-topic additive facts active together", () => {
        const reactId = memory.add("用户技术栈包含 React", "semantic", 0.8, { category: "fact" }, null, {
            status: "active",
            memoryKey: "tech_stack",
        });
        const candidate = memory.propose({
            content: "用户技术栈还包含 Node.js",
            memoryKey: "technology_stack",
            metadata: { category: "fact" },
        });

        expect(candidate).toMatchObject({ relation: "supplement", relatedMemoryId: reactId, conflictWith: null });
        expect(memory.approve(candidate.id)).toBe(true);
        expect(memory.search("", null, 20, 0)).toHaveLength(2);
        expect(memory.lineage(candidate.id).impact.action).toBe("keep_both");
    });

    it("marks an explicit retirement as expiration and preserves the replacement chain", () => {
        const oldId = memory.add("用户偏好 Python", "semantic", 0.8, { category: "preference" }, null, {
            status: "active",
            memoryKey: "preferred_language",
        });
        const candidate = memory.propose({
            content: "用户已经不再使用 Python，改为 TypeScript",
            memoryKey: "programming_language",
            metadata: { category: "preference" },
        });

        expect(candidate).toMatchObject({ relation: "expiration", conflictWith: oldId });
        expect(memory.lineage(candidate.id).impact).toMatchObject({ action: "supersede", target: { id: oldId } });
        memory.approve(candidate.id);

        const chain = memory.lineage(candidate.id).chain;
        expect(chain.find((item) => item.id === oldId)).toMatchObject({ status: "superseded", superseded_by: candidate.id });
        expect(chain.find((item) => item.id === candidate.id)).toMatchObject({ status: "active", supersedes_id: oldId });
    });

    it("rebases stale pending conflicts onto the current active version", () => {
        const originalId = memory.add("用户偏好 Python", "semantic", 0.8, { category: "preference" }, null, {
            status: "active",
            memoryKey: "preferred_language",
        });
        const typescript = memory.propose({
            content: "用户现在更偏好 TypeScript 而不是 Python",
            memoryKey: "preferred_language",
            metadata: { category: "preference" },
        });
        const rust = memory.propose({
            content: "用户现在更偏好 Rust 而不是 Python",
            memoryKey: "preferred_language",
            metadata: { category: "preference" },
        });

        memory.approve(typescript.id);
        memory.approve(rust.id);

        const active = memory.search("", null, 20, 0);
        expect(active.map((item) => item.id)).toEqual([rust.id]);
        const chain = memory.lineage(rust.id).chain;
        expect(chain.find((item) => item.id === originalId).status).toBe("superseded");
        expect(chain.find((item) => item.id === typescript.id)).toMatchObject({ status: "superseded", superseded_by: rust.id });
        expect(chain.find((item) => item.id === rust.id).supersedes_id).toBe(typescript.id);
    });

    it("recomputes relation metadata after a candidate edit", () => {
        const oldId = memory.add("用户偏好深色主题", "semantic", 0.8, { category: "preference" }, null, {
            status: "active",
            memoryKey: "ui_theme",
        });
        const candidate = memory.propose({
            content: "用户偏好浅色主题",
            memoryKey: "theme",
            metadata: { category: "preference" },
        });
        expect(candidate.relation).toBe("conflict");

        expect(memory.edit(candidate.id, {
            content: "用户技术栈还包含 React",
            category: "fact",
            memory_key: "tech_stack",
        })).toBe(true);
        const edited = memory.lineage(candidate.id).memory;
        expect(edited).toMatchObject({ relation_type: "independent", memory_key: "tech_stack", related_memory_id: null });
        expect(memory.lineage(oldId).chain).toHaveLength(1);
    });

    it("never exposes another owner's lineage", () => {
        const id = memory.add("用户偏好深色主题", "semantic", 0.8, {}, null, { status: "active", memoryKey: "ui_theme" });
        const otherUserId = createUser(`memory-m3-${Date.now()}-${Math.random()}`, "test-password-hash");
        const otherMemory = new MemoryService(otherUserId);
        expect(otherMemory.lineage(id)).toBeNull();
    });
});

describe("memory relation classifier", () => {
    it("distinguishes singleton conflicts from additive supplements", () => {
        expect(classifyMemoryRelation(
            { content: "用户偏好浅色主题", memoryKey: "ui_theme" },
            { content: "用户偏好深色主题", memory_key: "ui_theme" },
        ).type).toBe("conflict");
        expect(classifyMemoryRelation(
            { content: "用户技术栈包含 Node.js", memoryKey: "tech_stack" },
            { content: "用户技术栈包含 React", memory_key: "tech_stack" },
        ).type).toBe("supplement");
    });
});
