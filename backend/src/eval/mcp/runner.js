import crypto from "node:crypto";
import { ToolRegistry } from "../../mcp/registry.js";
import { McpObservationRecorder } from "../../mcp/observations.js";
import { mcpEvalEnabled } from "../../mcp/flags.js";
import {
    completeMcpEvalRun,
    createMcpEvalRun,
    saveMcpEvalCaseResult,
    saveMcpOperationObservation,
} from "../../db/index.js";
import { getMcpFixtureCases, MCP_FIXTURE_DATASET_VERSION } from "./cases.js";
import { createMcpFixtureConnector } from "./fixture.js";
import { checkResult, checksPassed, classifyMcpFailure } from "./checks.js";
import { summarizeMcpResults } from "./metrics.js";

function lastObservation(recorder, before, predicate = () => true) {
    return recorder.snapshot().slice(before).filter(predicate).at(-1) || null;
}

async function invokeWithAbort(tool, input, mode) {
    if (mode === "cancel") {
        const controller = new AbortController();
        const pending = tool.invoke(input, { signal: controller.signal, mcpRetries: 1 });
        setTimeout(() => controller.abort(), 10);
        return pending;
    }
    return tool.invoke(input, { mcpRetries: mode === "timeout" ? 0 : 1 });
}

export class McpEvalRunner {
    constructor({ persist = true } = {}) {
        this.persist = persist;
    }

