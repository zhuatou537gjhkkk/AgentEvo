/**
 * Coding registrar — owner-scoped projects/trust + run snapshot/events/cancel +
 * approvals/actions. This is a *control plane* over durable records and the
 * instance-local runtime registry; the Agent turn itself still enters the main
 * Graph through `/chat`. All capabilities default OFF (coding/flags.js): with the
 * workspace flag dark the whole tree (except `/coding/capabilities`) answers 403
 * CODING_FEATURE_DISABLED. Nothing here opens file writes or command execution.
 */
import express from "express";
import { sendError, svcFn } from "./deps.js";
import { notFoundResource } from "../security/resourceScope.js";
import { codingCapabilities, codingEventLogEnabled, codingWorkspaceEnabled } from "../coding/flags.js";
import { scopeFromRequest } from "../security/resourceScope.js";

function workspaceGate(req, res, next) {
    if (!codingWorkspaceEnabled()) {
        return res.status(403).json({
            ok: false,
            error: "CODING_FEATURE_DISABLED",
            errorCode: "CODING_FEATURE_DISABLED",
            message: "coding workspace is disabled",
            retryable: false,
            requestId: req.requestId || null,
        });
    }
    return next();
}

function eventLogGate(req, res, next) {
    if (!codingEventLogEnabled()) {
        return res.status(403).json({
            ok: false,
            error: "CODING_EVENT_LOG_DISABLED",
            errorCode: "CODING_EVENT_LOG_DISABLED",
            message: "coding event log is disabled",
            retryable: false,
            requestId: req.requestId || null,
        });
    }
    return next();
}

function services(req) {
    return {
        projects: svcFn(req, "codingProjectService"),
        runs: svcFn(req, "codingRunService"),
        events: svcFn(req, "codingEventStore"),
        approvals: svcFn(req, "approvalService"),
        registry: svcFn(req, "codingRuntimeRegistry"),
        workspace: svcFn(req, "workspaceRunner"),
    };
}

