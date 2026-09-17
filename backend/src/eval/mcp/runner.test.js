import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareMcpEvalRuns, getMcpEvalRun, initDB } from "../../db/index.js";
import { McpEvalRunner } from "./runner.js";

const scope = { userId: 1, tenantId: "user:1" };
const previous = { eval: process.env.MCP_EVAL_ENABLED, telemetry: process.env.MCP_TELEMETRY_ENABLED };

beforeEach(() => {
    initDB();
    process.env.MCP_EVAL_ENABLED = "true";
    process.env.MCP_TELEMETRY_ENABLED = "true";
});

afterEach(() => {
    if (previous.eval === undefined) delete process.env.MCP_EVAL_ENABLED;
    else process.env.MCP_EVAL_ENABLED = previous.eval;
    if (previous.telemetry === undefined) delete process.env.MCP_TELEMETRY_ENABLED;
    else process.env.MCP_TELEMETRY_ENABLED = previous.telemetry;
});

describe("MCP fixture evaluation", () => {
    it("separates protocol/tool/end-to-end layers and preserves not_run", async () => {
        const report = await new McpEvalRunner().run({ scope, caseIds: [
            "mcp.protocol.connect",
            "mcp.protocol.discovery",
            "mcp.call.protocol-is-error",
            "mcp.call.retry-once",
            "mcp.agent.fixture-answer-fails",
            "mcp.agent.real-model-answer",
        ] });
        expect(report.summary.layers.map((item) => item.layer)).toEqual(["protocol", "tool_call", "end_to_end"]);
        expect(report.cases.find((item) => item.case_id === "mcp.agent.real-model-answer").status).toBe("not_run");
        expect(report.cases.find((item) => item.case_id === "mcp.call.retry-once").evidence).toMatchObject({ actualStatus: "success" });
        expect(report.cases.find((item) => item.case_id === "mcp.call.retry-once").observationIds).toHaveLength(1);
    });

    it("baseline/candidate comparison is comparable and exposes the simulated legacy false success", async () => {
        const runner = new McpEvalRunner();
        const baseline = await runner.run({ scope, variant: "baseline", caseIds: ["mcp.call.protocol-is-error"] });
        const candidate = await runner.run({ scope, variant: "candidate", caseIds: ["mcp.call.protocol-is-error"] });
        expect(baseline.cases[0].status).toBe("fail");
        expect(candidate.cases[0].status).toBe("pass");
        const comparison = compareMcpEvalRuns(baseline.runId, candidate.runId, scope);
        expect(comparison.comparable).toBe(true);
        expect(comparison.perCase[0].baseline.status).toBe("fail");
        expect(comparison.perCase[0].candidate.status).toBe("pass");
        expect(getMcpEvalRun(candidate.runId, scope).cases[0].observation_ids).toHaveLength(1);
    });

    it("covers wrong-type validation and the should-not-call contract", async () => {
        const report = await new McpEvalRunner().run({ scope, caseIds: [
            "mcp.call.schema-wrong-type",
            "mcp.agent.fixture-no-tool-required",
        ] });
        expect(report.cases.find((item) => item.case_id === "mcp.call.schema-wrong-type")).toMatchObject({ status: "pass", evidence: { actualStatus: "validation_error" } });
        expect(report.cases.find((item) => item.case_id === "mcp.agent.fixture-no-tool-required")).toMatchObject({ status: "pass", evidence: { toolStatus: "not_applicable" } });
    });
});
