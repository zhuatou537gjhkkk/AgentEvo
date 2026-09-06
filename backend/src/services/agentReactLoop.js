/**
 * agentReactLoop.js — Phase 7 / R3 #7：统一、有界 ReAct 编排器（通用/工作 Agent）。
 *
 * 现状：generalChatNode 内联了一段"工具感知的 ReAct 循环（MAX_TOOL_ROUNDS=5）"。
 * 本模块把这段逻辑抽成**LLM 无关**的编排器 —— 不 import 任何 LLM SDK、不 new
 * ChatOpenAI：LLM 由调用方经 `resolveLlm` 工厂注入；结构化工具判定用注入谓词
 * `isStructuredTool`（默认 duck-typing，避免 import DynamicStructuredTool 类）。
 *
 * 预算（budget）：
 *   maxRounds           单次编排最多 LLM 轮数（默认 5，对齐 generalChatNode）
 *   maxToolCalls        最多执行工具调用次数（默认 12）
 *   maxTranscriptChars  会话转录最大字符（默认 60000），防超长上下文
 *
 * 行为对齐 generalChatNode（今天的 ReAct 循环）：
 *   - 每轮走"绑定工具"的流式 LLM；文本随流式经 sse.textChunk 输出；
 *   - 本轮无 tool_calls → 已有文本即最终答案；
 *   - 有 tool_calls → 逐个执行 systemTools 中可用的工具，ToolMessage 回填；
 *   - 工具执行失败 → 安全的 "工具暂时不可用" 文案 + ToolMessage(ok:false)；
 *   - 命中 maxRounds / maxToolCalls 预算仍未产出最终答案 → exceededBudget=true，
 *     用基础 LLM（不带工具）再流式一次收尾，避免"工具后无正文"的哑场。
 *
 * 对外依赖仅 @langchain/core/messages（ToolMessage/AIMessage）。
 */

import { AIMessage, ToolMessage } from "@langchain/core/messages";

// ═══════════════════════════════════════════════════════
// 常量 / 内部工具
// ═══════════════════════════════════════════════════════

const DEFAULT_BUDGET = { maxRounds: 5, maxToolCalls: 12, maxTranscriptChars: 60000 };
const SAFE_TOOL_ERROR = "工具暂时不可用";

/** 把 LLM 返回的 content（string / 分块数组 / null）归一成纯文本 */
function toText(content) {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (typeof content === "number") return String(content);
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") return part;
                if (part && typeof part.text === "string") return part.text;
                return "";
            })
            .join("");
    }
    if (typeof content === "object" && typeof content.text === "string") return content.text;
    return String(content);
}

/** 转录字符数：content + name 的估算，用于 maxTranscriptChars 预算 */
function transcriptChars(msgs) {
    let n = 0;
    for (const m of msgs || []) {
        n += toText(m?.content).length;
        if (typeof m?.name === "string") n += m.name.length + 1;
    }
    return n;
}

/** 累加 usage（兼容 chunk.usage_metadata / chunk.usage 两种形态，缺省则忽略） */
function addUsage(usage, chunk) {
    const u = chunk?.usage_metadata || chunk?.usage;
    if (!u || typeof u.total_tokens !== "number") return;
    usage.prompt_tokens += u.prompt_tokens || 0;
    usage.completion_tokens += u.completion_tokens || 0;
    usage.total_tokens += u.total_tokens || 0;
}

/** 默认结构化工具判定：duck-typing（有 zod schema 即结构化），避免 import SDK 类 */
const duckIsStructuredTool = (tool) => Boolean(
    tool && typeof tool === "object" && typeof tool.schema?.parse === "function"
);

/** 安全序列化 args（工具调用参数，可能是对象或 JSON 串） */
function parseArgs(tc) {
    if (tc?.args != null) return tc.args;
    const fnArgs = tc?.function?.arguments;
    if (fnArgs == null) return {};
    if (typeof fnArgs === "string") {
        try {
            return JSON.parse(fnArgs);
        } catch (e) {
            return {};
        }
    }
    return fnArgs;
}

/** 把任意形态的 tool_calls 条目归一成 {name, id, args} */
function normalizeToolCall(tc, index) {
    const name = tc?.name || tc?.function?.name || `tool_${index}`;
    const id = tc?.id || tc?.function?.id || tc?.name || `call_${index}`;
    return { name, id, args: parseArgs(tc) };
}

