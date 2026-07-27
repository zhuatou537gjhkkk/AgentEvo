import crypto from "crypto";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { createToolCallingAgent, AgentExecutor } from "@langchain/classic/agents";
import { saveMessage, getHistoryMessages } from "../db/index.js";
import { agentTools } from "../mcp/tools.js";

const WEB_SEARCH_TOOL_NAME = "web_search";
const FORCED_WEB_SEARCH_MAX_CHARS = 8000;
const DEFAULT_SYSTEM_PROMPT = "你是一个有用的 AI 助手。";
const DEFAULT_TEMPERATURE = 0.7;

function estimateTokens(text) {
    const source = String(text || "");
    if (!source.trim()) {
        return 0;
    }

    return Math.max(1, Math.ceil(source.length / 4));
}

function buildChatOpenAIConfig() {
    return {
        apiKey: process.env.OPENAI_API_KEY,
        configuration: {
            baseURL: process.env.OPENAI_BASE_URL,
        },
        timeout: 120000,
    };
}

function resolveModelName(hasImage = false, forceModel = null) {
    if (forceModel) {
        return forceModel;
    }

    if (hasImage) {
        // agnes-2.0-flash 支持多模态识图，默认使用该模型
        return process.env.QWEN_VISION_MODEL || process.env.OPENAI_MODEL || "agnes-2.0-flash";
    }

    return process.env.QWEN_MODEL || process.env.OPENAI_MODEL || "agnes-2.0-flash";
}

function emitThought(res, text, status = "running") {
    res.write(
        `data: ${JSON.stringify({
            type: "thought",
            text,
            status,
            at: new Date().toISOString()
        })}\n\n`
    );
}

function toLangChainMessage(message) {
    if (message.role === "user") {
        return new HumanMessage(message.content);
    }

    if (message.role === "assistant") {
        return new AIMessage(message.content);
    }

    return new SystemMessage(message.content);
}

function normalizeChunkContent(content) {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") {
                    return part;
                }

                if (part && typeof part.text === "string") {
                    return part.text;
                }

                return "";
            })
            .join("");
    }

    if (content == null) {
        return "";
    }

    return String(content);
}

function normalizeTemperature(input) {
    const value = Number(input);
    if (!Number.isFinite(value)) {
        return DEFAULT_TEMPERATURE;
    }

    return Math.max(0, Math.min(1, value));
}

function resolveSystemPrompt(input) {
    const prompt = String(input || "").trim();
    return prompt || DEFAULT_SYSTEM_PROMPT;
}

function isCreativeTask(input, systemPrompt) {
    const merged = `${String(input || "")}\n${String(systemPrompt || "")}`.toLowerCase();
    return /(slogan|标语|文案|广告语|取名|命名|润色|改写|创意|头脑风暴|branding|copywriting)/.test(merged);
}

function buildDirectAnswerSystemInstruction(enableWebSearch, userSystemPrompt) {
    const creativeGuard =
        "创意写作类任务（如标语、文案、命名、润色、头脑风暴）默认不调用任何工具，直接给出高质量结果。仅当用户明确要求基于上传文档证据时才允许调用 search_knowledge_base。";
    const noWebSearchGuard =
        "本轮已关闭联网检索：不要调用 web_search。若不是文档事实问答，也不要调用 search_knowledge_base。";

    return enableWebSearch
        ? `${userSystemPrompt}\n\n${creativeGuard}`
        : `${userSystemPrompt}\n\n${creativeGuard}\n${noWebSearchGuard}`;
}

function buildPrompt(enableWebSearch, userSystemPrompt) {
    const baseInstruction =
        `${userSystemPrompt}\n\n当前系统时间是：{current_date}。请优先基于可验证信息回答，保持结论清晰、结构化。`;

    const creativeTaskInstruction =
        "若用户请求是创意写作（如标语、文案、命名、润色、头脑风暴），请直接创作答案，不要调用工具。仅当用户明确要求“基于上传文档/证据”时才调用 search_knowledge_base。";

    const webSearchInstruction =
        "当你无法确定事实或用户询问最新资讯时，请务必主动使用 web_search 工具获取真实信息，并结合搜索结果进行总结回答。凡是公开互联网新闻、时事、公司动态、人物动态等问题，优先使用 web_search，不要误用 search_knowledge_base。同一轮回答默认只调用一次 web_search，除非用户明确要求追加检索。你必须基于 web_search 返回的条目作答，不得编造未检索到的事实。若用户要求时间窗口（如最近24小时、最近一周、最近一个月等），优先满足时间约束并明确说明命中情况；若工具返回“待核验”或“超窗候选”，必须在回答中显式标注其可靠性限制。";

    const noWebSearchInstruction =
        "本轮已关闭联网检索：不要调用 web_search，也不要假设你看到了实时网页结果。若问题依赖最新外部信息，请明确说明当前未启用联网，提示用户开启后再查证。如果不是文档事实问答，不要调用 search_knowledge_base。";

    const toolRetryInstruction =
        "如果工具返回“当前知识库为空”或“未检索到相关知识片段”，立即停止继续调用该工具，并直接给出不依赖该工具的回答。";

    const systemInstruction = enableWebSearch
        ? `${baseInstruction}\n\n${creativeTaskInstruction}\n\n${webSearchInstruction}\n\n${toolRetryInstruction}`
        : `${baseInstruction}\n\n${creativeTaskInstruction}\n\n${noWebSearchInstruction}\n\n${toolRetryInstruction}`;

    return ChatPromptTemplate.fromMessages([
        ["system", systemInstruction],
        new MessagesPlaceholder("chat_history"),
        ["user", "{input}"],
        new MessagesPlaceholder("agent_scratchpad")
    ]);
}

