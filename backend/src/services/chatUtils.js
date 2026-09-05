/**
 * chatUtils.js — 共享工具函数库
 *
 * 从 chat.js 提取的纯函数和常量，供 chat.js 和 chatGraph.js 复用。
 * Phase 2 改造的一部分，向后兼容：chat.js 通过 re-export 暴露这些函数。
 */

import { ChatOpenAI } from "@langchain/openai";
import { withRetry } from "./resilience.js";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { createToolCallingAgent, AgentExecutor } from "@langchain/classic/agents";
import { agentTools, setMemoryToolContext } from "../mcp/tools.js";
import { getRequestContext } from "./requestContext.js";
import { getSSEWriter } from "./sse.js";
import { toolRegistry } from "../mcp/registry.js";

// ═══════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const FORCED_WEB_SEARCH_MAX_CHARS = 8000;
export const DEFAULT_SYSTEM_PROMPT = "你是一个有用的 AI 助手。";
export const DEFAULT_TEMPERATURE = 0.7;

export const TOOL_ACTIVE_FORMS = {
    web_search: "正在搜索网络...",
    search_knowledge_base: "正在检索知识库...",
    get_system_time: "正在获取系统时间...",
    get_db_message_count: "正在查询数据库...",
    update_todo: "正在规划任务...",
    ask_user_question: "等待用户回答...",
};

// ⚠️ Phase 1 发现：PLAN_MODE_INSTRUCTION 仅是 prompt 级别的"建议"，LLM 可能忽略。
// Phase 2 改造方向：拆分为独立的 Planner LLM 调用 + Executor ReAct 循环。
// 届时 PLAN_MODE_INSTRUCTION 将被 Planner Prompt 替代，update_todo SSE 机制保留。
export const PLAN_MODE_INSTRUCTION =
    "重要：在调用任何其他工具之前，你必须先调用 update_todo 工具列出完整的执行计划。每个任务项包含 id（小写数字编号如 \"1\"、\"2\"）和 content（任务描述）。列出计划后，按计划逐项执行，每完成一项可再次调用 update_todo 更新对应任务状态为 completed。";

// ═══════════════════════════════════════════════════════
// Token 估算
// ═══════════════════════════════════════════════════════

export function estimateTokens(text) {
    if (!text) return 0;
    const str = String(text);
    // CJK 字符 ≈ 1 token/字
    const cjkCount = (str.match(/[一-鿿㐀-䶿豈-﫿]/g) || []).length;
    // 非 CJK 按空白分词，1 词 ≈ 1.3 token
    const nonCjk = str.replace(/[一-鿿㐀-䶿豈-﫿]/g, " ");
    const wordCount = nonCjk.split(/\s+/).filter(Boolean).length;
    const estimate = Math.ceil(cjkCount + wordCount * 1.3);
    return estimate > 0 ? estimate : 0;
}

// ═══════════════════════════════════════════════════════
// 模型上下文窗口映射
// ═══════════════════════════════════════════════════════

/** 模型 → 上下文窗口上限 (tokens) */
const MODEL_CONTEXT_WINDOWS = {
    "qwen-long": 1_000_000,
    "qwen-turbo": 1_000_000,
    "qwen-plus": 131_072,
    "deepseek-v4-pro": 128_000,
    "deepseek-v4-flash": 128_000,
    "deepseek-v3": 64_000,
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
    "claude-sonnet-5": 200_000,
    "claude-opus-5": 200_000,
    "claude-fable-5": 200_000,
    "agnes-2.0-flash": 32_000,
    "agnes-2.0-pro": 32_000,
};

/**
 * 根据模型名获取上下文窗口上限
 * @param {string|null} modelName
 * @returns {number}
 */
export function getModelContextWindow(modelName) {
    if (!modelName) return 128_000;
    // 精确匹配
    if (MODEL_CONTEXT_WINDOWS[modelName]) return MODEL_CONTEXT_WINDOWS[modelName];
    // 模糊匹配：遍历所有已知模型前缀
    for (const [key, limit] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
        if (modelName.includes(key)) return limit;
    }
    // 默认 128K（最常见的上下文窗口）
    return 128_000;
}

/**
 * 从 AIMessageChunk/AIMessage 中提取真实 LLM API 返回的 token usage。
 * @param {object} chunk — LangChain AIMessageChunk 或 AIMessage
 * @returns {{ prompt_tokens: number, completion_tokens: number, total_tokens: number } | null}
 */
export function extractUsageFromChunk(chunk) {
    const um = chunk?.usage_metadata;
    if (um && typeof um.input_tokens === 'number') {
        return {
            prompt_tokens: um.input_tokens,
            completion_tokens: um.output_tokens,
            total_tokens: um.total_tokens,
        };
    }
    return null;
}

// ═══════════════════════════════════════════════════════
// LLM 配置
// ═══════════════════════════════════════════════════════

