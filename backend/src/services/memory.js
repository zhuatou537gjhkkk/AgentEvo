/**
 * 记忆服务 — Phase 4 三层记忆架构核心
 *
 * 对标 Hello-Agents Ch8: MemoryTool + MemoryManager
 *
 * 三层记忆：
 *   working  — 当前会话临时信息（SQLite, session-scoped）
 *   episodic — 跨会话的关键事件提取（SQLite, 持久化）
 *   semantic — 用户偏好/知识积累（SQLite + 可选 FAISS 索引）
 *
 * 核心操作：
 *   - add: 添加记忆
 *   - search: 混合检索（关键词 + 时间衰减 + 重要性权重）
 *   - consolidate: 记忆巩固（working → episodic → semantic）
 *   - forget: 遗忘（重要性/时间策略）
 *   - stats/summary: 统计与摘要
 */

import {
    addMemory as dbAddMemory,
    searchMemory as dbSearchMemory,
    consolidateMemory as dbConsolidateMemory,
    forgetMemory as dbForgetMemory,
    getMemoryStats,
    getMemorySummary,
    updateMemory,
    removeMemory,
} from "../db/index.js";
import { agentConfig } from "./agentConfig.js";
import { withRetry } from "./resilience.js";

/**
 * MemoryService — 封装记忆系统的业务逻辑
 *
 * 用法：
 *   const memory = new MemoryService(userId);
 *   await memory.add("用户喜欢简洁的代码风格", "episodic", 0.8);
 *   const results = await memory.search("代码风格");
 */
export class MemoryService {
    constructor(userId) {
        this.userId = Number(userId);
    }

    /**
     * 添加记忆
     * @param {string} content - 记忆内容
     * @param {string} memoryType - "working" | "episodic" | "semantic"
     * @param {number} importance - 0.0~1.0
     * @param {object} metadata - 额外元数据
     * @param {number|null} sessionId - 关联的会话 ID
     * @returns {number} memoryId
     */
    add(content, memoryType = "working", importance = 0.5, metadata = {}, sessionId = null) {
        return dbAddMemory(this.userId, sessionId, content, memoryType, importance, metadata);
    }

    /**
     * 搜索记忆 — 混合检索
     * @param {string} query - 搜索查询
     * @param {string[]} memoryTypes - 限制记忆类型
     * @param {number} limit
     * @param {number} minImportance
     * @returns {Array} 带 relevanceScore 的记忆列表
     */
    search(query, memoryTypes = null, limit = 10, minImportance = 0.1) {
        return dbSearchMemory(this.userId, query, memoryTypes, limit, minImportance);
    }

    /**
     * 记忆巩固 — 高重要性短期记忆提升为长期
     * @param {string} fromType
     * @param {string} toType
     * @param {number} importanceThreshold
     * @returns {{ consolidated: number, total: number }}
     */
    consolidate(fromType = "working", toType = "episodic", importanceThreshold = null) {
        const threshold = importanceThreshold ?? agentConfig.getNumber("memory.consolidateThreshold", 0.7);
        return dbConsolidateMemory(this.userId, fromType, toType, threshold);
    }

    /**
     * 遗忘记忆
     * @param {string} strategy - "importance" | "time" | "all"
     * @param {string} memoryType
     * @param {number} threshold
     * @returns {number} 删除数
     */
    forget(strategy = "importance", memoryType = "working", threshold = null) {
        const t = threshold ?? agentConfig.getNumber("memory.autoForgetThreshold", 0.3);
        return dbForgetMemory(this.userId, strategy, memoryType, t);
    }

    /**
     * 获取记忆统计
     * @returns {object}
     */
    stats() {
        return getMemoryStats(this.userId);
    }

    /**
     * 获取记忆摘要（最高重要性优先）
     * @param {number} limit
     * @returns {Array}
     */
    summary(limit = 20) {
        return getMemorySummary(this.userId, limit);
    }

    /**
     * 更新记忆
     * @param {number} memoryId
     * @param {object} updates
     */
    update(memoryId, updates = {}) {
        return updateMemory(this.userId, memoryId, updates);
    }

    /**
     * 删除单条记忆
     * @param {number} memoryId
     */
    remove(memoryId) {
        return removeMemory(this.userId, memoryId);
    }

