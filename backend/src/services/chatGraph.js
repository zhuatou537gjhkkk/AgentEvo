/**
 * chatGraph.js — LangGraph 多 Agent 编排管道
 *
 * Phase 2 核心：Router → 子 Agent → Synthesizer 拓扑
 * 通过 process.env.USE_LANGGRAPH === 'true' 启用，旧路径 chatWithStream 不受影响。
 *
 * 对应 Hello-Agents: Ch6 (LangGraph StateGraph) + Ch14 (DeepResearch 多 Agent 模式)
 */

import crypto from "crypto";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, AIMessageChunk, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { StateGraph, START, END, Annotation, addMessages, MemorySaver, Send } from "@langchain/langgraph";
import { saveMessage, getHistoryMessages } from "../db/index.js";
import { agentTools, consumePendingQuestion, cancelAllPendingQuestions, setMemoryToolContext } from "../mcp/tools.js";
import { toolRegistry } from "../mcp/registry.js";
import { MemoryService } from "./memory.js";
import { createChatContextBuilder } from "./contextBuilder.js";
import { TraceCollector } from "../trace/collector.js";
import {
    WEB_SEARCH_TOOL_NAME,
    FORCED_WEB_SEARCH_MAX_CHARS,
    TOOL_ACTIVE_FORMS,
    normalizeChunkContent,
    normalizeTemperature,
    resolveSystemPrompt,
    resolveModelName,
    buildChatOpenAIConfig,
    estimateTokens,
    extractUsageFromChunk,
    emitThought,
    toLangChainMessage,
    isCreativeTask,
    buildDirectAnswerSystemInstruction,
    streamDirectChat,
    buildHumanInputMessage,
    PLAN_MODE_INSTRUCTION,
} from "./chatUtils.js";

// ═══════════════════════════════════════════════════════
// Agent 身份标签
// ═══════════════════════════════════════════════════════

const AGENT_META = {
    router:       { name: "路由Agent",   type: "router",          icon: "🧭" },
    search:       { name: "搜索Agent",   type: "searchAgent",     icon: "🔍" },
    knowledge:    { name: "知识库Agent", type: "knowledgeAgent",  icon: "📚" },
    general:      { name: "通用Agent",   type: "generalAgent",    icon: "💬" },
    code:         { name: "代码Agent",   type: "codeAgent",       icon: "💻" },
    synthesizer:  { name: "综合Agent",   type: "synthesizer",     icon: "🧩" },
    tool_executor:{ name: "工具执行",     type: "toolExecutor",    icon: "🔧" },
};

// intent → 节点名 映射表
const AGENT_NODE_MAP = {
    search:    "search_agent",
    knowledge: "knowledge_agent",
    code:      "code_agent",
    general:   "general_chat",
};

// Phase 4: 动态 intent → 节点映射（Router 工具感知后，intent 可能超出 4 固定枚举）
function mapIntentToNode(intent) {
    // 1. 已知 Agent 节点（有特殊逻辑的，直接映射）
    if (AGENT_NODE_MAP[intent]) return AGENT_NODE_MAP[intent];

    // 2. ToolRegistry 中有对应工具类别 → 路由到 tool_executor
    if (toolRegistry.hasToolCategory(intent)) return "tool_executor";

    // 3. Fallback
    console.log(`[graph][route] unknown intent "${intent}", falling back to general_chat`);
    return "general_chat";
}

// ═══════════════════════════════════════════════════════
// LangGraph 状态定义
// ═══════════════════════════════════════════════════════

const AgentState = Annotation.Root({
    // 消息历史（LangGraph addMessages reducer 自动合并）
    messages: Annotation({ default: () => [] }),

    // 用户输入
    userInput: Annotation({ default: () => "" }),
    chatHistory: Annotation({ default: () => [] }),
    currentDate: Annotation({ default: () => "" }),

    // 配置
    enableWebSearch: Annotation({ default: () => false }),
    planMode: Annotation({ default: () => false }),
    enableMemory: Annotation({ default: () => true }),
    systemPrompt: Annotation({ default: () => "你是一个有用的 AI 助手。" }),
    temperature: Annotation({ default: () => 0.7 }),
    modelName: Annotation({ default: () => "deepseek-v4-flash" }),

    // 路由字段（多意图：Router 可返回多个意图并行执行）
    intent: Annotation({ default: () => "general" }),
    intents: Annotation({ default: () => ["general"] }),
    primarySource: Annotation({ default: () => null }),

    // Phase 4: 上下文工程 — GSSC 管道构建的优化上下文
    optimizedContext: Annotation({ default: () => "" }),

    // Agent 追踪（自定义 reducer 支持并行节点并发写入）
    currentAgent: Annotation({
        default: () => null,
        reducer: (_, update) => update,
    }),
    previousAgent: Annotation({
        default: () => null,
        reducer: (_, update) => update,
    }),

    // 负载（各子 Agent 的结果）
    searchResults: Annotation({ default: () => "" }),
    knowledgeResults: Annotation({ default: () => "" }),
    codeResults: Annotation({ default: () => "" }),

    // Plan 模式产物（merge reducer：并行 Agent 更新不同步骤时自动合并）
    plan: Annotation({
        default: () => [],
        reducer: (current, update) => {
            if (!Array.isArray(update) || update.length === 0) return current;
            if (!Array.isArray(current) || current.length === 0) return update;
            const merged = current.map((step) => {
                const match = update.find((u) => u.id === step.id);
                return match ? { ...step, ...match } : step;
            });
            for (const u of update) {
                if (!merged.find((m) => m.id === u.id)) merged.push(u);
            }
            return merged;
        },
    }),

    // ═══════════════════════════════════════════════════════
    // Phase 4 P0: Plan 驱动多 Agent 执行
    // ═══════════════════════════════════════════════════════

    // Planner 输出：subTask[] 驱动执行（替代 display-only plan steps）
    subTasks: Annotation({
        default: () => [],
        reducer: (current, update) => {
            if (!Array.isArray(update) || update.length === 0) return current;
            if (!Array.isArray(current) || current.length === 0) return update;
            const merged = current.map((step) => {
                const match = update.find((u) => u.id === step.id);
                return match ? { ...step, ...match } : step;
            });
            for (const u of update) {
                if (!merged.find((m) => m.id === u.id)) merged.push(u);
            }
            return merged;
        },
    }),

    // planResults: { subTaskId: resultText } — 并行执行结果收集
    planResults: Annotation({
        default: () => ({}),
        reducer: (current, update) => {
            if (!update || typeof update !== "object") return current;
            return { ...current, ...update };
        },
    }),

    // currentSubTask: 当前正在执行的 subTask（注入到 Send target）
    currentSubTask: Annotation({
        default: () => null,
        reducer: (_, update) => update,
    }),

    // tokenUsage: 累加所有 LLM 调用的真实 API token usage（并行节点 sum reducer）
    tokenUsage: Annotation({
        default: () => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
        reducer: (current, update) => {
            if (!update) return current;
            return {
                prompt_tokens: (current?.prompt_tokens || 0) + (update.prompt_tokens || 0),
                completion_tokens: (current?.completion_tokens || 0) + (update.completion_tokens || 0),
                total_tokens: (current?.total_tokens || 0) + (update.total_tokens || 0),
            };
        },
    }),

    // SSE 上下文（通过闭包注入，不存到 checkpoint）
    sseEnabled: Annotation({ default: () => true }),
});

// ═══════════════════════════════════════════════════════
// SSE 事件发射器（闭包捕获 res）
// ═══════════════════════════════════════════════════════

function createSSEEmitter(res, traceCollector = null, traceId = null) {
    /** @type {string|null} — current agent span ID */
    let currentAgentSpanId = null;
    /** @type {Map<string, string>} — toolCallId → toolSpanId */
    const toolSpanMap = new Map();

    /** 检查 trace 是否仍然存活（未因 abort/disconnect 被 finishTrace 清理） */
    const _traceAlive = () => traceCollector && traceId && traceCollector.getTrace(traceId);

    return {
        agentStart(agentType) {
            const meta = AGENT_META[agentType] || {};
            const payload = {
                type: "agent_start",
                agentName: meta.name || agentType,
                agentType: meta.type || agentType,
                at: new Date().toISOString(),
            };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { /* response ended */ }
            // Phase 5: start agent span
            if (_traceAlive()) {
                currentAgentSpanId = traceCollector.startSpan(traceId, payload.agentName, "agent",
                    currentAgentSpanId || traceId);
            }
        },
        agentEnd(agentType) {
            const meta = AGENT_META[agentType] || {};
            const payload = {
                type: "agent_end",
                agentName: meta.name || agentType,
                agentType: meta.type || agentType,
                at: new Date().toISOString(),
            };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { /* response ended */ }
            // Phase 5: end agent span
            if (_traceAlive() && currentAgentSpanId) {
                traceCollector.endSpan(traceId, currentAgentSpanId);
                currentAgentSpanId = null;
            }
        },
        agentHandoff(fromType, toType) {
            const fromMeta = AGENT_META[fromType] || {};
            const toMeta = AGENT_META[toType] || {};
            const payload = {
                type: "agent_handoff",
                from: fromMeta.name || fromType,
                fromType: fromMeta.type || fromType,
                to: toMeta.name || toType,
                toType: toMeta.type || toType,
                at: new Date().toISOString(),
            };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { /* response ended */ }
        },
        toolStart(toolCallId, toolName, input, agentType) {
            const meta = AGENT_META[agentType] || {};
            const payload = {
                type: "tool_start",
                toolCallId,
                toolName,
                input,
                at: new Date().toISOString(),
                activeForm: TOOL_ACTIVE_FORMS[toolName] || "正在执行...",
                agentName: meta.name || agentType || "core",
                agentType: meta.type || agentType || "react",
            };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { /* response ended */ }
            // Phase 5: start tool span
            if (_traceAlive()) {
                const parentId = currentAgentSpanId || traceId;
                const toolSpanId = traceCollector.startSpan(traceId, toolName, "tool", parentId, { input });
                if (toolSpanId) toolSpanMap.set(toolCallId, toolSpanId);
            }
        },
        toolEnd(toolCallId, toolName, output, agentType) {
            const meta = AGENT_META[agentType] || {};
            const payload = {
                type: "tool_end",
                toolCallId,
                toolName,
                output: typeof output === "string" ? output.slice(0, 500) : "",
                at: new Date().toISOString(),
                agentName: meta.name || agentType || "core",
                agentType: meta.type || agentType || "react",
            };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { /* response ended */ }
            // Phase 5: end tool span
            if (_traceAlive()) {
                const toolSpanId = toolSpanMap.get(toolCallId);
                if (toolSpanId) {
                    traceCollector.endSpan(traceId, toolSpanId, { output: typeof output === "string" ? output.slice(0, 200) : "" });
                    toolSpanMap.delete(toolCallId);
                }
            }
        },
        toolError(toolCallId, toolName, error, agentType) {
            const meta = AGENT_META[agentType] || {};
            const payload = {
                type: "tool_error",
                toolCallId,
                toolName,
                error: String(error),
                at: new Date().toISOString(),
                agentName: meta.name || agentType || "core",
                agentType: meta.type || agentType || "react",
            };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { /* response ended */ }
            // Phase 5: end tool span with error
            if (_traceAlive()) {
                const toolSpanId = toolSpanMap.get(toolCallId);
                if (toolSpanId) {
                    traceCollector.endSpan(traceId, toolSpanId, { error: String(error) });
                    toolSpanMap.delete(toolCallId);
                }
            }
        },
        textChunk(text) {
            try { res.write(`data: ${JSON.stringify({ type: "text", text })}\n\n`); } catch (_) { /* response ended */ }
        },
        todoUpdated(todos) {
            try {
                res.write(`data: ${JSON.stringify({
                    type: "todo_updated",
                    todos,
                    at: new Date().toISOString(),
                })}\n\n`);
            } catch (_) { /* response ended */ }
        },
    };
}

