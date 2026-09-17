import { describe, expect, it } from "vitest";
import { runQueryRewrite } from "./queryRewrite.js";

describe("K8 query rewrite policy", () => {
    it("always keeps the original query and adds at most one rewrite", async () => {
        const result = await runQueryRewrite({
            query: "如何重启服务",
            enabled: true,
            provider: async () => ({ rewrite: "服务重新启动步骤", meta: { model: "fake", calls: 1 } }),
        });

        expect(result.applied).toBe(true);
        expect(result.queries).toEqual(["如何重启服务", "服务重新启动步骤"]);
    });

    it("falls back to the original query when the provider fails", async () => {
        const result = await runQueryRewrite({
            query: "Qwen3.7 batch size",
            enabled: true,
            provider: async () => { throw Object.assign(new Error("timeout"), { code: "RAG_LLM_TIMEOUT" }); },
        });

        expect(result.fallback).toBe(true);
        expect(result.queries).toEqual(["Qwen3.7 batch size"]);
        expect(result.reason).toBe("RAG_REWRITE_TIMEOUT");
    });

    it("does nothing when the flag is disabled or no provider is configured", async () => {
        await expect(runQueryRewrite({ query: "原始问题", enabled: false })).resolves.toMatchObject({
            queries: ["原始问题"],
            applied: false,
            reason: "disabled",
        });
        await expect(runQueryRewrite({ query: "原始问题", enabled: true })).resolves.toMatchObject({
            queries: ["原始问题"],
            applied: false,
            reason: "provider-unavailable",
        });
    });

    it("passes bounded context only for a dependent query and keeps diagnostics content-free", async () => {
        const calls = [];
        const context = {
            version: 1,
            recentTurns: [{ role: "assistant", content: "已完成登录模块设计" }],
            summary: "当前任务是完成 RAG 改造",
            workingState: { currentGoal: "完成 RAG 改造", constraints: [], completedSteps: [], nextStep: "补测试" },
        };
        const provider = async (payload) => {
            calls.push(payload);
            return { rewrite: "修改 RAG 改造的测试", keywords: ["RAG", "测试"], used_context: true, meta: { model: "fake", calls: 1 } };
        };

        const dependent = await runQueryRewrite({
            query: "这个怎么修改",
            enabled: true,
            provider,
            contextualEnabled: true,
            context,
        });
        const concrete = await runQueryRewrite({
            query: "React useEffect cleanup",
            enabled: true,
            provider,
            contextualEnabled: true,
            context,
        });

        expect(calls).toHaveLength(2);
        expect(calls[0].context).toEqual(context);
        expect(calls[1]).not.toHaveProperty("context");
        expect(dependent.queries).toEqual(["这个怎么修改", "修改 RAG 改造的测试"]);
        expect(dependent.contextual).toBe(true);
        expect(dependent.contextUsed).toEqual(["recent_turns", "summary", "working_memory"]);
        expect(dependent.keywords).toEqual(["RAG", "测试"]);
        expect(concrete.contextual).toBe(false);
    });

    it("falls back on invalid provider JSON and caps a precomputed plan to one rewrite", async () => {
        const invalid = await runQueryRewrite({
            query: "这个怎么修改",
            enabled: true,
            provider: async () => { throw Object.assign(new Error("bad json"), { code: "RAG_LLM_INVALID_JSON" }); },
        });
        expect(invalid.fallback).toBe(true);
        expect(invalid.reason).toBe("RAG_REWRITE_INVALID_RESPONSE");

        const { normalizeQueryPlan } = await import("./queryRewrite.js");
        const plan = normalizeQueryPlan({
            queries: ["改写结果一", "改写结果二", "不应到达"],
            keywords: ["a", "a", "b", "c", "d", "e", "f", "g", "h"],
            calls: 9,
        }, "原始问题");
        expect(plan.queries).toEqual(["原始问题", "改写结果一"]);
        expect(plan.keywords).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
        expect(plan.calls).toBe(1);
    });
});
