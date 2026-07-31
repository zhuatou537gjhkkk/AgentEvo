import crypto from "crypto";
import { saveMessage, getHistoryMessages } from "../db/index.js";
import { agentTools, consumePendingQuestion, cancelAllPendingQuestions } from "../mcp/tools.js";
import {
    WEB_SEARCH_TOOL_NAME,
    FORCED_WEB_SEARCH_MAX_CHARS,
    TOOL_ACTIVE_FORMS,
    normalizeChunkContent,
    normalizeTemperature,
    resolveSystemPrompt,
    resolveModelName,
    estimateTokens,
    emitThought,
    toLangChainMessage,
    isCreativeTask,
    buildDirectAnswerSystemInstruction,
    streamDirectChat,
    getAgentExecutor,
} from "./chatUtils.js";

export { estimateTokens, resolveModelName, buildChatOpenAIConfig, emitThought, toLangChainMessage, normalizeChunkContent, normalizeTemperature, resolveSystemPrompt, isCreativeTask, buildDirectAnswerSystemInstruction, streamDirectChat, getAgentExecutor, buildPrompt, buildHumanInputMessage, TOOL_ACTIVE_FORMS, PLAN_MODE_INSTRUCTION, WEB_SEARCH_TOOL_NAME, FORCED_WEB_SEARCH_MAX_CHARS, DEFAULT_SYSTEM_PROMPT, DEFAULT_TEMPERATURE } from "./chatUtils.js";

