/**
 * ContextBuilder — GSSC 上下文工程管道
 *
 * Phase 4 核心：对标 Hello-Agents Ch9 ContextBuilder
 *
 * GSSC 管道：
 *   Gather  → 多源收集候选信息（messages + memory + RAG + system prompt）
 *   Select  → 相关性×权重 + 时效性×权重，贪婪填充到 token 预算
 *   Structure → 固定模板 [Role][Task][State][Context][Output]
 *   Compress → token 超限时分段截断，保留结构完整性
 */

/**
 * ContextPacket — 候选信息单元
 */
class ContextPacket {
    /**
     * @param {object} opts
     * @param {string} opts.content - 内容文本
     * @param {Date} opts.timestamp - 时间戳
     * @param {number} opts.tokenCount - token 估算
     * @param {number} opts.relevanceScore - 相关性评分 0~1
     * @param {object} opts.metadata - 元数据 (type, role, priority 等)
     */
    constructor({ content, timestamp = new Date(), tokenCount = 0, relevanceScore = 0.5, metadata = {} }) {
        this.content = String(content || "");
        this.timestamp = timestamp instanceof Date ? timestamp : new Date(timestamp || Date.now());
        this.tokenCount = Math.max(0, Number(tokenCount) || estimateTokens(this.content));
        this.relevanceScore = Math.max(0, Math.min(1, Number(relevanceScore) || 0.5));
        this.metadata = metadata || {};
    }
}

/**
 * ContextConfig — 上下文构建配置
 */
class ContextConfig {
    constructor({
        maxTokens = 8000,
        reserveRatio = 0.2,
        minRelevance = 0.0,
        enableCompression = true,
        relevanceWeight = 0.7,
        recencyWeight = 0.3,
        maxHistoryTurns = 10,
    } = {}) {
        this.maxTokens = Math.max(500, Number(maxTokens) || 8000);
        this.reserveRatio = Math.max(0, Math.min(0.5, Number(reserveRatio) || 0.2));
        this.minRelevance = Math.max(0, Math.min(1, Number(minRelevance) || 0.0));
        this.enableCompression = Boolean(enableCompression);
        this.relevanceWeight = Number(relevanceWeight) || 0.7;
        this.recencyWeight = Number(recencyWeight) || 0.3;
        // 确保权重和为 1.0
        const total = this.relevanceWeight + this.recencyWeight;
        if (total !== 1.0) {
            this.relevanceWeight /= total;
            this.recencyWeight /= total;
        }
        this.maxHistoryTurns = Math.max(1, Number(maxHistoryTurns) || 10);
    }
}

/**
 * 估算中文+英文混合文本的 token 数
 * 中文 1 字 ≈ 1 token，英文 1 词 ≈ 1.3 token
 */
import { estimateTokens } from "./chatUtils.js";

export { estimateTokens };

/**
 * 计算 Jaccard 相关性得分
 */
function calculateRelevance(content, query) {
    if (!query || !content) return 0;
    const contentWords = new Set(content.toLowerCase().split(/\s+/));
    const queryWords = new Set(query.toLowerCase().split(/\s+/));
    if (queryWords.size === 0) return 0;

    let intersection = 0;
    for (const w of queryWords) {
        if (contentWords.has(w) || content.toLowerCase().includes(w)) {
            intersection++;
        }
    }
    return intersection / queryWords.size;
}

/**
 * 计算时间衰减得分
 * 指数衰减模型：24小时内保持高分，之后逐渐衰减
 */
function calculateRecency(timestamp) {
    const ageHours = (Date.now() - new Date(timestamp).getTime()) / (1000 * 3600);
    const decayFactor = 0.1;
    return Math.max(0.1, Math.exp(-decayFactor * ageHours / 24));
}

/**
 * ContextBuilder — 上下文构建器
 *
 * 用法：
 *   const builder = new ContextBuilder(new ContextConfig({ maxTokens: 6000 }));
 *   const context = await builder.build(userQuery, history, systemPrompt, options);
 */
export class ContextBuilder {
    /**
     * @param {ContextConfig} config
     * @param {object} [memoryService] - MemoryService 实例（可选，用于记忆检索）
     */
    constructor(config = new ContextConfig(), memoryService = null) {
        this.config = config;
        this.memoryService = memoryService;
    }

