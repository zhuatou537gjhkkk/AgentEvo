/**
 * Phase 7 / R4 (roadmap #9) — owner-scoped /rag HTTP surface over the durable
 * project-code RAG stack (index / query / rebuild) plus a telemetry endpoint.
 *
 * Everything is DEFAULT OFF (rag/flags.js): the /project/* tree answers 403
 * RAG_FEATURE_DISABLED unless PROJECT_RAG_ENABLED; /rag/telemetry requires
 * durable OR project RAG (RAG_DURABLE_ENABLED || PROJECT_RAG_ENABLED) so the
 * doc-store dual-write log can be observed before the code index is enabled.
 *
 * Implementations are resolved per request: an injected dependency-bag service
 * first (createApp dependencies.services.ragIndexer / ragRetrieval /
 * ragRebuilder / ragEmbedder), then a lazy `import()` of the sibling module
 * (../rag/indexer.js / ../rag/retrieval.js). The lazy default keeps this file
 * import-safe even while those modules are under construction — no static
 * import here, and nothing is touched while the flags are dark.
 *
 * Error-code contract (roadmap R4 DoD): 403 RAG_FEATURE_DISABLED (gate),
 * 413 RAG_PAYLOAD_TOO_LARGE, 422 RAG_INDEX_FAILED / RAG_REBUILD_FAILED,
 * 502 RAG_QUERY_FAILED (infrastructure), and a healthy no-match query returns
 * 200 with status "no_match" + empty items (never an error).
 */
import express from "express";
import { sendError, svcFn } from "./deps.js";
import { scopeFromRequest } from "../security/resourceScope.js";
import { durableRagEnabled, projectRagEnabled } from "../rag/flags.js";
import { getKnowledgeQuerySummary, getRecentKnowledgeQueries } from "../rag/telemetry.js";

const MAX_INDEX_FILES = 200;
const MAX_INDEX_CHARS = 2_000_000;

function disabledResponse(req, res) {
    return res.status(403).json({
        ok: false,
        error: "RAG_FEATURE_DISABLED",
        errorCode: "RAG_FEATURE_DISABLED",
        message: "RAG feature is disabled",
        retryable: false,
        requestId: req.requestId || null,
    });
}

function projectGate(req, res, next) {
    if (!projectRagEnabled()) return disabledResponse(req, res);
    return next();
}

function telemetryGate(req, res, next) {
    if (!(durableRagEnabled() || projectRagEnabled())) return disabledResponse(req, res);
    return next();
}

/** Bag lookup that returns null instead of throwing when the dep is absent. */
function bagService(req, name) {
    try {
        return svcFn(req, name);
    } catch {
        return null;
    }
}

function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function badRequest(res, requestId, message) {
    return res.status(400).json({
        ok: false,
        error: "RAG_BAD_REQUEST",
        errorCode: "RAG_BAD_REQUEST",
        message,
        retryable: false,
        requestId: requestId || null,
    });
}

// ────────────────────────── default lazy implementations ──────────────────────────

/**
 * Default indexer: indexProjectSnapshot from ../rag/indexer.js (built by the R4
 * indexer stack). Only ever imported when PROJECT_RAG_ENABLED AND no bag service
 * was injected. `embedder` is optional (lexical-only index when absent).
 */
async function defaultIndexer(req) {
    const injected = bagService(req, "ragIndexer");
    if (injected) {
        const fn = typeof injected === "function" ? injected : injected?.index;
        if (typeof fn === "function") return { index: fn, embedder: bagService(req, "ragEmbedder") || null };
    }
    const mod = await import("../rag/indexer.js");
    const fn = typeof mod?.indexProjectSnapshot === "function" ? mod.indexProjectSnapshot : null;
    if (!fn) throw new Error("project indexer unavailable");
    return { index: (args) => fn(args), embedder: bagService(req, "ragEmbedder") || null };
}

/** Default retriever: retrieveProjectCode from ../rag/retrieval.js (shared service). */
async function defaultRetriever(req) {
    const injected = bagService(req, "ragRetrieval");
    if (injected) {
        const fn = typeof injected === "function" ? injected : injected?.retrieveProjectCode;
        if (typeof fn === "function") return fn;
    }
    const mod = await import("../rag/retrieval.js");
    const fn = typeof mod?.retrieveProjectCode === "function" ? mod.retrieveProjectCode : null;
    if (!fn) throw new Error("project retrieval unavailable");
    return fn;
}

/** Default rebuilder: per-project re-embed (../rag/indexer.js) — may be absent pre-stack. */
async function defaultRebuilder(req) {
    const injected = bagService(req, "ragRebuilder");
    if (injected) {
        const fn = typeof injected === "function" ? injected : injected?.rebuild;
        if (typeof fn === "function") return fn;
    }
    let mod = null;
    try {
        mod = await import("../rag/indexer.js");
    } catch {
        mod = null;
    }
    const fn = mod?.rebuildProjectIndex || mod?.rebuildProjectEmbeddings || mod?.rebuildProject || null;
    if (typeof fn !== "function") throw new Error("project rebuild unavailable");
    return fn;
}

function normalizeIndexFiles(files) {
    const out = [];
    let totalChars = 0;
    for (const raw of files) {
        if (raw == null || typeof raw !== "object") continue;
        const text = String(raw.text ?? raw.content ?? "");
        const filePath = String(raw.path ?? raw.filePath ?? raw.file ?? "");
        out.push({ path: filePath, text });
        totalChars += filePath.length + text.length;
    }
    return { files: out, totalChars };
}