    /**
     * 从对话中自动提取关键信息
     * （简化版 — 生产环境应通过 LLM 调用来提取）
     * @param {string} text - 对话文本
     * @param {number} sessionId
     * @returns {number} 提取的记忆数
     */
    extractFromConversation(text, sessionId = null) {
        let extracted = 0;

        // 提取带有明确偏好/决策标记的语句
        const preferencePatterns = [
            // Bug A 修复: type 从 "episodic" 改为 "working"，让 consolidate() 统一负责提升
            // Bug B 修复: 添加 倾向于/爱/愿意/偏向/热衷/比较喜欢 等常见偏好表达
            { regex: /我(?:个人)?(喜欢|偏好|习惯|常用|经常|一般|通常|一直|总是|从不|倾向于|爱|愿意|偏向|热衷|比较喜欢|更偏好)(.+?)(?:[。；\n]|$)/g, importance: 0.8, type: "working" },
            { regex: /(记住|别忘了|注意|重要(?!性)|关键)(.+?)(?:[。；\n]|$)/g, importance: 0.9, type: "semantic" },
            { regex: /(我的|我个人)(名字|职业|工作|角色|任务|目标|项目)(是|为)(.+?)(?:[。，；\n]|$)/g, importance: 0.85, type: "semantic" },
        ];

        for (const { regex, importance, type } of preferencePatterns) {
            let match;
            while ((match = regex.exec(text)) !== null) {
                const content = match[0].trim();
                if (content.length > 3) {
                    this.add(content, type, importance, { source: "auto_extract" }, sessionId);
                    extracted++;
                }
            }
        }

        return extracted;
    }
}

/**
 * LLM 驱动的记忆提取器
 * 会话结束后由 LLM 提取关键信息并写入记忆系统
 *
 * @param {object} llm - HelloAgentsLLM / ChatOpenAI 实例
 * @param {MemoryService} memory - MemoryService 实例
 * @param {Array} messages - 会话消息列表 [{ role, content }]
 * @param {number} sessionId
 * @returns {Promise<{ extractedCount: number, consolidatedCount: number }>}
 */
// ⚠️ DEAD CODE：当前无任何生产/测试调用者（regex extractFromConversation 才是活跃记忆路径）。
// 若将来接线，必须保留下方 withRetry —— buildChatOpenAIConfig 默认 maxRetries:0，直接
// invoke 会静默零重试。llm 由调用方传入，来电方同样需遵循 withRetry 单一重试预算约定。
export async function llmMemoryConsolidation(llm, memory, messages, sessionId) {
    // 只处理 > 3 轮对话的会话
    const substantiveMessages = messages.filter(m =>
        m.role === "user" && m.content && m.content.length > 10
    );
    if (substantiveMessages.length < 3) {
        return { extractedCount: 0, consolidatedCount: 0 };
    }

    // 构建提示词让 LLM 提取关键记忆
    const conversationText = messages
        .slice(-20) // 最近 20 条
        .map(m => `${m.role}: ${m.content}`)
        .join("\n");

    const extractionPrompt = `分析以下对话，提取关键信息作为记忆条目。
每条记忆需包含：
- content: 简洁的事实/偏好/决策描述（15字以内）
- importance: 重要性 0.0-1.0（用户偏好/决策 0.8+，一般信息 0.5，闲聊 0.3-）
- memory_type: "episodic"（事件）或 "semantic"（知识/偏好）

返回 JSON 数组格式（最多5条）：
[{"content":"...","importance":0.8,"memory_type":"episodic"}]

对话：
${conversationText}

仅返回 JSON 数组，不要其他内容。`;

    try {
        const response = await withRetry(
            (_, retrySignal) => llm.invoke([{ role: "user", content: extractionPrompt }], { signal: retrySignal }),
            { retries: 2 }
        );
        const text = typeof response === "string" ? response : (response?.content || "");
        // 提取 JSON 数组
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            return { extractedCount: 0, consolidatedCount: 0 };
        }

        const items = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(items)) {
            return { extractedCount: 0, consolidatedCount: 0 };
        }

        // 写入记忆
        let extractedCount = 0;
        for (const item of items) {
            if (item.content && typeof item.importance === "number") {
                memory.add(
                    item.content,
                    item.memory_type || "episodic",
                    Math.max(0, Math.min(1, item.importance)),
                    { source: "llm_extract", session_id: sessionId },
                    sessionId
                );
                extractedCount++;
            }
        }

        // 触发记忆巩固
        const consolidated = memory.consolidate("working", "episodic", 0.7);

        return {
            extractedCount,
            consolidatedCount: consolidated.consolidated || 0,
        };
    } catch (err) {
        console.error("[memory] LLM consolidation failed:", err.message);
        return { extractedCount: 0, consolidatedCount: 0 };
    }
}

export default MemoryService;
