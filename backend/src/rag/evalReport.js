/**
 * Owner-scoped, content-free projection of a K9 RAG evaluation report.
 *
 * K9 reports are generated offline and are not stored in the chat database.
 * The HTTP surface binds user reports to the authenticated request user. A
 * report without an owner is an operator-generated, content-free global
 * report and is automatically projected for the current authenticated user.
 * Raw cases, answers, evidence, prompts, and absolute paths are never returned.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_RAG_EVAL_REPORT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../tmp/rag-eval-report.json");

const SUMMARY_KEYS = Object.freeze([
    "sampleCount", "passed", "failed", "recallAtK", "mrr", "ndcgAtK", "noAnswerPrecision",
    "noAnswerSamples", "citationPageAccuracy", "citationSamples", "faithfulness", "faithfulnessSamples",
    "unsupportedCriticalClaims", "p50LatencyMs", "p95LatencyMs", "llmCalls", "embeddingCalls",
    "callCount", "tokenCount", "avgCompressionRatio", "deterministicSecurityFailures", "citationAllowlistFailures",
]);

function publicNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function safeStatus(value) {
    return ["pass", "fail", "insufficient_sample", "insufficient_data"].includes(String(value)) ? String(value) : "unknown";
}

function sanitizeGate(value) {
    if (typeof value === "string") return safeStatus(value);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
        status: safeStatus(value.status),
        value: publicNumber(value.value),
        target: publicNumber(value.target),
        sampleCount: Number.isInteger(Number(value.sampleCount)) ? Math.max(0, Number(value.sampleCount)) : null,
    };
}

export function sanitizeRagEvalReport(report) {
    if (!report || typeof report !== "object" || !report.datasetVersion) {
        return { available: false, reason: "RAG_EVAL_REPORT_INVALID" };
    }
    const profiles = {};
    for (const [name, value] of Object.entries(report.profiles || {})) {
        const summary = {};
        for (const key of SUMMARY_KEYS) summary[key] = publicNumber(value?.summary?.[key]);
        profiles[String(name).slice(0, 80)] = { profile: String(value?.profile || name).slice(0, 80), summary };
    }
    const gateSource = report.gates?.full || report.gates || {};
    const gates = {};
    for (const [name, value] of Object.entries(gateSource)) gates[String(name).slice(0, 80)] = sanitizeGate(value);
    return {
        available: true,
        binding: report.visibility === "user" || report.ownerUserId != null ? "owner" : "current_user",
        datasetVersion: String(report.datasetVersion).slice(0, 120),
        modelAlias: report.modelAlias ? String(report.modelAlias).slice(0, 120) : null,
        gateStatus: safeStatus(report.gates?.status),
        profiles,
        gates,
    };
}

export function getOwnerScopedRagEvalReport(scope, {
    filePath = process.env.RAG_EVAL_REPORT_PATH || DEFAULT_RAG_EVAL_REPORT_PATH,
} = {}) {
    try {
        const raw = JSON.parse(fs.readFileSync(String(filePath), "utf8"));
        const hasOwner = raw?.visibility === "user" || raw?.ownerUserId != null;
        if (hasOwner && (!Number.isInteger(Number(scope?.userId)) || Number(raw.ownerUserId) !== Number(scope.userId))) {
            return { available: false, reason: "RAG_EVAL_REPORT_NOT_OWNER" };
        }
        return sanitizeRagEvalReport(raw);
    } catch (error) {
        return { available: false, reason: error?.code === "ENOENT" ? "RAG_EVAL_REPORT_NOT_FOUND" : "RAG_EVAL_REPORT_UNAVAILABLE" };
    }
}

export default { sanitizeRagEvalReport, getOwnerScopedRagEvalReport };
