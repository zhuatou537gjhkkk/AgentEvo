import net from "node:net";

const buckets = new Map();
const MAX_BUCKETS = 10_000;

function parseAddress(value) {
    const raw = String(value || "").trim().toLowerCase();
    const slash = raw.indexOf("/");
    const address = slash === -1 ? raw : raw.slice(0, slash);
    const prefixText = slash === -1 ? null : raw.slice(slash + 1);
    const family = net.isIP(address);
    const maxPrefix = family === 4 ? 32 : 128;
    if (!family || (prefixText != null && (!/^\d+$/.test(prefixText) || Number(prefixText) > maxPrefix))) {
        throw new Error("invalid trusted proxy address");
    }

    let bytes;
    if (family === 4) {
        bytes = Buffer.from(address.split(".").map(Number));
    } else {
        const [withoutZone] = address.split("%");
        const halves = withoutZone.split("::");
        if (halves.length > 2) throw new Error("invalid trusted proxy address");
        const left = halves[0] ? halves[0].split(":") : [];
        const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
        const expanded = halves.length === 2
            ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
            : left;
        if (expanded.length !== 8 || expanded.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) throw new Error("invalid trusted proxy address");
        bytes = Buffer.from(expanded.flatMap((part) => {
            const n = Number.parseInt(part, 16);
            return [n >> 8, n & 0xff];
        }));
    }
    return { address, family, bytes, prefix: prefixText == null ? maxPrefix : Number(prefixText) };
}

function normalizeAddress(value) {
    const parsed = parseAddress(value);
    return parsed.address;
}

function addressInNetwork(candidate, network) {
    let parsed;
    try { parsed = parseAddress(candidate); } catch { return false; }
    if (parsed.family !== network.family) return false;
    const fullBytes = Math.floor(network.prefix / 8);
    const remainder = network.prefix % 8;
    if (!parsed.bytes.subarray(0, fullBytes).equals(network.bytes.subarray(0, fullBytes))) return false;
    return remainder === 0 || (parsed.bytes[fullBytes] & (0xff << (8 - remainder))) === (network.bytes[fullBytes] & (0xff << (8 - remainder)));
}

export function parseTrustedProxyConfig(env = process.env) {
    const hopsValue = String(env.TRUSTED_PROXY_HOPS ?? "").trim();
    const hops = hopsValue === "" ? null : Number(hopsValue);
    if (hops != null && (!Number.isInteger(hops) || hops < 1 || hops > 32)) throw new Error("invalid trusted proxy hops");
    const addresses = String(env.TRUSTED_PROXY_ADDRESSES || "").split(",").map((item) => item.trim()).filter(Boolean).map(parseAddress);
    if (addresses.length > 0 && hops != null && addresses.length !== hops) throw new Error("trusted proxy hops/address count mismatch");
    if (env.NODE_ENV === "production" && env.TRUST_PROXY === "true" && !hops && addresses.length === 0) throw new Error("trusted proxy policy is required in production");
    return { hops, addresses };
}

function isTrustedProxy(req) {
    if (process.env.TRUST_PROXY !== "true") return false;
    let config;
    try { config = parseTrustedProxyConfig(); } catch { return false; }
    const remote = normalizeAddress(req.socket?.remoteAddress || "");
    if (config.addresses.length > 0) return config.addresses.some((network) => addressInNetwork(remote, network));
    return config.hops != null && req.app?.get?.("trust proxy") === config.hops;
}

function getClientAddress(req) {
    if (!isTrustedProxy(req)) return String(req.socket?.remoteAddress || "unknown");
    const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",").map((item) => item.trim()).filter(Boolean);
    const config = parseTrustedProxyConfig();
    if (config.hops != null && forwarded.length !== config.hops) return String(req.socket?.remoteAddress || "unknown");
    return normalizeAddress(forwarded[0] || req.socket?.remoteAddress || "unknown");
}

function getKey(req, scope) {
    const address = getClientAddress(req);
    const user = req.user;
    const identity = user
        ? `${user.tenantId || `user:${user.id}`}:${user.id}`
        : "anonymous";
    return `${scope}:${identity}:${address}`;
}

function pruneBuckets(now = Date.now(), windowMs = 60_000) {
    for (const [key, bucket] of buckets) {
        if (now - bucket.startedAt >= bucket.windowMs || now - bucket.lastSeenAt >= windowMs * 2) {
            buckets.delete(key);
        }
    }
    while (buckets.size > MAX_BUCKETS) {
        const oldest = buckets.keys().next().value;
        if (oldest == null) break;
        buckets.delete(oldest);
    }
}

/** Simple in-process limiter for the single-node deployment. */
export function createRateLimit({ scope, windowMs = 60_000, max = 60 } = {}) {
    return (req, res, next) => {
        const key = getKey(req, scope || req.path);
        const now = Date.now();
        pruneBuckets(now, windowMs);
        const current = buckets.get(key);
        if (!current || now - current.startedAt >= windowMs) {
            buckets.set(key, { startedAt: now, count: 1, windowMs, lastSeenAt: now });
            return next();
        }

        current.lastSeenAt = now;
        current.count += 1;
        if (current.count > max) {
            const retryAfter = Math.max(1, Math.ceil((windowMs - (now - current.startedAt)) / 1000));
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({
                ok: false,
                error: "RATE_LIMITED",
                errorCode: "RATE_LIMITED",
                message: "请求过于频繁，请稍后重试",
                retryable: true,
                requestId: req.requestId || null,
            });
        }
        return next();
    };
}

function parseIds(value) {
    return new Set(String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean));
}

export function isAdminUser(user) {
    if (!user) return false;
    const ids = parseIds(process.env.ADMIN_USER_IDS);
    const usernames = parseIds(process.env.ADMIN_USERNAMES);
    if (ids.has(String(user.id)) || usernames.has(String(user.username))) return true;
    // Keep local development usable without silently weakening production.
    return process.env.NODE_ENV !== "production" && !process.env.ADMIN_USER_IDS && !process.env.ADMIN_USERNAMES;
}

export function requireAdmin(req, res, next) {
    if (!isAdminUser(req.user)) {
        return res.status(403).json({
            ok: false,
            error: "FORBIDDEN",
            errorCode: "FORBIDDEN",
            message: "需要管理员权限",
            requestId: req.requestId || null,
            retryable: false,
        });
    }
    return next();
}

export function resetRateLimitState() {
    buckets.clear();
}

export function getRateLimitStateSize() {
    return buckets.size;
}

export function getRateLimitKey(req, scope) {
    return getKey(req, scope || req.path);
}