// ═══════════════════════════════════════════════════════
// 工具执行辅助：在 Agent 节点内手动执行工具调用并发射 SSE
// ═══════════════════════════════════════════════════════

async function executeToolCalls(toolCalls, agentType, sse, toolsMap) {
    const results = [];
    for (const toolCall of toolCalls) {
        const tool = toolsMap.get(toolCall.name);
        const toolCallId = toolCall.id || crypto.randomUUID();

        if (!tool) {
            sse.toolError(toolCallId, toolCall.name, `未找到工具: ${toolCall.name}`, agentType);
            results.push(new ToolMessage({
                content: `工具未找到: ${toolCall.name}`,
                tool_call_id: toolCall.id,
            }));
            continue;
        }

        // 发射 tool_start
        sse.toolStart(toolCallId, toolCall.name, toolCall.args, agentType);

        try {
            const toolResult = await tool.invoke(toolCall.args);
            const output = normalizeChunkContent(toolResult);
            sse.toolEnd(toolCallId, toolCall.name, output, agentType);

            // update_todo 特殊处理：发射 todo_updated
            if (toolCall.name === "update_todo") {
                try {
                    let parsed = toolCall.args;
                    if (typeof parsed === "string") {
                        try { parsed = JSON.parse(parsed); } catch { /* ignore */ }
                    }
                    if (parsed?.todos) {
                        sse.todoUpdated(parsed.todos);
                    }
                } catch { /* ignore */ }
            }

            // ask_user_question 特殊处理：延迟发射
            if (toolCall.name === "ask_user_question") {
                const pending = consumePendingQuestion();
                if (pending) {
                    // ask_user_question SSE 在 chatWithGraph 环境中通过 setImmediate 处理
                    // 这里通过 state 标记，外部循环处理
                }
            }

            results.push(new ToolMessage({
                content: output,
                tool_call_id: toolCall.id,
            }));
        } catch (err) {
            sse.toolError(toolCallId, toolCall.name, err.message, agentType);
            results.push(new ToolMessage({
                content: `工具执行失败: ${err.message}`,
                tool_call_id: toolCall.id,
            }));
        }
    }
    return results;
}

// ═══════════════════════════════════════════════════════
// 节点 1: InitializeNode — 初始化状态
// ═══════════════════════════════════════════════════════

function initializeNode(state) {
    console.log(`[graph][init] userInput length=${state.userInput.length} enableWebSearch=${state.enableWebSearch} enableMemory=${state.enableMemory}`);
    return { currentAgent: "router" };
}

// ═══════════════════════════════════════════════════════
// 节点 2: RouterNode — LLM 意图分类
// ═══════════════════════════════════════════════════════

async function routerNode(state, config) {
    console.log(`[graph][router] classifying intent for: "${state.userInput.slice(0, 80)}..."`);
    const signal = config?.configurable?.abortSignal;

    const llm = new ChatOpenAI({
        modelName: state.modelName,
        temperature: 0,
        ...buildChatOpenAIConfig(),
    });

    // Phase 4: 动态构建工具类别列表（从 ToolRegistry 实时获取）
    const categories = toolRegistry.getToolCategories();
    const categoryLines = categories.map(c => {
        const toolList = c.tools.map(t => `\`${t.name}\``).join(", ");
        return `- "${c.category}": ${toolList} (${c.type === "local" ? "内置" : "外部MCP"})`;
    }).join("\n");

    const knownCategoryHint = categories
        .filter(c => !["search", "knowledge", "system", "general"].includes(c.category))
        .map(c => `- "${c.category}": 外部工具类别，适合需要${c.tools[0]?.description?.slice(0, 40) || "调用外部工具"}的任务`)
        .join("\n");

    const planHint = state.planMode
        ? `\n\n注意：计划模式已开启。请在 analysis 中列出执行步骤，并始终返回 JSON 格式。`
        : "";

    const webSearchHint = state.enableWebSearch
        ? `\n\n⚠️ 联网搜索当前**已开启**。用户的问题适合通过搜索引擎获取更准确/更新信息时，请优先使用 "search" 而非 "general"。只有纯闲聊、问候、创意写作才用 "general"。`
        : `\n\n⚠️ 联网搜索当前**未开启**。"search" 意图不可用，请用 "general" 替代。`;

    const prompt = `你是一个智能路由助手。分析用户的问题，判断需要哪些专业智能体来处理。可以同时选择多个。

固定分类：
- "general": 普通对话、问候、闲聊、创意写作（纯主观/创造性任务，不需要外部信息）
- "search": 需要搜索最新网络信息或获取事实性知识（新闻、实时数据、技术概念解释、近期事件）
- "knowledge": 需要从已上传的文档/知识库中检索信息（用户提到了文档、资料、文件等）
- "code": 需要编写、分析或调试代码${webSearchHint}

当前系统额外可用的工具类别（实时注册中心提供）：
${knownCategoryHint || "(暂无额外工具类别)"}

当前所有可用工具：
${categoryLines}${planHint}

用户问题：${state.userInput}

请严格返回 JSON 格式，不要包含其他文字：
{"intents": ["general"], "primarySource": null, "analysis": "一句话理由"}

	intents 规则：
	- ⚠️ 仔细扫描用户问题中的**多意图信号词**：如"顺便"、"同时"、"还有"、"另外"、"也帮我"、"另外查一下"、"再加上"等，出现这些词时应返回多个意图，不要只选一个
	- 多意图常见组合示例：
	  * "介绍XX，顺便在知识库里找找" → ["search", "knowledge"]（介绍话题需要搜索 + 知识库检索）
	  * "查一下AA，另外帮我写个BB的代码" → ["search", "code"]
	  * "读写文件XX并分析内容" → ["filesystem", "general"]
	  * "分析这段代码，看看网上有没有更好的写法" → ["code", "search"]
	- 单意图示例：纯问知识 → ["general"]；纯搜实时信息 → ["search"]；纯查文档 → ["knowledge"]；纯写代码 → ["code"]
	- "general" 通常不与其他意图组合，除非用户明确要求"闲聊的同时做某事"
	- 如果用户的问题涉及上述"额外工具类别"中的操作（如读写文件），请使用对应的类别名（如 "filesystem"）`;


    let intent = "general";
    let intents = ["general"];
    let primarySource = null;
    let analysis = "";

    let routerUsage = null;
    try {
        const response = await llm.invoke([new SystemMessage(prompt)], { signal });
        routerUsage = extractUsageFromChunk(response);
        const text = normalizeChunkContent(response.content || "");

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);

            // 新格式：intents 数组
            if (Array.isArray(parsed.intents) && parsed.intents.length > 0) {
                intents = parsed.intents;
            } else if (parsed.intent && typeof parsed.intent === "string") {
                // 兼容旧格式：单 intent 字符串
                intents = [parsed.intent];
            }

            intent = intents[0] || "general";
            primarySource = parsed.primarySource || null;
            analysis = parsed.analysis || "";
        }
    } catch (err) {
        console.log(`[graph][router] classification failed, defaulting to general: ${err.message}`);
    }

    // ── Phase 4 能力校验 (主闸门)：对每个意图逐个过滤 ──
    const filteredIntents = intents.filter((i) => {
        // 固定规则：search 意图 + 联网关闭 → 移除
        if (i === "search" && !state.enableWebSearch) {
            console.log(`[graph][router] capability gate: search removed (enableWebSearch=false)`);
            return false;
        }
        // 动态规则：MCP 类别 → 验证 ToolRegistry 中确实有可用工具
        if (!["general", "search", "knowledge", "code"].includes(i)) {
            if (!toolRegistry.hasToolCategory(i)) {
                console.log(`[graph][router] capability gate: "${i}" removed (no tools in registry)`);
                return false;
            }
        }
        return true;
    });

    // 全部被过滤 → 降级为 general
    if (filteredIntents.length === 0) {
        filteredIntents.push("general");
        console.log(`[graph][router] all intents filtered, degraded to general`);
    }

    // 更新 primary intent
    const primaryIntent = filteredIntents[0];
    if (primaryIntent !== "search") primarySource = null;

    console.log(
        `[graph][router] intents=[${filteredIntents.join(",")}] primarySource=${primarySource} analysis="${analysis}"` +
        (intents.length !== filteredIntents.length ? ` [filtered: ${intents.length}→${filteredIntents.length}]` : "")
    );

    return {
        intent: primaryIntent,
        intents: filteredIntents,
        primarySource,
        currentAgent: "router",
        messages: [new AIMessage({ content: `[Router] 分类结果: ${filteredIntents.join(", ")} — ${analysis}` })],
        tokenUsage: routerUsage,
    };
}

// ═══════════════════════════════════════════════════════
// Plan 辅助：强制执行 gather → analyze → synthesize 排序
// 保持 LLM 生成的动态内容，仅按步骤类型调整顺序
// ═══════════════════════════════════════════════════════

// 关键词必须能清楚地区分步骤类型。去掉了歧义词：
//   "提取"/"读取" — 在上下文中通常是"从结果中提取"(分析)，而非外部获取
//   "请求"/"调用" — 太通用
//   "组织" — 可能是"组织答案"(综合)或"组织信息"(分析)
const STEP_GATHER_KEYWORDS = ['搜索', '检索', '获取', '查找', '查询', '收集', '联网'];
const STEP_SYNTHESIZE_KEYWORDS = ['总结', '整合', '归纳', '输出', '生成', '综合', '撰写', '回答', '回复', '呈现'];

