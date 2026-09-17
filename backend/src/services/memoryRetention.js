const DEFAULTS = {
    pendingTtlDays: 30,
    workingTtlDays: 7,
    inactiveDays: 90,
    lowConfidenceThreshold: 0.35,
    maxPending: 100,
    maxWorking: 200,
};

function boundedNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

function envNumber(name, fallback, min, max) {
    return boundedNumber(process.env[name], fallback, min, max);
}

export function memoryRetentionConfig(overrides = {}) {
    return {
        pendingTtlDays: boundedNumber(overrides.pendingTtlDays ?? envNumber("MEMORY_PENDING_TTL_DAYS", DEFAULTS.pendingTtlDays, 0, 3650), DEFAULTS.pendingTtlDays, 0, 3650),
        workingTtlDays: boundedNumber(overrides.workingTtlDays ?? envNumber("MEMORY_WORKING_TTL_DAYS", DEFAULTS.workingTtlDays, 0, 3650), DEFAULTS.workingTtlDays, 0, 3650),
        inactiveDays: boundedNumber(overrides.inactiveDays ?? envNumber("MEMORY_INACTIVE_DAYS", DEFAULTS.inactiveDays, 0, 3650), DEFAULTS.inactiveDays, 0, 3650),
        lowConfidenceThreshold: boundedNumber(overrides.lowConfidenceThreshold ?? envNumber("MEMORY_LOW_CONFIDENCE_THRESHOLD", DEFAULTS.lowConfidenceThreshold, 0, 1), DEFAULTS.lowConfidenceThreshold, 0, 1),
        maxPending: Math.round(boundedNumber(overrides.maxPending ?? envNumber("MEMORY_MAX_PENDING", DEFAULTS.maxPending, 0, 100000), DEFAULTS.maxPending, 0, 100000)),
        maxWorking: Math.round(boundedNumber(overrides.maxWorking ?? envNumber("MEMORY_MAX_WORKING", DEFAULTS.maxWorking, 0, 100000), DEFAULTS.maxWorking, 0, 100000)),
    };
}

function parseMetadata(value) {
    if (value && typeof value === "object") return value;
    try { return JSON.parse(value || "{}"); } catch { return {}; }
}

export function isExplicitMemoryProtected(row) {
    const metadata = parseMetadata(row?.metadata);
    return Boolean(
        row?.pinned
        || row?.source === "explicit"
        || row?.extraction_method === "explicit"
        || metadata.extraction_method === "explicit"
        || metadata.protected === true
    );
}

function timestamp(row) {
    const value = row?.last_recalled_at || row?.updated_at || row?.created_at;
    const parsed = value ? new Date(value).getTime() : 0;
    return Number.isFinite(parsed) ? parsed : 0;
}

function ageDays(row, now) {
    const created = row?.created_at ? new Date(row.created_at).getTime() : now;
    return Math.max(0, (now - (Number.isFinite(created) ? created : now)) / 86400000);
}

function inactiveAgeDays(row, now) {
    return Math.max(0, (now - timestamp(row)) / 86400000);
}

function isExpired(row, now) {
    if (!row?.expires_at) return false;
    const expiresAt = new Date(row.expires_at).getTime();
    return Number.isFinite(expiresAt) && expiresAt <= now;
}

/**
 * Pure policy evaluator. It only returns decisions; the database layer owns
 * the transaction and performs the actual soft invalidation.
 */
export function evaluateMemoryRetention(rows = [], policy = memoryRetentionConfig(), now = Date.now()) {
    const config = memoryRetentionConfig(policy);
    const decisions = new Map();
    const protectedIds = new Set();
    const eligible = rows.filter((row) => ["pending", "active"].includes(row.status));

    const consider = (row, reason) => {
        if (!row?.id || decisions.has(row.id)) return;
        if (isExplicitMemoryProtected(row)) {
            protectedIds.add(row.id);
            return;
        }
        decisions.set(row.id, { id: Number(row.id), status: row.status, reason });
    };

    for (const row of eligible) {
        if (row.status === "pending" && ageDays(row, now) >= config.pendingTtlDays) {
            consider(row, "retention_pending_ttl");
        } else if (
            row.status === "active"
            && row.memory_type === "working"
            && (isExpired(row, now) || (!row.expires_at && ageDays(row, now) >= config.workingTtlDays))
        ) {
            consider(row, "retention_working_ttl");
        } else if (
            row.status === "active"
            && Number(row.confidence ?? 1) < config.lowConfidenceThreshold
            && inactiveAgeDays(row, now) >= config.inactiveDays
        ) {
            consider(row, "retention_low_confidence");
        }
    }

    const applyCapacity = (status, memoryType, limit, reason) => {
        const candidates = eligible
            .filter((row) => row.status === status && (memoryType ? row.memory_type === memoryType : true))
            .filter((row) => {
                const protectedRow = isExplicitMemoryProtected(row);
                if (protectedRow) protectedIds.add(row.id);
                return !protectedRow;
            })
            .sort((left, right) => (timestamp(right) - timestamp(left)) || (Number(right.id) - Number(left.id)));
        for (const row of candidates.slice(Math.max(0, limit))) consider(row, reason);
    };

    applyCapacity("pending", null, config.maxPending, "retention_pending_capacity");
    applyCapacity("active", "working", config.maxWorking, "retention_working_capacity");

    return {
        decisions: [...decisions.values()],
        scanned: rows.length,
        protectedSkipped: protectedIds.size,
        byReason: [...decisions.values()].reduce((result, item) => {
            result[item.reason] = (result[item.reason] || 0) + 1;
            return result;
        }, {}),
    };
}

export default { memoryRetentionConfig, isExplicitMemoryProtected, evaluateMemoryRetention };
