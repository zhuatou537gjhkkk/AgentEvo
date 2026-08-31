import { describe, expect, it } from "vitest";
import { calculateContextUsage, CONTEXT_OVERHEAD_TOKENS } from "./contextUsage.js";

describe("calculateContextUsage", () => {
    it("does not show reserved overhead for an empty session", () => {
        const result = calculateContextUsage([], "deepseek-v4-flash", 12);

        expect(result).toMatchObject({
            sessionId: 12,
            usedTokens: 0,
            ratio: 0,
            messageCount: 0,
            maxTokens: 128000,
            modelName: "deepseek-v4-flash",
        });
    });

    it("includes the existing overhead for a non-empty session", () => {
        const result = calculateContextUsage([
            { role: "user", content: "hello" },
        ], "deepseek-v4-flash", 12);

        expect(result.usedTokens).toBeGreaterThanOrEqual(CONTEXT_OVERHEAD_TOKENS);
        expect(result.messageCount).toBe(1);
        expect(result.ratio).toBe(Math.round((result.usedTokens / 128000) * 100));
    });

    it("prefers metric totals and falls back to estimated content tokens", () => {
        const result = calculateContextUsage([
            { role: "user", content: "ignored", metrics: { total_tokens: 17 } },
            { role: "assistant", content: "abcd" },
        ], "deepseek-v3", "7");

        expect(result.sessionId).toBe("7");
        expect(result.usedTokens).toBe(CONTEXT_OVERHEAD_TOKENS + 17 + 2);
        expect(result.maxTokens).toBe(64000);
    });

    it("stops at the compression summary when counting older messages", () => {
        const result = calculateContextUsage([
            { role: "user", content: "old message", metrics: { total_tokens: 1000 } },
            { role: "system", content: "[上下文压缩摘要]\nsummary", metrics: { total_tokens: 25 } },
            { role: "user", content: "new message", metrics: { total_tokens: 10 } },
        ], "qwen-plus", 3);

        expect(result.usedTokens).toBe(CONTEXT_OVERHEAD_TOKENS + 35);
        expect(result.maxTokens).toBe(131072);
    });
});