function getStepCategory(step) {
    const content = step.content || '';
    if (STEP_GATHER_KEYWORDS.some((kw) => content.includes(kw))) return 0;   // gather first
    if (STEP_SYNTHESIZE_KEYWORDS.some((kw) => content.includes(kw))) return 2; // synthesize last
    return 1; // analyze/filter in the middle
}

function enforcePlanOrder(plan) {
    if (!Array.isArray(plan) || plan.length < 2) return plan;
    const sorted = [...plan].sort((a, b) => getStepCategory(a) - getStepCategory(b));
    // Reassign sequential IDs
    return sorted.map((step, i) => ({ ...step, id: String(i + 1) }));
}

// ═══════════════════════════════════════════════════════
// Plan 辅助：构建 plan-aware system prompt 片段
// ═══════════════════════════════════════════════════════

function buildPlanAwareInstruction(plan, agentType) {
    if (!Array.isArray(plan) || plan.length === 0) return '';
    const planLines = plan.map((s) =>
        `  ${s.id}. ${s.content} [${s.status === 'in_progress' ? '← 当前步骤' : 'pending'}]`
    ).join('\n');
    return `
[任务执行计划]
你需要按照以下计划逐步执行。你拥有 update_todo 工具来更新计划的执行状态：
- 开始执行某个步骤前，调用 update_todo 将该步骤标记为 in_progress
- 完成某个步骤后，调用 update_todo 将其标记为 completed，并将下一步标记为 in_progress
- 一次 update_todo 调用可以同时更新多个步骤的状态

当前计划：
${planLines}

请先调用 update_todo 标记你要执行的第一个步骤为 in_progress，再调用其他工具。`;
}

// ═══════════════════════════════════════════════════════
// Plan 辅助：统一的计划进度发射器
//
// 业界调研结论（Manus/Devin/LangGraph）：
//   进度由编排层/框架层自动驱动，不依赖 LLM 调用 update_todo。
//   本函数是唯一的进度发射入口，所有 Agent 节点通过 phase 参数表达当前阶段，
//   由函数内部根据步骤类别（gather/analyze/synthesize）自动计算新状态。
// ═══════════════════════════════════════════════════════

/**
 * @param {object} sse - SSE emitter
 * @param {array}  plan - 计划步骤数组
 * @param {'agent_start'|'tools_done'|'all_done'|'synth_start'} phase
 *        agent_start  — 子 Agent 开始工作：首个 pending 步骤 → in_progress
 *        tools_done   — 工具执行完成，LLM 总结即将开始：
 *                        gather+analyze → completed, synthesize → in_progress
 *        all_done     — 全部工作完成：所有步骤 → completed
 *        synth_start  — Synthesizer 启动：最后一个 pending 步骤 → in_progress
 */
function emitPlanProgress(sse, plan, phase) {
    if (!sse || !plan || plan.length === 0) return plan;

    const updated = plan.map((s) => ({ ...s }));

    switch (phase) {
        case 'agent_start': {
            // 首个非 completed 步骤 → in_progress
            for (const step of updated) {
                if (step.status !== 'completed') {
                    step.status = 'in_progress';
                    break;
                }
            }
            console.log(`[graph][progress] agent_start: step ${updated.findIndex(s => s.status === 'in_progress') + 1} → in_progress`);
            break;
        }
        case 'tools_done': {
            // 工具执行完毕 → gather+analyze 标记 completed，synthesize 标记 in_progress
            let changed = 0;
            for (const step of updated) {
                const cat = getStepCategory(step);
                if (cat <= 1 && step.status !== 'completed') {
                    step.status = 'completed';
                    changed++;
                } else if (cat === 2 && step.status !== 'completed' && step.status !== 'in_progress') {
                    step.status = 'in_progress';
                    changed++;
                }
            }
            console.log(`[graph][progress] tools_done: ${changed} steps updated (gather/analyze→completed, synthesize→in_progress)`);
            break;
        }
        case 'all_done': {
            for (const step of updated) step.status = 'completed';
            console.log(`[graph][progress] all_done: ${updated.length} steps → completed`);
            break;
        }
        case 'synth_start': {
            // 最后一个非 completed 步骤 → in_progress
            for (let i = updated.length - 1; i >= 0; i--) {
                if (updated[i].status !== 'completed') {
                    updated[i].status = 'in_progress';
                    console.log(`[graph][progress] synth_start: step ${i + 1} → in_progress`);
                    break;
                }
            }
            break;
        }
        default:
            break;
    }

    sse.todoUpdated(updated);
    return updated;  // 返回更新后的 plan，供调用方更新 LangGraph State
}

// ═══════════════════════════════════════════════════════
// 节点 2.5: PlannerNode — Plan-Solve 计划生成（planMode=true 时激活）
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// Phase 4 P0: PlannerNode — subTask[] 驱动执行
//
// planMode=true 时：
//   - 从 ToolRegistry 获取可用工具列表
//   - LLM 分解为 subTask[]（区分 tool/reasoning 类型）
//   - 校验 toolName 可用性
//   - 同时生成兼容 plan steps（供 TaskProgressCard）
// planMode=false 时：直接跳过
// ═══════════════════════════════════════════════════════

async function plannerNode(state, config) {
    const sse = config?.configurable?.sse;
    const signal = config?.configurable?.abortSignal;

    // 非 Plan 模式 → 跳过
    if (!state.planMode) {
        console.log(`[graph][planner] skipped (planMode=false)`);
        return { currentAgent: "router" };
    }

    // general 意图（纯 general，无其他混合意图）→ 跳过（简单对话不需要分解）
    const allIntents = state.intents || [state.intent || "general"];
    if (state.intent === "general" && allIntents.length === 1) {
        console.log(`[graph][planner] skipped (intent=general, no mixed intents)`);
        return { currentAgent: "router" };
    }

    console.log(`[graph][planner] generating subTasks for intent="${state.intent}"`);

    const llm = new ChatOpenAI({
        modelName: state.modelName,
        temperature: 0,
        ...buildChatOpenAIConfig(),
    });

    // Phase 4: 构建可用工具列表（从 ToolRegistry 动态获取）
    const categories = toolRegistry.getToolCategories();
    const toolListText = categories.map(c => {
        return c.tools.map(t => `- \`${t.name}\`: ${(t.description || "").slice(0, 80)}`).join("\n");
    }).join("\n");

    const prompt = `你是一个任务规划助手。将用户的请求分解为具体的执行步骤（subTasks）。

当前可用的工具列表：
${toolListText || "(暂无可用工具)"}

用户问题：${state.userInput}
用户意图类型：${[...new Set(state.intents || [state.intent || "general"])].join("、")}

每个 subTask 包含以下字段：
- id: 字符串ID（从"1"递增）
- type: "tool"（调用工具获取数据）或 "reasoning"（分析/推理/综合）
- content: 步骤的人类可读描述
- toolName: 仅 type="tool" 时需要，必须是上方可用工具列表中的工具名
- toolInput: 仅 type="tool" 时需要，传递给工具的输入。⚠️ 必须是**纯字符串**（如搜索词、文件路径），不要用 JSON 对象！
- dependsOn: 依赖的前置步骤id列表，无依赖则为空数组[]
- status: 固定为 "pending"

步骤分解规则：
1. type="tool" 的步骤放在前面，type="reasoning" 的步骤放在最后
2. 多个独立的 tool 步骤之间 dependsOn 应为空（可并行执行）
3. reasoning 步骤 dependsOn 应包含所有前置 tool 步骤的 id
4. 通常 1-3 个 tool 步骤 + 1 个 reasoning 步骤即可
5. ⚠️ toolInput 始终使用简单字符串，不要写成对象格式。文件读取传路径字符串，搜索传查询词字符串

请严格返回 JSON 数组（toolInput 必须是简单字符串，不要用对象字面量）：
[
  {"id":"1", "type":"tool", "content":"搜索相关信息", "toolName":"web_search", "toolInput":"最近的AI新闻", "dependsOn":[], "status":"pending"},
  {"id":"2", "type":"tool", "content":"读取指定文件", "toolName":"filesystem/read_file", "toolInput":"d:/AI-Chat/CLAUDE.md", "dependsOn":[], "status":"pending"},
  {"id":"3", "type":"reasoning", "content":"综合对比分析并给出最终回答", "dependsOn":["1","2"], "status":"pending"}
]

只返回 JSON 数组，不要包含其他文字。`;

    let plannerUsage = null;
    let subTasks = [];
    try {
        const response = await llm.invoke([new HumanMessage(prompt)], { signal });
        plannerUsage = extractUsageFromChunk(response);
        const raw = normalizeChunkContent(response.content);
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            subTasks = JSON.parse(jsonMatch[0]);
        }
    } catch (err) {
        console.log(`[graph][planner] subTask generation failed: ${err.message}`);
    }

    // 降级：生成默认 subTask
    if (!Array.isArray(subTasks) || subTasks.length === 0) {
        console.log(`[graph][planner] LLM failed, generating fallback subTasks`);
        const agentMeta = AGENT_META[state.intent] || AGENT_META.general;
        subTasks = [
            { id: "1", type: "reasoning", content: `执行${agentMeta.name}任务`, dependsOn: [], status: "pending" },
        ];
    }

    // Phase 4: subTask 可用性校验
    subTasks = subTasks.map((st) => {
        if (st.type === "tool" && st.toolName) {
            const tool = toolRegistry.getTool(st.toolName);
            if (!tool) {
                console.log(`[graph][planner] tool "${st.toolName}" not available, marking blocked`);
                return { ...st, status: "blocked", blockedReason: `工具 "${st.toolName}" 不可用` };
            }
            // web_search 需要 enableWebSearch
            if (st.toolName === "web_search" && !state.enableWebSearch) {
                return { ...st, status: "blocked", blockedReason: "联网搜索已关闭" };
            }
        }
        return st;
    });

    // 后处理：tool 步骤在前，reasoning 步骤在后
    subTasks = enforceSubTaskOrder(subTasks);

    // 标记第一个非 blocked 步骤为 in_progress
    const firstReady = subTasks.find(s => s.status === "pending");
    if (firstReady) firstReady.status = "in_progress";

    console.log(`[graph][planner] generated ${subTasks.length} subTasks (${
        subTasks.filter(s => s.type === "tool").length
    } tool + ${
        subTasks.filter(s => s.type === "reasoning").length
    } reasoning, ${subTasks.filter(s => s.status === "blocked").length} blocked)`);

    // 生成兼容 plan steps（供前端 TaskProgressCard 消费）
    const plan = subTasksToPlan(subTasks);

    // 发射 todo_updated SSE
    if (sse) {
        sse.todoUpdated(plan);
    }

    return {
        subTasks,
        plan,
        planResults: {},
        currentAgent: "router",
        tokenUsage: plannerUsage,
    };
}

