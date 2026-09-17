/**
 * M8 — shared memory/context contract.
 *
 * This module is deliberately storage-agnostic. User memory and project memory
 * stay in separate tables and services; this contract only gives their
 * serialized records and ContextPackets a common vocabulary.
 */

export const MEMORY_CONTRACT_VERSION = "memory-context-v2";

export const MEMORY_STATUS = Object.freeze({
    PENDING: "pending",
    ACTIVE: "active",
    REJECTED: "rejected",
    SUPERSEDED: "superseded",
    INVALIDATED: "invalidated",
    STALE: "stale",
    DELETED: "deleted",
});

const SOURCE_TYPES = new Set([
    "user_memory",
    "project_memory",
    "repo",
    "rag",
    "knowledge",
    "search",
    "conversation",
    "system",
    "custom",
]);

function firstValue(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "") ?? null;
}

function clamp01(value, fallback = null) {
    if (value === null || value === undefined || value === "") return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

function positiveInt(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanString(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
}

export function normalizeSourceType(value, fallback = "custom") {
    const source = cleanString(value);
    return source && SOURCE_TYPES.has(source) ? source : fallback;
}

/** Map legacy booleans and lifecycle values into the common state vocabulary. */
export function normalizeMemoryStatus({ status = null, invalidated = false, stale = false } = {}) {
    const normalized = cleanString(status)?.toLowerCase();
    if (normalized && Object.values(MEMORY_STATUS).includes(normalized)) return normalized;
    if (Boolean(invalidated)) return MEMORY_STATUS.INVALIDATED;
    if (Boolean(stale)) return MEMORY_STATUS.STALE;
    return MEMORY_STATUS.ACTIVE;
}

export function normalizeScope({ ownerUserId = null, tenantId = null, projectId = null, sessionId = null } = {}) {
    return {
        ownerUserId: positiveInt(ownerUserId),
        tenantId: cleanString(tenantId),
        projectId: cleanString(projectId),
        sessionId: positiveInt(sessionId),
    };
}

/**
 * Normalize both user-memory and repository-style provenance. Legacy aliases
 * are retained in the result so citation/rendering code remains compatible.
 */
export function normalizeProvenance(input = {}, defaults = {}) {
    const source = input && typeof input === "object" ? input : {};
    const base = defaults && typeof defaults === "object" ? defaults : {};
    const files = [...new Set([
        ...(Array.isArray(source.files) ? source.files : []),
        ...([source.file, source.path].filter(Boolean)),
    ].map((value) => cleanString(value)).filter(Boolean))].slice(0, 20);
    const path = cleanString(firstValue(source.path, source.file, files[0]));
    const lineStart = firstValue(source.lineStart, source.startLine);
    const lineEnd = firstValue(source.lineEnd, source.endLine);
    const sourceType = normalizeSourceType(
        firstValue(source.sourceType, base.sourceType),
        "custom",
    );
    const ownerUserId = positiveInt(firstValue(source.ownerUserId, base.ownerUserId));
    const tenantId = cleanString(firstValue(source.tenantId, base.tenantId));
    const projectId = cleanString(firstValue(source.projectId, base.projectId));
    const sessionId = positiveInt(firstValue(source.sessionId, base.sessionId));
    const sourceId = cleanString(firstValue(
        source.sourceId,
        source.memoryId,
        source.chunkId,
        source.documentId,
        source.sourceRunId,
        base.sourceId,
    ));
    const commit = cleanString(firstValue(source.commit, source.commitRef, source.sourceCommit));
    const extractionMethod = cleanString(firstValue(source.extractionMethod, source.extraction_method, base.extractionMethod));
    const createdAt = firstValue(source.createdAt, source.created_at, base.createdAt);
    const invalidatedAt = firstValue(source.invalidatedAt, source.invalidated_at, base.invalidatedAt);
    const invalidationReason = cleanString(firstValue(source.invalidationReason, source.invalidate_reason, base.invalidationReason));
    const runId = cleanString(firstValue(source.runId, base.runId));

    return {
        sourceType,
        sourceId,
        ownerUserId,
        tenantId,
        projectId,
        sessionId,
        path,
        lineStart: lineStart == null ? null : Number(lineStart) || null,
        lineEnd: lineEnd == null ? null : Number(lineEnd) || null,
        commit,
        extractionMethod,
        runId,
        createdAt,
        invalidatedAt,
        invalidationReason,
        invalidation: { at: invalidatedAt, reason: invalidationReason },
        // Compatibility aliases used by existing citation and project-memory UI.
        file: path,
        startLine: lineStart == null ? null : Number(lineStart) || null,
        endLine: lineEnd == null ? null : Number(lineEnd) || null,
        files,
        sourceRunId: cleanString(firstValue(source.sourceRunId, base.sourceRunId)),
        commitRef: commit,
        confidence: clamp01(firstValue(source.confidence, base.confidence)),
    };
}

export function buildUserMemoryProvenance({ memoryId, ownerUserId, sessionId = null, source = null, metadata = {}, ...rest } = {}) {
    return normalizeProvenance({
        ...rest,
        ...metadata,
        sourceType: "user_memory",
        sourceId: memoryId,
        memoryId,
        ownerUserId,
        sessionId,
        extractionMethod: firstValue(metadata?.extractionMethod, metadata?.extraction_method, source),
    }, { sourceType: "user_memory" });
}

export function buildProjectMemoryProvenance({ id, ownerUserId, tenantId, projectId, runId, sourceRunId, files, commitRef, confidence, createdAt, invalidatedAt, invalidationReason } = {}) {
    return normalizeProvenance({
        sourceType: "project_memory",
        sourceId: id,
        ownerUserId,
        tenantId,
        projectId,
        runId,
        sourceRunId,
        files,
        commitRef,
        confidence,
        createdAt,
        invalidatedAt,
        invalidationReason,
    }, { sourceType: "project_memory" });
}

export function buildProjectRetrievalProvenance({ item = {}, scope = {}, projectId = null } = {}) {
    const scopeValue = normalizeScope({
        ownerUserId: scope?.ownerUserId ?? scope?.userId,
        tenantId: scope?.tenantId,
        projectId,
    });
    return normalizeProvenance({
        sourceType: "project_memory",
        sourceId: item.chunkId ?? item.id,
        ownerUserId: scopeValue.ownerUserId,
        tenantId: scopeValue.tenantId,
        projectId: scopeValue.projectId,
        path: item.filePath ?? item.file ?? item.provenance?.file,
        startLine: item.startLine ?? item.provenance?.startLine,
        endLine: item.endLine ?? item.provenance?.endLine,
        commit: item.commit ?? item.sourceCommit ?? item.provenance?.commit,
        stale: item.stale,
    }, { sourceType: "project_memory", projectId: scopeValue.projectId });
}

/** Add common metadata without removing legacy fields used by selectors/UI. */
export function normalizeContextMetadata(metadata = {}, defaults = {}) {
    const input = metadata && typeof metadata === "object" ? metadata : {};
    const type = cleanString(firstValue(input.type, defaults.type)) || "custom";
    const sourceType = normalizeSourceType(
        firstValue(input.sourceType, input.projectMemory ? "project_memory" : type === "memory" ? "user_memory" : type === "repo" ? "repo" : type === "conversation_history" ? "conversation" : type === "system_instruction" ? "system" : type),
        "custom",
    );
    const status = normalizeMemoryStatus({
        status: input.status,
        invalidated: input.invalidated,
        stale: input.stale,
    });
    const scope = normalizeScope({
        ownerUserId: firstValue(input.ownerUserId, input.userId, input.scope?.ownerUserId),
        tenantId: firstValue(input.tenantId, input.scope?.tenantId),
        projectId: firstValue(input.projectId, input.scope?.projectId),
        sessionId: firstValue(input.sessionId, input.session_id, input.scope?.sessionId),
    });
    const provenance = normalizeProvenance(input.provenance || {}, {
        sourceType,
        ownerUserId: scope.ownerUserId,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        sourceId: input.memory_id ?? input.memoryId ?? input.chunkId ?? input.sourceId,
        confidence: input.confidence,
        createdAt: input.createdAt ?? input.created_at,
        invalidatedAt: input.invalidated_at,
        invalidationReason: input.invalidate_reason,
    });
    return {
        ...input,
        contractVersion: MEMORY_CONTRACT_VERSION,
        sourceType,
        status,
        confidence: clamp01(input.confidence, null),
        invalidation: provenance.invalidation,
        scope,
        provenance,
    };
}

export default {
    MEMORY_CONTRACT_VERSION,
    MEMORY_STATUS,
    normalizeSourceType,
    normalizeMemoryStatus,
    normalizeScope,
    normalizeProvenance,
    buildUserMemoryProvenance,
    buildProjectMemoryProvenance,
    buildProjectRetrievalProvenance,
    normalizeContextMetadata,
};
