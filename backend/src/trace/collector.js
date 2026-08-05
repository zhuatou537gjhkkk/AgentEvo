/**
 * TraceCollector — 全链路 Trace/Span 采集器
 *
 * Phase 5 核心：对齐 AgentArts 可观测性模块。
 * 提供层次化 Span 追踪： root → agent → tool，记录每个步骤的耗时和元数据。
 *
 * 用法：
 *   const tc = new TraceCollector();
 *   const traceId = tc.startTrace(userId, sessionId, 'chat', { input: "..." });
 *   const rootId = traceId; // root span id = traceId
 *
 *   const agentSpan = tc.startSpan(traceId, 'router', 'agent', rootId);
 *   const toolSpan = tc.startSpan(traceId, 'web_search', 'tool', agentSpan, { query: "..." });
 *   tc.endSpan(traceId, toolSpan);
 *   tc.endSpan(traceId, agentSpan);
 *
 *   const trace = tc.finishTrace(traceId, 'deepseek-v4-flash');
 *   // trace 已写入 eval_traces 表
 */

import { saveTrace } from "../db/index.js";

class TraceCollector {
    constructor() {
        /** @type {Map<string, Trace>} */
        this._traces = new Map();
    }

    /**
     * 开始一个新的 Trace（root span 自动创建）
     * @param {number} userId
     * @param {number} sessionId
     * @param {string} traceType — 'chat' | 'eval' | 'reflection'
     * @param {object} metadata
     * @returns {string} traceId (同时也是 rootSpan.id)
     */
    startTrace(userId, sessionId, traceType = "chat", metadata = {}) {
        const traceId = this._generateId();
        const now = new Date().toISOString();

        const trace = {
            traceId,
            userId,
            sessionId,
            traceType,
            metadata,
            spans: new Map(),
            agentTraversalPath: [],
            toolCallCount: 0,
            errorCount: 0,
            rootSpan: {
                id: traceId,
                name: "root",
                type: "root",
                parentSpanId: null,
                startedAt: now,
                endedAt: null,
                durationMs: 0,
                metadata,
                children: [],
            },
            startedAt: now,
        };

        trace.spans.set(traceId, trace.rootSpan);
        this._traces.set(traceId, trace);

        if (metadata.agentName) {
            trace.agentTraversalPath.push(metadata.agentName);
        }

        return traceId;
    }

    /**
     * 在指定 trace 中创建子 Span
     * @param {string} traceId
     * @param {string} spanName — 如 "router", "web_search"
     * @param {string} spanType — "agent" | "tool"
     * @param {string} parentSpanId — 父 Span ID
     * @param {object} metadata — 自定义元数据
     * @returns {string|null} spanId（出错时返回 null）
     */
    startSpan(traceId, spanName, spanType = "tool", parentSpanId = null, metadata = {}) {
        const trace = this._traces.get(traceId);
        if (!trace) {
            // 静默返回：trace 可能已在 abort/disconnect 场景下被 finishTrace 清理
            return null;
        }

        const spanId = this._generateId();
        const now = new Date().toISOString();

        const parentId = parentSpanId || traceId; // default to root

        const span = {
            id: spanId,
            name: spanName,
            type: spanType,
            parentSpanId: parentId,
            startedAt: now,
            endedAt: null,
            durationMs: 0,
            metadata,
            children: [],
        };

        trace.spans.set(spanId, span);

        // 将当前 span 挂到父 span 的 children 数组
        const parentSpan = trace.spans.get(parentId);
        if (parentSpan) {
            parentSpan.children.push(spanId);
        }

        // 类别感知的自动记录
        if (spanType === "agent" && !trace.agentTraversalPath.includes(spanName)) {
            trace.agentTraversalPath.push(spanName);
        }
        if (spanType === "tool") {
            trace.toolCallCount++;
        }

        return spanId;
    }

    /**
     * 结束一个 Span，记录持续时间和结束时间
     * @param {string} traceId
     * @param {string} spanId
     * @param {object} metadata — 结束时的元数据（可选，如 output/error）
     */
    endSpan(traceId, spanId, metadata = {}) {
        const trace = this._traces.get(traceId);
        if (!trace) {
            // 静默返回：trace 可能已在 abort/disconnect 场景下被 finishTrace 清理
            return;
        }

        const span = trace.spans.get(spanId);
        if (!span) {
            console.warn(`[TraceCollector] endSpan: span "${spanId}" not found in trace "${traceId}"`);
            return;
        }

        const endedAt = new Date();
        span.endedAt = endedAt.toISOString();
        span.durationMs = endedAt.getTime() - new Date(span.startedAt).getTime();
        Object.assign(span.metadata, metadata);

        // 如果工具 Span 结束时有 error，计数
        if (span.type === "tool" && metadata.error) {
            trace.errorCount++;
        }
    }

    /**
     * 结束整个 Trace 并写入数据库
     * @param {string} traceId
     * @param {string} model
     * @param {object} extra — 额外字段: messageId, parentTraceId
     * @returns {object} trace
     */
    finishTrace(traceId, model = "", extra = {}) {
        const trace = this._traces.get(traceId);
        if (!trace) {
            return null;
        }

        // 记录 root span 结束时间
        const endedAt = new Date();
        trace.rootSpan.endedAt = endedAt.toISOString();
        trace.rootSpan.durationMs = endedAt.getTime() - new Date(trace.startedAt).getTime();

        // 递归序列化 span tree
        const serializeSpan = (spanId) => {
            const s = trace.spans.get(spanId);
            if (!s) return null;
            return {
                id: s.id,
                name: s.name,
                type: s.type,
                parentSpanId: s.parentSpanId,
                startedAt: s.startedAt,
                endedAt: s.endedAt,
                durationMs: s.durationMs,
                metadata: s.metadata,
                children: s.children.map(serializeSpan).filter(Boolean),
            };
        };

        const traceRecord = {
            userId: trace.userId,
            sessionId: trace.sessionId,
            messageId: extra.messageId || null,
            traceId: trace.traceId,
            parentTraceId: extra.parentTraceId || null,
            traceType: trace.traceType,
            rootSpan: serializeSpan(traceId),
            agentTraversalPath: trace.agentTraversalPath,
            toolCallCount: trace.toolCallCount,
            errorCount: trace.errorCount,
            totalLatencyMs: trace.rootSpan.durationMs,
            model: model,
        };

        // 写入数据库
        try {
            saveTrace(traceRecord);
            console.log(
                `[TraceCollector] trace "${traceId}" saved: ` +
                `${trace.toolCallCount} tool(s), ${trace.errorCount} error(s), ` +
                `path=[${trace.agentTraversalPath.join("→")}], ` +
                `latency=${trace.rootSpan.durationMs}ms`
            );
        } catch (err) {
            console.error(`[TraceCollector] failed to save trace "${traceId}":`, err.message);
        }

        // 从活跃 traces 中移除
        this._traces.delete(traceId);

        return traceRecord;
    }

    /**
     * 获取活跃 trace（用于集成到其他组件）
     * @param {string} traceId
     * @returns {object|undefined}
     */
    getTrace(traceId) {
        return this._traces.get(traceId);
    }

    // ── private ──

    _generateId() {
        // 简洁的唯一 ID：时间戳 + 随机串
        const t = Date.now().toString(36);
        const r = Math.random().toString(36).slice(2, 8);
        return `${t}-${r}`;
    }
}

export { TraceCollector };
