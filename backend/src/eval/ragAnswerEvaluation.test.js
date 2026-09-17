import { describe, expect, it } from "vitest";
import { evaluateDeterministicAnswer, evaluateRagAnswer, extractCitationRefs } from "./ragAnswerEvaluation.js";

const testCase = { id: "case-1", query: "如何重启？", relevantChunkIds: ["chunk-1"], expectedPages: [2], noAnswer: false };
const response = { status: "ok", items: [{ chunkId: "chunk-1", pageStart: 2, pageEnd: 2, content: "先停止再启动" }], answer: "先停止再启动 [1]" };

describe("K9 answer faithfulness contract", () => {
    it("extracts citations and accepts supported evidence", async () => {
        expect(extractCitationRefs("答案 [1]，重复 [1]。")).toEqual([1]);
        const result = await evaluateRagAnswer(testCase, response, {
            judge: async () => ({ value: { claims: [{ claim: "重启要先停止", supported: true, evidenceIds: ["chunk-1"], score: 1, critical: true }], score: 0.96 } }),
        });
        expect(result.passed).toBe(true);
        expect(result.deterministic.pageAccuracy).toBe(1);
        expect(result.faithfulness.score).toBe(0.96);
        expect(result.faithfulness.unsupportedCriticalClaims).toBe(0);
    });

    it("does not let a judge override an unknown citation", async () => {
        const result = await evaluateRagAnswer(testCase, { ...response, answer: "伪造来源 [2]" }, {
            judge: async () => ({ value: { claims: [], score: 1 } }),
        });
        expect(result.passed).toBe(false);
        expect(result.deterministic.deterministicFailures).toContain("RAG_CITATION_ID_NOT_ALLOWED");
        expect(result.faithfulness.status).toBe("blocked");
    });

    it("supports deterministic no-answer and safe bad-judge fallback", async () => {
        const noAnswer = await evaluateRagAnswer({ id: "none", query: "不存在", noAnswer: true, expectedPages: [] }, { status: "no_match", items: [], answer: "未找到足够证据。" });
        expect(noAnswer.passed).toBe(true);
        expect(noAnswer.deterministic.noAnswerCorrect).toBe(true);
        const badJudge = await evaluateRagAnswer(testCase, response, { judge: async () => ({ value: null }) });
        expect(badJudge.passed).toBe(false);
        expect(badJudge.faithfulness.reason).toBe("RAG_JUDGE_INVALID_JSON");
        const unknownJudgeId = await evaluateRagAnswer(testCase, response, { judge: async () => ({ value: { claims: [{ claim: "x", supported: true, evidenceIds: ["not-allowed"], score: 1 }], score: 1 } }) });
        expect(unknownJudgeId.faithfulness.reason).toBe("RAG_JUDGE_INVALID_JSON");
    });

    it("fails closed for owner isolation and stale evidence", () => {
        const ownerFailure = evaluateDeterministicAnswer(testCase, { ...response, items: [{ ...response.items[0], ownerAllowed: false }] });
        expect(ownerFailure.passed).toBe(false);
        expect(ownerFailure.deterministicFailures).toContain("RAG_OWNER_ISOLATION_FAILURE");
        const staleFailure = evaluateDeterministicAnswer({ ...testCase, staleRevision: true }, { ...response, items: [{ ...response.items[0], stale: true }] });
        expect(staleFailure.passed).toBe(false);
        expect(staleFailure.deterministicFailures).toContain("RAG_STALE_EVIDENCE");
    });
});
