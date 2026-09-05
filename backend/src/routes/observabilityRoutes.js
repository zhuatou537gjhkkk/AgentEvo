import { dbFn, svcFn, sendError } from "./deps.js";

function parseJson(value, fallback) {
    try {
        return JSON.parse(value || "");
    } catch {
        return fallback;
    }
}

function toTraceListRow(row) {
    return {
        trace_id: row.trace_id,
        trace_type: row.trace_type,
        agent_traversal_path: parseJson(row.agent_traversal_path, []),
        tool_call_count: row.tool_call_count,
        error_count: row.error_count,
        total_latency_ms: row.total_latency_ms,
        model: row.model,
        created_at: row.created_at ? new Date(row.created_at + "Z").toISOString() : null,
    };
}

function toTraceDetail(trace) {
    return {
        trace_id: trace.trace_id,
        trace_type: trace.trace_type,
        total_latency_ms: trace.total_latency_ms,
        tool_call_count: trace.tool_call_count,
        error_count: trace.error_count,
        model: trace.model,
        agent_traversal_path: parseJson(trace.agent_traversal_path, []),
        root_span: parseJson(trace.root_span, {}),
        created_at: trace.created_at ? new Date(trace.created_at + "Z").toISOString() : null,
    };
}

/**
 * Observability reads are per-factory registrars. All DB/state access goes
 * through the request dependency bag so a factory instance can fake user-owned
 * traces/metrics and prove two-user isolation over native HTTP.
 */
export function registerObservabilityRoutes(router, { requireAuth }) {
    router.get("/observability/recent", requireAuth, (req, res) => {
        try {
            const limit = Number(req.query?.limit || 30);
            const records = dbFn(req, "getRecentObservability")(req.user.id, limit);
            return res.json({ ok: true, records });
        } catch (error) {
            console.error("[observability/recent] GET failed:", error.message);
            return sendError(res, req.requestId, error, { code: "REQUEST_FAILED", status: 500 });
        }
    });

    router.get("/observability/metrics", requireAuth, (req, res) => {
        try {
            const window = ["7d", "30d", "all"].includes(req.query?.window)
                ? req.query.window
                : "7d";
            const report = svcFn(req, "metricsAggregator").getFullReport(req.user.id, window);
            return res.json({ ok: true, ...report });
        } catch (error) {
            console.error("[observability/metrics] GET failed:", error.message);
            return sendError(res, req.requestId, error, { code: "REQUEST_FAILED", status: 500 });
        }
    });

    router.get("/observability/traces", requireAuth, (req, res) => {
        try {
            const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 30));
            const scope = { userId: req.user.id, tenantId: req.user.tenantId };
            const rows = dbFn(req, "getRecentTraces")(req.user.id, limit, scope);
            const traces = rows.map(toTraceListRow);
            return res.json({ ok: true, traces, total: traces.length });
        } catch (error) {
            console.error("[observability/traces] GET failed:", error.message);
            return sendError(res, req.requestId, error, { code: "REQUEST_FAILED", status: 500 });
        }
    });

    router.get("/observability/traces/:traceId", requireAuth, (req, res) => {
        try {
            const scope = { userId: req.user.id, tenantId: req.user.tenantId };
            const trace = dbFn(req, "getTraceById")(req.params.traceId, req.user.id, scope);
            if (!trace) {
                return sendError(res, req.requestId, Object.assign(new Error("trace not found"), { statusCode: 404, code: "NOT_FOUND" }));
            }
            return res.json({ ok: true, trace: toTraceDetail(trace) });
        } catch (error) {
            console.error("[observability/traces/:id] GET failed:", error.message);
            return sendError(res, req.requestId, error, { code: "REQUEST_FAILED", status: 500 });
        }
    });

    router.get("/observability/traces/:traceId/otel", requireAuth, (req, res) => {
        try {
            const scope = { userId: req.user.id, tenantId: req.user.tenantId };
            const trace = dbFn(req, "getTraceById")(req.params.traceId, req.user.id, scope);
            if (!trace) {
                return sendError(res, req.requestId, Object.assign(new Error("trace not found"), { statusCode: 404, code: "NOT_FOUND" }));
            }
            const traceRecord = {
                traceId: trace.trace_id,
                rootSpan: parseJson(trace.root_span, {}),
                agentTraversalPath: parseJson(trace.agent_traversal_path, []),
                toolCallCount: trace.tool_call_count,
                errorCount: trace.error_count,
                model: trace.model,
            };
            const otelFormat = svcFn(req, "TraceCollector").toOpenTelemetry(traceRecord);
            if (!otelFormat) {
                return sendError(res, req.requestId, Object.assign(new Error("failed to convert to OTel format"), { statusCode: 500, code: "OTEL_EXPORT_FAILED" }));
            }
            return res.json({ ok: true, otel: otelFormat });
        } catch (error) {
            console.error("[observability/traces/:id/otel] GET failed:", error.message);
            return sendError(res, req.requestId, error, { code: "REQUEST_FAILED", status: 500 });
        }
    });

    router.post("/observability/otel/import", requireAuth, (req, res) => {
        try {
            const { otel } = req.body || {};
            if (!otel) {
                return sendError(res, req.requestId, Object.assign(new Error("otel is required in request body"), { statusCode: 400, code: "OTEL_INVALID" }));
            }
            const otelJson = typeof otel === "string" ? JSON.parse(otel) : otel;

            let sessionId = Number(req.body?.session_id) || 0;
            if (sessionId && !dbFn(req, "getSessionById")(req.user.id, sessionId)) {
                return sendError(res, req.requestId, Object.assign(new Error("session not found"), { statusCode: 404, code: "NOT_FOUND" }));
            }
            if (!sessionId) {
                const sessions = dbFn(req, "getSessions")(req.user.id);
                if (sessions.length > 0) {
                    sessionId = sessions[0].id;
                } else {
                    const newSession = dbFn(req, "createSession")(req.user.id, "OTel 导入");
                    sessionId = typeof newSession === "object" ? newSession.id : newSession;
                }
            }

            const internal = svcFn(req, "otelToInternalTrace")(otelJson, {
                userId: req.user.id,
                sessionId,
            });
            if (!internal) {
                return sendError(res, req.requestId, Object.assign(new Error("failed to parse OTel trace: no valid spans found"), { statusCode: 400, code: "OTEL_INVALID" }));
            }

            const id = dbFn(req, "saveTrace")(internal);
            console.log(`[observability/otel/import] imported trace "${internal.traceId}" (${internal.toolCallCount} tools, ${internal.agentTraversalPath.length} agents), db id=${id}`);
            return res.json({
                ok: true,
                trace_id: internal.traceId,
                db_id: id,
                spans: internal.agentTraversalPath.length + internal.toolCallCount,
            });
        } catch (error) {
            console.error("[observability/otel/import] POST failed:", error.message);
            return sendError(res, req.requestId, error, { code: "REQUEST_FAILED", status: 500 });
        }
    });
}
