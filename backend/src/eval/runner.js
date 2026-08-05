/**
 * EvalRunner — 自动化评估流水线
 *
 * Phase 5 核心：对齐 AgentArts 离线评估 + Hello-Agents Ch12 BFCL/GAIA。
 *
 * 流程：测试用例 → Agent 执行 → 捕获输出 → LLMJudge → 存储分数
 *
 * 用法：
 *   const runner = new EvalRunner({ model: "deepseek-v4-flash" });
 *   const report = await runner.run(["tc_knowledge_001", "tc_search_001"]);
 */

import crypto from "crypto";
import { testCases, getTestCaseById, getTestCasesByCategory } from "./testCases.js";
import { LLMJudge } from "./judge.js";
import { saveEvalRunScores, getRunSummary } from "./metrics.js";
import { saveMessage, saveMessageMetric, createSession } from "../db/index.js";
import { estimateTokens } from "../services/chatUtils.js";

// Resolve which chat implementation to use based on feature flag
// App-level logic in app.js also sets this, so we mimic the same logic
const _useLangGraph = process.env.USE_LANGGRAPH === "true";

class EvalRunner {
    constructor(options = {}) {
        this.model = options.model || process.env.OPENAI_MODEL || "deepseek-v4-flash";
        this.judge = options.judge || new LLMJudge({ model: this.model });
    }

    /**
     * 运行评估（批量）
     * @param {string[]} testCaseIds — 要运行的测试用例 ID 列表（空=全部）
     * @param {string} runId — 批次 ID（自动生成）
     * @param {object} options
     * @param {boolean} options.reflect — 是否启用 Reflection 自改进（默认 false）
     * @param {function} options.onProgress — 进度回调 (completed, total, lastResult)
     * @returns {Promise<EvalReport>}
     */
    async run(testCaseIds = [], runId = null, options = {}) {
        const { reflect = false, onProgress = null } = options;

        const effectiveRunId = runId || this._generateRunId();
        const selected = testCaseIds.length > 0
            ? testCaseIds.map(id => getTestCaseById(id)).filter(Boolean)
            : testCases;
        const targetTestCases = testCaseIds.length === 0 && selected.length === 0
            ? [] // All tests filtered out
            : (selected.length > 0 ? selected : testCases);

        if (targetTestCases.length === 0) {
            return {
                runId: effectiveRunId,
                total: 0,
                passed: 0,
                failed: 0,
                skipped: 0,
                avgScores: {},
                results: [],
            };
        }

        const results = [];
        const startTime = Date.now();

        // 为评估创建专用 session（避免 saveMessage 报 session not found）
        const evalSessionId = createSession(1, `eval-${effectiveRunId}`);

        for (let i = 0; i < targetTestCases.length; i++) {
            const testCase = targetTestCases[i];
            try {
                const result = await this._runSingle(testCase, effectiveRunId, { reflect, evalSessionId });
                results.push(result);
            } catch (err) {
                console.error(`[EvalRunner] test case ${testCase.id} failed:`, err.message);
                results.push({
                    testCaseId: testCase.id,
                    category: testCase.category,
                    passed: false,
                    scores: { correctness: 0, tool_usage: 0, conciseness: 0, safety: 0 },
                    error: err.message,
                    latencyMs: 0,
                    toolCalls: [],
                });
            }

            if (onProgress) {
                onProgress(i + 1, targetTestCases.length, results[results.length - 1]);
            }
        }

        const totalMs = Date.now() - startTime;
        const passed = results.filter(r => r.passed).length;
        const failed = results.filter(r => !r.passed && !r.skipped).length;
        const skipped = results.filter(r => r.skipped).length;

        const avgScores = this._computeAvgScores(results);

        const report = {
            runId: effectiveRunId,
            total: targetTestCases.length,
            passed,
            failed,
            skipped,
            avgScores,
            totalMs,
            model: this.model,
            results,
        };

        return report;
    }

    /**
     * 运行单个测试用例
     * @param {object} testCase
     * @param {string} runId
     * @param {object} options
     * @returns {Promise<EvalResult>}
     */
    async _runSingle(testCase, runId, options = {}) {
        const { chatWithStream } = await import("../services/chat.js");
        const { chatWithGraph } = await import("../services/chatGraph.js");

        // 选择 chat 实现
        const chatImpl = _useLangGraph ? chatWithGraph : chatWithStream;

        // 构建 fake response 来捕获 SSE 输出
        const captured = new CapturedResponse();

        const userId = 1; // 评估使用默认用户
        const sessionId = options.evalSessionId || null; // 评估使用专用 session

        const startedAt = Date.now();

        // 调用 chat 实现
        await chatImpl(
            userId,
            sessionId,
            testCase.input,
            null, // no image
            testCase.systemPrompt || "",
            0.7,  // default temperature
            captured,
            {
                enableWebSearch: testCase.enableWebSearch || false,
                planMode: false,
                skipUserMessageSave: true,
            }
        );

        const latencyMs = Date.now() - startedAt;

        // 提取捕获的输出
        const capturedText = captured.getText();
        const capturedToolCalls = captured.getToolCalls();
        const toolCallNames = capturedToolCalls.map(tc => tc.toolName);

        // LLMJudge 评分
        const scores = await this.judge.evaluate(testCase, {
            text: capturedText,
            toolCallNames,
            trace: null,
        });

        // 判定是否通过
        const passed = LLMJudge.isPassing(scores, 3.0);

        // 存储分数到数据库
        try {
            saveEvalRunScores({
                scores,
                runId,
                testCaseId: testCase.id,
                judgeModel: this.model,
                scoreType: "offline",
            });
        } catch (err) {
            console.warn(`[EvalRunner] failed to save scores for ${testCase.id}:`, err.message);
        }

        return {
            testCaseId: testCase.id,
            category: testCase.category,
            difficulty: testCase.difficulty,
            passed,
            scores,
            latencyMs,
            toolCalls: toolCallNames,
            expectedTools: testCase.expectedTools || [],
            textPreview: capturedText.slice(0, 200),
            error: null,
        };
    }

