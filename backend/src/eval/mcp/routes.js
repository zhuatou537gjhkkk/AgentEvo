import express from "express";
import { dbFn, sendError, svcFn } from "../../routes/deps.js";
import { mcpEvalEnabled } from "../../mcp/flags.js";
import { getMcpFixtureCases, MCP_FIXTURE_DATASET_VERSION } from "./cases.js";

export function createMcpEvalRouter() {
    const router = express.Router();

    router.get("/cases", (req, res) => {
        if (!mcpEvalEnabled()) return res.json({ ok: true, enabled: false, datasetVersion: MCP_FIXTURE_DATASET_VERSION, cases: [] });
        return res.json({
            ok: true,
            enabled: true,
            datasetVersion: MCP_FIXTURE_DATASET_VERSION,
            cases: getMcpFixtureCases().map(({ input, ...item }) => ({ ...item, input: input || null })),
        });
    });

    router.post("/runs", async (req, res) => {
        try {
            if (!mcpEvalEnabled()) return sendError(res, req.requestId, Object.assign(new Error("MCP evaluation is disabled"), { code: "MCP_EVAL_DISABLED", statusCode: 503 }), { code: "MCP_EVAL_DISABLED", status: 503 });
            const body = req.body || {};
            const caseIds = body.caseIds == null ? null : body.caseIds;
            if (caseIds !== null && (!Array.isArray(caseIds) || caseIds.length > 50)) {
                return sendError(res, req.requestId, Object.assign(new Error("caseIds must be an array with at most 50 items"), { code: "INVALID_ARGUMENT", statusCode: 400 }), { code: "INVALID_ARGUMENT", status: 400 });
            }
            const known = new Set(getMcpFixtureCases().map((item) => item.id));
            if (caseIds && caseIds.some((id) => !known.has(String(id)))) {
                return sendError(res, req.requestId, Object.assign(new Error("unknown MCP fixture case"), { code: "MCP_CASE_NOT_ALLOWED", statusCode: 400 }), { code: "MCP_CASE_NOT_ALLOWED", status: 400 });
            }
            const variant = body.variant === "baseline" ? "baseline" : "candidate";
            const scope = { userId: req.user.id, tenantId: req.user.tenantId };
            const report = await svcFn(req, "mcpEvalRunner").run({
                scope,
                caseIds,
                variant,
                baselineRunId: body.baselineRunId || null,
                configId: body.configId || null,
            });
            return res.json(report);
        } catch (error) {
            console.error("[eval/mcp/runs] POST failed:", error.message);
            return sendError(res, req.requestId, error, { code: error?.code || "MCP_EVAL_FAILED", status: Number(error?.statusCode) || 500 });
        }
    });

    router.get("/runs", (req, res) => {
        try {
            if (!mcpEvalEnabled()) return res.json({ ok: true, enabled: false, runs: [] });
            const runs = dbFn(req, "listMcpEvalRuns")({ userId: req.user.id, tenantId: req.user.tenantId }, req.query?.limit);
            return res.json({ ok: true, enabled: true, runs });
        } catch (error) {
            return sendError(res, req.requestId, error, { code: "MCP_EVAL_READ_FAILED", status: 500 });
        }
    });

    router.get("/runs/:id", (req, res) => {
        try {
            if (!mcpEvalEnabled()) return res.json({ ok: true, enabled: false, run: null });
            const run = dbFn(req, "getMcpEvalRun")(req.params.id, { userId: req.user.id, tenantId: req.user.tenantId });
            if (!run) return sendError(res, req.requestId, Object.assign(new Error("MCP evaluation run not found"), { code: "NOT_FOUND", statusCode: 404 }), { code: "NOT_FOUND", status: 404 });
            return res.json({ ok: true, enabled: true, run });
        } catch (error) {
            return sendError(res, req.requestId, error, { code: "MCP_EVAL_READ_FAILED", status: 500 });
        }
    });

    router.get("/compare", (req, res) => {
        try {
            if (!mcpEvalEnabled()) return res.json({ ok: true, enabled: false, comparable: false, reason: "MCP_EVAL_DISABLED" });
            const baseline = String(req.query?.baseline || "").trim();
            const candidate = String(req.query?.candidate || "").trim();
            if (!baseline || !candidate) return sendError(res, req.requestId, Object.assign(new Error("baseline and candidate are required"), { code: "INVALID_ARGUMENT", statusCode: 400 }), { code: "INVALID_ARGUMENT", status: 400 });
            const result = dbFn(req, "compareMcpEvalRuns")(baseline, candidate, { userId: req.user.id, tenantId: req.user.tenantId });
            return res.json({ ok: true, enabled: true, ...result });
        } catch (error) {
            return sendError(res, req.requestId, error, { code: "MCP_EVAL_COMPARE_FAILED", status: 500 });
        }
    });

    return router;
}

export const mcpEvalRouter = createMcpEvalRouter();