// ═══════════════════════════════════════════════════════
// Phase 4: SubTask 辅助函数
// ═══════════════════════════════════════════════════════

/**
 * 将 subTask[] 转为前端 TaskProgressCard 兼容的 plan step[]。
 */
function subTasksToPlan(subTasks) {
    if (!Array.isArray(subTasks)) return [];
    return subTasks.map(({ id, content, status }) => ({ id, content, status }));
}

/**
 * 强制执行 tool 步骤在前、reasoning 步骤在后的排序。
 */
function enforceSubTaskOrder(subTasks) {
    if (!Array.isArray(subTasks) || subTasks.length < 2) return subTasks;
    const toolTasks = subTasks.filter(s => s.type === "tool");
    const reasoningTasks = subTasks.filter(s => s.type === "reasoning");
    const sorted = [...toolTasks, ...reasoningTasks];
    // 重新分配 ID
    return sorted.map((step, i) => ({ ...step, id: String(i + 1) }));
}


// ═══════════════════════════════════════════════════════
// 辅助：判断是否为 solo 运行（单个 Agent）
//
// solo:  子Agent 自己输出最终回答 → Synthesizer 透传
// multi: 子Agent 只存原始结果 → Synthesizer 多源融合
// ═══════════════════════════════════════════════════════

function isSoloRun(state) {
    const intents = state.intents || [state.intent || "general"];
    return intents.length === 1;
}

// ═══════════════════════════════════════════════════════
// 节点 3: GeneralChatNode — 通用对话（无工具）
// ═══════════════════════════════════════════════════════

async function generalChatNode(state, config) {
    console.log(`[graph][general] generating direct response`);

    const sse = config?.configurable?.sse;
    const signal = config?.configurable?.abortSignal;
    if (sse) sse.agentStart("general");

    // Phase 4: 获取 system 类别工具（memory, get_system_time, update_todo 等），
    // 让 general_chat 节点也能调用这些通用工具。
    // 排除 ai-chat-local/* MCP 自连重复项（与本地工具同名，避免 LLM 混淆）
    // 当 enableMemory=false 时，排除 memory 工具
    const rawSystemTools = toolRegistry.getToolsByCategory?.("system") || [];
    const systemTools = rawSystemTools.filter(t =>
        !t.name.includes("/") && (state.enableMemory !== false || t.name !== "memory")
    );
    const hasTools = systemTools.length > 0;

    const llm = new ChatOpenAI({
        modelName: state.modelName,
        temperature: state.temperature,
        streaming: true,
        ...buildChatOpenAIConfig(),
    });

    const messages = [
        new SystemMessage(`${state.systemPrompt}\n当前时间：${state.currentDate}
${hasTools ? `\n你可以使用以下系统工具：memory（记忆管理）、get_system_time（时间查询）等。
使用规则：
- 用户要求执行具体操作时，直接执行，不要先搜索或验证。
- 例如用户说"添加记忆"，直接用 memory action="add" 添加。` : ""}`),
        ...state.chatHistory,
        new HumanMessage(state.userInput),
    ];

    let fullText = "";
    const nodeUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const addUsage = (u) => {
        if (u && u.total_tokens > 0) {
            nodeUsage.prompt_tokens += u.prompt_tokens || 0;
            nodeUsage.completion_tokens += u.completion_tokens || 0;
            nodeUsage.total_tokens += u.total_tokens || 0;
        }
    };

    // 如果有可用工具，使用 ReAct 循环（最多 5 轮）
    if (hasTools) {
        try {
            const tooledLlm = llm.bindTools(systemTools);
            const MAX_TOOL_ROUNDS = 5;
            let round = 0;
            const conversation = [...messages];

            while (round < MAX_TOOL_ROUNDS) {
                round++;
                const isFirstRound = round === 1;

                // 首轮使用流式 → 文本逐字推送到前端；后续轮用 invoke（更快）
                let response;
                if (isFirstRound) {
                    const stream = await tooledLlm.stream(conversation, { signal });
                    for await (const chunk of stream) {
                        response = response ? response.concat(chunk) : chunk;
                        const text = normalizeChunkContent(chunk?.content);
                        if (text && sse) sse.textChunk(text);
                    }
                } else {
                    response = await tooledLlm.invoke(conversation, { signal });
                }
                addUsage(extractUsageFromChunk(response));

                const toolCalls = response?.tool_calls || response?.additional_kwargs?.tool_calls || [];

                if (toolCalls.length === 0) {
                    // 本轮无工具调用 → LLM 返回了最终文本回复
                    const text = normalizeChunkContent(response?.content);
                    if (text) {
                        fullText = text;
                        if (!isFirstRound && sse) sse.textChunk(text); // 非流式轮次需要一次性推送
                    }
                    conversation.push(response);
                    break;
                }

                console.log(`[graph][general] round ${round}: ${toolCalls.length} tool call(s)`);
                for (const tc of toolCalls) {
                    console.log(`[graph][general]   tc.name=${tc.name} tc.args=${JSON.stringify(tc.args)} id=${tc.id}`);
                }

                // 执行工具调用
                conversation.push(response);
                for (const tc of toolCalls) {
                    const toolName = tc.name || tc.function?.name;
                    // tc.args 可能是 {input: "实际JSON"} 或直接的参数对象
                    const rawArgs = tc.args || (tc.function?.arguments
                        ? (typeof tc.function.arguments === "string"
                            ? JSON.parse(tc.function.arguments)
                            : tc.function.arguments)
                        : {});
                    // LangChain DynamicTool 把参数包在 input 字段里:
                    //   tc.args = { input: '{"action":"add",...}' }
                    // 需要取出 input 值作为 tool.invoke() 的实际参数
                    const toolInputStr = rawArgs?.input != null
                        ? (typeof rawArgs.input === "string" ? rawArgs.input : JSON.stringify(rawArgs.input))
                        : JSON.stringify(rawArgs);
                    const tool = systemTools.find(t => t.name === toolName);
                    if (tool) {
                        const toolCallId = tc.id || crypto.randomUUID();
                        sse?.toolStart(toolCallId, toolName, toolInputStr, "general");
                        try {
                            const result = await tool.invoke(toolInputStr);
                            const resultStr = typeof result === "string" ? result : JSON.stringify(result);
                            sse?.toolEnd(toolCallId, toolName, resultStr, "general");
                            conversation.push(new ToolMessage({ content: resultStr, tool_call_id: tc.id || toolCallId, name: toolName }));
                        } catch (err) {
                            sse?.toolError(toolCallId, toolName, err.message, "general");
                            conversation.push(new ToolMessage({ content: `Error: ${err.message}`, tool_call_id: tc.id || toolCallId, name: toolName }));
                        }
                    }
                }

                // 最后一轮：流式输出最终回复
                if (round >= MAX_TOOL_ROUNDS) {
                    try {
                        const stream = await llm.stream(conversation, { signal });
                        let finalResponse;
                        for await (const chunk of stream) {
                            finalResponse = finalResponse ? finalResponse.concat(chunk) : chunk;
                            const text = normalizeChunkContent(chunk?.content);
                            if (!text) continue;
                            fullText += text;
                            if (sse) sse.textChunk(text);
                        }
                        addUsage(extractUsageFromChunk(finalResponse));
                    } catch (err) {
                        console.log(`[graph][general] final stream error: ${err.message}`);
                        if (!fullText) fullText = `操作完成但回复生成失败: ${err.message}`;
                        if (sse) sse.textChunk(fullText);
                    }
                }
            }
        } catch (err) {
            console.log(`[graph][general] tool loop error: ${err.message}`);
            // Fallback: 直接流式
            try {
                const stream = await llm.stream(messages, { signal });
                let fallbackResponse;
                for await (const chunk of stream) {
                    fallbackResponse = fallbackResponse ? fallbackResponse.concat(chunk) : chunk;
                    const text = normalizeChunkContent(chunk?.content);
                    if (!text) continue;
                    fullText += text;
                    if (sse) sse.textChunk(text);
                }
                addUsage(extractUsageFromChunk(fallbackResponse));
            } catch (err2) {
                fullText = `回答生成失败: ${err2.message}`;
                if (sse) sse.textChunk(fullText);
            }
        }
    } else {
        // 无工具：原有直接流式逻辑
        try {
            const stream = await llm.stream(messages, { signal });
            let noToolsResponse;
            for await (const chunk of stream) {
                noToolsResponse = noToolsResponse ? noToolsResponse.concat(chunk) : chunk;
                const text = normalizeChunkContent(chunk?.content);
                if (!text) continue;
                fullText += text;
                if (sse) sse.textChunk(text);
            }
            addUsage(extractUsageFromChunk(noToolsResponse));
        } catch (err) {
            console.log(`[graph][general] stream error: ${err.message}`);
            fullText = `回答生成失败: ${err.message}`;
            if (sse) sse.textChunk(fullText);
        }
    }

    if (sse) sse.agentEnd("general");

    return {
        messages: [new AIMessage({ content: fullText })],
        currentAgent: "general",
        tokenUsage: nodeUsage.total_tokens > 0 ? nodeUsage : null,
    };
}

// ═══════════════════════════════════════════════════════
// 节点 4: SearchAgentNode — 联网搜索 Agent
// ═══════════════════════════════════════════════════════

