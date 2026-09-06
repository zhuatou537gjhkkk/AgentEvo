import { describe, it, expect } from "vitest";
import {
    parseTestOutput,
    deterministicCritic,
    shouldAcceptRefine,
    optionalLlmCritic,
    boundedRefine,
} from "./codingReflect.js";

describe("parseTestOutput — 确定性验证输出打分 (R3 #9)", () => {
    it("统计 N passed 的绿色输出", () => {
        const p = parseTestOutput("# tests 12\n# pass 12\n\n12 passed in 0.1s");
        expect(p.passed).toBe(12);
        expect(p.failed).toBe(0);
        expect(p.score).toBe(120);
    });

    it("统计 N failed 并把分数压到 0", () => {
        const p = parseTestOutput("3 passed, 2 failed in 0.4s");
        expect(p.passed).toBe(3);
        expect(p.failed).toBe(2);
        expect(p.score).toBe(0);
    });

    it("识别 Traceback / FAILED / 非零退出为失败标记", () => {
        const tb = parseTestOutput("Traceback (most recent call last):\n  File \"x.py\"");
        expect(tb.errorMarkers).toContain("failure-markers");
        expect(tb.score).toBe(0);
        const exit = parseTestOutput("node exited with code 1");
        expect(exit.errorMarkers).toContain("nonzero-exit");
        expect(deterministicCritic("node exited with code 1")).toMatchObject({ accept: false });
    });

    it("TAP ok/not ok 行计数", () => {
        const p = parseTestOutput("ok 1 - add works\nok 2 - sub works\nnot ok 3 - mul broken");
        expect(p.passed).toBe(2);
        expect(p.failed).toBe(1);
        expect(p.score).toBe(0);
    });
});

describe("deterministicCritic / shouldAcceptRefine — 验收门 (R3 DoD: 不变差才接受)", () => {
    it("ok:false → reject；ok:true 无失败标记 → accept", () => {
        expect(deterministicCritic({ ok: false, output: "" })).toMatchObject({ accept: false });
        expect(deterministicCritic({ ok: true, output: "1 passed" }).accept).toBe(true);
    });

    it("shouldAcceptRefine 要求 not worse", () => {
        expect(shouldAcceptRefine({ score: 10 }, { score: 20 })).toBe(true);
        expect(shouldAcceptRefine({ score: 20 }, { score: 10 })).toBe(false);
        expect(shouldAcceptRefine({ score: 10 }, { score: 10 })).toBe(true);
    });
});

describe("optionalLlmCritic — 可选 LLM，失败降级确定性", () => {
    it("无 llmCritic → 返回 deterministic reason", async () => {
        const out = await optionalLlmCritic({ deterministicReason: "验证失败" }, {});
        expect(out).toEqual({ suggestion: "验证失败", severity: "medium", source: "deterministic" });
    });

    it("有 llmCritic → 用其建议；抛错时降级", async () => {
        const out = await optionalLlmCritic(
            { deterministicReason: "fallback" },
            { llmCritic: async () => ({ suggestion: "补一个单测断言" }) },
        );
        expect(out.source).toBe("llm");
        expect(out.suggestion).toBe("补一个单测断言");
        const degraded = await optionalLlmCritic(
            { deterministicReason: "fallback" },
            { llmCritic: async () => { throw new Error("llm down"); } },
        );
        expect(degraded.source).toBe("deterministic");
        expect(degraded.suggestion).toBe("fallback");
    });
});

describe("boundedRefine — 有界反思闭环", () => {
    it("baseline 已通过 → 零轮反思即 accept", async () => {
        const res = await boundedRefine({ runVerify: async () => ({ ok: true, output: "5 passed" }) });
        expect(res.accepted).toBe(true);
        expect(res.rounds).toBe(0);
    });

    it("失败 → 修一次即绿 → 一轮 accept（rounds=1, actions=1）", async () => {
        let calls = 0;
        const res = await boundedRefine({
            runVerify: async () => ({ ok: false, output: "1 failed" }),
            applyFix: async () => { calls += 1; return { ok: true, output: "1 passed" }; },
        });
        expect(res.accepted).toBe(true);
        expect(res.rounds).toBe(1);
        expect(calls).toBe(1);
        expect(res.reasons.some((r) => r.includes("round 1: accepted"))).toBe(true);
    });

    it("始终修不好 → maxFixRounds 硬上限内 rejected，不越预算", async () => {
        let calls = 0;
        const res = await boundedRefine({
            budget: { maxFixRounds: 3, maxFixActions: 4 },
            runVerify: async () => ({ ok: false, output: "1 failed" }),
            applyFix: async () => { calls += 1; return { ok: false, output: "1 failed" }; },
        });
        expect(res.accepted).toBe(false);
        expect(calls).toBeLessThanOrEqual(3);
        expect(res.rounds).toBeLessThanOrEqual(3);
    });

    it("maxFixActions 先耗尽也停（动作预算与轮预算都算）", async () => {
        let calls = 0;
        const res = await boundedRefine({
            budget: { maxFixRounds: 10, maxFixActions: 2 },
            runVerify: async () => ({ ok: false, output: "boom\n1 failed" }),
            applyFix: async () => { calls += 1; return { ok: false, output: "1 failed" }; },
        });
        expect(res.accepted).toBe(false);
        expect(calls).toBe(2);
    });

    it("修完还是失败但分数上升不被当作成功（只有绿/不变差才 accept）", async () => {
        const res = await boundedRefine({
            budget: { maxFixRounds: 2 },
            runVerify: async () => ({ ok: false, output: "5 failed" }),
            applyFix: async () => ({ ok: false, output: "1 failed" }), // 改善但未绿 → 仍不算 accept
        });
        expect(res.accepted).toBe(false);
    });
});