async function getAgentExecutor(enableWebSearch, temperature, systemPrompt) {
    const tools = enableWebSearch
        ? agentTools
        : agentTools.filter((tool) => tool.name !== WEB_SEARCH_TOOL_NAME);

    const llm = new ChatOpenAI({
        modelName: resolveModelName(false),
        temperature,
        streaming: true,
        ...buildChatOpenAIConfig(),
    });
    const prompt = buildPrompt(enableWebSearch, systemPrompt);
    const agent = await createToolCallingAgent({
        llm,
        tools,
        prompt
    });

    return new AgentExecutor({
        agent,
        tools,
        maxIterations: 4,
        earlyStoppingMethod: "generate"
    });
}

function buildHumanInputMessage(userMessage, image) {
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

async function streamDirectChat({
    userMessage,
    image,
    formattedHistory,
    res,
    systemInstruction,
    temperature,
    forceModel
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
        const text = normalizeChunkContent(chunk?.content);
        if (!text) {
            continue;
        }

        fullText += text;
        res.write(`data: ${JSON.stringify({ type: "text", text })}\n\n`);
    }

    return fullText;
}

export async function chatWithStream(userId, session_id, userMessage, image, systemPromptInput, temperatureInput, res, options = {}) {
    const {
        enableWebSearch = false,
        skipUserMessageSave = false,
        userMessageForStorage,
        forceModel = null,
        onComplete,
    } = options;
    const normalizedUserMessage = String(userMessage || "");
    const temperature = normalizeTemperature(temperatureInput);
    const systemPrompt = resolveSystemPrompt(systemPromptInput);
    const hasImage = Boolean(image);
    const startedAt = Date.now();
    const modelName = resolveModelName(hasImage, forceModel);

    if (!skipUserMessageSave) {
        saveMessage(userId, session_id, "user", userMessageForStorage ?? normalizedUserMessage);
    }

    const history = getHistoryMessages(userId, session_id, 10);
    const formattedHistory = history.map(toLangChainMessage);

    // We pass the latest user message as input, so remove duplicated tail user message from chat_history.
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
        emitThought(res, "正在分析你的问题");

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
                forceModel
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
            return;
        }

        if (enableWebSearch) {
            emitThought(res, "需要联网信息，正在准备搜索");
            const webSearchTool = agentTools.find((tool) => tool.name === WEB_SEARCH_TOOL_NAME);

            if (webSearchTool) {
                const forcedToolCallId = crypto.randomUUID();
                const startedAt = new Date().toISOString();
                console.log(
                    `[agent][tool_start][forced] at=${startedAt} id=${forcedToolCallId} name=${WEB_SEARCH_TOOL_NAME} input=${JSON.stringify(normalizedUserMessage)}`
                );
                res.write(
                    `data: ${JSON.stringify({
                        type: "tool_start",
                        toolCallId: forcedToolCallId,
                        toolName: WEB_SEARCH_TOOL_NAME,
                        input: normalizedUserMessage
                    })}\n\n`
                );

                let forcedSearchOutput = "";
                let forcedSearchError = null;

                try {
                    const toolResult = await webSearchTool.invoke(normalizedUserMessage);
                    forcedSearchOutput = normalizeChunkContent(toolResult).slice(0, FORCED_WEB_SEARCH_MAX_CHARS);
                } catch (forcedSearchErrorObj) {
                    forcedSearchError = forcedSearchErrorObj?.message || "unknown error";
                    forcedSearchOutput = `强制联网检索失败: ${forcedSearchError}`;
                }

                const endedAt = new Date().toISOString();

                if (forcedSearchError) {
                    console.log(
                        `[agent][tool_error][forced] at=${endedAt} id=${forcedToolCallId} name=${WEB_SEARCH_TOOL_NAME} error=${forcedSearchError}`
                    );
                    res.write(
                        `data: ${JSON.stringify({
                            type: "tool_error",
                            toolCallId: forcedToolCallId,
                            toolName: WEB_SEARCH_TOOL_NAME,
                            error: forcedSearchError
                        })}\n\n`
                    );
                } else {
                    console.log(
                        `[agent][tool_end][forced] at=${endedAt} id=${forcedToolCallId} name=${WEB_SEARCH_TOOL_NAME} output=${JSON.stringify(forcedSearchOutput)}`
                    );
                    res.write(
                        `data: ${JSON.stringify({
                            type: "tool_end",
                            toolCallId: forcedToolCallId,
                            toolName: WEB_SEARCH_TOOL_NAME,
                            output: forcedSearchOutput.slice(0, 500)
                        })}\n\n`
                    );
                }

                if (forcedSearchOutput) {
                    inputForAgent = `${normalizedUserMessage}\n\n[系统提示] 已按“联网:开”强制执行一次 web_search，请优先基于以下检索结果回答；如证据不足可再调用 web_search 补充。\n${forcedSearchOutput}`;
                    emitThought(res, "已获取联网结果，正在组织回答");
                }
            }
        }

        if (enableWebSearch) {
            // 联网模式：使用 Agent 编排工具调用
            emitThought(res, "正在调用模型生成回答");

            const agentExecutor = await getAgentExecutor(true, temperature, systemPrompt);
            console.log(`[agent] model=${resolveModelName(false)} baseURL=${process.env.OPENAI_BASE_URL}`);
            const eventStream = await agentExecutor.streamEvents(
                {
                    input: inputForAgent,
                    chat_history: formattedHistory,
                    current_date: new Date().toLocaleString()
                },
                { version: "v2" }
            );

            for await (const event of eventStream) {
                console.log(`[agent][event] type=${event.event} name=${event.name || "-"}`);
                if (event.event === "on_tool_start") {
                    const toolCallId = event.run_id || crypto.randomUUID();
                    console.log(
                        `[agent][tool_start] id=${toolCallId} name=${event.name || "unknown"}`
                    );
                    res.write(
                        `data: ${JSON.stringify({
                            type: "tool_start",
                            toolCallId,
                            toolName: event.name || "unknown",
                            input: event?.data?.input ?? {}
                        })}\n\n`
                    );
                    continue;
                }

                if (event.event === "on_tool_end") {
                    const toolCallId = event.run_id || "";
                    const output = event?.data?.output ?? "";
                    console.log(
                        `[agent][tool_end] id=${toolCallId} name=${event.name || "unknown"}`
                    );
                    res.write(
                        `data: ${JSON.stringify({
                            type: "tool_end",
                            toolCallId,
                            toolName: event.name || "unknown",
                            output: typeof output === "string" ? output.slice(0, 500) : ""
                        })}\n\n`
                    );
                    continue;
                }

                if (event.event === "on_tool_error") {
                    const toolCallId = event.run_id || "";
                    const errorMessage = event?.data?.error?.message || event?.data?.error || "工具执行异常";
                    console.log(
                        `[agent][tool_error] id=${toolCallId} name=${event.name || "unknown"} error=${errorMessage}`
                    );
                    res.write(
                        `data: ${JSON.stringify({
                            type: "tool_error",
                            toolCallId,
                            toolName: event.name || "unknown",
                            error: String(errorMessage)
                        })}\n\n`
                    );
                    continue;
                }

                if (event.event !== "on_chat_model_stream") {
                    continue;
                }

                const text = normalizeChunkContent(event?.data?.chunk?.content);

                if (!text) {
                    continue;
                }

                fullText += text;
                res.write(`data: ${JSON.stringify({ type: "text", text })}\n\n`);
            }
        } else {
            // 非联网模式：直接对话，无需 Agent
            emitThought(res, "准备生成回答");
            const directSystemInstruction = buildDirectAnswerSystemInstruction(false, systemPrompt);
            fullText = await streamDirectChat({
                userMessage: normalizedUserMessage,
                image,
                formattedHistory,
                res,
                systemInstruction: directSystemInstruction,
                temperature,
                forceModel
            });
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
        emitThought(res, "回答生成完成", "done");
        res.write("data: [DONE]\n\n");
        res.end();
    } catch (error) {
        console.error(`[agent][fatal] message="${error.message}" stack="${error.stack}"`);
        emitThought(res, "生成过程发生错误", "error");
        res.write(
            `data: ${JSON.stringify({ error: error.message || "stream failed" })}\n\n`
        );
        res.end();
    }
}