async function searchAgentNode(state, config) {
    const solo = isSoloRun(state);
    console.log(`[graph][search] starting (mode=${solo ? 'solo' : 'parallel'})`);

    const sse = config?.configurable?.sse;
    const signal = config?.configurable?.abortSignal;
    const agentType = "search";

    if (sse) sse.agentStart(agentType);

    const webSearchTool = toolRegistry.getTool(WEB_SEARCH_TOOL_NAME);
    if (!webSearchTool) {
        console.log(`[graph][search] web_search tool not found`);
        if (sse) sse.agentEnd(agentType);
        return { searchResults: "(web_search 工具不可用)", currentAgent: "search" };
    }

    // Plan 模式：标记首个步骤为 in_progress
    let plan = emitPlanProgress(sse, state.plan, 'agent_start');

    // ── 执行 web_search（solo/parallel 都需要） ──
    const toolCallId = crypto.randomUUID();
    sse.toolStart(toolCallId, WEB_SEARCH_TOOL_NAME, state.userInput, agentType);

    let searchResults = "";
    try {
        const toolResult = await webSearchTool.invoke(state.userInput);
        searchResults = normalizeChunkContent(toolResult).slice(0, FORCED_WEB_SEARCH_MAX_CHARS);
        sse.toolEnd(toolCallId, WEB_SEARCH_TOOL_NAME, searchResults, agentType);
    } catch (err) {
        searchResults = `web_search 执行失败: ${err.message}`;
        sse.toolError(toolCallId, WEB_SEARCH_TOOL_NAME, err.message, agentType);
    }

    console.log(`[graph][search] web_search completed, result length=${searchResults.length}`);

    // ── Solo 模式：LLM 直接总结 + 流式输出，Synthesizer 会透传 ──
    if (solo) {
        plan = emitPlanProgress(sse, plan, 'tools_done');

        const llm = new ChatOpenAI({
            modelName: state.modelName,
            temperature: state.temperature,
            streaming: true,
            ...buildChatOpenAIConfig(),
        });

        // Solo 模式：进度由 emitPlanProgress 自动管理，不给 LLM update_todo 指令(LLM 没有 tool 会文字模拟)
        const systemMsg = new SystemMessage(
            `你是搜索专家。下面是一次 web_search 的检索结果。请基于这些结果为用户问题提供客观、结构化的总结回答。\n当前时间：${state.currentDate}\n\n重要：你必须在回答中引用搜索结果的来源信息。`
        );

        const messages = [
            systemMsg,
            ...state.chatHistory,
            new HumanMessage(`${state.userInput}\n\n[web_search 结果]\n${searchResults.slice(0, 6000)}`),
        ];

        let fullText = "";
        let searchUsage = null;
        try {
            const stream = await llm.stream(messages, { signal });
            let response;
            for await (const chunk of stream) {
                response = response ? response.concat(chunk) : chunk;
                const text = normalizeChunkContent(chunk?.content);
                if (!text) continue;
                fullText += text;
                if (sse) sse.textChunk(text);
            }
            searchUsage = extractUsageFromChunk(response);
        } catch (err) {
            console.log(`[graph][search] stream error: ${err.message}`);
            fullText = searchResults;
            if (sse) sse.textChunk(fullText);
        }

        plan = emitPlanProgress(sse, plan, 'all_done');
        if (sse) sse.agentEnd(agentType);

        return {
            messages: [new AIMessage({ content: fullText })],
            searchResults,
            plan,
            currentAgent: "search",
            tokenUsage: searchUsage,
        };
    }

    // ── Parallel 模式：只存结果，留给 Synthesizer 融合 ──
    plan = emitPlanProgress(sse, plan, 'tools_done');
    if (sse) sse.agentEnd(agentType);

    return {
        searchResults,
        plan,
        currentAgent: "search",
    };
}

// ═══════════════════════════════════════════════════════
// 节点 5: KnowledgeAgentNode — 知识库检索 Agent
// ═══════════════════════════════════════════════════════

async function knowledgeAgentNode(state, config) {
    const solo = isSoloRun(state);
    console.log(`[graph][knowledge] starting (mode=${solo ? 'solo' : 'parallel'})`);

    const sse = config?.configurable?.sse;
    const signal = config?.configurable?.abortSignal;
    const agentType = "knowledge";

    if (sse) sse.agentStart(agentType);

    // Plan 模式：确保首个步骤为 in_progress
    let plan = emitPlanProgress(sse, state.plan, 'agent_start');

    const kbTool = toolRegistry.getTool("search_knowledge_base");
    if (!kbTool) {
        console.log(`[graph][knowledge] search_knowledge_base tool not found`);
        if (sse) sse.agentEnd(agentType);
        return { knowledgeResults: "(知识库工具不可用)", currentAgent: "knowledge" };
    }

    const updateTodoTool = toolRegistry.getTool("update_todo");
    const toolsForAgent = updateTodoTool
        ? [kbTool, updateTodoTool]
        : [kbTool];
    const toolsMap = new Map(toolsForAgent.map(t => [t.name, t]));

    const llm = new ChatOpenAI({
        modelName: state.modelName,
        temperature: state.temperature,
        ...buildChatOpenAIConfig(),
    });

    const llmWithTools = llm.bindTools?.(toolsForAgent) || llm;

    // Solo 模式：进度由 emitPlanProgress 自动管理，不给 LLM update_todo 指令(LLM 没有 tool 会文字模拟)
    const soloHint = solo
        ? "检索完成后，请基于检索结果生成一个完整的回答。"
        : "重要：只需要执行工具返回检索结果即可，不需要生成最终回答。最终回答由综合Agent负责。";

    const systemMsg = new SystemMessage(
        `你是知识库检索专家。使用 search_knowledge_base 工具从用户上传的文档中检索相关信息。\n当前时间：${state.currentDate}\n\n${soloHint}`
    );

    const messages = [
        systemMsg,
        ...state.chatHistory,
        new HumanMessage(state.userInput),
    ];

    let knowledgeResults = "";
    let knowledgeUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const kaAddUsage = (u) => {
        if (u && u.total_tokens > 0) {
            knowledgeUsage.prompt_tokens += u.prompt_tokens || 0;
            knowledgeUsage.completion_tokens += u.completion_tokens || 0;
            knowledgeUsage.total_tokens += u.total_tokens || 0;
        }
    };

    try {
        const firstResponse = await llmWithTools.invoke(messages, { signal });
        kaAddUsage(extractUsageFromChunk(firstResponse));
        const toolCalls = firstResponse.tool_calls || firstResponse.additional_kwargs?.tool_calls || [];

        if (toolCalls.length > 0) {
            const toolMessages = await executeToolCalls(toolCalls, agentType, sse, toolsMap);
            knowledgeResults = toolMessages.map(m => m.content).join("\n\n");

            // ── Solo 模式：LLM 基于检索结果生成最终回答 ──
            if (solo && knowledgeResults && !knowledgeResults.includes("当前知识库为空") && !knowledgeResults.includes("未检索到相关知识片段")) {
                const { streamDirectChat } = await import("./chatUtils.js");
                // 用 invoke 生成总结（knowledge 不走流式，LLM 一次性输出）
                const summaryLlm = new ChatOpenAI({
                    modelName: state.modelName,
                    temperature: state.temperature,
                    streaming: true,
                    ...buildChatOpenAIConfig(),
                });

                const summarySys = new SystemMessage(
                    `${state.systemPrompt}\n当前时间：${state.currentDate}\n\n你是知识库检索专家。请基于以下检索结果为用户生成准确、完整的回答。`
                );

                const summaryMessages = [
                    summarySys,
                    ...state.chatHistory,
                    new HumanMessage(`${state.userInput}\n\n[知识库检索结果]\n${knowledgeResults.slice(0, 4000)}`),
                ];

                let fullText = "";
                try {
                    const stream = await summaryLlm.stream(summaryMessages, { signal });
                    let summaryResponse;
                    for await (const chunk of stream) {
                        summaryResponse = summaryResponse ? summaryResponse.concat(chunk) : chunk;
                        const text = normalizeChunkContent(chunk?.content);
                        if (!text) continue;
                        fullText += text;
                        if (sse) sse.textChunk(text);
                    }
                    kaAddUsage(extractUsageFromChunk(summaryResponse));
                } catch (err) {
                    console.log(`[graph][knowledge] summary stream error: ${err.message}`);
                    fullText = knowledgeResults;
                    if (sse) sse.textChunk(fullText);
                }

                plan = emitPlanProgress(sse, plan, 'all_done');
                if (sse) sse.agentEnd(agentType);

                return {
                    messages: [new AIMessage({ content: fullText })],
                    knowledgeResults,
                    plan,
                    currentAgent: "knowledge",
                    tokenUsage: knowledgeUsage.total_tokens > 0 ? knowledgeUsage : null,
                };
            }
        } else {
            knowledgeResults = normalizeChunkContent(firstResponse.content || "");
        }
    } catch (err) {
        console.log(`[graph][knowledge] agent error: ${err.message}`);
        knowledgeResults = `知识库检索出错: ${err.message}`;
    }

    console.log(`[graph][knowledge] retrieval completed, result length=${knowledgeResults.length}`);

    // Parallel 模式：只存结果，留给 Synthesizer
    plan = emitPlanProgress(sse, plan, 'tools_done');
    if (sse) sse.agentEnd(agentType);

    return {
        knowledgeResults,
        plan,
        currentAgent: "knowledge",
        tokenUsage: knowledgeUsage.total_tokens > 0 ? knowledgeUsage : null,
    };
}

// ═══════════════════════════════════════════════════════
// 节点 6: CodeAgentNode — 代码 Agent（占位）
// ═══════════════════════════════════════════════════════

async function codeAgentNode(state, config) {
    const solo = isSoloRun(state);
    console.log(`[graph][code] starting (mode=${solo ? 'solo' : 'parallel'})`);

    const sse = config?.configurable?.sse;
    const signal = config?.configurable?.abortSignal;
    const agentType = "code";

    if (sse) sse.agentStart(agentType);

    // Plan 模式：确保首个步骤为 in_progress
    let plan = emitPlanProgress(sse, state.plan, 'agent_start');

    const llm = new ChatOpenAI({
        modelName: state.modelName,
        temperature: state.temperature,
        streaming: solo,  // solo: stream to user directly
        ...buildChatOpenAIConfig(),
    });

    const parallelHint = solo
        ? ""
        : "\n\n重要：只需要生成代码和解释，不要做最终的格式化输出。最终展示由综合Agent负责。";

    // Solo 模式：进度由 emitPlanProgress 自动管理，不给 LLM update_todo 指令(LLM 没有 tool 会文字模拟)
    // Parallel 模式：也不需要，emitPlanProgress 在 tools_done 阶段统一处理
    const systemMsg = new SystemMessage(
        `${state.systemPrompt}\n\n你是代码助手。请帮助用户编写、分析、解释和调试代码。输出代码时使用 Markdown 代码块格式。\n当前时间：${state.currentDate}${parallelHint}`
    );

    const messages = [
        systemMsg,
        ...state.chatHistory,
        new HumanMessage(state.userInput),
    ];

    // ── Solo 模式：LLM stream 直出，Synthesizer 透传 ──
    if (solo) {
        let fullText = "";
        let soloUsage = null;
        try {
            const stream = await llm.stream(messages, { signal });
            let response;
            for await (const chunk of stream) {
                response = response ? response.concat(chunk) : chunk;
                const text = normalizeChunkContent(chunk?.content);
                if (!text) continue;
                fullText += text;
                if (sse) sse.textChunk(text);
            }
            soloUsage = extractUsageFromChunk(response);
        } catch (err) {
            console.log(`[graph][code] stream error: ${err.message}`);
            fullText = `代码生成失败: ${err.message}`;
            if (sse) sse.textChunk(fullText);
        }

        plan = emitPlanProgress(sse, plan, 'all_done');
        if (sse) sse.agentEnd(agentType);

        return {
            messages: [new AIMessage({ content: fullText })],
            codeResults: fullText,
            plan,
            currentAgent: "code",
            tokenUsage: soloUsage,
        };
    }

    // ── Parallel 模式：invoke 生成代码，存结果给 Synthesizer 融合 ──
    let codeResults = "";
    let parallelUsage = null;
    try {
        const response = await llm.invoke(messages, { signal });
        codeResults = normalizeChunkContent(response.content || "");
        parallelUsage = extractUsageFromChunk(response);
    } catch (err) {
        console.log(`[graph][code] generation error: ${err.message}`);
        codeResults = `代码生成失败: ${err.message}`;
    }

    console.log(`[graph][code] generation completed, result length=${codeResults.length}`);

    plan = emitPlanProgress(sse, plan, 'tools_done');
    if (sse) sse.agentEnd(agentType);

    return {
        codeResults,
        plan,
        currentAgent: "code",
        tokenUsage: parallelUsage,
    };
}

