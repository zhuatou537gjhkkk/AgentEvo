/**
 * agentReactLoop 单元测试 — Phase 7 / R3 #7。
 *
 * 用脚本化 fake resolveLlm 证明：
 *   (a) 单轮无工具 → 返回 fullText、无工具调用
 *   (b) 工具调用轮执行注入工具后再给最终正文
 *   (c) maxRounds 预算触底停止 → exceededBudget=true，且工具执行有界
 *   (d) 工具失败 → 安全 "工具暂时不可用" 并继续后续轮
 *   (e) capabilityGate 按名过滤工具（被禁工具绝不 invoke）
 *   (f) 结构化工具经 isStructuredTool 谓词判定，透传对象参数
 */

import { describe, it, expect, vi } from "vitest";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { runBoundedReactLoop } from "./agentReactLoop.js";

/**
 * 构造脚本化 fake LLM：每次 stream() 依次消耗一个"步骤"（返回 chunk 数组）。
 * chunk 支持 { content } 或 { content, tool_calls:[{name,args,id}] }。
 */
function makeFakeLlm(steps) {
    const queue = steps.slice();
    const llm = {
        boundTools: null,
        boundToolsNames: null,
        streamCalls: 0,
        stream: async function* (msgs, { signal } = {}) {
            this.streamCalls += 1;
            if (signal?.aborted) {
                const err = new Error("fake aborted");
                err.name = "AbortError";
                throw err;
            }
            const step = queue.length > 0 ? queue.shift() : [{ content: "(end)" }];
            const chunks = typeof step === "function" ? step(msgs) : step;
            for (const c of chunks) yield c;
        },
        bindTools(tools) {
            this.boundTools = tools;
            this.boundToolsNames = (tools || []).map((t) => t.name);
            return this;
        },
    };
    return llm;
}

/** 简单可调用工具（DynamicTool 风格：无 schema → 收到字符串入参） */
function fakeTool(name, impl, calls = []) {
    return {
        name,
        invoke: vi.fn(async (input, opts) => {
            calls.push(input);
            if (typeof impl === "function") return impl(input, opts);
            return impl;
        }),
    };
}

/** SSE 记录器：捕获四类事件便于断言 */
function makeSseRecorder() {
    const seen = { toolStart: [], toolEnd: [], toolError: [], textChunks: [] };
    return {
        seen,
        sse: {
            toolStart: (id, name, input) => seen.toolStart.push({ id, name, input }),
            toolEnd: (id, name, result) => seen.toolEnd.push({ id, name, result }),
            toolError: (id, name, msg) => seen.toolError.push({ id, name, msg }),
            textChunk: (text) => seen.textChunks.push(text),
        },
    };
}

describe("agentReactLoop (a) 单轮最终答案", () => {
    it("无工具时一轮返回正文，无工具调用、不超预算", async () => {
        const llm = makeFakeLlm([
            [{ content: "纯文字回答，不需要任何工具。" }],
        ]);
        const res = await runBoundedReactLoop({
            messages: [new SystemMessage("你是助手"), new HumanMessage("hi")],
            systemTools: [],
            resolveLlm: () => llm,
        });
        expect(res.fullText).toBe("纯文字回答，不需要任何工具。");
        expect(res.rounds).toBe(1);
        expect(res.toolCalls).toBe(0);
        expect(res.exceededBudget).toBe(false);
        expect(typeof res.usage.total_tokens).toBe("number");
    });
});

describe("agentReactLoop streamed tool-call chunks", () => {
    it("parses complete JSON args from tool_call_chunks instead of invoking an empty delta", async () => {
        const calls = [];
        const lookup = fakeTool("lookup", "found", calls);
        const llm = makeFakeLlm([
            [{ content: "", tool_call_chunks: [{ name: "lookup", args: '{"input":"late"}', id: "c1" }] }],
            [{ content: "读取完成。" }],
        ]);
        const result = await runBoundedReactLoop({
            messages: [new HumanMessage("read")],
            systemTools: [lookup],
            resolveLlm: () => llm,
        });
        expect(calls).toEqual(["late"]);
        expect(result.fullText).toBe("读取完成。");
    });

    it("uses function.arguments when an OpenAI-compatible chunk also has empty args", async () => {
        const calls = [];
        const lookup = fakeTool("lookup", "found", calls);
        const llm = makeFakeLlm([
            [{ content: "", tool_calls: [{ name: "lookup", args: {}, function: { arguments: '{"input":"from-function"}' }, id: "c1" }] }],
            [{ content: "读取完成。" }],
        ]);
        await runBoundedReactLoop({
            messages: [new HumanMessage("read")],
            systemTools: [lookup],
            resolveLlm: () => llm,
        });
        expect(calls).toEqual(["from-function"]);
    });
});

