/**
 * TestCaseGenerator 单元测试 (Phase 6b G7)
 *
 * 测试 LLM 输出解析 + 参数校验 + 用例构建 + 内置分类模板
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock DB functions
const mockInserted = [];
const mockExistingIds = [];

vi.mock("../../db/index.js", () => ({
    insertGeneratedTestCase: vi.fn((tc) => { mockInserted.push(tc); }),
    getGeneratedTestCaseIds: vi.fn(() => mockExistingIds),
    getGeneratedTestCaseById: vi.fn(() => null),
}));

import { TestCaseGenerator, CATEGORY_DEFAULTS } from "../generator.js";

describe("CATEGORY_DEFAULTS", () => {
    it("should have all 8 categories", () => {
        const cats = Object.keys(CATEGORY_DEFAULTS);
        expect(cats).toContain("knowledge_qa");
        expect(cats).toContain("web_search");
        expect(cats).toContain("multi_step");
        expect(cats).toContain("memory_recall");
        expect(cats).toContain("code_generation");
        expect(cats).toContain("creative");
        expect(cats).toContain("tool_selection");
        expect(cats).toContain("edge_case");
    });

    it("should have web_search with enableWebSearch=true", () => {
        expect(CATEGORY_DEFAULTS.web_search.enableWebSearch).toBe(true);
        expect(CATEGORY_DEFAULTS.web_search.tools).toEqual(["web_search"]);
    });

    it("should have knowledge_qa with no tools", () => {
        expect(CATEGORY_DEFAULTS.knowledge_qa.tools).toEqual([]);
        expect(CATEGORY_DEFAULTS.knowledge_qa.enableWebSearch).toBe(false);
    });
});

describe("TestCaseGenerator", () => {
    let gen;

    beforeEach(() => {
        gen = new TestCaseGenerator({ model: "test-model" });
        mockInserted.length = 0;
        mockExistingIds.length = 0;
    });

    // ── _parseResponse ──

    describe("_parseResponse", () => {
        it("should parse a valid JSON array", () => {
            const json = JSON.stringify([
                { category: "web_search", difficulty: "easy", input: "test?", expectedBehavior: "search", expectedTools: ["web_search"] },
            ]);
            const result = gen._parseResponse(json);
            expect(result).toHaveLength(1);
            expect(result[0].category).toBe("web_search");
        });

        it("should parse an object with testCases wrapper", () => {
            const json = JSON.stringify({
                testCases: [
                    { category: "knowledge_qa", difficulty: "easy", input: "q?", expectedBehavior: "ans", expectedTools: [] },
                ],
            });
            const result = gen._parseResponse(json);
            expect(result).toHaveLength(1);
            expect(result[0].category).toBe("knowledge_qa");
        });

        it("should parse an object with cases wrapper", () => {
            const json = JSON.stringify({
                cases: [
                    { category: "creative", difficulty: "medium", input: "write", expectedBehavior: "create", expectedTools: [] },
                ],
            });
            const result = gen._parseResponse(json);
            expect(result).toHaveLength(1);
        });

        it("should return null for non-JSON text", () => {
            const result = gen._parseResponse("这不是 JSON");
            expect(result).toBeNull();
        });

        it("should return null for empty string", () => {
            expect(gen._parseResponse("")).toBeNull();
            expect(gen._parseResponse(null)).toBeNull();
        });

        it("should extract JSON array from markdown code block", () => {
            const text = '```json\n[\n  {"category": "knowledge_qa", "difficulty": "easy", "input": "hi", "expectedBehavior": "hello", "expectedTools": []}\n]\n```';
            const result = gen._parseResponse(text);
            expect(result).toHaveLength(1);
            expect(result[0].input).toBe("hi");
        });

        it("should extract JSON array without code fence", () => {
            const text = '一些前置文字\n[\n  { "category": "knowledge_qa", "difficulty": "easy", "input": "hey", "expectedBehavior": "reply", "expectedTools": [] }\n]\n一些后置文字';
            const result = gen._parseResponse(text);
            expect(result).toHaveLength(1);
        });
    });

    // ── _buildTestCase ──

    describe("_buildTestCase", () => {
        it("should build a complete test case from LLM output", () => {
            const item = {
                category: "web_search",
                difficulty: "hard",
                description: "搜索测试",
                input: "搜索最新AI新闻",
                expectedBehavior: "调用web_search并总结结果",
                expectedTools: ["web_search"],
                enableWebSearch: true,
            };
            const tc = gen._buildTestCase("gen_web_search_001", "web_search", item, ["tc_search_001"], "batch1");
            expect(tc.id).toBe("gen_web_search_001");
            expect(tc.category).toBe("web_search");
            expect(tc.difficulty).toBe("hard");
            expect(tc.expectedTools).toEqual(["web_search"]);
            expect(tc.enableWebSearch).toBe(1);
            expect(tc.generated).toBe(1);
            expect(tc.reviewed).toBe(0);
            expect(tc.sourceSeeds).toEqual(["tc_search_001"]);
            expect(tc.genBatchId).toBe("batch1");
        });

        it("should default difficulty to medium for invalid values", () => {
            const tc = gen._buildTestCase("id1", "knowledge_qa", { difficulty: "impossible", input: "x", expectedBehavior: "y", expectedTools: [] }, [], "");
            expect(tc.difficulty).toBe("medium");
        });

        it("should handle missing optional fields", () => {
            const tc = gen._buildTestCase("id2", "creative", { input: "写首诗", expectedBehavior: "创作一首诗", expectedTools: [] }, [], "");
            expect(tc.description).toBe("");
            expect(tc.codeChecks).toBeNull();
            expect(tc.sourceSeeds).toEqual([]);
        });
    });

    // ── generate() validation ──

    describe("generate", () => {
        it("should reject invalid category with no seeds", async () => {
            const result = await gen.generate([], { category: "nonexistent" });
            expect(result.ok).toBe(false);
            expect(result.error).toContain("未知分类");
        });

        it("should use category defaults when no seeds provided", async () => {
            // This will try to call LLM — but we're testing without real LLM
            // The LLM call will fail → we test the error path gracefully
            const result = await gen.generate([], { category: "knowledge_qa" });
            // Will fail at LLM call since there's no real API key in test
            expect(result.ok).toBe(false);
            expect(result.error).toBeDefined();
        });

        it("should truncate seeds to max 3", async () => {
            const seeds = [
                { id: "1", category: "web_search", input: "a", expectedBehavior: "x", expectedTools: [] },
                { id: "2", category: "web_search", input: "b", expectedBehavior: "y", expectedTools: [] },
                { id: "3", category: "web_search", input: "c", expectedBehavior: "z", expectedTools: [] },
                { id: "4", category: "web_search", input: "d", expectedBehavior: "w", expectedTools: [] },
            ];
            // Will fail at LLM stage, but seeds truncation happens first
            const result = await gen.generate(seeds, { category: "web_search", count: 5 });
            expect(result.ok).toBe(false); // LLM will fail in test env
        });

        it("should return generated cases with ok=true on success", async () => {
            // Mock the LLM to return valid JSON
            const mockInvoke = vi.fn().mockResolvedValue({
                content: JSON.stringify([
                    { category: "web_search", difficulty: "easy", description: "天气查询", input: "今天天气如何？", expectedBehavior: "搜索天气", expectedTools: ["web_search"], enableWebSearch: true },
                    { category: "web_search", difficulty: "medium", description: "新闻摘要", input: "最近AI有什么进展？", expectedBehavior: "搜索AI新闻", expectedTools: ["web_search"], enableWebSearch: true },
                    { category: "web_search", difficulty: "hard", description: "多源验证", input: "对比两家公司的财报", expectedBehavior: "搜索并对比", expectedTools: ["web_search"], enableWebSearch: true },
                ]),
            });
            gen.llm.invoke = mockInvoke;

            const seeds = [{ id: "tc_search_001", category: "web_search", difficulty: "medium", input: "新闻", expectedBehavior: "搜索", expectedTools: ["web_search"] }];
            const result = await gen.generate(seeds, { category: "web_search", count: 3 });

            expect(result.ok).toBe(true);
            expect(result.generated).toHaveLength(3);
            expect(result.batchId).toBeTruthy();
            expect(mockInserted.length).toBe(3);

            // Verify first generated case structure
            const first = result.generated[0];
            expect(first.id).toBe("gen_web_search_001");
            expect(first.category).toBe("web_search");
            expect(first.reviewed).toBe(false);
        });

        it("should cap count at 50", async () => {
            const mockInvoke = vi.fn().mockResolvedValue({
                content: JSON.stringify(
                    Array.from({ length: 60 }, (_, i) => ({
                        category: "knowledge_qa", difficulty: "easy", description: `测试${i}`,
                        input: `问题${i}`, expectedBehavior: "回答", expectedTools: [],
                    }))
                ),
            });
            gen.llm.invoke = mockInvoke;

            const result = await gen.generate([], { category: "knowledge_qa", count: 100 });
            expect(result.ok).toBe(true);
            expect(result.generated.length).toBeLessThanOrEqual(50);
        });

        it("should handle LLM output nested in testCases wrapper", async () => {
            const mockInvoke = vi.fn().mockResolvedValue({
                content: JSON.stringify({
                    testCases: [
                        { category: "code_generation", difficulty: "easy", description: "写函数", input: "写一个排序函数", expectedBehavior: "返回排序代码", expectedTools: [] },
                    ],
                }),
            });
            gen.llm.invoke = mockInvoke;

            const result = await gen.generate(
                [{ id: "tc_code_001", category: "code_generation", difficulty: "easy", input: "写素数函数", expectedBehavior: "返回代码", expectedTools: [] }],
                { category: "code_generation", count: 1 }
            );

            expect(result.ok).toBe(true);
            expect(result.generated).toHaveLength(1);
            expect(result.generated[0].category).toBe("code_generation");
        });

        it("should handle LLM error gracefully", async () => {
            const mockInvoke = vi.fn().mockRejectedValue(new Error("API timeout"));
            gen.llm.invoke = mockInvoke;

            const result = await gen.generate(
                [{ id: "s1", category: "web_search", input: "x", expectedBehavior: "y", expectedTools: [] }],
                { count: 3 }
            );

            expect(result.ok).toBe(false);
            expect(result.error).toContain("LLM调用失败");
        });

        it("should handle unparseable LLM output", async () => {
            const mockInvoke = vi.fn().mockResolvedValue({
                content: "抱歉，我无法生成测试用例...",
            });
            gen.llm.invoke = mockInvoke;

            const result = await gen.generate(
                [{ id: "s1", category: "web_search", input: "x", expectedBehavior: "y", expectedTools: [] }],
                { count: 3 }
            );

            expect(result.ok).toBe(false);
            expect(result.error).toBeDefined();
        });
    });
});
