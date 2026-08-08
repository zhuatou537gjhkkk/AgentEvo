/**
 * OTel Trace 导入器 (Phase 6c OTel)
 *
 * 将标准 OpenTelemetry JSON (OTLP/JSON) Trace 转换为内部 eval_traces 格式，
 * 使外部 Agent (LangChain/AutoGen 等) 的 Trace 可在 AgentEvo 观测面板可视化。
 *
 * 支持的 OTel SpanKind:
 *   SPAN_KIND_UNSPECIFIED = 0
 *   SPAN_KIND_INTERNAL    = 1
 *   SPAN_KIND_SERVER      = 2
 *   SPAN_KIND_CLIENT      = 3
 *   SPAN_KIND_PRODUCER    = 4
 *   SPAN_KIND_CONSUMER    = 5
 */

/**
 * 将 OTel JSON (OTLP/JSON format) 转换为内部 Trace Record
 *
 * 输入格式 (简化):
 *   {
 *     resourceSpans: [{
 *       resource: { attributes: [...] },
 *       scopeSpans: [{
 *         scope: { name: "..." },
 *         spans: [{ traceId, spanId, parentSpanId, name, kind, startTimeUnixNano, endTimeUnixNano, attributes, status }]
 *       }]
 *     }]
 *   }
 *
 * @param {object} otelJson — 已解析的 OTel JSON 对象
 * @param {object} opts — { userId, sessionId }
 * @returns {object|null} 内部 trace record（可直接传给 saveTrace()）
 */
