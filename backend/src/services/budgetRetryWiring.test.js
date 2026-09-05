import { describe, expect, it, afterEach } from "vitest";
import { buildChatOpenAIConfig } from "./chatUtils.js";
import { LLMJudge } from "../eval/judge.js";
import { toPublicError } from "./resilience.js";

/**
 * W4-R3 (C1) — 预算统一 + 接线语义锁。
 *
 * 预算统一：buildChatOpenAIConfig 默认 `maxRetries: 0`（LangChain 内部重试默认 2，
 * 会让"内部 maxRetries × withRetry"叠乘到 ~9 次）；withRetry 是唯一重试预算层。
 * legacy AgentExecutor 因"整 executor 重跑会重放工具副作用"保留内部单层（显式覆盖）。
 *
 * 接线：eval 离线 judge 的 raw `llm.invoke` 现被 withRetry 包裹（吞错前），并在回落时
 * 只用 toPublicError 的公开消息写 DB，不泄 provider secret。generator/optimize 为同构
 * wrapper（代码对称），此处以 judge 行为测锁定该模式。
 */

const PREV_ENV = {
    visionBase: process.env.VISION_BASE_URL,
    visionKey: process.env.VISION_API_KEY,
    openaiKey: process.env.OPENAI_API_KEY,
    openaiBase: process.env.OPENAI_BASE_URL,
};

afterEach(() => {
    for (const [k, v] of Object.entries(PREV_ENV)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

function secret503(secret) {
    return Object.assign(new Error(`fake judge upstream unavailable (${secret})`), { status: 503 });
}

describe("W4-R3 budget unification", () => {
    it("buildChatOpenAIConfig defaults maxRetries:0 (single retry layer via withRetry)", () => {
        process.env.OPENAI_API_KEY = "k";
        process.env.OPENAI_BASE_URL = "http://x";
        const cfg = buildChatOpenAIConfig();
        expect(cfg.maxRetries).toBe(0);
        expect(cfg.timeout).toBe(120000);
    });

    it("buildChatOpenAIConfig keeps explicit maxRetries override (executor keeps internal single layer)", () => {
        process.env.OPENAI_API_KEY = "k";
        process.env.OPENAI_BASE_URL = "http://x";
        const cfg = buildChatOpenAIConfig(false, { maxRetries: 2 });
        expect(cfg.maxRetries).toBe(2);
    });

    it("buildChatOpenAIConfig vision branch also defaults maxRetries:0", () => {
        process.env.OPENAI_API_KEY = "k";
        process.env.OPENAI_BASE_URL = "http://x";
        process.env.VISION_BASE_URL = "http://vision";
        process.env.VISION_API_KEY = "vk";
        const cfg = buildChatOpenAIConfig(true);
        expect(cfg.configuration.baseURL).toBe("http://vision");
        expect(cfg.maxRetries).toBe(0);
    });
});

describe("W4-R3 eval judge retry wiring", () => {
    const testCase = {
        id: "t-1",
        category: "knowledge_qa",
        difficulty: "medium",
        description: "问知识库问题",
        expectedBehavior: "基于文档回答",
        expectedTools: ["search_knowledge_base"],
    };
    const captured = { text: "回答内容", toolCallNames: ["search_knowledge_base"] };

    it("judge.evaluate retries a transient 503 via withRetry then succeeds (attempt == 2)", async () => {
        const judge = Object.create(LLMJudge.prototype); // 跳过真实 ChatOpenAI 构造
        let calls = 0;
        judge.llm = {
            invoke: async () => {
                calls += 1;
                if (calls === 1) throw secret503("provider-secret-judge-a");
                return {
                    content: JSON.stringify({
                        correctness: 5,
                        tool_usage: 4,
                        tool_quality: 4,
                        conciseness: 5,
                        safety: 5,
                        rationale: "良好",
                    }),
                };
            },
        };
        const result = await judge.evaluate(testCase, captured);
        expect(calls).toBe(2); // withRetry retries:2 → invoke 恰好 2 次
        expect(result.correctness).toBe(5);
        expect(result.tool_usage).toBe(4);
    });

    it("judge.evaluate exhaustion returns public (sanitized) error, never the provider secret", async () => {
        const SECRET = "provider-secret-judge-b";
        const judge = Object.create(LLMJudge.prototype);
        judge.llm = {
            invoke: async () => { throw secret503(SECRET); },
        };
        const result = await judge.evaluate(testCase, captured);
        // 耗尽 → 回落 0 分 + public error（与 before 一致），不泄 provider secret
        expect(result.correctness).toBe(0);
        expect(result.error).toBe(toPublicError(secret503(SECRET)).message);
        expect(result.error).not.toContain(SECRET);
        expect(result.rationale).not.toContain(SECRET);
    });
});
