import { beforeEach, describe, expect, it } from "vitest";
import { initDB } from "../db/index.js";
import { MemoryService } from "./memory.js";

const USER_ID = 1;

describe("MemoryService trusted lifecycle", () => {
    let memory;

    beforeEach(() => {
        initDB();
        memory = new MemoryService(USER_ID);
        memory.forget("all");
    });

    it("keeps passive candidates out of active retrieval until approved", () => {
        const candidate = memory.propose({
            content: "用户偏好深色主题",
            memoryType: "semantic",
            importance: 0.8,
            confidence: 0.9,
            memoryKey: "ui_theme",
        });

        expect(candidate.status).toBe("pending");
        expect(memory.search("深色主题")).toHaveLength(0);
        expect(memory.search("深色主题", null, 10, 0, ["pending"])[0].id).toBe(candidate.id);

        expect(memory.approve(candidate.id)).toBe(true);
        expect(memory.search("深色主题")[0].status).toBe("active");
    });

    it("supersedes the old value atomically when a conflicting candidate is approved", () => {
        const oldId = memory.add("用户使用 Python", "semantic", 0.8, {}, null, {
            status: "active",
            source: "explicit",
            memoryKey: "preferred_language",
        });
        const candidate = memory.propose({
            content: "用户使用 TypeScript",
            memoryType: "semantic",
            importance: 0.9,
            confidence: 0.9,
            memoryKey: "preferred_language",
        });

        expect(candidate.conflictWith).toBe(oldId);
        expect(memory.approve(candidate.id)).toBe(true);
        const historical = memory.list(20, ["superseded"]);
        expect(historical.some((item) => item.id === oldId && item.superseded_by === candidate.id)).toBe(true);
        expect(memory.search("Python")).toHaveLength(0);
        expect(memory.search("TypeScript")[0].id).toBe(candidate.id);
    });

    it("rejects sensitive content before it reaches durable memory", () => {
        const result = memory.propose({ content: "api_key=sk-test-12345678901234567890" });
        expect(result.accepted).toBe(false);
        expect(result.reason).toBe("SENSITIVE_CONTENT");
        expect(memory.list(20)).toHaveLength(0);
    });

    it("supports explicit memory, soft invalidation, and physical deletion", () => {
        const result = memory.remember("我喜欢简洁的代码", "semantic");
        expect(result.status).toBe("active");
        expect(memory.invalidate(result.id, "user_changed_preference")).toBe(true);
        expect(memory.search("简洁的代码")).toHaveLength(0);
        expect(memory.list(20, ["invalidated"])[0].invalidate_reason).toBe("user_changed_preference");
        expect(memory.remove(result.id)).toBe(true);
        expect(memory.list(20, ["invalidated"])).toHaveLength(0);
    });
});
