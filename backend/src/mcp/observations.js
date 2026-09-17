import crypto from "node:crypto";
import { classifyError } from "../services/resilience.js";
import { getRequestContext } from "../services/requestContext.js";
import { mcpTelemetryEnabled } from "./flags.js";

export const MCP_OPERATION_STATUSES = [
    "success",
    "protocol_error",
    "validation_error",
    "timeout",
    "transport_error",
    "aborted",
    "unavailable",
];

export class McpProtocolError extends Error {
    constructor(message = "MCP tool returned isError", { errorCode = "MCP_PROTOCOL_ERROR", retryable = false } = {}) {
        super(message);
        this.name = "McpProtocolError";
        this.code = errorCode;
        this.statusCode = 502;
        this.retryable = retryable;
        this.protocolError = true;
    }
}

function safeString(value, max = 160) {
    return value == null ? null : String(value).slice(0, max);
}

export function statusForMcpError(error) {
    let source = error;
    for (let depth = 0; source && depth < 5; depth += 1) {
        if (source?.protocolError || source?.name === "McpProtocolError" || source?.code === "MCP_PROTOCOL_ERROR") return "protocol_error";
        if (source?.name === "ZodError" || source?.name === "ValidationError" || source?.code === "INVALID_ARGUMENT" || /expected schema|did not match expected schema|tool input|required|invalid.*(input|argument)|expected .*received/i.test(String(source?.message || ""))) return "validation_error";
        if (source?.code === "ABORTED" || source?.name === "AbortError" || source?.code === "ABORT_ERR") return "aborted";
        if (source?.code === "MCP_CONNECT_TIMEOUT" || source?.code === "ETIMEDOUT" || /timeout/i.test(String(source?.name || source?.message || ""))) return "timeout";
        if (source?.code === "MCP_TOOL_UNAVAILABLE" || source?.code === "MCP_SERVER_UNAVAILABLE") return "unavailable";
        source = source?.cause;
    }
    if (error?.retryable || Number(error?.statusCode || error?.status || 0) >= 500) return "transport_error";
    return "transport_error";
}

function defaultScope(scope) {
    const context = getRequestContext();
    const source = scope || context;
    if (!source?.userId || !source?.tenantId) return null;
    return { userId: Number(source.userId), tenantId: String(source.tenantId) };
}

/**
 * In-memory operation recorder. The default instance persists only when the
 * telemetry flag is enabled and a trusted request scope exists. Fixtures can
 * inject a recorder with persist=false and inspect records without a database.
 */
export class McpObservationRecorder {
    constructor({ persist = null, now = () => Date.now() } = {}) {
        this.persist = typeof persist === "function" ? persist : null;
        this.now = now;
        this.records = [];
    }

    start({ serverName, toolName = null, operation, scope = null, requestId = null, traceId = null, spanId = null, schemaStatus = "not_checked", subtaskId = null } = {}) {
        const trustedScope = defaultScope(scope);
        return {
            operation_id: crypto.randomUUID(),
            owner_user_id: trustedScope?.userId || null,
            tenant_id: trustedScope?.tenantId || null,
            request_id: safeString(requestId || getRequestContext()?.requestId, 120),
            trace_id: safeString(traceId, 120),
            span_id: safeString(spanId, 120),
            server_name: safeString(serverName, 120),
            tool_name: safeString(toolName, 160),
            operation: safeString(operation, 40),
            status: "transport_error",
            error_code: null,
            duration_ms: 0,
            attempt_count: 0,
            schema_status: safeString(schemaStatus, 40) || "not_checked",
            subtask_id: safeString(subtaskId, 120),
            created_at: new Date(this.now()).toISOString(),
            _startedAt: this.now(),
        };
    }

    attempt(operation) {
        operation.attempt_count += 1;
    }

    finish(operation, { status = "success", error = null, schemaStatus, durationMs = null } = {}) {
        const end = this.now();
        const record = {
            operation_id: operation.operation_id,
            owner_user_id: operation.owner_user_id,
            tenant_id: operation.tenant_id,
            request_id: operation.request_id,
            trace_id: operation.trace_id,
            span_id: operation.span_id,
            server_name: operation.server_name,
            tool_name: operation.tool_name,
            operation: operation.operation,
            status: MCP_OPERATION_STATUSES.includes(status) ? status : "transport_error",
            error_code: safeString(error?.code || error?.errorCode, 80),
            duration_ms: Math.max(0, Number(durationMs ?? end - operation._startedAt) || 0),
            attempt_count: Math.max(0, Number(operation.attempt_count) || 0),
            schema_status: safeString(schemaStatus || operation.schema_status, 40) || "not_checked",
            subtask_id: operation.subtask_id,
            created_at: operation.created_at,
        };
        this.records.push(record);
        if (this.persist && mcpTelemetryEnabled() && record.owner_user_id && record.tenant_id) {
            try { this.persist(record); } catch (persistError) {
                // Telemetry must never block the Agent path.
                console.warn(`[mcp:telemetry] persist failed: ${persistError?.message || "unknown"}`);
            }
        }
        return record;
    }

    snapshot() {
        return this.records.map((record) => ({ ...record }));
    }

    clear() {
        this.records.length = 0;
    }
}

export function safeMcpError(error) {
    const classified = classifyError(error);
    return {
        code: safeString(classified.code || error?.code || "MCP_TOOL_FAILED", 80),
        status: statusForMcpError(error),
        retryable: Boolean(classified.retryable || error?.retryable),
    };
}