/**
 * 统一 LLM 构造配置。默认 `maxRetries: 0`：LangChain/OpenAI SDK 的内部重试交给
 * 调用方的 `withRetry` 统一管理（withRetry 是唯一重试预算层），避免"内部 maxRetries(默认 2)
 * × withRetry 叠乘"把一次上游故障放大到 ~9 次尝试。
 *
 * 仅当调用点**没有** withRetry、且只能在模型层重试时才显式传 `{ maxRetries: 2 }`
 * 保留单层内部重试 —— 典型如 legacy AgentExecutor（整 executor 用 withRetry 重跑会
 * 重放已执行工具的副作用，只能在模型 HTTP 层重试）。
 */
export function buildChatOpenAIConfig(hasImage = false, { maxRetries = 0 } = {}) {
    if (hasImage && process.env.VISION_BASE_URL) {
        return {
            apiKey: process.env.VISION_API_KEY || process.env.OPENAI_API_KEY,
            configuration: {
                baseURL: process.env.VISION_BASE_URL,
            },
            timeout: 120000,
            maxRetries,
        };
    }
    return {
        apiKey: process.env.OPENAI_API_KEY,
        configuration: {
            baseURL: process.env.OPENAI_BASE_URL,
        },
        timeout: 120000,
        maxRetries,
    };
}

export function resolveModelName(hasImage = false, forceModel = null) {
    if (forceModel) {
        return forceModel;
    }
    if (hasImage) {
        return process.env.QWEN_VISION_MODEL || process.env.OPENAI_MODEL || "agnes-2.0-flash";
    }
    return process.env.QWEN_MODEL || process.env.OPENAI_MODEL || "agnes-2.0-flash";
}

// ═══════════════════════════════════════════════════════
// SSE 辅助
// ═══════════════════════════════════════════════════════

export function emitThought(res, text, status = "running", writer = null) {
    return (writer || getSSEWriter(res, { requestId: res.req?.requestId })).write({
        type: "thought",
        text,
        status,
        at: new Date().toISOString(),
    });
}

// ═══════════════════════════════════════════════════════
// 消息转换
// ═══════════════════════════════════════════════════════

export function toLangChainMessage(message) {
    if (message.role === "user") {
        return new HumanMessage(message.content);
    }
    if (message.role === "assistant") {
        return new AIMessage(message.content);
    }
    return new SystemMessage(message.content);
}

export function buildHumanInputMessage(userMessage, image) {
    if (image) {
        return new HumanMessage({
            content: [
                { type: "text", text: userMessage || "请描述这张图片。" },
                { type: "image_url", image_url: { url: image } }
            ]
        });
    }
    return new HumanMessage(userMessage);
}

// ═══════════════════════════════════════════════════════
// 文本/参数规范化
// ═══════════════════════════════════════════════════════

export function normalizeChunkContent(content) {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") return part;
                if (part && typeof part.text === "string") return part.text;
                return "";
            })
            .join("");
    }
    if (content == null) {
        return "";
    }
    return String(content);
}

export function normalizeTemperature(input) {
    const value = Number(input);
    if (!Number.isFinite(value)) {
        return DEFAULT_TEMPERATURE;
    }
    return Math.max(0, Math.min(1, value));
}

export function resolveSystemPrompt(input) {
    const prompt = String(input || "").trim();
    return prompt || DEFAULT_SYSTEM_PROMPT;
}

// ═══════════════════════════════════════════════════════
// 任务类型判断
// ═══════════════════════════════════════════════════════

export function isCreativeTask(input, systemPrompt) {
    const merged = `${String(input || "")}\n${String(systemPrompt || "")}`.toLowerCase();
    return /(slogan|标语|文案|广告语|取名|命名|润色|改写|创意|头脑风暴|branding|copywriting)/.test(merged);
}

// ═══════════════════════════════════════════════════════
// Prompt 构建
// ═══════════════════════════════════════════════════════

export function buildDirectAnswerSystemInstruction(enableWebSearch, userSystemPrompt) {
    const creativeGuard =
        "创意写作类任务（如标语、文案、命名、润色、头脑风暴）默认不调用任何工具，直接给出高质量结果。仅当用户明确要求基于上传文档证据时才允许调用 search_knowledge_base。";
    const noWebSearchGuard =
        "本轮已关闭联网检索：不要调用 web_search。若不是文档事实问答，也不要调用 search_knowledge_base。";

    return enableWebSearch
        ? `${userSystemPrompt}\n\n${creativeGuard}`
        : `${userSystemPrompt}\n\n${creativeGuard}\n${noWebSearchGuard}`;
}