    _generateRunId() {
        const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const rand = Math.random().toString(36).slice(2, 6);
        return `eval-${date}-${rand}`;
    }

    _computeAvgScores(results) {
        const valid = results.filter(r => r.scores && !r.skipped);
        if (valid.length === 0) return { correctness: 0, tool_usage: 0, conciseness: 0, safety: 0 };

        const avg = { correctness: 0, tool_usage: 0, conciseness: 0, safety: 0 };
        for (const r of valid) {
            if (r.scores) {
                avg.correctness += r.scores.correctness || 0;
                avg.tool_usage += r.scores.tool_usage || 0;
                avg.conciseness += r.scores.conciseness || 0;
                avg.safety += r.scores.safety || 0;
            }
        }
        const n = valid.length;
        for (const key of Object.keys(avg)) {
            avg[key] = Math.round(avg[key] / n * 100) / 100;
        }
        return avg;
    }
}

/**
 * CapturedResponse — 模拟 SSE response 对象，
 * 截获 chatWithStream/chatWithGraph 的 write() 调用，
 * 提取 text + tool 事件。
 */
class CapturedResponse {
    constructor() {
        this._chunks = [];
        this._toolStarts = [];
        this._toolEnds = [];
        this._toolErrors = [];
        this._finished = false;
        this._closeHandler = null;
    }

    write(data) {
        // 解析 SSE 格式: "data: {...}\n\n"
        const lines = String(data).split("\n");
        for (const line of lines) {
            if (line.startsWith("data: ")) {
                try {
                    const parsed = JSON.parse(line.slice(6));
                    if (parsed.type === "text" || parsed.text) {
                        this._chunks.push(parsed.text || parsed.type === "text" ? parsed.text : "");
                    }
                    if (parsed.type === "tool_start") {
                        this._toolStarts.push({
                            toolCallId: parsed.toolCallId,
                            toolName: parsed.toolName,
                            input: parsed.input,
                        });
                    }
                    if (parsed.type === "tool_end") {
                        this._toolEnds.push({
                            toolCallId: parsed.toolCallId,
                            toolName: parsed.toolName,
                            output: parsed.output,
                        });
                    }
                    if (parsed.type === "tool_error") {
                        this._toolErrors.push({
                            toolCallId: parsed.toolCallId,
                            toolName: parsed.toolName,
                            error: parsed.error,
                        });
                    }
                } catch {
                    // skip non-JSON lines (like "[DONE]")
                }
            }
        }
    }

    end() {
        this._finished = true;
    }

    on(event, handler) {
        if (event === "close") {
            this._closeHandler = handler;
        }
    }

    off(event, handler) {
        if (event === "close" && this._closeHandler === handler) {
            this._closeHandler = null;
        }
    }

    getText() {
        return this._chunks.join("");
    }

    getToolCalls() {
        // Merge tool_start + tool_end by toolCallId
        const result = [];
        const endMap = new Map();
        for (const te of this._toolEnds) {
            endMap.set(te.toolCallId, te);
        }
        const errorMap = new Map();
        for (const te of this._toolErrors) {
            errorMap.set(te.toolCallId, te);
        }

        for (const ts of this._toolStarts) {
            const end = endMap.get(ts.toolCallId);
            const err = errorMap.get(ts.toolCallId);
            result.push({
                toolCallId: ts.toolCallId,
                toolName: ts.toolName,
                input: ts.input,
                output: end?.output || null,
                error: err?.error || null,
            });
        }
        return result;
    }
}

export { EvalRunner, CapturedResponse };

/**
 * @typedef {object} EvalReport
 * @property {string} runId
 * @property {number} total
 * @property {number} passed
 * @property {number} failed
 * @property {number} skipped
 * @property {object} avgScores
 * @property {number} [totalMs]
 * @property {string} [model]
 * @property {EvalResult[]} results
 */

/**
 * @typedef {object} EvalResult
 * @property {string} testCaseId
 * @property {string} category
 * @property {string} [difficulty]
 * @property {boolean} passed
 * @property {object} scores
 * @property {number} latencyMs
 * @property {string[]} toolCalls
 * @property {string[]} expectedTools
 * @property {string} textPreview
 * @property {string|null} error
 */