    /**
     * 构建优化后的上下文字符串
     *
     * @param {string} userQuery - 用户当前查询
     * @param {Array} conversationHistory - 对话历史 [{ role, content, timestamp }]
     * @param {string} systemInstructions - 系统指令
     * @param {object} options - 额外选项
     * @param {Array<ContextPacket>} options.customPackets - 自定义信息包
     * @param {string} options.modelName - 模型名（用于调整 token 预算）
     * @returns {Promise<string>} 结构化的上下文字符串
     */
    async build(userQuery, conversationHistory = [], systemInstructions = "", options = {}) {
        // 1. Gather — 收集候选信息
        let packets = this._gather(userQuery, conversationHistory, systemInstructions, options.customPackets || []);

        // 如果有 MemoryService，从记忆系统检索相关记忆
        if (this.memoryService) {
            try {
                const memories = this.memoryService.search(userQuery, ["episodic", "semantic"], 5, 0.3);
                for (const mem of memories) {
                    packets.push(new ContextPacket({
                        content: `[记忆] ${mem.content}`,
                        timestamp: new Date(mem.created_at),
                        tokenCount: estimateTokens(mem.content),
                        relevanceScore: Math.min(1, mem.relevanceScore || 0.5),
                        metadata: { type: "memory", memory_type: mem.memory_type },
                    }));
                }
            } catch (e) {
                // 记忆检索失败不影响整体
            }
        }

        // 2. Select — 评分 + 贪婪选择
        const availableTokens = Math.floor(this.config.maxTokens * (1 - this.config.reserveRatio));
        const selected = this._select(packets, userQuery, availableTokens);

        // 3. Structure — 结构化组织
        let context = this._structure(selected, userQuery);

        // 4. Compress — token 超限时压缩
        if (this.config.enableCompression) {
            context = this._compress(context, this.config.maxTokens);
        }

        const finalTokens = estimateTokens(context);
        console.log(`[contextBuilder] built context: ${packets.length} gathered → ${selected.length} selected → ${finalTokens} tokens`);

        return context;
    }

    // ── Stage 1: Gather ──
    _gather(userQuery, conversationHistory, systemInstructions, customPackets) {
        const packets = [];

        // 1) 系统指令（最高优先级，relevanceScore=1.0，始终保留）
        if (systemInstructions) {
            packets.push(new ContextPacket({
                content: systemInstructions,
                timestamp: new Date(),
                relevanceScore: 1.0,
                metadata: { type: "system_instruction", priority: "high" },
            }));
        }

        // 2) 对话历史（只保留最近 N 轮）
        if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
            const recentHistory = conversationHistory.slice(-this.config.maxHistoryTurns * 2); // 每轮 user+assistant
            for (const msg of recentHistory) {
                packets.push(new ContextPacket({
                    content: `${msg.role || "unknown"}: ${msg.content || ""}`,
                    timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
                    relevanceScore: 0.6, // 历史消息基础相关性
                    metadata: { type: "conversation_history", role: msg.role },
                }));
            }
        }

        // 3) 自定义信息包
        for (const p of customPackets) {
            if (p instanceof ContextPacket) {
                packets.push(p);
            } else if (p && typeof p.content === "string") {
                packets.push(new ContextPacket(p));
            }
        }

