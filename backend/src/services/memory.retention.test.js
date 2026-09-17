import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { initDB } from "../db/index.js";
import { MemoryService } from "./memory.js";
import { evaluateMemoryRetention } from "./memoryRetention.js";

const USER_ID = 1;
const previousFlag = process.env.MEMORY_RETENTION_V2;

describe("memory retention policy", () => {
    let memory;

    beforeEach(() => {
        process.env.MEMORY_RETENTION_V2 = "true";
        initDB();
        memory = new MemoryService(USER_ID);
        memory.forget("all");
    });

    afterAll(() => {
        if (previousFlag == null) delete process.env.MEMORY_RETENTION_V2;
        else process.env.MEMORY_RETENTION_V2 = previousFlag;
    });

    it("soft-invalidates the oldest pending entries while protecting explicit memories", () => {
        const first = memory.propose({ content: "待确认的旧偏好", metadata: { category: "preference" } });
        const second = memory.propose({ content: "待确认的新偏好", metadata: { category: "preference" } });
        const protectedId = memory.add("用户明确要求保留", "semantic", 0.9, { source: "explicit" }, null, {
            status: "pending",
            source: "explicit",
        });

        const result = memory.retentionSweep({
            policy: { pendingTtlDays: 3650, workingTtlDays: 3650, inactiveDays: 3650, maxPending: 1 },
        });

        expect(result.invalidated).toBe(1);
        expect(memory.list(20, ["invalidated"])).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: first.id, invalidate_reason: "retention_pending_capacity" }),
        ]));
        expect(memory.list(20, ["pending"]).map((item) => item.id)).toEqual(expect.arrayContaining([second.id, protectedId]));
    });

    it("restores a retention-invalidated memory but does not restore rejected records", () => {
        const id = memory.propose({ content: "长期未使用候选", confidence: 0.1 });
        const result = memory.retentionSweep({
            policy: { pendingTtlDays: 0, workingTtlDays: 3650, inactiveDays: 3650, maxPending: 100 },
        });
        expect(result.invalidated).toBe(1);
        expect(memory.restore(id.id)).toBe(true);
        expect(memory.list(20, ["active"])[0].id).toBe(id.id);
        expect(memory.reject(id.id)).toBe(true);
        expect(memory.restore(id.id)).toBe(false);
    });

    it("exports all owner-scoped statuses and requires explicit cleanup confirmation", () => {
        const active = memory.remember("用户喜欢短回答");
        const pending = memory.propose({ content: "用户可能喜欢表格", metadata: { category: "preference" } });
        expect(memory.cleanup([active.id], false).errorCode).toBe("CONFIRMATION_REQUIRED");

        const exported = memory.exportData();
        expect(exported.schemaVersion).toBe("memory-export-v1");
        expect(exported.memories.map((item) => item.id)).toEqual(expect.arrayContaining([active.id, pending.id]));

        expect(memory.cleanup([active.id], true)).toMatchObject({ ok: true, succeeded: 1, failed: 0 });
        expect(memory.list(20, ["active"]).some((item) => item.id === active.id)).toBe(false);
    });

    it("keeps policy evaluation pure and marks low-confidence inactive entries", () => {
        const now = Date.now();
        const result = evaluateMemoryRetention([
            {
                id: 10,
                status: "active",
                memory_type: "semantic",
                confidence: 0.2,
                created_at: new Date(now - 120 * 86400000).toISOString(),
                updated_at: new Date(now - 120 * 86400000).toISOString(),
            },
        ], { inactiveDays: 90, lowConfidenceThreshold: 0.35 }, now);
        expect(result.decisions).toEqual([{ id: 10, status: "active", reason: "retention_low_confidence" }]);
    });
});