function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function registerCodingRoutes(router, { requireAuth }) {
    const coding = express.Router();

    // Capability view is available to any authenticated owner so clients can
    // detect whether (and which) coding capabilities are enabled.
    coding.get("/capabilities", requireAuth, (req, res) => {
        res.json({ ok: true, capabilities: codingCapabilities() });
    });

    coding.use(requireAuth);
    coding.use(workspaceGate);

    // ── projects / trust ──
    coding.get("/projects", (req, res) => {
        try {
            const items = services(req).projects.list(scopeFromRequest(req), {
                status: req.query.status || null,
                limit: positiveInt(req.query.limit, 100),
            });
            return res.json({ ok: true, projects: items, count: items.length });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    coding.post("/projects", (req, res) => {
        try {
            const project = services(req).projects.register(scopeFromRequest(req), {
                name: req.body?.name,
                rootPath: req.body?.root_path ?? req.body?.rootPath,
                meta: req.body?.meta,
            });
            return res.status(201).json({ ok: true, project });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    coding.get("/projects/:projectId", (req, res) => {
        try {
            const project = services(req).projects.get(scopeFromRequest(req), req.params.projectId);
            if (!project) return notFoundResource(res, "project not found");
            return res.json({ ok: true, project });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    coding.patch("/projects/:projectId", (req, res) => {
        try {
            const project = services(req).projects.update(scopeFromRequest(req), req.params.projectId, {
                name: req.body?.name ?? null,
                status: req.body?.status ?? null,
                trusted: req.body?.trusted == null ? null : Boolean(req.body.trusted),
            });
            if (!project) return notFoundResource(res, "project not found");
            return res.json({ ok: true, project });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    coding.delete("/projects/:projectId", (req, res) => {
        try {
            const project = services(req).projects.revoke(scopeFromRequest(req), req.params.projectId);
            if (!project) return notFoundResource(res, "project not found");
            return res.json({ ok: true, project });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    // ── workspace (R1 read-only runner surface) ──
    // Every op is owner-scoped first (project fetched from the registrar by the
    // authenticated request), then re-validated inside the runner at access time.
    // Only READ_OPS dispatch; write/exec ops arrive in R2 on the same transport.
    coding.post("/projects/:projectId/open", async (req, res) => {
        try {
            const project = services(req).projects.get(scopeFromRequest(req), req.params.projectId);
            if (!project) return notFoundResource(res, "project not found");
            const workspace = await services(req).workspace.open(project);
            return res.json({ ok: true, workspace });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    coding.post("/projects/:projectId/ops", async (req, res) => {
        try {
            const project = services(req).projects.get(scopeFromRequest(req), req.params.projectId);
            if (!project) return notFoundResource(res, "project not found");
            const { op, args } = req.body || {};
            const result = await services(req).workspace.invoke(project, op, args);
            return res.json({ ok: true, op: result.op, data: result.data });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    // ── runs / snapshot ──
    coding.post("/runs", (req, res) => {
        try {
            const run = services(req).runs.createRun(scopeFromRequest(req), {
                projectId: req.body?.project_id ?? req.body?.projectId ?? null,
                sessionId: req.body?.session_id ?? req.body?.sessionId ?? null,
                mode: req.body?.mode ?? "observe",
                requestId: req.requestId || null,
            });
            return res.status(201).json({ ok: true, run });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    coding.get("/runs", (req, res) => {
        try {
            const items = services(req).runs.listRuns(scopeFromRequest(req), {
                projectId: req.query.project_id || null,
                limit: positiveInt(req.query.limit, 50),
            });
            return res.json({ ok: true, runs: items, count: items.length });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    coding.get("/runs/:runId", (req, res) => {
        try {
            const run = services(req).runs.getRun(scopeFromRequest(req), req.params.runId);
            if (!run) return notFoundResource(res, "coding run not found");
            return res.json({ ok: true, run });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    // Single-runtime start: registry lock first (409 on concurrent start), then
    // the atomic DB claim. A cancelled/completed run is terminal and cannot restart.
    coding.post("/runs/:runId/start", (req, res) => {
        const scope = scopeFromRequest(req);
        const runId = req.params.runId;
        const { registry, runs } = services(req);
        let token = null;
        try {
            token = registry.acquireStart(scope, runId);
            if (token === null) {
                return res.status(409).json({
                    ok: false, error: "CONCURRENT_RUNTIME", errorCode: "CONCURRENT_RUNTIME",
                    message: "a runtime is already active for this run", retryable: false,
                    requestId: req.requestId || null,
                });
            }
            let run;
            try {
                run = runs.startRun(scope, runId);
            } catch (error) {
                registry.releaseRun(scope, runId, { token });
                throw error;
            }
            if (!run) {
                registry.releaseRun(scope, runId, { token });
                return notFoundResource(res, "coding run not found");
            }
            return res.json({ ok: true, run, runtime: { active: true } });
        } catch (error) {
            if (token) registry.releaseRun(scope, runId, { token });
            return sendError(res, req.requestId, error);
        }
    });

    // Cancel = persist terminal state (authoritative) then fan out + free runtime.
    coding.post("/runs/:runId/cancel", (req, res) => {
        const scope = scopeFromRequest(req);
        const runId = req.params.runId;
        try {
            const run = services(req).runs.cancelRun(scope, runId);
            const outcome = services(req).registry.cancel(scope, runId, { reason: "cancelled by owner" });
            services(req).registry.releaseRun(scope, runId);
            return res.json({ ok: true, run, runtime: { hadRuntime: outcome.hadRuntime, subscriberCount: outcome.subscriberCount } });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    // ── events (durable, replay-safe by seq) ──
    coding.get("/runs/:runId/events", eventLogGate, (req, res) => {
        try {
            const scope = scopeFromRequest(req);
            const runId = req.params.runId;
            const run = services(req).runs.getRun(scope, runId);
            if (!run) return notFoundResource(res, "coding run not found");
            const afterSeq = req.query.after_seq == null ? 0 : Number(req.query.after_seq);
            if (!Number.isInteger(afterSeq) || afterSeq < 0) {
                return res.status(400).json({ ok: false, error: "INVALID_AFTER_SEQ", errorCode: "INVALID_AFTER_SEQ", message: "after_seq must be a non-negative integer", retryable: false });
            }
            const events = services(req).events.listEvents(scope, runId, {
                afterSeq,
                limit: positiveInt(req.query.limit, 200),
            });
            const lastSeq = services(req).events.getLastSeq(scope, runId);
            return res.json({ ok: true, runId, events, after_seq: afterSeq, count: events.length, last_seq: lastSeq });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    // ── approvals / actions (durable request/decision transcript; no execution in R0) ──
    coding.post("/runs/:runId/approvals", (req, res) => {
        try {
            const result = services(req).approvals.requestApproval(scopeFromRequest(req), req.params.runId, {
                type: req.body?.type ?? req.body?.action?.type,
                tool: req.body?.tool ?? req.body?.action?.tool,
                input: req.body?.input ?? req.body?.action?.input ?? {},
                timeoutMs: req.body?.timeout_ms ?? req.body?.timeoutMs ?? null,
                policy: req.body?.policy ?? {},
                requestedBy: req.user?.id ?? null,
                reason: req.body?.reason ?? null,
                expiresInMs: req.body?.expires_in_ms ?? req.body?.expiresInMs ?? 15 * 60 * 1000,
            });
            return res.status(201).json({ ok: true, ...result });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    coding.get("/runs/:runId/approvals", (req, res) => {
        try {
            const items = services(req).approvals.listApprovals(scopeFromRequest(req), {
                runId: req.params.runId,
                status: req.query.status || null,
                limit: positiveInt(req.query.limit, 200),
            });
            return res.json({ ok: true, approvals: items, count: items.length });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    coding.get("/runs/:runId/actions", (req, res) => {
        try {
            const items = services(req).approvals.listActions(scopeFromRequest(req), req.params.runId, {
                limit: positiveInt(req.query.limit, 200),
            });
            return res.json({ ok: true, actions: items, count: items.length });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    coding.post("/approvals/:approvalId/decision", (req, res) => {
        try {
            const approve = req.body?.approve;
            if (typeof approve !== "boolean") {
                return res.status(400).json({ ok: false, error: "INVALID_DECISION", errorCode: "INVALID_DECISION", message: "approve must be a boolean", retryable: false });
            }
            const result = services(req).approvals.decide(scopeFromRequest(req), req.params.approvalId, {
                approve,
                decidedBy: req.user?.id ?? null,
                reason: req.body?.reason ?? null,
            });
            return res.json({ ok: true, ...result });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    router.use("/coding", coding);
}
