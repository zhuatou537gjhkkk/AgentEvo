import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "../services/resilience.js";

/**
 * W4-R5 (T1) — RAG 检索/索引 embedding 的 withRetry 接线。
 *
 * 改造前：rag/index.js 的 `FaissStore.fromTexts`（首次建索引）、
 * `vectorStore.addDocuments`（增量索引）、`similaritySearchWithScore`（请求路径检索）
 * 都是裸调用 —— embedding 推理是网络调用，5xx/超时/网络错会被一次性上抛，
 * 且 embeddings 未置 maxRetries:0 时会与 SDK 内建重试叠乘。
 *
 * 本文件把 faiss 模块替换成可控假实现（不碰真实 embedding 网络），驱动真实
 * rag 内部函数端到端验证：瞬态失败 → withRetry 真重试（attempt==retries+1）；
 * 恒 503 → 耗尽后异常可被 classifyError 归类为 retryable UPSTREAM_UNAVAILABLE。
 * 零生产 seam（纯 vi.mock + 每个 user 独立 tenant store）。不触碰 dev 库。
 */

const E503 = () => Object.assign(new Error("embedding upstream 503"), { status: 503 });

// 逐调用行为的共享控制对象（fromTexts / addDocuments / search 的剩余失败次数）。
const behavior = {
    failFromTexts: 0,
    failAddDocuments: 0,
    failSearch: 0,
    calls: { fromTexts: 0, addDocuments: 0, search: 0 },
    searchHits: () => [
        [{ pageContent: "内容片段A（含 agentic 主题）", metadata: { source: "a.txt" } }, 0.2],
        [{ pageContent: "内容片段B（含编排主题）", metadata: { source: "a.txt" } }, 0.35],
    ],
};

vi.mock("@langchain/community/vectorstores/faiss", () => {
    return {
        FaissStore: {
            async fromTexts() {
                behavior.calls.fromTexts += 1;
                if (behavior.failFromTexts > 0) {
                    behavior.failFromTexts -= 1;
                    throw E503();
                }
                return makeFakeStore();
            },
        },
    };
});

function makeFakeStore() {
    return {
        async addDocuments() {
            behavior.calls.addDocuments += 1;
            if (behavior.failAddDocuments > 0) {
                behavior.failAddDocuments -= 1;
                throw E503();
            }
            return;
        },
        async similaritySearchWithScore() {
            behavior.calls.search += 1;
            if (behavior.failSearch > 0) {
                behavior.failSearch -= 1;
                throw E503();
            }
            return behavior.searchHits();
        },
    };
}

// 必须在 vi.mock 之后动态 import，保证拿到被 mock 的 faiss。
const { processAndStoreDocument, retrieveKnowledgeEvidence } = await import("./index.js");

let nextUserId = 5200;
function freshUser() {
    nextUserId += 1;
    return nextUserId;
}

const DOC = Buffer.from(
    "Agentic AI 是当前热点。自主 Agent 依赖编排、工具调用与记忆。检索增强生成把外部知识注入上下文。"
);

beforeEach(() => {
    behavior.failFromTexts = 0;
    behavior.failAddDocuments = 0;
    behavior.failSearch = 0;
    behavior.calls.fromTexts = 0;
    behavior.calls.addDocuments = 0;
    behavior.calls.search = 0;
});

describe("RAG embedding/search withRetry wiring (W4-R5 T1)", () => {
    it("首次建索引：fromTexts 瞬态 503 → withRetry 重试（calls==2）后成功", async () => {
        const userId = freshUser();
        behavior.failFromTexts = 1;

        const result = await processAndStoreDocument(DOC, "a.txt", userId);

        expect(result.mode).toBe("vector");
        expect(result.chunkCount).toBeGreaterThan(0);
        expect(behavior.calls.fromTexts).toBe(2); // withRetry retries:2 → 1 次重试
    });

    it("增量索引：addDocuments 瞬态 503 → 重试后成功，两次文档都入库", async () => {
        const userId = freshUser();
        await processAndStoreDocument(DOC, "a.txt", userId); // 首次 fromTexts，建库
        expect(behavior.calls.fromTexts).toBe(1);

        behavior.failAddDocuments = 1;
        const second = await processAndStoreDocument(DOC, "b.txt", userId);

        expect(second.mode).toBe("vector");
        expect(behavior.calls.addDocuments).toBe(2); // addDocuments 真重试一次
    });

    it("请求路径检索：similaritySearchWithScore 瞬态 503 → 重试后返回 ok 结果", async () => {
        const userId = freshUser();
        await processAndStoreDocument(DOC, "a.txt", userId); // 建库

        behavior.failSearch = 1;
        const evidence = await retrieveKnowledgeEvidence("agentic 主题", { userId });

        expect(behavior.calls.search).toBe(2); // 检索重试一次
        expect(evidence.status).toBe("ok");
        expect(evidence.items).toHaveLength(2);
        expect(evidence.items[0].content).toContain("内容片段A");
    });

    it("恒 503 → withRetry 耗尽（calls==3），异常归类 retryable UPSTREAM_UNAVAILABLE", async () => {
        const userId = freshUser();
        await processAndStoreDocument(DOC, "a.txt", userId); // 建库

        behavior.failSearch = Number.MAX_SAFE_INTEGER; // 恒失败
        let classified = null;
        try {
            await retrieveKnowledgeEvidence("agentic 主题", { userId });
        } catch (err) {
            classified = classifyError(err);
        }
        expect(behavior.calls.search).toBe(3); // retries:2 → 3 次尝试后耗尽
        expect(classified).not.toBeNull();
        expect(classified.retryable).toBe(true);
        expect(classified.code).toBe("UPSTREAM_UNAVAILABLE");
    });
});