describe("agentReactLoop (b) 工具调用后给最终正文", () => {
    it("执行注入的工具，ToolMessage 回填后模型产出最终正文", async () => {
        const toolCalls = [];
        const lookup = fakeTool("lookup", "found=42", toolCalls);
        const llm = makeFakeLlm([
            [{ content: "", tool_calls: [{ name: "lookup", args: { input: "x" }, id: "c1" }] }],
            [{ content: "查到答案：42。" }],
        ]);
        const { seen, sse } = makeSseRecorder();
        const res = await runBoundedReactLoop({
            messages: [new HumanMessage("查一下 x")],
            systemTools: [lookup],
            resolveLlm: () => llm,
            sse,
        });
        expect(lookup.invoke).toHaveBeenCalledTimes(1);
        expect(toolCalls[0]).toBe("x"); // DynamicTool 风格 → 解开 input 字段直接给字符串入参
        expect(res.fullText).toBe("查到答案：42。");
        expect(res.rounds).toBe(2);
        expect(res.toolCalls).toBe(1);
        expect(res.exceededBudget).toBe(false);
        expect(seen.toolStart).toHaveLength(1);
        expect(seen.toolEnd).toHaveLength(1);
        expect(seen.toolError).toHaveLength(0);
    });
});

describe("agentReactLoop (c) maxRounds 预算触底", () => {
    it("模型每轮都要工具 → 预算耗尽返回 exceededBudget=true 且执行次数有界", async () => {
        const toolCalls = [];
        const busy = fakeTool("busy", "ok", toolCalls);
        const llm = makeFakeLlm([
            [{ content: "", tool_calls: [{ name: "busy", args: { input: "1" }, id: "c1" }] }],
            [{ content: "", tool_calls: [{ name: "busy", args: { input: "2" }, id: "c2" }] }],
            [{ content: "预算用尽，先给个阶段性结论。" }], // 收尾流
        ]);
        const res = await runBoundedReactLoop({
            messages: [new HumanMessage("deep task")],
            systemTools: [busy],
            resolveLlm: () => llm,
            budget: { maxRounds: 2 },
        });
        expect(res.exceededBudget).toBe(true);
        expect(res.rounds).toBe(2);
        expect(res.toolCalls).toBe(2); // 两轮各一次，未超过上限但轮数触底
        expect(busy.invoke).toHaveBeenCalledTimes(2);
        expect(res.fullText).toContain("阶段性结论");
    });
});

describe("agentReactLoop (d) 工具失败 → 安全文案并继续", () => {
    it("工具抛错给出 '工具暂时不可用'，下一轮模型仍可正常产出", async () => {
        const flaky = fakeTool("flaky", () => {
            const err = new Error("boom");
            throw err;
        });
        const llm = makeFakeLlm([
            [{ content: "", tool_calls: [{ name: "flaky", args: { input: "1" }, id: "c1" }] }],
            [{ content: "虽然 flaky 失败，但我还是能回答。" }],
        ]);
        const { seen, sse } = makeSseRecorder();
        const res = await runBoundedReactLoop({
            messages: [new HumanMessage("do it")],
            systemTools: [flaky],
            resolveLlm: () => llm,
            sse,
        });
        expect(flaky.invoke).toHaveBeenCalledTimes(1);
        expect(seen.toolError).toHaveLength(1);
        expect(seen.toolError[0].msg).toBe("工具暂时不可用");
        expect(seen.toolEnd).toHaveLength(0);
        expect(res.fullText).toBe("虽然 flaky 失败，但我还是能回答。");
        expect(res.rounds).toBe(2);
        expect(res.exceededBudget).toBe(false);
    });

    it("信号中止时工具错误向上抛出（不作为普通失败吞掉）", async () => {
        const ac = new AbortController();
        const hang = {
            name: "hang",
            invoke: async () => {
                ac.abort();
                const err = new Error("aborted");
                err.name = "AbortError";
                throw err;
            },
        };
        const llm = makeFakeLlm([
            [{ content: "", tool_calls: [{ name: "hang", args: {}, id: "c1" }] }],
        ]);
        await expect(
            runBoundedReactLoop({
                messages: [new HumanMessage("x")],
                systemTools: [hang],
                resolveLlm: () => llm,
                signal: ac.signal,
            })
        ).rejects.toThrow();
    });
});