        return packets;
    }

    // ── Stage 2: Select ──
    _select(packets, userQuery, availableTokens) {
        if (packets.length === 0) return [];

        // 分离系统指令和其他信息
        const systemPackets = packets.filter(p => p.metadata.type === "system_instruction");
        const otherPackets = packets.filter(p => p.metadata.type !== "system_instruction");

        // 系统指令占用的 token
        const systemTokens = systemPackets.reduce((sum, p) => sum + p.tokenCount, 0);
        const remainingTokens = availableTokens - systemTokens;

        if (remainingTokens <= 0) {
            console.warn(`[contextBuilder] system instructions consume all ${availableTokens} tokens`);
            return systemPackets;
        }

        // 计算综合得分
        const scored = [];
        for (const packet of otherPackets) {
            // 更新相关性得分（如果还是默认值 0.5）
            if (packet.relevanceScore === 0.5) {
                packet.relevanceScore = calculateRelevance(packet.content, userQuery);
            }
            const recency = calculateRecency(packet.timestamp);
            const combinedScore =
                this.config.relevanceWeight * packet.relevanceScore +
                this.config.recencyWeight * recency;

            // 过滤低于最低相关性阈值的信息
            if (packet.relevanceScore >= this.config.minRelevance) {
                scored.push({ score: combinedScore, packet });
            }
        }

        // 按综合得分降序排序（高分优先）
        scored.sort((a, b) => b.score - a.score);

        // 贪婪填充：从高到低直到 token 预算耗尽
        const selected = [...systemPackets];
        let currentTokens = systemTokens;

        for (const { packet } of scored) {
            if (currentTokens + packet.tokenCount <= availableTokens) {
                selected.push(packet);
                currentTokens += packet.tokenCount;
            } else {
                // 如果这是关键信息（relevanceScore >= 0.8），仍然尝试截断后加入
                if (packet.relevanceScore >= 0.8 && packet.metadata.type !== "conversation_history") {
                    const remaining = availableTokens - currentTokens;
                    if (remaining > 30) {
                        const truncated = packet.content.slice(0, Math.floor(remaining * 1.5));
                        selected.push(new ContextPacket({
                            content: truncated,
                            timestamp: packet.timestamp,
                            relevanceScore: packet.relevanceScore,
                            metadata: { ...packet.metadata, truncated: true },
                        }));
                        currentTokens += estimateTokens(truncated);
                    }
                }
                // token 预算已满（或不可截断），停止
                break;
            }
        }

        return selected;
    }

    // ── Stage 3: Structure ──
    _structure(selectedPackets, userQuery) {
        // 按类型分组
        const byType = {};
        for (const p of selectedPackets) {
            const type = p.metadata.type || "other";
            if (!byType[type]) byType[type] = [];
            byType[type].push(p);
        }

        const sections = [];

        // [Role & Policies] — 系统指令
        if (byType["system_instruction"]) {
            sections.push("## 角色与规则\n" + byType["system_instruction"].map(p => p.content).join("\n\n"));
        }

        // [Task] — 当前任务
        sections.push("## 当前任务\n" + userQuery);

        // [State] — 上下文状态（记忆 + 笔记）
        const statePackets = [...(byType["memory"] || [])];
        if (statePackets.length > 0) {
            sections.push("## 上下文状态\n" + statePackets.map(p => p.content).join("\n"));
        }

        // [Context] — 对话历史
        if (byType["conversation_history"]) {
            sections.push("## 对话历史\n" + byType["conversation_history"].map(p => p.content).join("\n"));
        }

        // [Evidence] — 检索结果 / RAG 证据
        const evidencePackets = [...(byType["rag"] || []), ...(byType["knowledge"] || []), ...(byType["search"] || [])];
        if (evidencePackets.length > 0) {
            sections.push("## 参考证据\n" + evidencePackets.map(p => p.content).join("\n\n"));
        }

        // [Output] — 输出指示
        sections.push("## 输出要求\n请基于以上信息提供准确、有根据的回答。如果信息不足，请明确指出。");

        return sections.join("\n\n---\n\n");
    }

    // ── Stage 4: Compress ──
    _compress(context, maxTokens) {
        const currentTokens = estimateTokens(context);
        if (currentTokens <= maxTokens) {
            return context; // 不需要压缩
        }

        console.log(`[contextBuilder] compression needed: ${currentTokens} > ${maxTokens} tokens`);

        // 分段压缩：保留结构性，逐段截断
        const sections = context.split(/\n\n---\n\n/);
        const compressedSections = [];
        let currentTotal = 0;

        for (const section of sections) {
            const sectionTokens = estimateTokens(section);
            if (currentTotal + sectionTokens <= maxTokens) {
                // 整段保留
                compressedSections.push(section);
                currentTotal += sectionTokens;
            } else {
                // 部分保留
                const remainingTokens = maxTokens - currentTotal;
                if (remainingTokens > 50) {
                    // 按字符比例截断
                    const charLimit = Math.floor(section.length * (remainingTokens / sectionTokens));
                    let truncated = section.slice(0, charLimit);
                    // 尝试在句子边界处截断
                    const lastPeriod = Math.max(
                        truncated.lastIndexOf("。"),
                        truncated.lastIndexOf("\n"),
                        truncated.lastIndexOf(".")
                    );
                    if (lastPeriod > truncated.length * 0.7) {
                        truncated = truncated.slice(0, lastPeriod + 1);
                    }
                    compressedSections.push(truncated + "\n[... 内容已压缩 ...]");
                }
                break;
            }
        }

        const result = compressedSections.join("\n\n---\n\n");
        return result;
    }
}

/**
 * 创建适合 AI-Chat 的 ContextBuilder 实例
 *
 * @param {object} memoryService - MemoryService 实例
 * @param {object} overrides - 覆盖默认配置
 * @returns {ContextBuilder}
 */
export function createChatContextBuilder(memoryService = null, overrides = {}) {
    const config = new ContextConfig({
        maxTokens: 6000,      // 为模型输出保留足够空间
        reserveRatio: 0.15,   // 15% 预留给系统指令
        minRelevance: 0.0,    // 对话历史不过滤（0.1 可能丢失近期信息）
        enableCompression: true,
        relevanceWeight: 0.6,
        recencyWeight: 0.4,
        maxHistoryTurns: 10,  // 最近 10 轮对话
        ...overrides,
    });

    return new ContextBuilder(config, memoryService);
}

export { ContextPacket, ContextConfig };