export function registerRagRoutes(router, { requireAuth }) {
    const rag = express.Router();
    rag.use(requireAuth);

    // Owner-scoped hit / no-match / latency telemetry over the durable log.
    rag.get("/telemetry", telemetryGate, (req, res) => {
        try {
            const scope = scopeFromRequest(req);
            const windowMinutes = positiveInt(req.query.window_minutes ?? req.query.windowMinutes, 0);
            const summary = getKnowledgeQuerySummary(scope, { windowMinutes });
            const recent = getRecentKnowledgeQueries(scope, {
                limit: positiveInt(req.query.limit, 20),
            });
            return res.json({ ok: true, telemetry: { summary, recent } });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    // Index a project-code snapshot ({ files: [{ path, text }] }) into the
    // owner-scoped durable project index.
    rag.post("/project/:projectId/index", projectGate, async (req, res) => {
        const projectId = String(req.params.projectId || "");
        const rawFiles = Array.isArray(req.body?.files) ? req.body.files : null;
        if (!rawFiles) return badRequest(res, req.requestId, "files must be an array of {path, text}");
        if (rawFiles.length > MAX_INDEX_FILES) {
            return res.status(413).json({
                ok: false,
                error: "RAG_PAYLOAD_TOO_LARGE",
                errorCode: "RAG_PAYLOAD_TOO_LARGE",
                message: `too many files: ${rawFiles.length} exceeds the ${MAX_INDEX_FILES} file limit`,
                retryable: false,
                requestId: req.requestId || null,
            });
        }
        const { files, totalChars } = normalizeIndexFiles(rawFiles);
        if (totalChars > MAX_INDEX_CHARS) {
            return res.status(413).json({
                ok: false,
                error: "RAG_PAYLOAD_TOO_LARGE",
                errorCode: "RAG_PAYLOAD_TOO_LARGE",
                message: `payload too large: ${totalChars} characters exceeds the ${MAX_INDEX_CHARS} char limit`,
                retryable: false,
                requestId: req.requestId || null,
            });
        }
        try {
            const scope = scopeFromRequest(req);
            const impl = await defaultIndexer(req);
            const summary = await impl.index({
                scope,
                projectId,
                files,
                sourceRunId: req.body?.source_run_id ?? req.body?.sourceRunId ?? null,
                sourceCommit: req.body?.commit ?? null,
                ...(impl.embedder ? { embedder: impl.embedder } : {}),
            });
            const safe = summary && typeof summary === "object" ? summary : {};
            return res.json({
                ok: true,
                projectId,
                files: files.length,
                documents: Number(safe.documents ?? safe.documentCount ?? safe.files ?? files.length) || 0,
                chunks: Number(safe.chunks ?? safe.chunkCount ?? 0) || 0,
                ...safe,
            });
        } catch (error) {
            return sendError(res, req.requestId, error, { code: "RAG_INDEX_FAILED", status: 422 });
        }
    });

    // Shared project-code query. A healthy no-match is 200 status:"no_match"
    // with empty items; only a backend failure is 502 RAG_QUERY_FAILED.
    rag.post("/project/:projectId/query", projectGate, async (req, res) => {
        const projectId = String(req.params.projectId || "");
        const query = String(req.body?.query ?? "");
        try {
            const scope = scopeFromRequest(req);
            const retriever = await defaultRetriever(req);
            const outcome = (await retriever({
                scope,
                projectId,
                query,
                mode: req.body?.mode ?? "knowledge",
                deps: {},
            })) || {};
            if (outcome.status === "no_match") {
                return res.json({
                    ok: true,
                    status: "no_match",
                    items: [],
                    text: "",
                    mode: outcome.mode || null,
                    metrics: outcome.metrics || null,
                });
            }
            if (outcome.status === "ok") {
                return res.json({
                    ok: true,
                    status: "ok",
                    items: Array.isArray(outcome.items) ? outcome.items : [],
                    text: String(outcome.text ?? ""),
                    mode: outcome.mode || null,
                    metrics: outcome.metrics || null,
                });
            }
            // status "error" or any unexpected shape → infrastructure failure.
            throw new Error("project retrieval failed");
        } catch (error) {
            // Deterministic envelope: a resilient 502 classifier would rewrite the
            // code, so this route pins its own RAG_QUERY_FAILED errorCode contract.
            console.log(`[rag][query] project retrieval failed: ${error?.message}`);
            return res.status(502).json({
                ok: false,
                error: "RAG_QUERY_FAILED",
                errorCode: "RAG_QUERY_FAILED",
                message: "project retrieval unavailable",
                retryable: true,
                requestId: req.requestId || null,
            });
        }
    });

    // Re-embed a project's persisted chunks (recovery / offline-embed rebuild).
    rag.post("/project/:projectId/rebuild", projectGate, async (req, res) => {
        const projectId = String(req.params.projectId || "");
        try {
            const scope = scopeFromRequest(req);
            const rebuilder = await defaultRebuilder(req);
            const result = (await rebuilder({
                scope,
                projectId,
                ...(bagService(req, "ragEmbedder") ? { embedder: bagService(req, "ragEmbedder") } : {}),
            })) || {};
            const safe = result && typeof result === "object" ? result : {};
            return res.json({
                ok: true,
                projectId,
                total: Number(safe.total ?? 0) || 0,
                embedded: Number(safe.embedded ?? 0) || 0,
                ...safe,
            });
        } catch (error) {
            return sendError(res, req.requestId, error, { code: "RAG_REBUILD_FAILED", status: 422 });
        }
    });

    router.use("/rag", rag);
}