    async run({ scope, caseIds = null, variant = "candidate", runId = null, configId = null, baselineRunId = null, force = false } = {}) {
        if (!force && !mcpEvalEnabled()) {
            const error = Object.assign(new Error("MCP evaluation is disabled"), { code: "MCP_EVAL_DISABLED", statusCode: 503 });
            throw error;
        }
        const cases = getMcpFixtureCases(caseIds);
        const id = createMcpEvalRun({
            runId: runId || crypto.randomUUID(),
            datasetVersion: MCP_FIXTURE_DATASET_VERSION,
            caseIds: cases.map((item) => item.id),
            configId,
            variant,
            baselineRunId,
            scope,
        });
        const recorder = new McpObservationRecorder({ persist: this.persist ? saveMcpOperationObservation : null });
        const counters = {};
        const registry = new ToolRegistry({
            connect: createMcpFixtureConnector({ variant, counters }),
            observations: recorder,
        });
        let fixtureConnected = false;
        const results = [];
        try {
            if (cases.some((testCase) => testCase.serverName === "fixture")) {
                await registry.registerMCPServer({ name: "fixture", command: "fixture", scope, requestId: scope?.requestId });
                fixtureConnected = true;
            }
            for (const testCase of cases) {
                const started = Date.now();
                const before = recorder.snapshot().length;
                let status = "fail";
                let checks = [];
                let failureClass = null;
                let evidence = {};
                if (testCase.requiresModel) {
                    status = "not_run";
                    checkResult(checks, false, "MODEL_NOT_CONFIGURED", "真实模型未配置，本次不执行");
                    evidence = { reason: "requiresModel=true; no real model configured" };
                } else {
                    try {
                        if (!fixtureConnected && testCase.serverName === "fixture") {
                            await registry.registerMCPServer({ name: "fixture", command: "fixture", scope, requestId: scope?.requestId });
                            fixtureConnected = true;
                        }
                        if (testCase.id === "mcp.protocol.connect") {
                            const operation = lastObservation(recorder, 0, (item) => item.operation === "connect" && item.server_name === "fixture");
                            checkResult(checks, operation?.status === testCase.expectedStatus, "CONNECT_STATUS", "连接状态符合预期", operation?.status);
                            evidence = { operationId: operation?.operation_id || null };
                        } else if (testCase.id === "mcp.protocol.discovery") {
                            const operation = lastObservation(recorder, 0, (item) => item.operation === "list_tools" && item.server_name === "fixture");
                            const tools = registry.getMCPServerTools("fixture", scope);
                            checkResult(checks, operation?.status === "success", "DISCOVERY_STATUS", "发现状态符合预期", operation?.status);
                            checkResult(checks, testCase.expectedToolSet.every((name) => tools.some((tool) => tool.name.endsWith(`/${name}`))), "DISCOVERY_TOOL_SET", "发现工具集合符合预期", tools.map((tool) => tool.name));
                            evidence = { operationId: operation?.operation_id || null, toolNames: tools.map((tool) => tool.name) };
                        } else if (testCase.id === "mcp.protocol.unavailable") {
                            const unavailableRegistry = new ToolRegistry({
                                connect: createMcpFixtureConnector({ variant, counters }),
                                observations: recorder,
                            });
                            await unavailableRegistry.registerMCPServer({ name: "unavailable", command: "fixture", scope });
                        } else if (testCase.layer === "end_to_end") {
                            const expectedTool = testCase.expectedToolSet[0] || null;
                            const tool = expectedTool ? registry.getTool(expectedTool, scope) : null;
                            checkResult(checks, expectedTool ? tool?.name === expectedTool : !tool, "CORRECT_TOOL", expectedTool ? "fixture agent 选择了预期工具" : "fixture agent 正确不调用工具", tool?.name || null);
                            if (!expectedTool) {
                                const callCount = recorder.snapshot().slice(before).filter((item) => item.operation === "call_tool").length;
                                checkResult(checks, callCount === 0, "NO_TOOL_CALL", "不应调用 MCP 工具", callCount);
                                checkResult(checks, true, "ANSWER_LAYER_PASS", "无需工具即可完成最终答案", "direct fixture answer");
                                evidence = { observationId: null, toolStatus: "not_applicable", outputPreview: "direct fixture answer", fixtureAgent: true };
                            } else {
                            let toolStatus = "success";
                            let toolOutput = "";
                            try {
                                toolOutput = await tool.invoke(testCase.input, { mcpRetries: 1 });
                            } catch (error) {
                                toolStatus = lastObservation(recorder, before, (item) => item.operation === "call_tool")?.status || "transport_error";
                            }
                            const toolObservation = lastObservation(recorder, before, (item) => item.operation === "call_tool");
                            if (testCase.id === "mcp.agent.fixture-answer-fails") {
                                checkResult(checks, toolStatus === "success", "TOOL_LAYER_PASS", "工具调用层成功", toolStatus);
                                checkResult(checks, String(toolOutput).includes("未找到"), "ANSWER_LAYER_FAIL", "最终答案未满足期望（故意 BadCase）", toolOutput);
                            } else if (testCase.id === "mcp.agent.fixture-call-fails-answer-misuse") {
                                checkResult(checks, toolStatus === "protocol_error", "TOOL_LAYER_FAILURE_RECORDED", "工具协议失败被保留", toolStatus);
                                checkResult(checks, false, "ANSWER_MUST_NOT_MASK_TOOL_FAILURE", "工具失败不能被流畅答案掩盖", toolStatus);
                            } else {
                                checkResult(checks, toolStatus === "success", "TOOL_LAYER_PASS", "工具调用层成功", toolStatus);
                                checkResult(checks, String(toolOutput).includes("fixture"), "ANSWER_LAYER_PASS", "最终答案包含工具结果", toolOutput);
                            }
                            evidence = { observationId: toolObservation?.operation_id || null, toolStatus, outputPreview: String(toolOutput).slice(0, 80), fixtureAgent: true };
                            }
                        } else {
                            const toolName = testCase.toolName.includes("/") ? testCase.toolName : `fixture/${testCase.toolName}`;
                            const tool = registry.getTool(toolName, scope);
                            checkResult(checks, Boolean(tool), "TOOL_AVAILABLE", "预期工具可用", toolName);
                            if (testCase.id === "mcp.call.namespace-no-duplicate") {
                                const alias = registry.getTool("echo", scope);
                                checkResult(checks, Boolean(alias) && alias.name === "echo", "BARE_ALIAS_COMPAT", "裸名仅作为兼容别名", alias?.name);
                            }
                            let output = null;
                            try {
                                output = await invokeWithAbort(tool, testCase.input, testCase.id.endsWith("cancelled") ? "cancel" : testCase.id.endsWith("timeout") ? "timeout" : "normal");
                            } catch { /* observation is the source of truth */ }
                            const observation = lastObservation(recorder, before, (item) => item.operation === "call_tool" && item.tool_name === testCase.toolName);
                            const actualStatus = observation?.status || "transport_error";
                            // The baseline is an explicitly labelled simulation of
                            // the old wrapper contract: an isError response was
                            // reported as a successful string. It is not a real
                            // production run and is never described as one.
                            const reportedStatus = variant === "baseline" && testCase.id === "mcp.call.protocol-is-error"
                                ? "success"
                                : actualStatus;
                            checkResult(checks, reportedStatus === testCase.expectedStatus, "CALL_STATUS", "调用状态符合预期", reportedStatus);
                            if (testCase.id === "mcp.call.retry-once") checkResult(checks, observation?.attempt_count === 2, "ATTEMPT_COUNT", "实际尝试次数为 2", observation?.attempt_count);
                            if (testCase.id === "mcp.call.cancelled") checkResult(checks, observation?.attempt_count === 1, "CANCEL_NO_RETRY", "取消不触发额外重试", observation?.attempt_count);
                            if (testCase.id === "mcp.call.namespace-no-duplicate") checkResult(checks, recorder.snapshot().slice(before).filter((item) => item.operation === "call_tool").length === 1, "ONE_OPERATION", "裸名/命名空间不重复计数", recorder.snapshot().slice(before));
                            evidence = { observationId: observation?.operation_id || null, actualStatus, reportedStatus, outputPreview: output == null ? null : String(output).slice(0, 120) };
                        }
                        status = testCase.id === "mcp.protocol.unavailable"
                            ? (checks.some((check) => check.evidence === "unavailable") ? "pass" : "fail")
                            : checksPassed(checks) ? "pass" : "fail";
                    } catch (error) {
                        const operation = lastObservation(recorder, before);
                        checkResult(checks, operation?.status === testCase.expectedStatus, "EXPECTED_FAILURE_STATUS", "失败也必须有可判定状态", operation?.status || error?.code);
                        status = checksPassed(checks) ? "pass" : "fail";
                        evidence = { operationId: operation?.operation_id || null, errorCode: error?.code || "MCP_EVAL_CASE_FAILED" };
                    }
                }
                if (status === "fail") failureClass = classifyMcpFailure({ status: evidence.actualStatus || lastObservation(recorder, before)?.status, answerCorrect: !checks.some((check) => check.code === "ANSWER_LAYER_FAIL") });
                const observations = recorder.snapshot().slice(before);
                const evidenceOperationId = evidence.operationId || evidence.observationId || null;
                const observationIds = [...new Set([
                    ...observations.map((item) => item.operation_id),
                    ...(evidenceOperationId ? [evidenceOperationId] : []),
                ])];
                const result = {
                    run_id: id,
                    case_id: testCase.id,
                    layer: testCase.layer,
                    status,
                    checks,
                    failureClass,
                    observationIds,
                    traceIds: observations.map((item) => item.trace_id).filter(Boolean),
                    durationMs: Date.now() - started,
                    evidence,
                    sample: { requiresModel: Boolean(testCase.requiresModel), variant },
                };
                results.push(result);
                if (this.persist) saveMcpEvalCaseResult({
                    run_id: id,
                    case_id: testCase.id,
                    layer: testCase.layer,
                    status,
                    checks,
                    failure_class: failureClass,
                    observation_ids: result.observationIds,
                    trace_ids: result.traceIds,
                    duration_ms: result.durationMs,
                    sample: result.sample,
                    evidence_summary: JSON.stringify(evidence).slice(0, 500),
                }, scope);
            }
            const summary = summarizeMcpResults(results);
            completeMcpEvalRun(id, { status: "completed", summary }, scope);
            return { ok: true, runId: id, datasetVersion: MCP_FIXTURE_DATASET_VERSION, variant, cases: results, summary };
        } catch (error) {
            completeMcpEvalRun(id, { status: "failed", summary: { errorCode: error?.code || "MCP_EVAL_FAILED" } }, scope);
            throw error;
        }
    }
}

export const mcpEvalRunner = new McpEvalRunner();