/** 把 LLM 返回构造成 LangChain AIMessage 可接受的 tool_calls 形状 */
function toAIMessageToolCalls(calls) {
    return calls.map((c) => ({ type: "tool_call", name: c.name, args: c.args, id: c.id }));
}

/** 工具入参：结构化工具直接传对象；DynamicTool 风格工具需要字符串 */
function buildToolInput(tool, args, structuredCheck) {
    if (structuredCheck(tool)) return args;
    if (args && typeof args === "object" && args.input != null) {
        const input = args.input;
        return typeof input === "string" ? input : JSON.stringify(input);
    }
    return JSON.stringify(args);
}

/** 小重试包装：仅当错误标记 retryable 且还有次数时才重试（对齐上游降级语义） */
async function invokeToolWithRetry(tool, input, signal, retries = 1) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await tool.invoke(input, { signal });
        } catch (err) {
            if (signal?.aborted) throw err;
            lastErr = err;
            if (attempt >= retries || err?.retryable !== true) throw err;
        }
    }
    throw lastErr;
}

/** 收集一轮流式响应（content 拼接 + 末次 tool_calls + usage）；把文本即时推给 sse */
async function drainStream(stream, w, usage) {
    let content = "";
    let toolCalls = null; // null = 本流未携带任何 tool_calls
    for await (const chunk of stream) {
        const txt = toText(chunk?.content);
        if (txt) {
            content += txt;
            if (w.textChunk) w.textChunk(txt);
        }
        const raw = chunk?.tool_calls || chunk?.additional_kwargs?.tool_calls || [];
        if (raw && raw.length > 0) {
            // 携带 tool_calls 的 chunk 视为权威（与 streamEvents 的行为一致：末块给全量）
            toolCalls = raw.map((tc, i) => normalizeToolCall(tc, i));
        }
        addUsage(usage, chunk);
    }
    return { content, toolCalls: toolCalls || [] };
}

/** 预算触底后的收尾：用基础 LLM 流式产出一段正文，避免"工具执行后无文字" */
async function streamFinalAnswer(llm, transcript, sig, w, usage) {
    let out = "";
    const stream = await llm.stream(transcript, { signal: sig });
    for await (const chunk of stream) {
        const txt = toText(chunk?.content);
        if (txt) {
            out += txt;
            if (w.textChunk) w.textChunk(txt);
        }
        addUsage(usage, chunk);
    }
    return out;
}

// ═══════════════════════════════════════════════════════
// runBoundedReactLoop — 统一有界 ReAct 编排
// ═══════════════════════════════════════════════════════

/**
 * 执行一轮有界 ReAct：轮询「绑定工具的流式 LLM」→ 执行 tool_calls → ToolMessage 回填，
 * 直到 (a) 模型产出无工具正文、(b) 预算耗尽（exceededBudget=true + 收尾流）。
 *
 * @param {object} params
 * @param {Array}  params.messages        初始消息（LangChain BaseMessage[]）
 * @param {Array}  params.systemTools     可用工具数组（含 name/invoke；结构化工具可有 schema）
 * @param {Function} params.resolveLlm    工厂：() => ({ stream(msgs,{signal}), bindTools?(tools) })
 * @param {object} [params.sse]           可选：{toolStart,toolEnd,toolError,textChunk}
 * @param {AbortSignal} [params.signal]
 * @param {Function} [params.capabilityGate] (systemTools) => ({allowed: string[]}) 按名过滤工具
 * @param {object} [params.budget]        预算覆盖（见 DEFAULT_BUDGET）
 * @param {Function} [params.isStructuredTool] (tool)=>boolean；默认 duck-typing schema.parse
 * @returns {Promise<{fullText:string, rounds:number, toolCalls:number,
 *                    exceededBudget:boolean, usage:object}>}
 */
