import { estimateTokens, getModelContextWindow } from "./chatUtils.js";

const CONTEXT_OVERHEAD_TOKENS = 2000;
const SUMMARY_PREFIX = "[上下文压缩摘要";

/**
 * 计算会话当前的上下文窗口用量。
 * 空会话不计入系统提示词/工具预留，避免新对话显示非零用量。
 * @param {Array<object>} history
 * @param {string|null} modelName
 * @param {number|string|null} sessionId
 * @returns {{ sessionId: number|string|null, usedTokens: number, maxTokens: number, ratio: number, messageCount: number, modelName: string|null }}
 */
export function calculateContextUsage(history, modelName, sessionId = null) {
    const messages = Array.isArray(history) ? history : [];
    let totalTokens = 0;

    // 从最新向最旧遍历，遇到压缩摘要标记即停止。
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (
            message?.role === "system" &&
            String(message.content || "").startsWith(SUMMARY_PREFIX)
        ) {
            totalTokens += message.metrics?.total_tokens || estimateTokens(String(message.content || ""));
            break;
        }

        if (message?.metrics && typeof message.metrics.total_tokens === "number") {
            totalTokens += message.metrics.total_tokens;
        } else {
            totalTokens += estimateTokens(String(message?.content || ""));
        }
    }

    const overheadTokens = messages.length > 0 ? CONTEXT_OVERHEAD_TOKENS : 0;
    const usedTokens = totalTokens + overheadTokens;
    const resolvedModelName = modelName || null;
    const maxTokens = getModelContextWindow(resolvedModelName);

    return {
        sessionId,
        usedTokens,
        maxTokens,
        ratio: Math.round((usedTokens / maxTokens) * 100),
        messageCount: messages.length,
        modelName: resolvedModelName,
    };
}

export { CONTEXT_OVERHEAD_TOKENS };