export async function chatWithStream(userId, session_id, userMessage, image, systemPromptInput, temperatureInput, res, options = {}) {
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
        // 清理所有未完成的用户提问
        cancelAllPendingQuestions();
        if (!abortController.signal.aborted) {
            console.log('[agent] client disconnected, aborting upstream stream');
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
                        input: normalizedUserMessage,
                        at: startedAt
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
                            error: forcedSearchError,
                            at: endedAt
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
                            output: forcedSearchOutput.slice(0, 500),
                            at: endedAt
                        })}\n\n`
                    );
                }

                if (forcedSearchOutput) {
                    if (abortController.signal.aborted) { cleanupDisconnect(); return; }
                    inputForAgent = `${normalizedUserMessage}\n\n[系统提示] 已按"联网:开"强制执行一次 web_search，请优先基于以下检索结果回答；如证据不足可再调用 web_search 补充。\n${forcedSearchOutput}`;
                    emitThought(res, "已获取联网结果，正在组织回答");
                }
            }
        }

        if (enableWebSearch) {
            // 联网模式：使用 Agent 编排工具调用
            emitThought(res, "正在调用模型生成回答");

            const agentExecutor = await getAgentExecutor(true, temperature, systemPrompt, planMode);
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
                if (abortController.signal.aborted) {
                    console.log('[agent] agent event stream aborted by client disconnect');
                    break;
                }
                if (event.event !== "on_chat_model_stream") {
                    console.log(`[agent][event] type=${event.event} name=${event.name || "-"}`);
                }
                if (event.event === "on_tool_start") {
                    const toolCallId = event.run_id || crypto.randomUUID();
                    const toolStartedAt = new Date().toISOString();
                    const toolName = event.name || "unknown";
                    console.log(
                        `[agent][tool_start] id=${toolCallId} name=${toolName}`
                    );
                    res.write(
                        `data: ${JSON.stringify({
                            type: "tool_start",
                            toolCallId,
                            toolName,
                            input: event?.data?.input ?? {},
                            at: toolStartedAt,
                            activeForm: TOOL_ACTIVE_FORMS[toolName] || "正在执行...",
                        })}\n\n`
                    );

                    // update_todo: 从 tool input 中提取任务计划并发射 todo_updated
                    if (toolName === "update_todo") {
                        try {
                            let parsed = event?.data?.input;
                            // 循环解包：先 parse JSON 字符串，再剥离 {input: ...} 包装层
                            // LangChain 可能多层包裹，且可能含 tool_call_id 等额外字段
                            for (let i = 0; i < 5; i++) {
                                if (typeof parsed === "string") {
                                    try { parsed = JSON.parse(parsed); } catch { break; }
                                } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "input" in parsed) {
                                    parsed = parsed.input;
                                } else {
                                    break;
                                }
                            }
                            if (typeof parsed === "string") {
                                try { parsed = JSON.parse(parsed); } catch { /* ignore */ }
                            }
                            const todos = Array.isArray(parsed?.todos) ? parsed.todos : [];
                            console.log(`[agent][todo_updated] count=${todos.length}`);
                            res.write(
                                `data: ${JSON.stringify({ type: "todo_updated", todos, at: toolStartedAt })}\n\n`
                            );
                        } catch (e) {
                            console.log(`[agent][todo_updated] parse error:`, e.message);
                        }
                    }

                    // 如果是 ask_user_question，延迟到 tool func 同步部分执行后发射提问事件
                    // LangChain 的 on_tool_start 在 tool.func 执行前触发，直接 consumePendingQuestion() 会拿到 null
                    if (event.name === "ask_user_question") {
                        const toolStartedAtCapture = toolStartedAt;
                        setImmediate(() => {
                            const pending = consumePendingQuestion();
                            if (pending) {
                                console.log(
                                    `[agent][ask_user_question] id=${pending.questionId} type=${pending.questionType}`
                                );
                                res.write(
                                    `data: ${JSON.stringify({
                                        type: "ask_user_question",
                                        questionId: pending.questionId,
                                        question: pending.question,
                                        questionType: pending.questionType,
                                        options: pending.options,
                                        at: toolStartedAtCapture,
                                    })}\n\n`
                                );
                            } else {
                                console.log(`[agent][ask_user_question] consumePendingQuestion returned null!`);
                            }
                        });
                    }
                    continue;
                }

                if (event.event === "on_tool_end") {
                    const toolCallId = event.run_id || "";
                    const output = event?.data?.output ?? "";
                    const toolEndedAt = new Date().toISOString();
                    console.log(
                        `[agent][tool_end] id=${toolCallId} name=${event.name || "unknown"}`
                    );
                    res.write(
                        `data: ${JSON.stringify({
                            type: "tool_end",
                            toolCallId,
                            toolName: event.name || "unknown",
                            output: typeof output === "string" ? output.slice(0, 500) : "",
                            at: toolEndedAt
                        })}\n\n`
                    );
                    continue;
                }

                if (event.event === "on_tool_error") {
                    const toolCallId = event.run_id || "";
                    const errorMessage = event?.data?.error?.message || event?.data?.error || "工具执行异常";
                    const toolEndedAt = new Date().toISOString();
                    console.log(
                        `[agent][tool_error] id=${toolCallId} name=${event.name || "unknown"} error=${errorMessage}`
                    );
                    res.write(
                        `data: ${JSON.stringify({
                            type: "tool_error",
                            toolCallId,
                            toolName: event.name || "unknown",
                            error: String(errorMessage),
                            at: toolEndedAt
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
            // 非联网模式：使用 Agent 编排（排除 web_search），支持 get_system_time / get_db_message_count 等工具
            emitThought(res, "正在调用模型生成回答");

            const agentExecutor = await getAgentExecutor(false, temperature, systemPrompt, planMode);
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
                if (abortController.signal.aborted) {
                    console.log('[agent] agent event stream aborted by client disconnect');
                    break;
                }
                if (event.event !== "on_chat_model_stream") {
                    console.log(`[agent][event] type=${event.event} name=${event.name || "-"}`);
                }
                if (event.event === "on_tool_start") {
                    const toolCallId = event.run_id || crypto.randomUUID();
                    const toolStartedAt = new Date().toISOString();
                    const toolName = event.name || "unknown";
                    console.log(
                        `[agent][tool_start] id=${toolCallId} name=${toolName}`
                    );
                    res.write(
                        `data: ${JSON.stringify({
                            type: "tool_start",
                            toolCallId,
                            toolName,
                            input: event?.data?.input ?? {},
                            at: toolStartedAt,
                            activeForm: TOOL_ACTIVE_FORMS[toolName] || "正在执行...",
                        })}\n\n`
                    );

                    // update_todo: 从 tool input 中提取任务计划并发射 todo_updated
                    if (toolName === "update_todo") {
                        try {
                            let parsed = event?.data?.input;
                            // 循环解包：先 parse JSON 字符串，再剥离 {input: ...} 包装层
                            // LangChain 可能多层包裹，且可能含 tool_call_id 等额外字段
                            for (let i = 0; i < 5; i++) {
                                if (typeof parsed === "string") {
                                    try { parsed = JSON.parse(parsed); } catch { break; }
                                } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "input" in parsed) {
                                    parsed = parsed.input;
                                } else {
                                    break;
                                }
                            }
                            if (typeof parsed === "string") {
                                try { parsed = JSON.parse(parsed); } catch { /* ignore */ }
                            }
                            const todos = Array.isArray(parsed?.todos) ? parsed.todos : [];
                            console.log(`[agent][todo_updated] count=${todos.length}`);
                            res.write(
                                `data: ${JSON.stringify({ type: "todo_updated", todos, at: toolStartedAt })}\n\n`
                            );
                        } catch (e) {
                            console.log(`[agent][todo_updated] parse error:`, e.message);
                        }
                    }

                    // 如果是 ask_user_question，延迟到 tool func 同步部分执行后发射提问事件
                    // LangChain 的 on_tool_start 在 tool.func 执行前触发，直接 consumePendingQuestion() 会拿到 null
                    if (event.name === "ask_user_question") {
                        const toolStartedAtCapture = toolStartedAt;
                        setImmediate(() => {
                            const pending = consumePendingQuestion();
                            if (pending) {
                                console.log(
                                    `[agent][ask_user_question] id=${pending.questionId} type=${pending.questionType}`
                                );
                                res.write(
                                    `data: ${JSON.stringify({
                                        type: "ask_user_question",
                                        questionId: pending.questionId,
                                        question: pending.question,
                                        questionType: pending.questionType,
                                        options: pending.options,
                                        at: toolStartedAtCapture,
                                    })}\n\n`
                                );
                            } else {
                                console.log(`[agent][ask_user_question] consumePendingQuestion returned null!`);
                            }
                        });
                    }
                    continue;
                }

                if (event.event === "on_tool_end") {
                    const toolCallId = event.run_id || "";
                    const output = event?.data?.output ?? "";
                    const toolEndedAt = new Date().toISOString();
                    console.log(
                        `[agent][tool_end] id=${toolCallId} name=${event.name || "unknown"}`
                    );
                    res.write(
                        `data: ${JSON.stringify({
                            type: "tool_end",
                            toolCallId,
                            toolName: event.name || "unknown",
                            output: typeof output === "string" ? output.slice(0, 500) : "",
                            at: toolEndedAt
                        })}\n\n`
                    );
                    continue;
                }

                if (event.event === "on_tool_error") {
                    const toolCallId = event.run_id || "";
                    const errorMessage = event?.data?.error?.message || event?.data?.error || "工具执行异常";
                    const toolEndedAt = new Date().toISOString();
                    console.log(
                        `[agent][tool_error] id=${toolCallId} name=${event.name || "unknown"} error=${errorMessage}`
                    );
                    res.write(
                        `data: ${JSON.stringify({
                            type: "tool_error",
                            toolCallId,
                            toolName: event.name || "unknown",
                            error: String(errorMessage),
                            at: toolEndedAt
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
        console.error(`[agent][fatal] message="${error.message}" stack="${error.stack}"`);
        // 清理所有未完成的用户提问
        cancelAllPendingQuestions();
        if (!clientDisconnected) {
            emitThought(res, "生成过程发生错误", "error");
            res.write(
                `data: ${JSON.stringify({ error: error.message || "stream failed" })}\n\n`
            );
        }
        res.end();
        cleanupDisconnect();
    }
}
