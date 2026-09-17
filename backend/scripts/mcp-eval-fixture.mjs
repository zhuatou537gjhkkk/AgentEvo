import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const keep = process.env.MCP_KEEP_FIXTURE_DB === "true";
const compact = process.env.MCP_FIXTURE_COMPACT === "true";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentevo-mcp-fixture-"));
const dbPath = process.env.MCP_FIXTURE_DB || path.join(root, "agent_data.db");
process.env.DB_PATH = dbPath;
process.env.MCP_EVAL_ENABLED = "true";
process.env.MCP_TELEMETRY_ENABLED = "true";

const { initDB, createUser, compareMcpEvalRuns } = await import("../src/db/index.js");
const { McpEvalRunner } = await import("../src/eval/mcp/runner.js");

initDB();
const userId = createUser(`mcp_fixture_${Date.now()}`, "fixture-hash");
const scope = { userId, tenantId: `user:${userId}` };
const runner = new McpEvalRunner();
const baseline = await runner.run({ scope, variant: "baseline" });
const candidate = await runner.run({ scope, variant: "candidate", baselineRunId: baseline.runId });
const comparison = compareMcpEvalRuns(baseline.runId, candidate.runId, scope);

const output = {
    dbPath,
    datasetVersion: candidate.datasetVersion,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    baselineSummary: baseline.summary,
    candidateSummary: candidate.summary,
    comparison: compact ? {
        comparable: comparison.comparable,
        reason: comparison.reason || null,
        newlyFailed: comparison.newlyFailed || [],
        cases: comparison.cases?.map((item) => ({
            caseId: item.caseId,
            baseline: { status: item.baseline?.status, observationIds: item.baseline?.observation_ids || [], evidence: item.baseline?.evidence_summary || null },
            candidate: { status: item.candidate?.status, observationIds: item.candidate?.observation_ids || [], evidence: item.candidate?.evidence_summary || null },
        })),
    } : comparison,
    limitations: [
        "所有结果来自本地确定性 fake MCP Client/Server，不代表真实第三方 Server 质量。",
        "requiresModel=true 的 Case 标记 not_run，不计入端到端通过率。",
        "baseline 是旧错误字符串/协议误判语义的模拟比较，不是生产流量 A/B。",
    ],
};

if (compact) {
    output.baselineSummary = baseline.summary;
    output.candidateSummary = candidate.summary;
    delete output.comparison.cases;
    output.evidence = [
        "mcp.call.protocol-is-error",
        "mcp.call.transport-failure",
        "mcp.call.retry-once",
        "mcp.agent.fixture-call-fails-answer-misuse",
        "mcp.agent.real-model-answer",
    ].map((caseId) => {
        const find = (run) => run.cases.find((item) => item.case_id === caseId);
        return { caseId, baseline: find(baseline), candidate: find(candidate) };
    });
}

console.log(JSON.stringify(output, null, 2));

if (!keep && !process.env.MCP_FIXTURE_DB) {
    for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* best effort */ }
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}
