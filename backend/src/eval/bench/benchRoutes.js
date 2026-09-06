/**
 * Phase 7 / R6 — bench registrar (offline coding-benchmark surface).
 *
 * A thin admin + operator-gated HTTP layer over benchService. Everything is default
 * OFF: with BENCH_ENABLED dark the whole tree answers 403 BENCH_FEATURE_DISABLED and
 * nothing executes. Runs are long offline evaluations of FIXED-revision fixture
 * repos against a deterministic scripted model; they share the server's coding
 * substrate and honor the server's own feature flags (a run never grants write/exec
 * capability the operator has not enabled — see harness.js). Export endpoints are
 * additionally owner-consent gated (R6 #5).
 *
 * Mounted at /bench (registerAllRoutes → appRouter.use).
 */
import express from "express";
import { sendError } from "../../routes/deps.js";
import { scopeFromRequest } from "../../security/resourceScope.js";
import { benchEnabled } from "./flags.js";
import * as benchService from "./benchService.js";

const router = express.Router();

function gate(req, res, next) {
    if (!benchEnabled()) {
        return res.status(403).json({
            ok: false,
            error: "BENCH_FEATURE_DISABLED",
            errorCode: "BENCH_FEATURE_DISABLED",
            message: "offline bench is disabled",
            retryable: false,
            requestId: req.requestId || null,
        });
    }
    return next();
}

function scope(req) {
    return scopeFromRequest(req);
}

function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

// ── catalog (listing-safe meta, never files/script/decider) ──────────────────
router.get("/scenarios", (req, res) => {
    try {
        const scenarios = benchService.listScenarios();
        return res.json({ ok: true, scenarios, count: scenarios.length });
    } catch (error) {
        return sendError(res, req.requestId, error);
    }
});

// ── run ledger ────────────────────────────────────────────────────────────────
router.get("/runs", (req, res) => {
    try {
        const runs = benchService.listRuns(scope(req), {
            scenarioId: req.query.scenario_id || req.query.scenarioId || null,
            status: req.query.status || null,
            limit: positiveInt(req.query.limit, 50),
        });
        return res.json({ ok: true, runs, count: runs.length });
    } catch (error) {
        return sendError(res, req.requestId, error);
    }
});

router.get("/runs/:runId", (req, res) => {
    try {
        const run = benchService.getRun(scope(req), req.params.runId);
        if (!run) return res.status(404).json({ ok: false, error: "BENCH_RUN_NOT_FOUND", errorCode: "BENCH_RUN_NOT_FOUND", message: "bench run not found", retryable: false, requestId: req.requestId || null });
        return res.json({ ok: true, run });
    } catch (error) {
        return sendError(res, req.requestId, error);
    }
});

// ── run one scenario (offline, synchronous for the admin) ─────────────────────
router.post("/run", async (req, res) => {
    try {
        const { scenario_id: scenarioId, cleanup = true, reconnect_delay_ms: reconnectDelayMs } = req.body || {};
        const result = await benchService.runScenario(scope(req), scenarioId, {
            cleanup: cleanup !== false,
            reconnectDelayMs: reconnectDelayMs == null ? undefined : positiveInt(reconnectDelayMs, 60),
        });
        // Echo the durable summary row only — never the full raw transcript.
        return res.status(201).json({ ok: true, run: result.run });
    } catch (error) {
        return sendError(res, req.requestId, error);
    }
});

// ── consent + export (R6 #5 — consent gates any export) ───────────────────────
router.patch("/runs/:runId/consent", (req, res) => {
    try {
        const run = benchService.setConsent(scope(req), req.params.runId, req.body?.consent === true);
        return res.json({ ok: true, run });
    } catch (error) {
        return sendError(res, req.requestId, error);
    }
});

router.get("/runs/:runId/trajectory", (req, res) => {
    try {
        const redact = String(req.query.redact || "paths");
        const payload = benchService.exportRunTrajectory(scope(req), req.params.runId, { redact });
        return res.json({ ok: true, ...payload });
    } catch (error) {
        return sendError(res, req.requestId, error);
    }
});

router.get("/runs/:runId/dataset", (req, res) => {
    try {
        const kinds = req.query.kinds
            ? String(req.query.kinds).split(",").map((k) => k.trim()).filter(Boolean)
            : ["sft", "preference", "grpo"];
        const redact = String(req.query.redact || "full");
        const payload = benchService.exportRunDataset(scope(req), req.params.runId, { kinds, redact });
        return res.json({ ok: true, ...payload });
    } catch (error) {
        return sendError(res, req.requestId, error);
    }
});

export function registerBenchRoutes(appRouter, { requireAuth, requireAdmin, createRateLimit }) {
    appRouter.use(
        "/bench",
        requireAuth,
        createRateLimit({ scope: "bench", windowMs: 60_000, max: 30 }),
        requireAdmin,
        gate,
        router,
    );
}

export default registerBenchRoutes;
