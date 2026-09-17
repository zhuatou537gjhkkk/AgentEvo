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
    transitionMemory,
    proposeMemory as dbProposeMemory,
    getMemoryLineage,
    applyMemoryRetention,
    exportMemory as dbExportMemory,
    recordMemoryRecall,
    getMemoryVectorRows,
    upsertSessionWorkingMemory as dbUpsertSessionWorkingMemory,
    getSessionWorkingMemory as dbGetSessionWorkingMemory,
    invalidateSessionWorkingMemory as dbInvalidateSessionWorkingMemory,
} from "../db/index.js";
import { agentConfig } from "./agentConfig.js";
import { AppError, isAbortError, withRetry } from "./resilience.js";
import { memoryRetentionConfig } from "./memoryRetention.js";
import { memoryExtractionScoringRubricEnabled, memoryRecallEnabled, memoryRetentionEnabled, memoryTypeAwareScoringEnabled, memoryVectorRecallEnabled, workingMemoryEnabled } from "./memoryFlags.js";
import { memoryRecallConfig, rankMemoryCandidates } from "./memoryRecall.js";
import { memoryVectorRecallConfig, retrieveMemoryVectorCandidates } from "./memoryVectorRecall.js";
import {
    buildMemoryExtractionPrompt,
    containsSensitiveContent,
    extractExplicitMemoryContents,
    MEMORY_EXTRACTION_PROMPT_VERSION,
    memoryExtractionConfig,
    parseMemoryCandidateResponse,
    shouldExtractMemoryCandidates,
} from "./memoryExtraction.js";
import {
    canonicalMemoryKey,
    classifyMemoryRelation,
    normalizeMemoryCategory,
} from "./memoryRelations.js";
import {
    buildWorkingMemoryRecords,
    workingStateFromRecords,
} from "./workingMemory.js";