// ═══════════════════════════════════════════════════════
// Plan 收尾辅助：全部步骤标记完成 + 发射 todo_updated
// ═══════════════════════════════════════════════════════

function completePlan(plan, sse) {
    return emitPlanProgress(sse, plan || [], 'all_done');
}

// ═══════════════════════════════════════════════════════
// 节点 7: SynthesizerNode — 多源融合输出
//
// 逻辑：
//   - Pure general chat → 透传（general 已流式输出）
//   - 1+ 工具型 Agent (search/knowledge/code) → 读取结果，融合生成最终回答，流式输出
//   - 单源：直接基于该源总结输出
//   - 多源：合并所有来源后再输出
// ═══════════════════════════════════════════════════════

async function synthesizerNode(state, config) {
    const sse = config?.configurable?.sse;
    const signal = config?.configurable?.abortSignal;
    const agentType = "synthesizer";
    const intents = state.intents || [state.intent || "general"];
    const subTasks = state.subTasks || [];

    if (sse) sse.agentStart(agentType);

    // Synthesizer 启动 → 若计划未全部完成，标记最后一个步骤为 in_progress
    let plan = state.plan || [];
    const planAllDone = plan.length > 0 && plan.every(s => s.status === 'completed');
    if (!planAllDone) {
        plan = emitPlanProgress(sse, plan, 'synth_start');
    }

    // ── 判断模式 ──
    const solo = intents.length === 1 && subTasks.length === 0;

    // ── Solo 模式（无 subTask 的单意图）→ 透传 ──
    if (solo) {
        console.log(`[graph][synthesizer] solo mode (${intents[0]}), pass-through`);
        plan = completePlan(plan, sse);
        if (sse) sse.agentEnd(agentType);
        return { plan, currentAgent: "synthesizer" };
    }

    // ── Phase 4: 构建融合上下文 ──
    const sources = [];
    let contextBlock = "";
    const errorResults = []; // 收集错误/不可用的结果来源

    // 辅助函数：检测错误/不可用结果
    const isErrorResult = (text) => {
        if (!text || !text.trim()) return true;
        const s = text.trim();
        return /^\(.*工具不可用\)$/.test(s) ||
            /^知识库检索出错:/.test(s) ||
            /^联网搜索出错:/.test(s) ||
            /^工具调用失败:/.test(s) ||
            /^Error:/i.test(s);
    };

    // Phase 4: 从 planResults 收集 subTask 执行结果
    const planResults = state.planResults || {};
    const completedSubTasks = subTasks.filter(s => s.status === "completed" || planResults[s.id]);
    const blockedSubTasks = subTasks.filter(s => s.status === "blocked");

    if (completedSubTasks.length > 0) {
        for (const st of completedSubTasks) {
            const result = planResults[st.id] || "";
            if (!result) continue;
            if (isErrorResult(result)) {
                errorResults.push(`${st.content.slice(0, 30)}(${st.toolName || "未知工具"})`);
                continue;
            }
            const label = st.toolName
                ? `步骤${st.id}: ${st.content.slice(0, 50)} (${st.toolName})`
                : `步骤${st.id}: ${st.content.slice(0, 50)}`;
            sources.push(st.toolName || st.content.slice(0, 20));
            contextBlock += `\n\n[${label}]\n${result.slice(0, 4000)}`;
        }
    }

    // 旧字段 fallback（无 subTask 的 Parallel 模式）
    if (completedSubTasks.length === 0) {
        if (state.searchResults) {
            if (isErrorResult(state.searchResults)) {
                errorResults.push("搜索");
            } else {
                sources.push("搜索");
                contextBlock += `\n\n[搜索结果]\n${state.searchResults.slice(0, 4000)}`;
            }
        }
        if (state.knowledgeResults) {
            if (isErrorResult(state.knowledgeResults)) {
                errorResults.push("知识库");
            } else {
                sources.push("知识库");
                contextBlock += `\n\n[知识库结果]\n${state.knowledgeResults.slice(0, 4000)}`;
            }
        }
        if (state.codeResults) {
            if (isErrorResult(state.codeResults)) {
                errorResults.push("代码");
            } else {
                sources.push("代码");
                contextBlock += `\n\n[代码生成结果]\n${state.codeResults.slice(0, 4000)}`;
            }
        }
    }

    // Phase 4: reasoning subTask 作为结构指引（精简版，~50 tokens）
    const reasoningSubTasks = subTasks.filter(s => s.type === "reasoning");
    let reasoningGuide = "";
    if (reasoningSubTasks.length > 0) {
        reasoningGuide = `\n\n[推理要求]\n请按以下逻辑组织最终回答：\n${
            reasoningSubTasks.map((s, i) => `${i + 1}. ${s.content.slice(0, 80)}`).join('\n')
        }`;
    }

    // Blocked 提示
    let blockedNote = "";
    const blockedItems = [
        ...blockedSubTasks.map(s => `${s.content}(${s.blockedReason || "未知原因"})`),
        ...errorResults.map(e => `${e}(结果异常或不可用)`),
    ];
    if (blockedItems.length > 0) {
        blockedNote = `\n\n注意：以下步骤/来源因工具不可用或结果异常被跳过：${
            blockedItems.join("、")
        }。请基于已有信息回答，或告知用户原因。`;
    }

    // 如果没有有效结果（极端情况），回退到透传
    if (!contextBlock && !reasoningGuide) {
        console.log(`[graph][synthesizer] no results or reasoning, pass-through`);
        plan = completePlan(plan, sse);
        if (sse) sse.agentEnd(agentType);
        return { plan, currentAgent: "synthesizer" };
    }

    console.log(`[graph][synthesizer] merging ${sources.length} source(s): [${sources.join(", ")}]` +
        (reasoningSubTasks.length > 0 ? ` + ${reasoningSubTasks.length} reasoning step(s)` : ""));

    // ── 融合生成最终回答 ──
    const llm = new ChatOpenAI({
        modelName: state.modelName,
        temperature: state.temperature,
        streaming: true,
        ...buildChatOpenAIConfig(),
    });

    const mergeHint = sources.length > 1
        ? `\n注意：以上结果来自 ${sources.join("、")} 等多个工具的执行结果。请将它们融合为一个连贯的回答，避免内容重复。`
        : "";

    const systemMsg = new SystemMessage(
        `${state.systemPrompt}\n当前时间：${state.currentDate}\n\n你是综合处理助手。根据以下工具执行结果，为用户问题生成完整、准确的回答。${contextBlock}${reasoningGuide}${blockedNote}${mergeHint}\n\n请用自然语言组织回答，确保信息准确、结构清晰。${state.searchResults || sources.includes("搜索") ? '需要引用搜索来源时请注明。' : ''}`
    );

    const messages = [
        systemMsg,
        ...state.chatHistory,
        new HumanMessage(state.userInput),
    ];

    let fullText = "";
    let synthUsage = null;
    try {
        const stream = await llm.stream(messages, { signal });
        for await (const chunk of stream) {
            // 从最后一个 chunk 提取真实 API token usage
            const chunkUsage = extractUsageFromChunk(chunk);
            if (chunkUsage) synthUsage = chunkUsage;

            const text = normalizeChunkContent(chunk?.content);
            if (!text) continue;
            fullText += text;
            if (sse) sse.textChunk(text);
        }
    } catch (err) {
        console.log(`[graph][synthesizer] stream error: ${err.message}`);
        // Fallback: 拼接所有结果
        const allResults = subTasks
            .filter(s => planResults[s.id])
            .map(s => planResults[s.id])
            .concat([state.searchResults, state.knowledgeResults, state.codeResults].filter(Boolean));
        fullText = allResults.join("\n\n");
        if (sse && fullText) sse.textChunk(fullText);
    }

    // 综合输出完成 → 所有步骤完成
    plan = emitPlanProgress(sse, plan, 'all_done');
    if (sse) sse.agentEnd(agentType);

    return {
        messages: [new AIMessage({ content: fullText })],
        plan,
        currentAgent: "synthesizer",
        tokenUsage: synthUsage,
    };
}

// ═══════════════════════════════════════════════════════
// 条件路由
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// Fan-out 路由：根据 intents 数组生成并行 Send
//
// LangGraph Send API: 返回 Send[] 时，运行时会并行执行所有 Send 目标节点，
// 全部完成后收敛到各节点的静态出边（→ synthesizer）。
//
// Phase 4 P0: 双路径路由
//   - 路径 A: subTask 驱动 (planMode ON, Planner 已生成 subTasks)
//   - 路径 B: intent 驱动 (planMode OFF, 向后兼容 + 动态 intent)
// ═══════════════════════════════════════════════════════

function fanoutToAgents(state) {
    // Phase 4: 如果 Planner 已生成 subTasks，按 subTask 驱动执行
    if (state.subTasks && state.subTasks.length > 0) {
        return fanoutBySubTasks(state);
    }
    // 否则走 intent-based 路由（向后兼容）
    return fanoutByIntents(state);
}

/**
 * Phase 4 路径 A: subTask 驱动扇出。
 * 所有 type="tool" 且未 blocked 的 subTask 并行扇出到 tool_executor。
 * reasoning subTask 延迟到 Synthesizer 处理。
 */
