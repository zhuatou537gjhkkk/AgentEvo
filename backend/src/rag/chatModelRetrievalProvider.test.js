import { describe, expect, it } from "vitest";
import {
    createChatModelQueryRewriter,
    createChatModelReranker,
    preservesProtectedFragments,
} from "./chatModelRetrievalProvider.js";

function fakeLlm(content) {
    return {
        invoke: async () => ({
            content: typeof content === "function" ? content() : content,
            usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
    };
}

describe("K8 current chat-model retrieval providers", () => {
    it("uses the injected chat model for strict rerank JSON and returns safe metadata", async () => {
        const provider = createChatModelReranker({
            modelName: "current-chat-model",
            llm: fakeLlm(JSON.stringify({ items: [
                { chunkId: "b", relevance: 0.95 },
                { chunkId: "a", relevance: 0.2 },
            ] })),
        });

        const result = await provider.rerank({
            query: "部署",
            candidates: [
                { chunkId: "a", content: "a" },
                { chunkId: "b", content: "b" },
            ],
        });

        expect(result.items[0].chunkId).toBe("b");
        expect(result.meta).toMatchObject({ model: "current-chat-model", calls: 1 });
        expect(result.meta.usage.total_tokens).toBe(15);
    });

    it("rewrites without dropping protected model/version fragments", async () => {
        const provider = createChatModelQueryRewriter({
            modelName: "current-chat-model",
            llm: fakeLlm(JSON.stringify({ rewrite: "Qwen3.7 embedding batch size 配置", keywords: ["embedding"] })),
        });
        const result = await provider.rewrite({ query: "Qwen3.7 的 embedding batch size 是多少？" });

        expect(result.rewrite).toContain("Qwen3.7");
        expect(result.keywords).toEqual(["embedding"]);
        expect(preservesProtectedFragments("Qwen3.7 的 embedding batch size 是多少？", result.rewrite)).toBe(true);
    });

    it("rejects a rewrite that drops a protected technical token", async () => {
        const provider = createChatModelQueryRewriter({
            modelName: "current-chat-model",
            llm: fakeLlm(JSON.stringify({ rewrite: "embedding 配置", keywords: [] })),
        });

        await expect(provider.rewrite({ query: "Qwen3.7 embedding batch size" }))
            .rejects.toMatchObject({ code: "RAG_REWRITE_PROTECTED_FRAGMENT" });
    });

    it("renders contextual data as bounded reference material and reports only safe usage", async () => {
        const messages = [];
        const provider = createChatModelQueryRewriter({
            modelName: "current-chat-model",
            llm: {
                invoke: async (input) => {
                    messages.push(input);
                    return { content: JSON.stringify({ rewrite: "修改当前任务", keywords: ["任务"], used_context: true }) };
                },
            },
        });
        const result = await provider.rewrite({
            query: "这个怎么修改",
            context: {
                version: 1,
                recentTurns: [{ role: "assistant", content: "当前任务说明" }],
                summary: "摘要",
                workingState: { currentGoal: "目标", constraints: [], completedSteps: [], nextStep: "下一步" },
                userId: 99,
                sessionId: 100,
            },
        });

        const prompt = String(messages[0]?.[1]?.content || "");
        expect(prompt).toContain("<recent_turns>");
        expect(prompt).toContain("当前任务说明");
        expect(prompt).not.toContain("userId");
        expect(prompt).not.toContain("sessionId");
        expect(result.used_context).toBe(true);
    });

    it("rejects non-JSON rewrite responses", async () => {
        const provider = createChatModelQueryRewriter({
            modelName: "current-chat-model",
            llm: fakeLlm("not json"),
        });
        await expect(provider.rewrite({ query: "这个怎么修改" }))
            .rejects.toMatchObject({ code: "RAG_LLM_INVALID_JSON" });
    });
});
