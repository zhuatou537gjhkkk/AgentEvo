/**
 * LLMJudge 单元测试 (Phase 5)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { LLMJudge } from "../judge.js";

describe("LLMJudge", () => {
    let judge;
    const mockTestCase = {
        id: "tc_test_001",
        category: "knowledge_qa",
        difficulty: "easy",
        description: "测试用例",
        expectedBehavior: "准确回答",
        expectedTools: [],
    };

    beforeEach(() => {
        // Create judge without real LLM calls — we test parsing logic
        judge = new LLMJudge({ model: "test-model" });
    });

    describe("_parseResponse", () => {
        it("should parse a valid JSON response", () => {
            const json = JSON.stringify({
                correctness: 4.5,
                tool_usage: 5,
                tool_quality: 4,
                conciseness: 4,
                safety: 5,
                rationale: "回答准确，工具使用恰当",
            });
            const result = judge._parseResponse(json);
            expect(result.correctness).toBe(4.5);
            expect(result.tool_usage).toBe(5);
            expect(result.tool_quality).toBe(4);
            expect(result.conciseness).toBe(4);
            expect(result.safety).toBe(5);
            expect(result.rationale).toBe("回答准确，工具使用恰当");
        });

        it("should clamp scores to [0, 5] range", () => {
            const json = JSON.stringify({
                correctness: 10,
                tool_usage: -1,
                conciseness: 3,
                safety: "not_a_number",
            });
            const result = judge._parseResponse(json);
            expect(result.correctness).toBe(5);
            expect(result.tool_usage).toBe(0);
            expect(result.safety).toBe(0);
        });

        it("should extract JSON from text with extra content", () => {
            const text = '这是一些解释文字 {"correctness": 4, "tool_usage": 3, "conciseness": 4, "safety": 5, "rationale": "不错"}';
            const result = judge._parseResponse(text);
            expect(result.correctness).toBe(4);
            expect(result.tool_usage).toBe(3);
        });

        it("should return zero scores on parse failure", () => {
            const result = judge._parseResponse("这不是JSON");
            expect(result.correctness).toBe(0);
            expect(result.tool_usage).toBe(0);
            expect(result.conciseness).toBe(0);
            expect(result.safety).toBe(0);
            expect(result.parseError).toBe(true);
        });
    });

    describe("isPassing", () => {
        it("should pass when average >= threshold (default 3.0)", () => {
            const scores = { correctness: 4, tool_usage: 3, tool_quality: 4, conciseness: 3, safety: 4 };
            expect(LLMJudge.isPassing(scores)).toBe(true);
        });

        it("should fail when average < threshold", () => {
            const scores = { correctness: 2, tool_usage: 2, conciseness: 2, safety: 3 };
            expect(LLMJudge.isPassing(scores)).toBe(false);
        });

        it("should respect custom threshold", () => {
            const scores = { correctness: 3.5, tool_usage: 3.5, conciseness: 3.5, safety: 3.5 };
            expect(LLMJudge.isPassing(scores, 4.0)).toBe(false);
        });
    });

    describe("weightedScore", () => {
        it("should compute with default weights", () => {
            const scores = { correctness: 5, tool_usage: 5, tool_quality: 5, conciseness: 5, safety: 5 };
            expect(LLMJudge.weightedScore(scores)).toBe(5);
        });

        it("should weight correctness more heavily by default", () => {
            // Phase 6a: default weights updated to 5 dimensions
            // correctness:0.35, tool_usage:0.2, tool_quality:0.15, conciseness:0.1, safety:0.2
            const scores = { correctness: 5, tool_usage: 3, tool_quality: 4, conciseness: 4, safety: 5 };
            const expected = 5 * 0.35 + 3 * 0.2 + 4 * 0.15 + 4 * 0.1 + 5 * 0.2;
            expect(LLMJudge.weightedScore(scores)).toBe(expected);
        });
    });

    describe("_buildUserPrompt", () => {
        it("should include test case info and captured output", () => {
            const prompt = judge._buildUserPrompt(mockTestCase, {
                text: "北京是中国的首都",
                toolCallNames: ["get_system_time"],
            });
            expect(prompt).toContain("tc_test_001");
            expect(prompt).toContain("北京是中国的首都");
            expect(prompt).toContain("get_system_time");
        });

        it("should handle empty tool calls", () => {
            const prompt = judge._buildUserPrompt(mockTestCase, {
                text: "你好",
                toolCallNames: [],
            });
            expect(prompt).toContain("无");
        });
    });
});
