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
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { StateGraph, START, END, Annotation, addMessages, MemorySaver, Send } from "@langchain/langgraph";
import { saveMessage, getHistoryMessages } from "../db/index.js";
import { agentTools, consumePendingQuestion, cancelAllPendingQuestions } from "../mcp/tools.js";
import { toolRegistry } from "../mcp/registry.js";
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
};

// intent → 节点名 映射表
const AGENT_NODE_MAP = {
    search:    "search_agent",
    knowledge: "knowledge_agent",
    code:      "code_agent",
    general:   "general_chat",
};

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
    systemPrompt: Annotation({ default: () => "你是一个有用的 AI 助手。" }),
    temperature: Annotation({ default: () => 0.7 }),
    modelName: Annotation({ default: () => "deepseek-v4-flash" }),

    // 路由字段（多意图：Router 可返回多个意图并行执行）
    intent: Annotation({ default: () => "general" }),
    intents: Annotation({ default: () => ["general"] }),
    primarySource: Annotation({ default: () => null }),

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

    // SSE 上下文（通过闭包注入，不存到 checkpoint）
    sseEnabled: Annotation({ default: () => true }),
});

// ═══════════════════════════════════════════════════════
// SSE 事件发射器（闭包捕获 res）
// ═══════════════════════════════════════════════════════