export async function runBoundedReactLoop({
    messages,
    systemTools,
    resolveLlm,
    sse,
    signal,
    capabilityGate,
    budget,
    isStructuredTool,
} = {}) {
    const b = { ...DEFAULT_BUDGET, ...(budget || {}) };
    const w = sse && typeof sse === "object" ? sse : {};
    const sig = signal || null;
    const structuredCheck = typeof isStructuredTool === "function" ? isStructuredTool : duckIsStructuredTool;

    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const transcript = Array.isArray(messages) ? messages.slice() : [];
    if (transcript.length === 0) {
        throw new Error("agentReactLoop: messages 不能为空");
    }

    // capabilityGate：按名字 allowlist 过滤可调用工具（未提供 → 全部可用）
    const availableTools = Array.isArray(systemTools) ? systemTools : [];
    let tools = availableTools;
    if (typeof capabilityGate === "function") {
        const gate = capabilityGate(availableTools) || {};
        const allowed = Array.isArray(gate.allowed) ? gate.allowed : null;
        if (allowed) {
            const allowSet = new Set(allowed);
            tools = availableTools.filter((t) => t && allowSet.has(t.name));
        }
    }

    // LLM：resolveLlm 是工厂（可返回绑定工具对象），也可能是已构造实例
    const llm = typeof resolveLlm === "function" ? resolveLlm() : resolveLlm;
    if (!llm || typeof llm.stream !== "function") {
        throw new Error("agentReactLoop: resolveLlm 必须返回具备 stream() 能力的 LLM");
    }

    const hasTools = tools.length > 0;
    const tooled = hasTools && typeof llm.bindTools === "function" ? llm.bindTools(tools) : llm;

    let fullText = "";
    let round = 0;
    let executedCalls = 0;
    let exceededBudget = false;
    let finalized = false; // 是否已在最后一轮做过收尾流（避免重复）

    while (round < b.maxRounds) {
        if (transcriptChars(transcript) > b.maxTranscriptChars) {
            exceededBudget = true;
            break;
        }
        round += 1;

        const response = await drainStream(
            await tooled.stream(transcript, { signal: sig }),
            w,
            usage,
        );

        if (response.toolCalls.length === 0) {
            // 本轮无工具调用 → 模型给出的文本即最终答案（已随流式推送）
            const text = response.content;
            if (text) fullText = fullText ? `${fullText}\n${text}` : text;
            if (text) transcript.push(new AIMessage({ content: text }));
            break;
        }

        // 有工具调用：把该轮响应（含 tool_calls）压入对话，再逐个执行
        transcript.push(new AIMessage({
            content: response.content || "",
            tool_calls: toAIMessageToolCalls(response.toolCalls),
        }));

        for (const tc of response.toolCalls) {
            executedCalls += 1;
            const tool = tools.find((t) => t && t.name === tc.name);
            if (!tool) {
                const msg = "工具不可用";
                const content = JSON.stringify({ ok: false, data: null, errorCode: "TOOL_NOT_FOUND", message: msg, retryable: false });
                transcript.push(new ToolMessage({ content, tool_call_id: tc.id, name: tc.name }));
                if (w.toolError) w.toolError(tc.id, tc.name, msg);
                continue;
            }
            const input = buildToolInput(tool, tc.args, structuredCheck);
            const inputForSse = typeof input === "string" ? input : JSON.stringify(input);
            if (w.toolStart) w.toolStart(tc.id, tc.name, inputForSse);
            try {
                const result = await invokeToolWithRetry(tool, input, sig, 1);
                const resultStr = typeof result === "string" ? result : JSON.stringify(result);
                if (w.toolEnd) w.toolEnd(tc.id, tc.name, resultStr);
                transcript.push(new ToolMessage({ content: resultStr, tool_call_id: tc.id, name: tc.name }));
            } catch (err) {
                if (sig?.aborted) throw err; // 客户端断连 → 向上抛
                if (w.toolError) w.toolError(tc.id, tc.name, SAFE_TOOL_ERROR);
                transcript.push(new ToolMessage({
                    content: JSON.stringify({ ok: false, data: null, errorCode: "TOOL_FAILED", message: SAFE_TOOL_ERROR, retryable: Boolean(err?.retryable) }),
                    tool_call_id: tc.id,
                    name: tc.name,
                }));
            }
        }

        // 预算上限检查
        if (executedCalls >= b.maxToolCalls || round >= b.maxRounds) {
            exceededBudget = true;
            if (!finalized) {
                finalized = true;
                fullText = fullText ? `${fullText}\n` : "";
                fullText += await streamFinalAnswer(llm, transcript, sig, w, usage);
            }
            break;
        }
    }

    if (round >= b.maxRounds && !finalized && fullText.length === 0) {
        // 理论上不可达（while 内已收尾），兜底标记预算用尽
        exceededBudget = true;
    }

    return { fullText, rounds: round, toolCalls: executedCalls, exceededBudget, usage };
}