describe("agentReactLoop (e) capabilityGate 按名过滤", () => {
    it("gate 只放行 public；secret 即使被模型点名也不 invoke", async () => {
        const secretCalls = [];
        const publicCalls = [];
        const secret = fakeTool("secret", "should-not-run", secretCalls);
        const pub = fakeTool("public", "ran", publicCalls);
        const gate = vi.fn((all) => ({ allowed: all.map((t) => t.name).filter((n) => n === "public") }));

        const llm = makeFakeLlm([
            [{ content: "", tool_calls: [{ name: "secret", args: { input: "s" }, id: "c1" }] }],
            [{ content: "", tool_calls: [{ name: "public", args: { input: "p" }, id: "c2" }] }],
            [{ content: "仅 public 被放行，secret 未执行。" }],
        ]);
        const res = await runBoundedReactLoop({
            messages: [new HumanMessage("x")],
            systemTools: [secret, pub],
            resolveLlm: () => llm,
            capabilityGate: gate,
        });
        expect(gate).toHaveBeenCalledTimes(1);
        expect(gate.mock.calls[0][0].map((t) => t.name)).toEqual(["secret", "public"]);
        expect(llm.boundToolsNames).toEqual(["public"]); // bindTools 只拿到放行的工具
        expect(secret.invoke).not.toHaveBeenCalled();
        expect(pub.invoke).toHaveBeenCalledTimes(1);
        expect(res.fullText).toContain("public 被放行");
        expect(res.toolCalls).toBe(2); // secret 记一次"不可用"，public 记一次成功
    });
});

describe("agentReactLoop execution hooks", () => {
    it("uses injected stream and tool hooks for tool rounds and budget finalization", async () => {
        const tool = fakeTool("lookup", "ok");
        const llm = makeFakeLlm([
            [{ content: "", tool_calls: [{ name: "lookup", args: { input: "x" }, id: "c1" }] }],
            [{ content: "", tool_calls: [{ name: "lookup", args: { input: "y" }, id: "c2" }] }],
            [{ content: "预算收尾正文" }],
        ]);
        const streamLlm = vi.fn((target, msgs, signal) => target.stream(msgs, { signal }));
        const invokeTool = vi.fn((target, input, signal) => target.invoke(input, { signal }));

        const res = await runBoundedReactLoop({
            messages: [new HumanMessage("x")],
            systemTools: [tool],
            resolveLlm: () => llm,
            budget: { maxRounds: 2 },
            streamLlm,
            invokeTool,
        });

        expect(res.fullText).toContain("预算收尾正文");
        expect(res.exceededBudget).toBe(true);
        expect(streamLlm).toHaveBeenCalledTimes(3);
        expect(invokeTool).toHaveBeenCalledTimes(2);
        expect(tool.invoke).toHaveBeenCalledTimes(2);
    });
});

describe("agentReactLoop (f) 结构化工具参数透传", () => {
    it("isStructuredTool 谓词命中的工具收到对象参数（非 JSON 字符串）", async () => {
        const kvCalls = [];
        const kv = fakeTool("kv", "stored", kvCalls);
        const llm = makeFakeLlm([
            [{ content: "", tool_calls: [{ name: "kv", args: { key: "a", value: "1" }, id: "c1" }] }],
            [{ content: "写入完成。" }],
        ]);
        const res = await runBoundedReactLoop({
            messages: [new HumanMessage("存个值")],
            systemTools: [kv],
            resolveLlm: () => llm,
            isStructuredTool: (t) => t.name === "kv",
        });
        expect(kvCalls[0]).toEqual({ key: "a", value: "1" }); // 对象直接透传
        expect(res.fullText).toBe("写入完成。");
        expect(res.toolCalls).toBe(1);
    });
});