export function buildPrompt(enableWebSearch, userSystemPrompt, planMode = false) {
    const baseInstruction =
        `${userSystemPrompt}\n\n当前系统时间是：{current_date}。请优先基于可验证信息回答，保持结论清晰、结构化。`;

    const creativeTaskInstruction =
        "若用户请求是创意写作（如标语、文案、命名、润色、头脑风暴），请直接创作答案，不要调用工具。仅当用户明确要求「基于上传文档/证据」时才调用 search_knowledge_base。";

    const webSearchInstruction =
        "当你无法确定事实或用户询问最新资讯时，请务必主动使用 web_search 工具获取真实信息，并结合搜索结果进行总结回答。凡是公开互联网新闻、时事、公司动态、人物动态等问题，优先使用 web_search，不要误用 search_knowledge_base。同一轮回答默认只调用一次 web_search，除非用户明确要求追加检索。你必须基于 web_search 返回的条目作答，不得编造未检索到的事实。若用户要求时间窗口（如最近24小时、最近一周、最近一个月等），优先满足时间约束并明确说明命中情况；若工具返回「待核验」或「超窗候选」，必须在回答中显式标注其可靠性限制。";

    const noWebSearchInstruction =
        "本轮已关闭联网检索：不要调用 web_search，也不要假设你看到了实时网页结果。若问题依赖最新外部信息，请明确说明当前未启用联网，提示用户开启后再查证。如果不是文档事实问答，不要调用 search_knowledge_base。";

    const toolRetryInstruction =
        "如果工具返回「当前知识库为空」或「未检索到相关知识片段」，立即停止继续调用该工具，并直接给出不依赖该工具的回答。";

    const planPrefix = planMode ? `${PLAN_MODE_INSTRUCTION}\n\n` : "";
    const systemInstruction = enableWebSearch
        ? `${planPrefix}${baseInstruction}\n\n${creativeTaskInstruction}\n\n${webSearchInstruction}\n\n${toolRetryInstruction}`
        : `${planPrefix}${baseInstruction}\n\n${creativeTaskInstruction}\n\n${noWebSearchInstruction}\n\n${toolRetryInstruction}`;

    return ChatPromptTemplate.fromMessages([
        ["system", systemInstruction],
        new MessagesPlaceholder("chat_history"),
        ["user", "{input}"],
        new MessagesPlaceholder("agent_scratchpad")
    ]);
}

// ═══════════════════════════════════════════════════════
// AgentExecutor 构建（旧 ReAct 路径）
// ═══════════════════════════════════════════════════════

export async function getAgentExecutor(enableWebSearch, temperature, systemPrompt, planMode = false) {
    const allTools = toolRegistry.getAllTools(getRequestContext());
    const tools = enableWebSearch
        ? allTools
        : allTools.filter((tool) => tool.name !== WEB_SEARCH_TOOL_NAME);

    // legacy AgentExecutor 路径**不加** withRetry（整 executor 重跑会重放已执行工具的
    // 副作用），因此保留模型层内部 maxRetries:2 作为其唯一重试层；其余经 withRetry
    // 包裹的调用点由 buildChatOpenAIConfig 默认 maxRetries:0 统一关闭内部重试。
    const llm = new ChatOpenAI({
        modelName: resolveModelName(false),
        temperature,
        streaming: true,
        ...buildChatOpenAIConfig(false, { maxRetries: 2 }),
    });
    const prompt = buildPrompt(enableWebSearch, systemPrompt, planMode);
    const agent = await createToolCallingAgent({
        llm,
        tools,
        prompt
    });

    const maxIterations = planMode ? 8 : 4;
    return new AgentExecutor({
        agent,
        tools,
        maxIterations,
        earlyStoppingMethod: "force"
    });
}

// ═══════════════════════════════════════════════════════
// 直接聊天流（无工具路径）
// ═══════════════════════════════════════════════════════

export async function streamDirectChat({
    userMessage,
    image,
    formattedHistory,
    res,
    writer = null,
    systemInstruction,
    temperature,
    forceModel,
    abortController,
}) {
    const hasImage = Boolean(image);
    const modelName = resolveModelName(hasImage, forceModel);
    const config = buildChatOpenAIConfig(hasImage);
    console.log(`[agent] streamDirectChat model=${modelName} baseURL=${config.configuration?.baseURL} hasImage=${hasImage}`);

    const llm = new ChatOpenAI({
        modelName,
        temperature,
        streaming: true,
        ...config,
    });

    const messages = [
        new SystemMessage(systemInstruction),
        ...formattedHistory,
        buildHumanInputMessage(userMessage, image)
    ];

    let fullText = "";
    let usage = null;

    try {
        const stream = await withRetry(
            (_, signal) => llm.stream(messages, { signal }),
            { retries: 2, signal: abortController?.signal }
        );

        for await (const chunk of stream) {
            if (abortController?.signal.aborted) {
                console.log('[agent] streamDirectChat aborted by client disconnect');
                break;
            }
            // 从最后一个 chunk 提取真实 API token usage
            const chunkUsage = extractUsageFromChunk(chunk);
            if (chunkUsage) usage = chunkUsage;

            const text = normalizeChunkContent(chunk?.content);
            if (!text) {
                continue;
            }
            fullText += text;
            (writer || getSSEWriter(res, { requestId: res.req?.requestId })).write({ type: "text", text });
        }
    } catch (err) {
        console.error(`[agent] streamDirectChat failed: model=${modelName} baseURL=${config.configuration?.baseURL} error="${err.message}"`);
        // Do not turn an upstream failure into a successful placeholder. The
        // caller must be able to mark idempotency as failed and avoid storing
        // an assistant message that can later be replayed as a success.
        throw err;
    }

    return { fullText, usage };
}