function createSSEEmitter(res) {
    return {
        agentStart(agentType) {
            const meta = AGENT_META[agentType] || {};
            const payload = {
                type: "agent_start",
                agentName: meta.name || agentType,
                agentType: meta.type || agentType,
                at: new Date().toISOString(),
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        },
        agentEnd(agentType) {
            const meta = AGENT_META[agentType] || {};
            const payload = {
                type: "agent_end",
                agentName: meta.name || agentType,
                agentType: meta.type || agentType,
                at: new Date().toISOString(),
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
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
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
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
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
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
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
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
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        },
        textChunk(text) {
            res.write(`data: ${JSON.stringify({ type: "text", text })}\n\n`);
        },
        todoUpdated(todos) {
            res.write(`data: ${JSON.stringify({
                type: "todo_updated",
                todos,
                at: new Date().toISOString(),
            })}\n\n`);
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
    console.log(`[graph][init] userInput length=${state.userInput.length} enableWebSearch=${state.enableWebSearch}`);
    return { currentAgent: "router" };
}

// ═══════════════════════════════════════════════════════
// 节点 2: RouterNode — LLM 意图分类
// ═══════════════════════════════════════════════════════

async function routerNode(state) {
    console.log(`[graph][router] classifying intent for: "${state.userInput.slice(0, 80)}..."`);

    const llm = new ChatOpenAI({
        modelName: state.modelName,
        temperature: 0,
        ...buildChatOpenAIConfig(),
    });

    const planHint = state.planMode
        ? `\n\n注意：计划模式已开启。请在 analysis 中列出执行步骤，并始终返回 JSON 格式。`
        : "";

    const prompt = `你是一个智能路由助手。分析用户的问题，判断需要哪些专业智能体来处理。可以同时选择多个。

分类选项：
- "general": 普通对话、问候、闲聊、简单问答、创意写作
- "search": 需要搜索最新网络信息（新闻、实时数据、近期事件、不确定的事实）
- "knowledge": 需要从已上传的文档/知识库中检索信息（用户提到了文档、资料、文件等）
- "code": 需要编写、分析或调试代码${planHint}

用户问题：${state.userInput}

请严格返回 JSON 格式，不要包含其他文字：
{"intents": ["general"], "primarySource": null, "analysis": "一句话理由"}

intents 规则：
- 大多数问题只需要一个意图，如 ["search"] 或 ["code"] 或 ["general"]
- 当用户同时提出多个不相关的需求时，返回多个，如 ["search", "code"]（搜资料+写代码）
- "general" 通常不与其他意图组合`;

    let intent = "general";
    let intents = ["general"];
    let primarySource = null;
    let analysis = "";

    try {
        const response = await llm.invoke([new SystemMessage(prompt)]);
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

    // ── 能力校验 (主闸门)：对每个意图逐个过滤 ──
    // search 意图 + 联网关闭 → 从列表中移除
    const filteredIntents = intents.filter((i) => {
        if (i === "search" && !state.enableWebSearch) {
            console.log(`[graph][router] capability gate: search removed (enableWebSearch=false)`);
            return false;
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

async function plannerNode(state, config) {
    const sse = config?.configurable?.sse;

    // 非 Plan 模式 / 普通聊天 → 跳过计划生成
    if (!state.planMode || state.intent === "general") {
        console.log(`[graph][planner] skipped (planMode=${state.planMode}, intent=${state.intent})`);
        return { currentAgent: "router" };
    }

    console.log(`[graph][planner] generating plan for intent="${state.intent}"`);

    const llm = new ChatOpenAI({
        modelName: state.modelName,
        temperature: 0,
        ...buildChatOpenAIConfig(),
    });

    const intentStepGuide = {
        search:    "①搜索/获取信息 → ②筛选整理关键内容 → ③综合输出最终回答",
        knowledge: "①检索知识库文档 → ②提取相关片段 → ③组织答案输出",
        code:      "①分析需求/设计思路 → ②编写代码 → ③审查并输出",
    };
    const stepGuide = intentStepGuide[state.intent] || "①分析问题 → ②执行 → ③总结输出";

    const prompt = `你是一个任务规划助手。将用户的请求分解为 2-5 个具体执行步骤。
步骤必须按实际执行的时间顺序排列（先做什么、再做什么、最后做什么）。

用户意图类型：${state.intent}
推荐步骤模式：${stepGuide}
用户问题：${state.userInput}

请严格返回 JSON 数组，步骤按执行先后排列，每个步骤包含 id(字符串从"1"递增)、content(步骤描述，要具体不要笼统)、status(固定为"pending")：
[
  {"id": "1", "content": "【第一步，最先执行】…", "status": "pending"},
  {"id": "2", "content": "【第二步，基于上一步结果】…", "status": "pending"}
]

注意：第一步必须是获取信息/数据的具体操作，最后一步必须是整理输出最终回答。
只返回 JSON 数组，不要包含其他文字。`;

    let plan = [];
    try {
        const response = await llm.invoke([new HumanMessage(prompt)]);
        const raw = normalizeChunkContent(response.content);
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            plan = JSON.parse(jsonMatch[0]);
        }
    } catch (err) {
        console.log(`[graph][planner] plan generation failed: ${err.message}`);
        // 降级：生成一个默认单步计划
        plan = [{ id: "1", content: `执行${AGENT_META[state.intent]?.name || state.intent}任务`, status: "pending" }];
    }

    // 后处理：强制执行 gather → analyze → synthesize 排序（BUG-P2-01 修复）
    plan = enforcePlanOrder(plan);

    // 标记第一步为 in_progress
    if (plan.length > 0) {
        plan[0].status = "in_progress";
    }

    console.log(`[graph][planner] generated ${plan.length} steps (order enforced)`);

    // 发射 todo_updated SSE → 前端 TaskProgressCard
    if (sse) {
        sse.todoUpdated(plan);
    }

    // 计划存入 state.plan，子 Agent 通过 buildPlanAwareInstruction 感知计划
    // 不覆盖 state.userInput，保持原始用户输入（搜索引擎需要精确的查询词）
    return {
        plan,
        currentAgent: "router",
    };
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
    if (sse) sse.agentStart("general");

    const llm = new ChatOpenAI({
        modelName: state.modelName,
        temperature: state.temperature,
        streaming: true,
        ...buildChatOpenAIConfig(),
    });

    const messages = [
        new SystemMessage(`${state.systemPrompt}\n当前时间：${state.currentDate}`),
        ...state.chatHistory,
        new HumanMessage(state.userInput),
    ];

    let fullText = "";
    try {
        const stream = await llm.stream(messages);
        for await (const chunk of stream) {
            const text = normalizeChunkContent(chunk?.content);
            if (!text) continue;
            fullText += text;
            if (sse) sse.textChunk(text);
        }
    } catch (err) {
        console.log(`[graph][general] stream error: ${err.message}`);
        fullText = `回答生成失败: ${err.message}`;
        if (sse) sse.textChunk(fullText);
    }

    if (sse) sse.agentEnd("general");

    return {
        messages: [new AIMessage({ content: fullText })],
        currentAgent: "general",
    };
}

// ═══════════════════════════════════════════════════════
// 节点 4: SearchAgentNode — 联网搜索 Agent
// ═══════════════════════════════════════════════════════

async function searchAgentNode(state, config) {
    const solo = isSoloRun(state);
    console.log(`[graph][search] starting (mode=${solo ? 'solo' : 'parallel'})`);

    const sse = config?.configurable?.sse;
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
        try {
            const stream = await llm.stream(messages);
            for await (const chunk of stream) {
                const text = normalizeChunkContent(chunk?.content);
                if (!text) continue;
                fullText += text;
                if (sse) sse.textChunk(text);
            }
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

    try {
        const firstResponse = await llmWithTools.invoke(messages);
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
                    const stream = await summaryLlm.stream(summaryMessages);
                    for await (const chunk of stream) {
                        const text = normalizeChunkContent(chunk?.content);
                        if (!text) continue;
                        fullText += text;
                        if (sse) sse.textChunk(text);
                    }
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
    };
}

// ═══════════════════════════════════════════════════════
// 节点 6: CodeAgentNode — 代码 Agent（占位）
// ═══════════════════════════════════════════════════════

async function codeAgentNode(state, config) {
    const solo = isSoloRun(state);
    console.log(`[graph][code] starting (mode=${solo ? 'solo' : 'parallel'})`);

    const sse = config?.configurable?.sse;
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
        try {
            const stream = await llm.stream(messages);
            for await (const chunk of stream) {
                const text = normalizeChunkContent(chunk?.content);
                if (!text) continue;
                fullText += text;
                if (sse) sse.textChunk(text);
            }
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
        };
    }

    // ── Parallel 模式：invoke 生成代码，存结果给 Synthesizer 融合 ──
    let codeResults = "";
    try {
        const response = await llm.invoke(messages);
        codeResults = normalizeChunkContent(response.content || "");
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
    const agentType = "synthesizer";
    const intents = state.intents || [state.intent || "general"];

    if (sse) sse.agentStart(agentType);

    // Synthesizer 启动 → 若计划未全部完成，标记最后一个步骤为 in_progress
    let plan = state.plan || [];
    const planAllDone = plan.length > 0 && plan.every(s => s.status === 'completed');
    if (!planAllDone) {
        plan = emitPlanProgress(sse, plan, 'synth_start');
    }

    // ── Solo 模式 → 透传 ──
    // 单 Agent 已在各自节点中流式输出了最终回答，Synthesizer 不重复
    const solo = intents.length === 1;

    if (solo) {
        console.log(`[graph][synthesizer] solo mode (${intents[0]}), pass-through`);
        plan = completePlan(plan, sse);
        if (sse) sse.agentEnd(agentType);
        return { plan, currentAgent: "synthesizer" };
    }

    // ── 收集所有子 Agent 的结果 ──
    const sources = [];
    let contextBlock = "";

    if (state.searchResults) {
        sources.push("搜索");
        contextBlock += `\n\n[搜索结果]\n${state.searchResults.slice(0, 4000)}`;
    }
    if (state.knowledgeResults) {
        sources.push("知识库");
        contextBlock += `\n\n[知识库结果]\n${state.knowledgeResults.slice(0, 4000)}`;
    }
    if (state.codeResults) {
        sources.push("代码");
        contextBlock += `\n\n[代码生成结果]\n${state.codeResults.slice(0, 4000)}`;
    }

    // 如果没有工具型结果（极端情况），回退到透传
    if (sources.length === 0) {
        console.log(`[graph][synthesizer] no tool results available, pass-through`);
        plan = completePlan(plan, sse);
        if (sse) sse.agentEnd(agentType);
        return { plan, currentAgent: "synthesizer" };
    }

    console.log(`[graph][synthesizer] merging ${sources.length} source(s): [${sources.join(", ")}]`);

    // ── 融合生成最终回答 ──
    const llm = new ChatOpenAI({
        modelName: state.modelName,
        temperature: state.temperature,
        streaming: true,
        ...buildChatOpenAIConfig(),
    });

    const mergeHint = sources.length > 1
        ? `\n注意：以上结果来自 ${sources.join("、")} 等多个Agent的并行分析。请将它们融合为一个连贯的回答，避免内容重复。`
        : "";

    const systemMsg = new SystemMessage(
        `${state.systemPrompt}\n当前时间：${state.currentDate}\n\n你是综合处理助手。根据以下专业Agent的执行结果，为用户问题生成完整、准确的回答。${contextBlock}${mergeHint}\n\n请用自然语言组织回答，确保信息准确、结构清晰。${state.searchResults ? '需要引用搜索来源时请注明。' : ''}`
    );

    const messages = [
        systemMsg,
        ...state.chatHistory,
        new HumanMessage(state.userInput),
    ];

    let fullText = "";
    try {
        const stream = await llm.stream(messages);
        for await (const chunk of stream) {
            const text = normalizeChunkContent(chunk?.content);
            if (!text) continue;
            fullText += text;
            if (sse) sse.textChunk(text);
        }
    } catch (err) {
        console.log(`[graph][synthesizer] stream error: ${err.message}`);
        // Fallback: 直接拼接所有结果
        fullText = [state.searchResults, state.knowledgeResults, state.codeResults]
            .filter(Boolean)
            .join("\n\n");
        if (sse && fullText) sse.textChunk(fullText);
    }

    // 综合输出完成 → 所有步骤完成
    plan = emitPlanProgress(sse, plan, 'all_done');
    if (sse) sse.agentEnd(agentType);

    return {
        messages: [new AIMessage({ content: fullText })],
        plan,
        currentAgent: "synthesizer",
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
// 替代旧 routeByIntent 的单选模式，实现 Phase 2 的多 Agent 并行。
// ═══════════════════════════════════════════════════════

function fanoutToAgents(state) {
    let intents = state.intents || [state.intent || "general"];

    // 去重
    intents = [...new Set(intents)];

    // 如果 general 与其他意图混合，移除 general — 让工具型 Agent 处理，
    // Synthesizer 统一输出，避免 general_chat 流式输出与其他 Agent 结果冲突
    if (intents.length > 1 && intents.includes("general")) {
        console.log(`[graph][route] removing "general" from mixed intents (synthesizer handles output)`);
        intents = intents.filter(i => i !== "general");
    }

    // Fallback
    if (intents.length === 0) {
        console.log(`[graph][route] no valid intents, fallback to general`);
        return "general";
    }

    // ── 单 Agent → 直接返回 intent 字符串，保留完整 state ──
    // 注意：返回的是 intent 名（如 "search"），不是节点名（如 "search_agent"）
    // addConditionalEdges 的映射表负责 intent → 节点名 的转换
    if (intents.length === 1) {
        console.log(`[graph][route] single: ${intents[0]} → ${AGENT_NODE_MAP[intents[0]]}`);
        return intents[0];
    }

    // ── 多 Agent → Send[] 并行扇出 ──
    const sends = [];
    for (const intent of intents) {
        const nodeName = AGENT_NODE_MAP[intent];
        if (nodeName) {
            // Send 的 args 会作为节点的 state 输入，需要传递完整 state
            sends.push(new Send(nodeName, { ...state }));
        } else {
            console.log(`[graph][route] unknown intent "${intent}", skipping`);
        }
    }

    console.log(`[graph][route] fanout: [${intents.join(", ")}] → [${sends.map((s) => s.node).join(", ")}] (${sends.length} parallel)`);
    return sends;
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
        .addNode("synthesizer", synthesizerNode)

        .addEdge(START, "initialize")
        .addEdge("initialize", "router")
        .addEdge("router", "planner")
        .addConditionalEdges("planner", fanoutToAgents, {
            general: "general_chat",
            search: "search_agent",
            knowledge: "knowledge_agent",
            code: "code_agent",
        })
        .addEdge("general_chat", "synthesizer")
        .addEdge("search_agent", "synthesizer")
        .addEdge("knowledge_agent", "synthesizer")
        .addEdge("code_agent", "synthesizer")
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
        onComplete,
    } = options;
    const normalizedUserMessage = String(userMessage || "");
    const temperature = normalizeTemperature(temperatureInput);
    const systemPrompt = resolveSystemPrompt(systemPromptInput);
    const hasImage = Boolean(image);
    const startedAt = Date.now();
    const modelName = resolveModelName(hasImage, forceModel);

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
            fullText = await streamDirectChat({
                userMessage: normalizedUserMessage,
                image,
                formattedHistory,
                res,
                systemInstruction: directSystemInstruction,
                temperature,
                forceModel,
                abortController,
            });

            const assistantMessageId = saveMessage(userId, session_id, "assistant", fullText);
            const promptTokens = estimateTokens(
                `${directSystemInstruction}\n${formattedHistory.map((item) => normalizeChunkContent(item?.content)).join("\n")}\n${normalizedUserMessage}`
            );
            const completionTokens = estimateTokens(fullText);
            onComplete?.({
                messageId: assistantMessageId,
                latency_ms: Date.now() - startedAt,
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
                model: modelName,
            });
            emitThought(res, "回答生成完成", "done");
            res.write("data: [DONE]\n\n");
            res.end();
            cleanupDisconnect();
            return;
        }

        // 构建 LangGraph
        const sse = createSSEEmitter(res);
        const graph = buildAgentGraph();

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
            systemPrompt,
            temperature,
            modelName,
            intent: "general",
            intents: ["general"],
            currentAgent: null,
        };

        const config = {
            configurable: {
                thread_id: `session-${session_id}-${Date.now()}`,
                sse, // SSE emitter 通过 config 传入节点
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
            // Fallback: 从 Search/Knowledge 节点的结果提取
            fullText = checkpointState?.values?.searchResults ||
                       checkpointState?.values?.knowledgeResults ||
                       "";
        }

        const assistantMessageId = saveMessage(userId, session_id, "assistant", fullText);
        const promptTokens = estimateTokens(
            `${systemPrompt}\n${formattedHistory.map((item) => normalizeChunkContent(item?.content)).join("\n")}\n${inputForAgent}`
        );
        const completionTokens = estimateTokens(fullText);
        onComplete?.({
            messageId: assistantMessageId,
            latency_ms: Date.now() - startedAt,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            model: modelName,
        });

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