export function otelToInternalTrace(otelJson, opts = {}) {
    if (!otelJson || !Array.isArray(otelJson.resourceSpans) || otelJson.resourceSpans.length === 0) {
        return null;
    }

    const userId = Number(opts.userId) || 0;
    const sessionId = Number(opts.sessionId) || 0;

    // ── 1. 展平所有 Span ──
    /** @type {Array<{spanId:string, parentSpanId:string, name:string, kind:number, startNano:number, endNano:number, attrs:object, status:object}>} */
    const flatSpans = [];
    const serviceName = otelJson.resourceSpans[0]?.resource?.attributes?.find(
        (a) => a.key === "service.name"
    )?.value?.stringValue || "external";

    for (const rs of otelJson.resourceSpans) {
        for (const ss of (rs.scopeSpans || [])) {
            for (const span of (ss.spans || [])) {
                const attrs = {};
                for (const attr of (span.attributes || [])) {
                    const val = attr.value || {};
                    attrs[attr.key] = val.stringValue ?? val.intValue ?? val.doubleValue ?? val.boolValue ?? JSON.stringify(val);
                }

                flatSpans.push({
                    spanId: String(span.spanId || ""),
                    parentSpanId: String(span.parentSpanId || ""),
                    name: String(span.name || "unknown"),
                    kind: Number(span.kind) || 0,
                    startNano: parseNanoseconds(span.startTimeUnixNano),
                    endNano: parseNanoseconds(span.endTimeUnixNano),
                    attrs,
                    status: span.status || { code: 1 },
                });
            }
        }
    }

    if (flatSpans.length === 0) return null;

    // ── 2. 生成内部 traceId ──
    const traceId = otelJson.resourceSpans[0]?.scopeSpans?.[0]?.spans?.[0]?.traceId
        ? `otel-${String(otelJson.resourceSpans[0].scopeSpans[0].spans[0].traceId).slice(0, 16)}`
        : `otel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    // ── 3. 构建树结构 (parentSpanId → children) ──
    const spanMap = new Map();
    const rootSpans = [];

    for (const fs of flatSpans) {
        const internalSpan = otelSpanToInternalSpan(fs);
        spanMap.set(fs.spanId, internalSpan);
    }

    // 挂载 children
    for (const fs of flatSpans) {
        const span = spanMap.get(fs.spanId);
        if (!span) continue;

        if (!fs.parentSpanId || !spanMap.has(fs.parentSpanId)) {
            rootSpans.push(span);
        } else {
            const parent = spanMap.get(fs.parentSpanId);
            if (parent) {
                parent.children.push(span);
            } else {
                rootSpans.push(span);
            }
        }
    }

    // ── 4. 合并为单根 Span 树 ──
    let rootSpan;
    if (rootSpans.length === 0) {
        // 没有根 → 第一作为根
        rootSpan = flatSpans.length > 0 ? spanMap.get(flatSpans[0].spanId) : null;
    } else if (rootSpans.length === 1) {
        rootSpan = rootSpans[0];
    } else {
        // 多根 → 创建合成 root
        const syntheticRootId = `${traceId}-root`;
        rootSpan = {
            id: syntheticRootId,
            name: "imported-trace",
            type: "root",
            parentSpanId: null,
            startedAt: new Date(Math.min(...flatSpans.map((s) => s.startNano))).toISOString(),
            endedAt: new Date(Math.max(...flatSpans.map((s) => s.endNano))).toISOString(),
            durationMs: 0,
            metadata: { service: serviceName, source: "otel-import" },
            children: rootSpans,
        };
        rootSpan.durationMs = new Date(rootSpan.endedAt).getTime() - new Date(rootSpan.startedAt).getTime();
    }

    if (!rootSpan) return null;

    // ── 5. 收集元数据 ──
    const agentTraversalPath = [];
    let toolCallCount = 0;
    let errorCount = 0;

    const collectMeta = (span) => {
        if (span.type === "agent" && !agentTraversalPath.includes(span.name)) {
            agentTraversalPath.push(span.name);
        }
        if (span.type === "tool") toolCallCount++;
        if (span.metadata?.error) errorCount++;
        for (const child of (span.children || [])) {
            collectMeta(child);
        }
    };
    collectMeta(rootSpan);

    const totalLatencyMs = rootSpan.durationMs || 0;

    // ── 6. 构建 saveTrace 兼容 record ──
    return {
        userId,
        sessionId,
        messageId: null,
        traceId,
        parentTraceId: null,
        traceType: "import",
        rootSpan,
        agentTraversalPath,
        toolCallCount,
        errorCount,
        totalLatencyMs,
        model: "external",
    };
}

/**
 * 转换单个 OTel Span → 内部 Span
 */
function otelSpanToInternalSpan(fs) {
    // 优先使用 gen_ai.span.type 属性（往返兼容）
    let spanType = fs.attrs["gen_ai.span.type"] || null;

    if (!spanType) {
        // OTel SpanKind → 内部 type (fallback for external traces)
        const KIND_TO_TYPE = {
            0: "tool",     // UNSPECIFIED → tool
            1: "agent",    // INTERNAL → agent
            2: "root",     // SERVER → root-like
            3: "tool",     // CLIENT → tool
            4: "tool",     // PRODUCER → tool
            5: "tool",     // CONSUMER → tool
        };
        spanType = KIND_TO_TYPE[fs.kind] || "tool";
    }
    const startedAt = new Date(fs.startNano).toISOString();
    const endedAt = new Date(fs.endNano).toISOString();
    const durationMs = fs.endNano > fs.startNano ? fs.endNano - fs.startNano : 0;

    // 提取 gen_ai.* 属性
    const metadata = {};
    for (const [k, v] of Object.entries(fs.attrs)) {
        // 跳过已知的资源级属性
        if (k === "service.name" || k === "service.version") continue;
        metadata[k] = v;
    }

    if (fs.status?.code === 2) {
        metadata.error = fs.status?.message || "span error";
    }

    return {
        id: fs.spanId,
        name: fs.name,
        type: spanType,
        parentSpanId: fs.parentSpanId || null,
        startedAt,
        endedAt,
        durationMs,
        metadata,
        children: [],
    };
}

/**
 * 安全解析 OTel 纳秒时间戳 (可能是 string 或 number)
 * @param {string|number} val
 * @returns {number} 毫秒时间戳
 */
function parseNanoseconds(val) {
    if (val === null || val === undefined || val === "") return Date.now();
    const nano = typeof val === "string" ? parseInt(val, 10) : Number(val);
    if (isNaN(nano) || nano <= 0) return Date.now();
    return Math.floor(nano / 1_000_000); // ns → ms
}
