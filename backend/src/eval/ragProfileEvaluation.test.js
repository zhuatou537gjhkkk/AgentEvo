import { describe, expect, it } from "vitest";
import { runRagProfileEvaluation } from "./ragProfileEvaluation.js";

describe("K9 RAG profile evaluation", () => {
    it("compares all profiles without persisting answer or evidence text", async () => {
        const cases = [
            { id: "positive", category: "semantic", query: "restart", relevantChunkIds: ["doc#1"], expectedPages: [2], noAnswer: false },
            { id: "negative", category: "no_answer", query: "quantum", relevantChunkIds: [], expectedPages: [], noAnswer: true },
        ];
        const result = await runRagProfileEvaluation({
            cases,
            retrieve: async ({ testCase }) => testCase.noAnswer
                ? { status: "no_match", items: [], metrics: { compression: { ratio: 1 } } }
                : { status: "ok", items: [{ chunkId: "doc#1", pageStart: 2, pageEnd: 2, content: "restart" }], metrics: { compression: { ratio: 0.8 } } },
            answer: async ({ response }) => response.status === "no_match" ? { status: "no_match", items: [], answer: "未找到" } : { ...response, answer: "restart [1]" },
        });
        expect(Object.keys(result.profiles)).toHaveLength(5);
        expect(result.profiles.full.summary.recallAtK).toBe(1);
        expect(result.profiles.full.summary.noAnswerPrecision).toBe(1);
        expect(result.gates.status).toBe("insufficient_sample");
        expect(result.profiles.full.cases[0].answer.deterministic).not.toHaveProperty("evidence");
    });
});