function fanoutBySubTasks(state) {
    const toolSubTasks = state.subTasks.filter(s =>
        s.type === "tool" && s.status !== "blocked" && s.status !== "completed"
    );
    const blockedCount = state.subTasks.filter(s => s.status === "blocked").length;

    if (toolSubTasks.length === 0) {
        // 无 tool 步骤（全部 blocked 或全部是 reasoning）→ 直接到 synthesizer
        console.log(`[graph][route] subTask: 0 tool tasks (${blockedCount} blocked), direct to synthesizer`);
        return "synthesizer";
    }

    // 单 tool subTask → Send 传递 currentSubTask（与多 tool 路径一致）
    if (toolSubTasks.length === 1) {
        const st = toolSubTasks[0];
        console.log(`[graph][route] subTask: solo tool "${st.toolName}" (id=${st.id}) → tool_executor`);
        return new Send("tool_executor", {
            currentSubTask: { ...st, status: "in_progress" },
        });
    }

    // 多 tool subTask → Send[] 并行扇出
    const sends = toolSubTasks.map(st => {
        console.log(`[graph][route] subTask: fanout "${st.toolName}" (id=${st.id}) → tool_executor`);
        return new Send("tool_executor", {
            currentSubTask: { ...st, status: "in_progress" },
        });
    });

    console.log(`[graph][route] subTask fanout: ${sends.length} tool executor(s)` +
        (blockedCount > 0 ? ` + ${blockedCount} blocked (skipped)` : ""));
    return sends;
}

/**
 * Phase 4 路径 B: intent 驱动路由（向后兼容 + 动态 intent 支持）。
 */
function fanoutByIntents(state) {
    let intents = state.intents || [state.intent || "general"];

    // 去重
    intents = [...new Set(intents)];

    // 如果 general 与其他意图混合，移除 general
    if (intents.length > 1 && intents.includes("general")) {
        console.log(`[graph][route] removing "general" from mixed intents (synthesizer handles output)`);
        intents = intents.filter(i => i !== "general");
    }

    // Fallback
    if (intents.length === 0) {
        console.log(`[graph][route] no valid intents, fallback to general_chat`);
        return "general_chat";
    }

    // ── 单 Agent → 直接返回 nodeName（由 mapIntentToNode 解析为节点名）──
    if (intents.length === 1) {
        const nodeName = mapIntentToNode(intents[0]);  // Phase 4: 动态映射
        console.log(`[graph][route] single: ${intents[0]} → ${nodeName}`);
        return nodeName;  // Phase 4 fix: 返回 nodeName 而非 intent，支持动态 intent
    }

    // ── 多 Agent → Send[] 并行扇出 ──
    const sends = [];
    for (const intent of intents) {
        const nodeName = mapIntentToNode(intent);  // Phase 4: 动态映射
        sends.push(new Send(nodeName, { ...state }));
    }

    console.log(`[graph][route] intent fanout: [${intents.join(", ")}] → [${sends.map((s) => s.node).join(", ")}] (${sends.length} parallel)`);
    return sends;
}

// ═══════════════════════════════════════════════════════
// Phase 4 P0: toolExecutorNode — 通用工具执行器
//
// 接收 state.currentSubTask，动态查找并执行工具。
// 替代原有的硬编码工具绑定（searchAgentNode→web_search 等）。
// 现有 agent 节点仍存在作为 intent-based fallback。
// ═══════════════════════════════════════════════════════