function raceWithAbort(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason || new AppError("Request aborted", { code: "ABORTED", statusCode: 499 }));
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason || new AppError("Request aborted", { code: "ABORTED", statusCode: 499 }));
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}

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
    add(content, memoryType = "working", importance = 0.5, metadata = {}, sessionId = null, lifecycle = {}) {
        const text = String(content || "");
        const category = normalizeMemoryCategory(lifecycle.category ?? metadata.category, memoryType, text);
        const memoryKey = canonicalMemoryKey(lifecycle.memoryKey ?? metadata.memory_key, { content: text, category });
        const id = dbAddMemory(this.userId, sessionId, text, memoryType, importance, {
            ...metadata,
            category,
            memory_key: memoryKey || undefined,
        }, {
            ...lifecycle,
            category,
            memoryKey,
        });
        if (memoryRetentionEnabled()) this.retentionSweep();
        return id;
    }

    /** Upsert the bounded, server-generated working snapshot for one session. */
    upsertSessionWorkingState(sessionId, state = {}, options = {}) {
        if (!workingMemoryEnabled()) {
            return { enabled: false, created: 0, updated: 0, unchanged: 0, ids: [], changed: false };
        }
        const policy = memoryRetentionConfig(options.policy || {});
        const ttlDays = Number.isFinite(Number(options.ttlDays))
            ? Math.max(0, Number(options.ttlDays))
            : policy.workingTtlDays;
        const expiresAt = options.expiresAt || new Date(Date.now() + ttlDays * 86400000).toISOString();
        const records = buildWorkingMemoryRecords(state, {
            source: options.source || "working_memory",
            taskStatus: options.taskStatus || "active",
            planGeneration: options.planGeneration ?? state.plan_generation ?? 0,
            expiresAt,
        });
        return {
            enabled: true,
            ...dbUpsertSessionWorkingMemory(this.userId, sessionId, records),
        };
    }

    /** Read only the current session's active working snapshot. */
    getSessionWorkingState(sessionId) {
        if (!workingMemoryEnabled()) return { enabled: false, records: [], state: null };
        const records = dbGetSessionWorkingMemory(this.userId, sessionId);
        const state = records.length > 0 ? workingStateFromRecords(records) : null;
        return {
            enabled: true,
            records,
            state,
            ...(state || {}),
        };
    }

    /** Soft-invalidate terminal working state; historical rows remain auditable. */
    invalidateSessionWorkingState(sessionId, reason = "task_terminal") {
        if (!workingMemoryEnabled()) return { enabled: false, invalidated: 0, ids: [] };
        return {
            enabled: true,
            ...dbInvalidateSessionWorkingMemory(this.userId, sessionId, reason),
        };
    }

    /**
     * 搜索记忆 — 混合检索
     * @param {string} query - 搜索查询
     * @param {string[]} memoryTypes - 限制记忆类型
     * @param {number} limit
     * @param {number} minImportance
     * @returns {Array} 带 relevanceScore 的记忆列表
     */
    search(query, memoryTypes = null, limit = 10, minImportance = 0.1, statuses = "active") {
        return dbSearchMemory(this.userId, query, memoryTypes, limit, minImportance, statuses);
    }

    /**
     * Context-facing recall. Candidate reads do not increment recall metrics;
     * only memories accepted by the M6 rank/budget gate are recorded as used.
     */
    recall(query, options = {}) {
        const config = memoryRecallConfig(options);
        const minImportance = Number.isFinite(Number(options.minImportance)) ? Number(options.minImportance) : 0.3;
        const candidates = dbSearchMemory(
            this.userId,
            query,
            options.memoryTypes || ["episodic", "semantic"],
            config.candidateLimit,
            minImportance,
            "active",
            { touchRecall: false },
        );
        if (!memoryRecallEnabled() && !memoryTypeAwareScoringEnabled()) {
            const memories = candidates.slice(0, config.maxItems);
            return {
                memories,
                diagnostics: {
                    enabled: false,
                    scanned: candidates.length,
                    selected: memories.map((item) => item.id),
                    dropped: [],
                    selectedTokens: memories.reduce((sum, item) => sum + Number(item.recallTokens || 0), 0),
                },
            };
        }
        const ranked = rankMemoryCandidates(candidates, config);
        return {
            memories: ranked.selected,
            diagnostics: {
                enabled: true,
                scanned: ranked.scanned,
                selected: ranked.selected.map((item) => item.id),
                dropped: ranked.dropped,
                selectedTokens: ranked.selectedTokens,
                config: ranked.config,
            },
        };
    }

    /**
     * Hybrid context-facing recall. Keyword/CJK bigram candidates remain the
     * deterministic baseline; optional vector candidates only expand the pool
     * and are still filtered by owner, active status, trust and token budget.
     */
    async recallHybrid(query, options = {}) {
        const config = memoryRecallConfig(options);
        const minImportance = Number.isFinite(Number(options.minImportance)) ? Number(options.minImportance) : 0.3;
        const memoryTypes = options.memoryTypes || ["episodic", "semantic"];
        const lexicalCandidates = dbSearchMemory(
            this.userId,
            query,
            memoryTypes,
            config.candidateLimit,
            minImportance,
            "active",
            { touchRecall: false },
        );

        if (!memoryVectorRecallEnabled()) {
            const ranked = rankMemoryCandidates(lexicalCandidates, config);
            return {
                memories: ranked.selected,
                diagnostics: {
                    enabled: true,
                    vectorEnabled: false,
                    retrievalMode: "lexical",
                    scanned: ranked.scanned,
                    selected: ranked.selected.map((item) => item.id),
                    dropped: ranked.dropped,
                    selectedTokens: ranked.selectedTokens,
                    config: ranked.config,
                },
            };
        }

        const vectorRows = getMemoryVectorRows(this.userId, memoryTypes)
            .filter((row) => Number(row.importance ?? 0) >= minImportance);
        const serializedRows = this.list(Math.max(50, vectorRows.length + 10), ["active"]);
        const rowsById = new Map(serializedRows.map((row) => [Number(row.id), row]));
        const vectorResult = await retrieveMemoryVectorCandidates({
            userId: this.userId,
            query,
            rows: vectorRows,
            options: {
                ...memoryVectorRecallConfig(options),
                embedder: options.embedder,
            },
        });

        const lexicalById = new Map(lexicalCandidates.map((row) => [Number(row.id), {
            ...row,
            lexicalScore: Number(row.relevanceScore) || 0,
            retrievalSources: ["lexical"],
        }]));
        const vectorWeight = memoryVectorRecallConfig(options).vectorWeight;
        const merged = lexicalById;

        for (const hit of vectorResult.hits || []) {
            const id = Number(hit.id);
            const vectorScore = Number(hit.vectorScore) || 0;
            const current = merged.get(id) || rowsById.get(id);
            if (!current) continue;
            const next = {
                ...current,
                vectorScore,
                retrievalSources: [...new Set([...(current.retrievalSources || []), "vector"])],
            };
            if (current.lexicalScore != null) {
                next.relevanceScore = current.lexicalScore * (1 - vectorWeight) + vectorScore * vectorWeight;
            } else {
                next.relevanceScore = vectorScore;
                next.lexicalScore = 0;
            }
            merged.set(id, next);
        }

        const ranked = rankMemoryCandidates([...merged.values()], config);
        return {
            memories: ranked.selected,
            diagnostics: {
                enabled: true,
                vectorEnabled: true,
                retrievalMode: vectorResult.error ? "lexical_fallback" : (vectorResult.hits?.length ? "hybrid" : "lexical"),
                vectorError: vectorResult.error || null,
                lexicalCandidates: lexicalCandidates.length,
                vectorCandidates: vectorResult.hits?.length || 0,
                vectorSync: vectorResult.sync || null,
                scanned: ranked.scanned,
                selected: ranked.selected.map((item) => item.id),
                dropped: ranked.dropped,
                selectedTokens: ranked.selectedTokens,
                config: { ...ranked.config, vectorWeight },
            },
        };
    }

    recordRecall(memoryIds = []) {
        return recordMemoryRecall(this.userId, memoryIds);
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
        return getMemorySummary(this.userId, limit, null);
    }

    list(limit = 50, statuses = null) {
        return getMemorySummary(this.userId, limit, statuses);
    }

    /**
     * 更新记忆
     * @param {number} memoryId
     * @param {object} updates
     */
    update(memoryId, updates = {}) {
        return updateMemory(this.userId, memoryId, updates);
    }

    edit(memoryId, updates = {}) {
        const current = this.lineage(memoryId)?.memory;
        if (!current) return false;
        const content = String(updates.content ?? current.content).trim();
        if (!content || containsSensitiveContent(content)) return false;
        const memoryType = updates.memory_type ?? current.memory_type;
        const shouldReclassify = updates.content !== undefined || updates.category !== undefined || updates.memory_key !== undefined;
        if (!shouldReclassify) return this.update(memoryId, updates);

        const analysis = this.analyzeCandidate({
            content,
            memoryType,
            category: updates.category ?? current.category,
            memoryKey: updates.memory_key === undefined ? current.memory_key : updates.memory_key,
            excludeId: memoryId,
        });
        const replacesPrevious = ["conflict", "expiration"].includes(analysis.relation.type);
        return this.update(memoryId, {
            ...updates,
            content,
            memory_type: memoryType,
            category: analysis.category,
            memory_key: analysis.memoryKey,
            relation_type: analysis.relation.type,
            related_memory_id: analysis.previous?.id || null,
            supersedes_id: replacesPrevious ? analysis.previous?.id || null : null,
            metadata: {
                ...(current.metadata || {}),
                relation_type: analysis.relation.type,
                relation_reason: analysis.relation.reason,
                relation_similarity: analysis.relation.similarity,
                related_memory_id: analysis.previous?.id || null,
                edited_at: new Date().toISOString(),
            },
        });
    }

    /**
     * 删除单条记忆
     * @param {number} memoryId
     */
    remove(memoryId) {
        return removeMemory(this.userId, memoryId);
    }

    lineage(memoryId) {
        return getMemoryLineage(this.userId, memoryId);
    }

    approve(memoryId) {
        return transitionMemory(this.userId, memoryId, "active");
    }

    reject(memoryId, reason = "user_rejected") {
        return transitionMemory(this.userId, memoryId, "rejected", reason);
    }

    invalidate(memoryId, reason = "user_invalidated") {
        return transitionMemory(this.userId, memoryId, "invalidated", reason);
    }

    restore(memoryId) {
        const current = this.lineage(memoryId)?.memory;
        if (!current || current.status !== "invalidated") return false;
        return transitionMemory(this.userId, memoryId, "active");
    }

    retentionSweep({ dryRun = false, policy = {} } = {}) {
        const resolvedPolicy = memoryRetentionConfig(policy);
        if (!memoryRetentionEnabled()) {
            return {
                enabled: false,
                dryRun: Boolean(dryRun),
                policy: resolvedPolicy,
                scanned: 0,
                invalidated: 0,
                protectedSkipped: 0,
                byReason: {},
                candidates: [],
            };
        }
        return {
            ...applyMemoryRetention(this.userId, resolvedPolicy, { dryRun }),
            policy: resolvedPolicy,
        };
    }

    exportData() {
        return {
            schemaVersion: "memory-export-v1",
            exportedAt: new Date().toISOString(),
            memories: dbExportMemory(this.userId),
        };
    }

    cleanup(memoryIds = [], confirm = false) {
        const ids = [...new Set((Array.isArray(memoryIds) ? memoryIds : []).map(Number))]
            .filter((id) => Number.isInteger(id) && id > 0)
            .slice(0, 100);
        if (confirm !== true) {
            return { ok: false, errorCode: "CONFIRMATION_REQUIRED", results: [], succeeded: 0, failed: ids.length };
        }
        const results = ids.map((id) => {
            const ok = this.remove(id);
            return { id, ok, errorCode: ok ? null : "NOT_FOUND" };
        });
        return {
            ok: results.every((item) => item.ok),
            results,
            succeeded: results.filter((item) => item.ok).length,
            failed: results.filter((item) => !item.ok).length,
        };
    }

    batchTransition(memoryIds = [], action = "approve", reason = null) {
        const transition = {
            approve: (id) => this.approve(id),
            reject: (id) => this.reject(id, reason || "user_rejected"),
            invalidate: (id) => this.invalidate(id, reason || "user_invalidated"),
        }[String(action || "")];
        if (!transition) return { ok: false, errorCode: "INVALID_MEMORY_ACTION", results: [] };

        const ids = [...new Set((Array.isArray(memoryIds) ? memoryIds : []).map(Number))]
            .filter((id) => Number.isInteger(id) && id > 0)
            .slice(0, 100);
        const results = ids.map((id) => {
            try {
                const ok = transition(id);
                return {
                    id,
                    ok: Boolean(ok),
                    status: ok ? this.lineage(id)?.memory?.status || null : null,
                    errorCode: ok ? null : "NOT_FOUND",
                };
            } catch (error) {
                return { id, ok: false, status: null, errorCode: error?.code || "MEMORY_TRANSITION_FAILED" };
            }
        });
        return {
            ok: results.every((item) => item.ok),
            action,
            results,
            succeeded: results.filter((item) => item.ok).length,
            failed: results.filter((item) => !item.ok).length,
        };
    }

    analyzeCandidate({ content, memoryType = "semantic", category = null, memoryKey = null, excludeId = null } = {}) {
        const resolvedCategory = normalizeMemoryCategory(category, memoryType, content);
        const resolvedKey = canonicalMemoryKey(memoryKey, { content, category: resolvedCategory });
        // Relation checks are management reads, not recalls; use list() so
        // duplicate detection does not inflate recall_count/last_recalled_at.
        const candidates = this.list(200, ["active", "pending"])
            .filter((item) => item.id !== Number(excludeId));
        const normalizedCandidates = candidates.map((item) => ({
            ...item,
            memory_key: canonicalMemoryKey(item.memory_key, {
                content: item.content,
                category: item.category || resolvedCategory,
            }),
        }));
        const candidate = { content, category: resolvedCategory, memoryKey: resolvedKey };
        const duplicate = normalizedCandidates
            .map((item) => ({ item, relation: classifyMemoryRelation(candidate, item) }))
            .find(({ relation }) => relation.type === "duplicate");
        if (duplicate) {
            return { category: resolvedCategory, memoryKey: resolvedKey, previous: duplicate.item, relation: duplicate.relation };
        }
        const previous = normalizedCandidates
            .filter((item) => resolvedKey && item.memory_key === resolvedKey)
            .sort((left, right) => Number(right.status === "active") - Number(left.status === "active"))[0] || null;
        return {
            category: resolvedCategory,
            memoryKey: resolvedKey,
            previous,
            relation: classifyMemoryRelation(candidate, previous),
        };
    }

    recordDuplicate(existing, { importance, confidence, source, sessionId, memoryKey, category, extractionPromptVersion = null } = {}) {
        const metadata = {
            ...(existing.metadata || {}),
            duplicate_count: Number(existing.metadata?.duplicate_count || 0) + 1,
            last_duplicate_at: new Date().toISOString(),
            last_duplicate_source: source || "unknown",
            last_duplicate_session_id: sessionId || null,
        };
        if (extractionPromptVersion) metadata.extraction_prompt_version = extractionPromptVersion;
        this.update(existing.id, {
            importance: Math.max(Number(existing.importance || 0), Number(importance || 0)),
            confidence: Math.max(Number(existing.confidence || 0), Number(confidence || 0)),
            memory_key: memoryKey || existing.memory_key,
            category: category || existing.category,
            metadata,
        });
        return { accepted: true, duplicate: true, relation: "duplicate", id: existing.id, status: existing.status };
    }

    /**
     * 写入用户明确要求记住的事实。显式请求跳过审核，但仍执行精确去重
     * 和敏感信息过滤，避免把密钥/令牌变成长生命周期数据。
     */
    remember(content, memoryType = "semantic", importance = 0.9, metadata = {}, sessionId = null) {
        const text = String(content || "").trim();
        if (!text || containsSensitiveContent(text)) return { accepted: false, reason: "SENSITIVE_CONTENT" };
        const analysis = this.analyzeCandidate({
            content: text,
            memoryType,
            category: metadata.category,
            memoryKey: metadata.memory_key,
        });
        if (analysis.relation.type === "duplicate") {
            if (analysis.previous.status === "pending") this.approve(analysis.previous.id);
            return {
                ...this.recordDuplicate(analysis.previous, {
                    importance,
                    confidence: 1,
                    source: "explicit",
                    sessionId,
                    memoryKey: analysis.memoryKey,
                    category: analysis.category,
                }),
                status: "active",
            };
        }
        const sourceMetadata = {
            ...metadata,
            source: "explicit",
            confidence: 1,
            category: analysis.category,
            extraction_method: "explicit",
            source_session_id: sessionId,
            relation_type: analysis.relation.type,
            relation_reason: analysis.relation.reason,
            related_memory_id: analysis.previous?.id || null,
        };
        const lifecycle = {
            source: "explicit",
            confidence: 1,
            category: analysis.category,
            memoryKey: analysis.memoryKey,
            relationType: analysis.relation.type,
            relatedMemoryId: analysis.previous?.id || null,
            supersedesId: ["conflict", "expiration"].includes(analysis.relation.type) ? analysis.previous?.id || null : null,
        };
        let id;
        if (["conflict", "expiration"].includes(analysis.relation.type)) {
            id = dbProposeMemory(this.userId, sessionId, text, memoryType, importance, sourceMetadata, lifecycle);
            this.approve(id);
        } else {
            id = this.add(text, memoryType, importance, sourceMetadata, sessionId, { ...lifecycle, status: "active" });
        }
        return {
            accepted: true,
            id,
            status: "active",
            relation: analysis.relation.type,
            relatedMemoryId: analysis.previous?.id || null,
        };
    }

    /**
     * 写入自动提取的候选记忆。相同内容去重；同一个 memoryKey 的新值
     * 会挂到旧记忆上，等用户批准后再原子地 supersede 旧值。
     */
    propose({ content, memoryType = "semantic", importance = 0.5, confidence = 0.5, memoryKey = null, metadata = {}, sessionId = null } = {}) {
        const text = String(content || "").trim();
        if (!text || containsSensitiveContent(text)) return { accepted: false, reason: "SENSITIVE_CONTENT" };
        const source = metadata.source || "llm_extract";
        const extractionPromptVersion = source === "llm_extract" && memoryExtractionScoringRubricEnabled()
            ? MEMORY_EXTRACTION_PROMPT_VERSION
            : null;
        const analysis = this.analyzeCandidate({
            content: text,
            memoryType,
            category: metadata.category,
            memoryKey,
        });
        if (analysis.relation.type === "duplicate") {
            return this.recordDuplicate(analysis.previous, {
                importance,
                confidence,
                source,
                sessionId,
                memoryKey: analysis.memoryKey,
                category: analysis.category,
                extractionPromptVersion,
            });
        }
        const replacesPrevious = ["conflict", "expiration"].includes(analysis.relation.type);
        const sourceMetadata = {
            ...metadata,
            ...(extractionPromptVersion ? { extraction_prompt_version: extractionPromptVersion } : {}),
            source,
            category: analysis.category,
            memory_key: analysis.memoryKey || undefined,
            extraction_method: source,
            source_session_id: sessionId,
            relation_type: analysis.relation.type,
            relation_reason: analysis.relation.reason,
            relation_similarity: analysis.relation.similarity,
            related_memory_id: analysis.previous?.id || null,
        };
        if (!extractionPromptVersion) delete sourceMetadata.extraction_prompt_version;
        const id = dbProposeMemory(
            this.userId,
            sessionId,
            text,
            memoryType,
            importance,
            sourceMetadata,
            {
                source,
                confidence,
                category: analysis.category,
                memoryKey: analysis.memoryKey,
                relationType: analysis.relation.type,
                relatedMemoryId: analysis.previous?.id || null,
                supersedesId: replacesPrevious ? analysis.previous?.id || null : null,
            },
        );
        if (memoryRetentionEnabled()) this.retentionSweep();
        return {
            accepted: true,
            id,
            status: "pending",
            relation: analysis.relation.type,
            relatedMemoryId: analysis.previous?.id || null,
            conflictWith: replacesPrevious ? analysis.previous?.id || null : null,
        };
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

    /**
     * LLM 提取失败时的保守降级。规则只识别稳定偏好、身份、长期约束、
     * 持续目标和显著事件，并且始终写入 pending，不能绕过人工审核。
     */
    extractFallbackCandidates(text, sessionId = null) {
        const input = String(text || "").trim();
        if (!input || containsSensitiveContent(input)) {
            return { extractedCount: 0, duplicateCount: 0, rejectedCount: input ? 1 : 0, candidateIds: [] };
        }

        const categoryPatterns = [
            ["preference", /我(?:个人)?(?:喜欢|偏好|习惯|常用|一直|从不|不喜欢|讨厌|倾向于|更希望)|\b(?:i prefer|i like|i dislike|i always|i never)\b/i],
            ["fact", /我(?:的)?(?:名字|职业|工作|角色|项目|技术栈)(?:是|为|叫|使用|采用)|\b(?:my name is|i work as)\b/i],
            ["constraint", /(?:以后|今后|从现在起|每次|始终|一律|默认)(?:都|请|必须|不要|避免|统一|使用|采用|写|回答|生成)?|\bfrom now on\b/i],
            ["goal", /我(?:的)?(?:目标|计划)(?:是|为)|\bmy goal is\b/i],
            ["event", /我(?:今天|刚刚|已经|最近)(?:完成|决定|开始|加入|离开|迁移|发布)/],
        ];
        const sentences = input.split(/[。；;\n]+/).map((item) => item.trim()).filter(Boolean).slice(0, 8);
        let extractedCount = 0;
        let duplicateCount = 0;
        let rejectedCount = 0;
        const candidateIds = [];
        for (const sentence of sentences) {
            const category = categoryPatterns.find(([, pattern]) => pattern.test(sentence))?.[0];
            if (!category || sentence.length < 3 || sentence.length > 300 || containsSensitiveContent(sentence)) {
                if (category) rejectedCount += 1;
                continue;
            }
            const result = this.propose({
                content: sentence,
                memoryType: category === "event" ? "episodic" : "semantic",
                importance: category === "preference" || category === "constraint" ? 0.75 : 0.65,
                confidence: 0.55,
                metadata: { source: "rule_fallback", category },
                sessionId,
            });
            if (result.duplicate) duplicateCount += 1;
            else if (result.accepted) {
                extractedCount += 1;
                if (result.id) candidateIds.push(result.id);
            }
            else rejectedCount += 1;
        }
        return { extractedCount, duplicateCount, rejectedCount, candidateIds };
    }

    /** Explicit user intent is trusted, but still passes sensitive-data checks. */
    extractExplicitMemory(text, sessionId = null) {
        const matches = [];
        for (const content of extractExplicitMemoryContents(text)) {
            if (content.length < 2 || containsSensitiveContent(content)) continue;
            matches.push(this.remember(content, "semantic", 0.95, { source: "explicit" }, sessionId));
        }
        return matches;
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
export async function llmMemoryConsolidation(llm, memory, messages, sessionId, options = {}) {
    const startedAt = Date.now();
    const config = memoryExtractionConfig(options);
    const gate = shouldExtractMemoryCandidates(messages);
    const baseResult = {
        eligible: gate.eligible,
        extractedCount: 0,
        duplicateCount: 0,
        rejectedCount: 0,
        consolidatedCount: 0,
        retryCount: 0,
        candidateIds: [],
    };
    if (!gate.eligible) {
        return { ...baseResult, status: "skipped", reason: gate.reason, durationMs: Date.now() - startedAt };
    }

    const scoringRubricV2 = memoryExtractionScoringRubricEnabled();
    const extractionPrompt = buildMemoryExtractionPrompt(messages, { ...config, scoringRubricV2 });
    const controller = new AbortController();
    const parentSignal = options.signal;
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const timeout = setTimeout(() => controller.abort(new AppError("Memory extraction timed out", {
        code: "MEMORY_EXTRACTION_TIMEOUT",
        statusCode: 504,
        retryable: true,
    })), config.timeoutMs);
    let retryCount = 0;

    try {
        const response = await withRetry(
            (_, retrySignal) => raceWithAbort(
                llm.invoke([{ role: "user", content: extractionPrompt }], { signal: retrySignal }),
                retrySignal,
            ),
            {
                retries: config.retries,
                deadlineMs: config.timeoutMs,
                signal: controller.signal,
                onRetry: () => { retryCount += 1; },
            },
        );
        const raw = typeof response === "string" ? response : response?.content || "";
        const parsed = parseMemoryCandidateResponse(raw, { maxCandidates: config.maxCandidates });
        if (parsed.errorCode) {
            return {
                ...baseResult,
                status: "invalid_output",
                errorCode: parsed.errorCode,
                retryCount,
                durationMs: Date.now() - startedAt,
            };
        }

        let extractedCount = 0;
        let duplicateCount = 0;
        let rejectedCount = parsed.rejectedCount;
        const candidateIds = [];
        for (const candidate of parsed.candidates) {
            const metadata = {
                source: "llm_extract",
                category: candidate.category,
                ...(scoringRubricV2 ? { extraction_prompt_version: MEMORY_EXTRACTION_PROMPT_VERSION } : {}),
            };
            const result = memory.propose({
                content: candidate.content,
                memoryType: candidate.memoryType,
                importance: candidate.importance,
                confidence: candidate.confidence,
                memoryKey: candidate.key,
                metadata,
                sessionId,
            });
            if (result.duplicate) duplicateCount += 1;
            else if (result.accepted) {
                extractedCount += 1;
                if (result.id) candidateIds.push(result.id);
            }
            else rejectedCount += 1;
        }
        return {
            ...baseResult,
            status: "completed",
            parsedCount: parsed.candidates.length,
            extractedCount,
            duplicateCount,
            rejectedCount,
            candidateIds,
            retryCount,
            durationMs: Date.now() - startedAt,
        };
    } catch (error) {
        const errorCode = error?.code || "MEMORY_EXTRACTION_FAILED";
        const timedOut = errorCode === "MEMORY_EXTRACTION_TIMEOUT" || errorCode === "RETRY_DEADLINE_EXCEEDED";
        const aborted = !timedOut && isAbortError(error, controller.signal);
        console.warn(`[memory][extract] status=${timedOut ? "timeout" : aborted ? "aborted" : "provider_failed"} code=${errorCode}`);
        return {
            ...baseResult,
            status: timedOut ? "timeout" : aborted ? "aborted" : "provider_failed",
            errorCode,
            retryCount,
            durationMs: Date.now() - startedAt,
        };
    } finally {
        clearTimeout(timeout);
        parentSignal?.removeEventListener("abort", abortFromParent);
    }
}

export default MemoryService;

export function normalizeMemoryText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, "")
        .trim();
}

export { containsSensitiveContent };
