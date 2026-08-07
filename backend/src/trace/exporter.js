/**
 * Trace Exporter (stub)
 *
 * Phase 5: 预留 OpenTelemetry 兼容导出接口。
 * 当前为占位实现，后续可扩展为 OTLP/gRPC 导出。
 *
 * 目标格式：符合 OpenTelemetry Trace 数据模型，
 * 使 AgentEvo 的 trace 数据可被 AgentArts 兼容的观测平台消费。
 */

/**
 * 将 TraceCollector trace 导出为 OTel 兼容格式
 * @param {object} traceRecord — TraceCollector.finishTrace 的输出
 * @returns {object} OTel 格式的 trace
 */
export function toOpenTelemetryFormat(traceRecord) {
    if (!traceRecord || !traceRecord.rootSpan) return null;

    const convertSpan = (span, parentId) => ({
        traceId: traceRecord.traceId,
        spanId: span.id,
        parentSpanId: parentId || null,
        name: span.name,
        kind: span.type === "tool" ? "INTERNAL" : "SERVER",
        startTimeUnixNano: new Date(span.startedAt).getTime() * 1_000_000,
        endTimeUnixNano: span.endedAt
            ? new Date(span.endedAt).getTime() * 1_000_000
            : Date.now() * 1_000_000,
        attributes: {
            "agent.traversal_path": JSON.stringify(traceRecord.agentTraversalPath),
            "agent.tool_call_count": traceRecord.toolCallCount,
            "agent.error_count": traceRecord.errorCount,
            "agent.model": traceRecord.model,
            ...Object.entries(span.metadata || {}).reduce((acc, [k, v]) => {
                acc[`custom.${k}`] = typeof v === "string" ? v : JSON.stringify(v);
                return acc;
            }, {}),
        },
    });

    const allSpans = [];

    const walkSpanTree = (span, parentId) => {
        allSpans.push(convertSpan(span, parentId));
        if (span.children) {
            for (const child of span.children) {
                walkSpanTree(child, span.id);
            }
        }
    };

    walkSpanTree(traceRecord.rootSpan, null);

    return {
        resourceSpans: [
            {
                resource: {
                    attributes: [
                        { key: "service.name", value: { stringValue: "agent-evo" } },
                        { key: "service.version", value: { stringValue: "phase-5" } },
                    ],
                },
                scopeSpans: [
                    {
                        scope: { name: "agent-evo-agent" },
                        spans: allSpans,
                    },
                ],
            },
        ],
    };
}

/**
 * 将 OTel 格式导出为 JSON 字符串
 * @param {object} traceRecord
 * @returns {string}
 */
export function exportAsJSON(traceRecord) {
    const otelFormat = toOpenTelemetryFormat(traceRecord);
    return JSON.stringify(otelFormat, null, 2);
}