async function toolExecutorNode(state, config) {
    let subTask = state.currentSubTask;
    const sse = config?.configurable?.sse;
    const agentType = "tool_executor";

    // Phase 4: planMode=OFF 时 Planner 跳过，currentSubTask 可能为 null。
    // 对于动态 MCP 意图（如 filesystem），根据 intent 自动构造默认 subTask。
    if (!subTask || !subTask.toolName) {
        const intent = state.intent;
        if (intent && !["general", "search", "knowledge", "code"].includes(intent)
            && toolRegistry.hasToolCategory(intent)) {
            const categories = toolRegistry.getToolCategories();
            const category = categories.find(c => c.category === intent);
            if (category && category.tools.length > 0) {
                const firstTool = category.tools[0];
                // 尝试从用户消息中提取文件路径（read_file / write_file 等工具需要）
                let toolInput = state.userInput;
                // 匹配 Windows 路径 (C:/...) 或 Unix 绝对路径 (/...)，在空白/CJK字符处截断
                const pathMatch = state.userInput.match(
                    /(?:[A-Za-z]:[/\\][^\s\u3000-\u9FFF\uFF00-\uFFEF"']+|\/[^\s\u3000-\u9FFF\uFF00-\uFFEF"']+)/
                );
                if (pathMatch) {
                    toolInput = pathMatch[0].replace(/\\/g, "/");
                    console.log(`[graph][tool_executor] extracted path from user input: "${toolInput}"`);
                }
                subTask = {
                    id: "1",
                    type: "tool",
                    toolName: firstTool.name,
                    toolInput,
                    content: `${intent} 工具调用`,
                    status: "pending",
                };
                console.log(`[graph][tool_executor] auto-constructed subTask for intent="${intent}": ${firstTool.name}`);
            }
        }
    }

    if (!subTask || subTask.type !== "tool" || !subTask.toolName) {
        console.log(`[graph][tool_executor] no valid subTask, skipping`);
        if (sse) sse.agentEnd(agentType);
        return { currentAgent: agentType };
    }

    const rawPreview = subTask.toolInput || subTask.content || "";
    const safePreview = typeof rawPreview === "string"
        ? rawPreview.slice(0, 60)
        : JSON.stringify(rawPreview).slice(0, 60);
    console.log(`[graph][tool_executor] executing subTask ${subTask.id}: ${subTask.toolName}("${safePreview}")`);

    if (sse) sse.agentStart(agentType);

    // 动态获取工具（支持命名空间格式 "serverName/toolName"）
    const tool = toolRegistry.getTool(subTask.toolName);
    const toolCallId = crypto.randomUUID();
    const toolInput = subTask.toolInput || state.userInput;

    if (!tool) {
        const errMsg = `工具 "${subTask.toolName}" 不可用`;
        console.log(`[graph][tool_executor] ${errMsg}`);
        if (sse) sse.toolError(toolCallId, subTask.toolName, errMsg, agentType);
        if (sse) sse.agentEnd(agentType);
        return {
            planResults: { [subTask.id]: `(blocked: ${subTask.blockedReason || errMsg})` },
            currentAgent: agentType,
        };
    }

    // 发射 tool_start SSE
    if (sse) sse.toolStart(toolCallId, subTask.toolName, toolInput, agentType);

    let result;
    let hasError = false;
    try {
        const toolResult = await tool.invoke(toolInput);
        result = normalizeChunkContent(toolResult);

        // 智能截断：按工具类型限制输出长度
        const isFileContent = subTask.toolName.includes("read_file") || subTask.toolName.includes("read");
        const maxChars = isFileContent ? 10000 : 4000;
        result = result.slice(0, maxChars);

        if (sse) sse.toolEnd(toolCallId, subTask.toolName, result, agentType);
        console.log(`[graph][tool_executor] subTask ${subTask.id} completed, result length=${result.length}`);
    } catch (err) {
        hasError = true;
        result = `工具执行失败: ${err.message}`;
        console.log(`[graph][tool_executor] subTask ${subTask.id} failed: ${err.message}`);
        if (sse) sse.toolError(toolCallId, subTask.toolName, err.message, agentType);
    }

    if (sse) sse.agentEnd(agentType);

    // 标记当前 subTask 为 completed；自动构造的 subTask 也追加到数组
    const wasAutoConstructed = !state.currentSubTask?.toolName && subTask.toolName;
    let updatedSubTasks = (state.subTasks || []).map(s =>
        s.id === subTask.id ? { ...s, status: hasError ? "error" : "completed" } : s
    );
    if (wasAutoConstructed && !updatedSubTasks.find(s => s.id === subTask.id)) {
        updatedSubTasks.push({ ...subTask, status: hasError ? "error" : "completed" });
    }

    return {
        planResults: { [subTask.id]: result },
        subTasks: updatedSubTasks,
        currentAgent: agentType,
    };
}

// ═══════════════════════════════════════════════════════
// 构建 Graph
// ═══════════════════════════════════════════════════════

function buildAgentGraph() {
    const graph = new StateGraph(AgentState)
        .addNode("initialize", initializeNode)
        .addNode("router", routerNode)
        .addNode("planner", plannerNode)
        .addNode("general_chat", generalChatNode)
        .addNode("search_agent", searchAgentNode)
        .addNode("knowledge_agent", knowledgeAgentNode)
        .addNode("code_agent", codeAgentNode)
        .addNode("tool_executor", toolExecutorNode)   // Phase 4: 通用工具执行器
        .addNode("synthesizer", synthesizerNode)

        .addEdge(START, "initialize")
        .addEdge("initialize", "router")
        .addEdge("router", "planner")
        .addConditionalEdges("planner", fanoutToAgents, {
            general: "general_chat",
            general_chat: "general_chat",       // Phase 4: fanoutByIntents 返回 nodeName
            search: "search_agent",
            search_agent: "search_agent",       // Phase 4: fanoutByIntents 返回 nodeName
            knowledge: "knowledge_agent",
            knowledge_agent: "knowledge_agent", // Phase 4: fanoutByIntents 返回 nodeName
            code: "code_agent",
            code_agent: "code_agent",           // Phase 4: fanoutByIntents 返回 nodeName
            tool_executor: "tool_executor",     // Phase 4: 动态工具执行
            synthesizer: "synthesizer",         // Phase 4: 跳过 agent 直接融合
        })
        .addEdge("general_chat", "synthesizer")
        .addEdge("search_agent", "synthesizer")
        .addEdge("knowledge_agent", "synthesizer")
        .addEdge("code_agent", "synthesizer")
        .addEdge("tool_executor", "synthesizer")  // Phase 4: 工具结果 → 融合
        .addEdge("synthesizer", END);

    return graph.compile({ checkpointer: new MemorySaver() });
}

// ═══════════════════════════════════════════════════════
// Graph 事件 → SSE 适配
// ═══════════════════════════════════════════════════════

async function streamGraphToSSE(graph, initialState, config, res, sse, abortController) {
    let previousAgent = "router";

    try {
        const eventStream = await graph.stream(initialState, config);

        for await (const event of eventStream) {
            if (abortController?.signal.aborted) {
                console.log('[graph] stream aborted by client disconnect');
                break;
            }

            for (const [nodeName, nodeOutput] of Object.entries(event)) {
                // LangGraph 元数据节点跳过
                if (nodeName === "__metadata__" || nodeName === "__interrupt__") continue;

                const currentNodeAgent = nodeOutput?.currentAgent;

                // 检测 Agent 切换 → 发射 handoff
                if (currentNodeAgent && currentNodeAgent !== previousAgent) {
                    sse.agentHandoff(previousAgent, currentNodeAgent);
                }

                if (currentNodeAgent) {
                    // agent_start 和 agent_end 在各自节点函数内部发射
                    previousAgent = currentNodeAgent;
                }

                console.log(`[graph][event] node=${nodeName} agent=${currentNodeAgent || "none"}`);
            }
        }
    } catch (err) {
        if (err.name === "AbortError" || abortController?.signal.aborted) {
            console.log('[graph] stream aborted');
        } else {
            throw err;
        }
    }
}

// ═══════════════════════════════════════════════════════
// 主入口：chatWithGraph
// ═══════════════════════════════════════════════════════

export async function chatWithGraph(userId, session_id, userMessage, image, systemPromptInput, temperatureInput, res, options = {}) {
    const {
        enableWebSearch = false,
        skipUserMessageSave = false,
        userMessageForStorage,
        forceModel = null,
        planMode = false,
        enableMemory = true,
        onComplete,
    } = options;
    const normalizedUserMessage = String(userMessage || "");
    const temperature = normalizeTemperature(temperatureInput);
    let systemPrompt = resolveSystemPrompt(systemPromptInput);
    const hasImage = Boolean(image);
    const startedAt = Date.now();
    const modelName = resolveModelName(hasImage, forceModel);

    // 动态注入模型身份：防止模型幻觉（如 deepseek 训练数据含 Claude 样本，会自称 Claude）
    systemPrompt += `\n\n[系统信息] 你是 AI-Chat 平台的智能助手，底层由 ${modelName} 模型驱动。如果用户询问你的身份或模型，请如实告知以上信息，不要声称自己是 Claude、GPT 或其他特定模型。`;

    // Phase 4: 设置 memory_tool 的当前用户上下文
    if (enableMemory) {
        setMemoryToolContext(userId, session_id);
    }

    // Phase 5: Trace 采集
    const traceCollector = new TraceCollector();
    const traceId = traceCollector.startTrace(userId, session_id, "chat", {
        input: normalizedUserMessage.slice(0, 200),
        enableWebSearch,
        planMode,
        hasImage,
    });

    const abortController = new AbortController();
    let clientDisconnected = false;
    const onClientClose = () => {
        clientDisconnected = true;
        cancelAllPendingQuestions();
        if (!abortController.signal.aborted) {
            console.log('[graph] client disconnected, aborting');
            abortController.abort();
        }
    };
    res.on('close', onClientClose);
    const cleanupDisconnect = () => { res.off('close', onClientClose); };

    if (!skipUserMessageSave) {
        saveMessage(userId, session_id, "user", userMessageForStorage ?? normalizedUserMessage);
    }

    const history = getHistoryMessages(userId, session_id, 10);
    const formattedHistory = history.map(toLangChainMessage);

    // 去重尾部用户消息
    if (history.length > 0) {
        const lastHistoryMessage = history[history.length - 1];
        if (
            lastHistoryMessage.role === "user" &&
            lastHistoryMessage.content === normalizedUserMessage
        ) {
            formattedHistory.pop();
        }
    }

    let fullText = "";
    let inputForAgent = normalizedUserMessage;
    const shouldBypassTools = isCreativeTask(normalizedUserMessage, systemPrompt) || hasImage || Boolean(forceModel);

    try {
        emitThought(res, "多智能体系统已启动，正在分析并路由你的问题");

        // 直接回答路径（图片/创意任务/forceModel）— 走原逻辑
        if (shouldBypassTools) {
            emitThought(res, hasImage ? "识别到图片输入，切换视觉理解模式" : "识别为直接回答任务，准备生成结果");
            const directSystemInstruction = buildDirectAnswerSystemInstruction(enableWebSearch, systemPrompt);
            const { fullText: directText, usage: directUsage } = await streamDirectChat({
                userMessage: normalizedUserMessage,
                image,
                formattedHistory,
                res,
                systemInstruction: directSystemInstruction,
                temperature,
                forceModel,
                abortController,
            });
            fullText = directText;

            const assistantMessageId = saveMessage(userId, session_id, "assistant", fullText);
            // Phase 5: finish trace (direct answer path)
            traceCollector.finishTrace(traceId, modelName, { messageId: assistantMessageId });
            // 优先使用真实 API usage，fallback 到 CJK-aware 估算
            const dMetrics = directUsage && directUsage.total_tokens > 0
                ? {
                    messageId: assistantMessageId,
                    latency_ms: Date.now() - startedAt,
                    prompt_tokens: directUsage.prompt_tokens,
                    completion_tokens: directUsage.completion_tokens,
                    total_tokens: directUsage.total_tokens,
                    model: modelName,
                    trace_id: traceId,
                  }
                : {
                    messageId: assistantMessageId,
                    latency_ms: Date.now() - startedAt,
                    prompt_tokens: estimateTokens(
                        `${directSystemInstruction}\n${formattedHistory.map((item) => normalizeChunkContent(item?.content)).join("\n")}\n${normalizedUserMessage}`
                    ),
                    completion_tokens: estimateTokens(fullText),
                    total_tokens: estimateTokens(
                        `${directSystemInstruction}\n${formattedHistory.map((item) => normalizeChunkContent(item?.content)).join("\n")}\n${normalizedUserMessage}`
                    ) + estimateTokens(fullText),
                    model: modelName,
                    trace_id: traceId,
                  };
            onComplete?.(dMetrics);
            emitThought(res, "回答生成完成", "done");
            res.write("data: [DONE]\n\n");
            res.end();
            cleanupDisconnect();
            return;
        }

        // 构建 LangGraph
        const sse = createSSEEmitter(res, traceCollector, traceId);
        const graph = buildAgentGraph();

        // ── Phase 4: 上下文工程 — 构建 token 感知的优化上下文 ──
        const memory = enableMemory ? new MemoryService(userId) : null;
        const contextBuilder = createChatContextBuilder(memory);
        const rawHistory = history.map(m => ({ role: m.role, content: m.content, timestamp: m.created_at }));
        const optimizedContext = await contextBuilder.build(
            inputForAgent,
            rawHistory,
            systemPrompt,
            { modelName }
        );

        const initialState = {
            messages: [
                ...formattedHistory,
                new HumanMessage(inputForAgent),
            ],
            userInput: inputForAgent,
            chatHistory: formattedHistory,
            currentDate: new Date().toLocaleString(),
            enableWebSearch,
            planMode,
            enableMemory,
            systemPrompt,
            temperature,
            modelName,
            intent: "general",
            intents: ["general"],
            currentAgent: null,
            // Phase 4: Plan-driven execution
            subTasks: [],
            planResults: {},
            currentSubTask: null,
            // Phase 4: 上下文工程
            optimizedContext,
        };

        const config = {
            configurable: {
                thread_id: `session-${session_id}-${Date.now()}`,
                sse, // SSE emitter 通过 config 传入节点
                abortSignal: abortController.signal, // 允许节点感知客户端断连
            },
        };

        emitThought(res, "路由分析完成，启动多智能体协作");

        await streamGraphToSSE(graph, initialState, config, res, sse, abortController);

        // 收集最终文本（从 Synthesizer 的输出）
        const checkpointState = await graph.getState(config);
        const lastMessages = checkpointState?.values?.messages || [];
        for (let i = lastMessages.length - 1; i >= 0; i--) {
            const msg = lastMessages[i];
            if (msg instanceof AIMessage && msg.content) {
                const text = normalizeChunkContent(msg.content);
                if (text && !text.startsWith("[Router]")) {
                    fullText = text;
                    break;
                }
            }
        }

        if (!fullText) {
            // Phase 4: 优先从 planResults 提取，其次是旧字段
            const pr = checkpointState?.values?.planResults || {};
            const prTexts = Object.values(pr).filter(Boolean);
            fullText = prTexts.length > 0
                ? prTexts.join("\n\n")
                : (checkpointState?.values?.searchResults ||
                   checkpointState?.values?.knowledgeResults ||
                   "");
        }

        const assistantMessageId = saveMessage(userId, session_id, "assistant", fullText);
        // Phase 5: finish trace (graph path)
        traceCollector.finishTrace(traceId, modelName, { messageId: assistantMessageId });
        // 优先使用 State 中累加的真实 API token usage，fallback 到 CJK-aware 估算
        const accUsage = checkpointState?.values?.tokenUsage;
        const gMetrics = (accUsage && accUsage.total_tokens > 0)
            ? {
                messageId: assistantMessageId,
                latency_ms: Date.now() - startedAt,
                prompt_tokens: accUsage.prompt_tokens,
                completion_tokens: accUsage.completion_tokens,
                total_tokens: accUsage.total_tokens,
                model: modelName,
                trace_id: traceId,
              }
            : {
                messageId: assistantMessageId,
                latency_ms: Date.now() - startedAt,
                prompt_tokens: estimateTokens(
                    `${systemPrompt}\n${formattedHistory.map((item) => normalizeChunkContent(item?.content)).join("\n")}\n${inputForAgent}`
                ),
                completion_tokens: estimateTokens(fullText),
                total_tokens: estimateTokens(
                    `${systemPrompt}\n${formattedHistory.map((item) => normalizeChunkContent(item?.content)).join("\n")}\n${inputForAgent}`
                ) + estimateTokens(fullText),
                model: modelName,
                trace_id: traceId,
              };
        onComplete?.(gMetrics);

        // ── Phase 4: 自动记忆巩固 ──
        // 会话结束后，自动将高重要性 working 记忆提升为 episodic
        if (enableMemory) {
            try {
                const memory = new MemoryService(userId);
                // 先用简单规则提取对话中的关键信息
                memory.extractFromConversation(normalizedUserMessage, session_id);
                // 然后执行记忆巩固
                const result = memory.consolidate("working", "episodic", 0.7);
                if (result.consolidated > 0) {
                    console.log(`[memory] auto-consolidated ${result.consolidated}/${result.total} memories for user ${userId}`);
                }
            } catch (memErr) {
                console.warn(`[memory] auto-consolidation failed:`, memErr.message);
            }
        }

        if (!clientDisconnected) {
            emitThought(res, "回答生成完成", "done");
            res.write("data: [DONE]\n\n");
        }
        res.end();
        cleanupDisconnect();
    } catch (error) {
        console.error(`[graph][fatal] message="${error.message}" stack="${error.stack}"`);
        cancelAllPendingQuestions();
        if (!clientDisconnected) {
            emitThought(res, "生成过程发生错误", "error");
            res.write(
                `data: ${JSON.stringify({ error: error.message || "graph stream failed" })}\n\n`
            );
        }
        res.end();
        cleanupDisconnect();
    }
}

// ═══════════════════════════════════════════════════════
// Phase 4: 测试导出（供 vitest 使用，不影响运行时行为）
// ═══════════════════════════════════════════════════════

export {
    AgentState,
    AGENT_META,
    AGENT_NODE_MAP,
    mapIntentToNode,
    enforceSubTaskOrder,
    subTasksToPlan,
    isSoloRun,
    fanoutToAgents,
    fanoutBySubTasks,
    fanoutByIntents,
    buildAgentGraph,
    createSSEEmitter,
};
