import { describe, expect, it } from "vitest";
import { aggregateMemoryQuality, evaluateMemoryQuality } from "./memoryQuality.js";
import { getTestCaseById } from "./testCases.js";

function call(action, input = {}, output = "") {
    return { toolName: "memory", input: JSON.stringify({ action, ...input }), output };
}

describe("M7 deterministic memory quality evaluator", () => {
    it("passes a compliant remember-and-confirm scenario", () => {
        const result = evaluateMemoryQuality(getTestCaseById("tc_memory_001"), {
            text: "已记录你喜欢 Python。",
            toolCalls: [call("add", { content: "用户喜欢 Python" }, '{"success":true}')],
        });

        expect(result).toMatchObject({ passed: true, score: 1, testCaseId: "tc_memory_001" });
        expect(result.metrics.actionCompliance).toBe(1);
    });

    it("fails when an agent calls the wrong action or invents an absent fact", () => {
        const result = evaluateMemoryQuality(getTestCaseById("tc_memory_004"), {
            text: "你的电话号码是 13800138000。",
            toolCalls: [call("add", { content: "电话号码是 13800138000" })],
        });

        expect(result.passed).toBe(false);
        expect(result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: "action:search", pass: false }),
            expect.objectContaining({ name: "response_safety", pass: false }),
        ]));
    });

    it("checks action order and recall adoption when trace diagnostics exist", () => {
        const result = evaluateMemoryQuality(getTestCaseById("tc_memory_005"), {
            text: "已搜索并巩固 Python 学习记忆。",
            toolCalls: [call("search"), call("consolidate")],
            trace: { metadata: { memory_recall: { selected: [1], contextSelected: [1] } } },
        });

        expect(result.passed).toBe(true);
        expect(result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: "action_order", pass: true }),
        ]));
    });

    it("does not turn missing optional trace telemetry into a false quality failure", () => {
        const result = evaluateMemoryQuality(getTestCaseById("tc_memory_002"), {
            text: "你之前说过喜欢 Python。",
            toolCalls: [call("search", {}, '{"results":[{"content":"Python"}]}')],
        });
        expect(result.passed).toBe(true);
        expect(result.metrics.recallAdoption).toBeNull();
        expect(result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: "recall_adoption", pass: null, evaluated: false }),
        ]));
    });

    it("aggregates pass rate and quality dimensions for a run", () => {
        const first = evaluateMemoryQuality(getTestCaseById("tc_memory_001"), {
            text: "已记录 Python",
            toolCalls: [call("add", { content: "Python" })],
        });
        const second = evaluateMemoryQuality(getTestCaseById("tc_memory_004"), {
            text: "没有找到电话号码。",
            toolCalls: [call("search")],
        });
        const summary = aggregateMemoryQuality([{ memoryQuality: first }, { memoryQuality: second }]);

        expect(summary).toMatchObject({ version: "memory-quality-v1", total: 2, passed: 2, passRate: 1 });
        expect(summary.byCase).toHaveLength(2);
    });
});
