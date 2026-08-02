/**
 * chatUtils.js — 共享工具函数库
 *
 * 从 chat.js 提取的纯函数和常量，供 chat.js 和 chatGraph.js 复用。
 * Phase 2 改造的一部分，向后兼容：chat.js 通过 re-export 暴露这些函数。
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { createToolCallingAgent, AgentExecutor } from "@langchain/classic/agents";
import { agentTools } from "../mcp/tools.js";
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
    const source = String(text || "");
    if (!source.trim()) {
        return 0;
    }
    return Math.max(1, Math.ceil(source.length / 4));
}

// ═══════════════════════════════════════════════════════
// LLM 配置
// ═══════════════════════════════════════════════════════

export function buildChatOpenAIConfig() {
    return {
        apiKey: process.env.OPENAI_API_KEY,
        configuration: {
            baseURL: process.env.OPENAI_BASE_URL,
        },
        timeout: 120000,
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

export function emitThought(res, text, status = "running") {
    res.write(
        `data: ${JSON.stringify({
            type: "thought",
            text,
            status,
            at: new Date().toISOString()
        })}\n\n`
    );
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
    const allTools = toolRegistry.getAllTools();
    const tools = enableWebSearch
        ? allTools
        : allTools.filter((tool) => tool.name !== WEB_SEARCH_TOOL_NAME);

    const llm = new ChatOpenAI({
        modelName: resolveModelName(false),
        temperature,
        streaming: true,
        ...buildChatOpenAIConfig(),
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
    systemInstruction,
    temperature,
    forceModel,
    abortController,
}) {
    const hasImage = Boolean(image);
    const llm = new ChatOpenAI({
        modelName: resolveModelName(hasImage, forceModel),
        temperature,
        streaming: true,
        ...buildChatOpenAIConfig(),
    });

    const messages = [
        new SystemMessage(systemInstruction),
        ...formattedHistory,
        buildHumanInputMessage(userMessage, image)
    ];

    let fullText = "";
    const stream = await llm.stream(messages);

    for await (const chunk of stream) {
        if (abortController?.signal.aborted) {
            console.log('[agent] streamDirectChat aborted by client disconnect');
            break;
        }
        const text = normalizeChunkContent(chunk?.content);
        if (!text) {
            continue;
        }
        fullText += text;
        res.write(`data: ${JSON.stringify({ type: "text", text })}\n\n`);
    }

    return fullText;
}
