import { beforeEach, describe, expect, it } from "vitest";
import { initDB } from "../db/index.js";
import { MemoryService } from "./memory.js";

const USER_ID = 1;

describe("memory review control plane", () => {
    let memory;

    beforeEach(() => {
        initDB();
        memory = new MemoryService(USER_ID);
        memory.forget("all");
    });

    it("approves a selected batch and returns per-item outcomes", () => {
        const first = memory.propose({ content: "用户目标是完成 Agent 项目", memoryKey: "goal_one", metadata: { category: "goal" } });
        const second = memory.propose({ content: "用户计划学习 RAG", memoryKey: "goal_two", metadata: { category: "goal" } });

        const result = memory.batchTransition([first.id, second.id], "approve");
        expect(result).toMatchObject({ ok: true, action: "approve", succeeded: 2, failed: 0 });
        expect(result.results).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: first.id, ok: true, status: "active" }),
            expect.objectContaining({ id: second.id, ok: true, status: "active" }),
        ]));
    });

    it("rejects a selected batch without affecting active memories", () => {
        const candidate = memory.propose({ content: "用户偏好简洁回答", memoryKey: "response_style", metadata: { category: "preference" } });
        const active = memory.remember("用户喜欢深色主题");

        const result = memory.batchTransition([candidate.id], "reject", "not_durable");
        expect(result).toMatchObject({ ok: true, succeeded: 1, failed: 0 });
        expect(memory.search("简洁回答")).toHaveLength(0);
        expect(memory.search("深色主题")[0].id).toBe(active.id);
        expect(memory.list(20, ["rejected"])[0]).toMatchObject({
            id: candidate.id,
            invalidate_reason: "not_durable",
        });
    });

    it("returns a safe error for unsupported batch actions", () => {
        const result = memory.batchTransition([1], "delete");
        expect(result).toMatchObject({ ok: false, errorCode: "INVALID_MEMORY_ACTION", results: [] });
    });
});
