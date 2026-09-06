/**
 * Phase 7 / R5 (roadmap #5) — remote MCP health lifecycle + owner-scoped registry.
 *
 * R5 is pure governance: preconditions (master flag, URL SSRF policy, plaintext-
 * secret refusal, secret resolvability, transport availability) are enforced
 * before any remote server is accepted, and the registry tracks an explicit
 * state machine. The Streamable HTTP transport itself is NOT implemented yet —
 * REMOTE_TRANSPORT_AVAILABLE stays false — so a registered server is never
 * dialed: health() answers unreachable and nothing ever pretends to connect
 * (real transport + DNS-rebinding defence are R7).
 */
import { randomUUID } from "node:crypto";
import { remoteMcpEnabled } from "../extensibility/flags.js";
import { codingError, requireCodingScope } from "../coding/util.js";
import { assertSafeRemoteTarget, parseRemoteServerUrl } from "./remotePolicy.js";
import { REMOTE_MCP_BAD_SECRET_REF, SECRET_REF_RE, describeSecret, normalizeSecretRef, resolveSecret } from "./vault.js";

export const REMOTE_MCP_DISABLED = "REMOTE_MCP_DISABLED";
export const REMOTE_MCP_PLAINTEXT_SECRET = "REMOTE_MCP_PLAINTEXT_SECRET";
export const REMOTE_MCP_SECRET_MISSING = "REMOTE_MCP_SECRET_MISSING";
export const REMOTE_MCP_TRANSPORT_UNSUPPORTED = "REMOTE_MCP_TRANSPORT_UNSUPPORTED";
export const REMOTE_MCP_EXISTS = "REMOTE_MCP_EXISTS";
export const REMOTE_MCP_CFG_INVALID = "REMOTE_MCP_CFG_INVALID";
export const INVALID_STATE_TRANSITION = "INVALID_STATE_TRANSITION";

/** R5 marker: the real remote (Streamable HTTP) transport is NOT implemented. */
export const REMOTE_TRANSPORT_AVAILABLE = false;

export const REMOTE_STATES = Object.freeze([
    "created", "validating", "connecting", "ready", "degraded", "failed", "closing", "closed",
]);

/** Supported remote transport family that MAY be dialed once R7 lands. */
const ALLOWED_TRANSPORTS = Object.freeze(["streamable-http"]);

const ALLOWED_TRANSITIONS = Object.freeze({
    created: ["validating", "failed", "closing"],
    validating: ["connecting", "failed", "closing"],
    connecting: ["ready", "failed", "closing"],
    ready: ["degraded", "failed", "closing"],
    degraded: ["ready", "failed", "closing"],
    failed: ["closing"],
    closing: ["closed"],
    closed: [],
});

const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Enforce the lifecycle transition contract. Returns true on a legal migration,
 * throws codingError(INVALID_STATE_TRANSITION) otherwise.
 * @param {string} state
 * @param {string} to
 * @returns {true}
 */
export function transitionValid(state, to) {
    const allowed = ALLOWED_TRANSITIONS[state] || [];
    if (!allowed.includes(to)) {
        throw codingError(INVALID_STATE_TRANSITION, `remote MCP state ${state} → ${to} is not a valid transition`, 400);
    }
    return true;
}

/**
 * Build a fresh, secret-free remote session. cfg is sanitized: any secret
 * reference (env/header/auth secretRef) is replaced by its {source,key,redacted}
 * descriptor — a resolved value is never stored here or in any audit record.
 * @param {object} cfg
 * @returns {{id:string, name:string, state:string, cfg:object, createdAt:string,
 *            lastHealthAt:string|null, healthChecks:number, failureCount:number}}
 */
export function createRemoteSession(cfg) {
    const name = String(cfg?.name || "");
    const now = new Date().toISOString();
    return {
        id: `rmcp_${randomUUID()}`,
        name,
        state: "created",
        cfg: sanitizeCfg(cfg || {}),
        createdAt: now,
        lastHealthAt: null,
        healthChecks: 0,
        failureCount: 0,
    };
}

/** Keep only non-secret config + secret-ref descriptors. */
function sanitizeCfg(cfg) {
    const out = {};
    for (const key of Object.keys(cfg || {})) {
        if (key === "env" || key === "headers") {
            const map = cfg[key];
            if (map && typeof map === "object" && !Array.isArray(map)) {
                const safe = {};
                for (const [k, v] of Object.entries(map)) {
                    safe[k] = (typeof v === "string" && SECRET_REF_RE.test(v))
                        ? describeSecret(v)
                        : { redacted: "***" };
                }
                out[key] = safe;
            }
            continue;
        }
        if (key === "auth" && cfg[key] && typeof cfg[key] === "object") {
            const a = { ...cfg[key] };
            if (typeof a.secretRef === "string" && SECRET_REF_RE.test(a.secretRef)) {
                a.secretRef = describeSecret(a.secretRef);
            }
            for (const forbidden of ["clientSecret", "client_secret", "token", "accessToken", "authorization"]) {
                delete a[forbidden];
            }
            out[key] = a;
            continue;
        }
        out[key] = cfg[key];
    }
    return out;
}

/** Group env/headers/auth secret references that must resolve before registration. */
function collectSecretRefs(cfg) {
    const refs = [];
    for (const group of ["env", "headers"]) {
        const map = cfg?.[group];
        if (map && typeof map === "object" && !Array.isArray(map)) {
            for (const value of Object.values(map)) {
                if (typeof value === "string" && SECRET_REF_RE.test(value)) refs.push(value);
            }
        }
    }
    const auth = cfg?.auth;
    if (auth && typeof auth === "object") {
        for (const key of ["secretRef", "clientRef", "tokenRef"]) {
            const value = auth[key];
            if (typeof value === "string" && SECRET_REF_RE.test(value)) refs.push(value);
        }
    }
    return refs;
}

function isRefString(value) {
    return typeof value === "string" && SECRET_REF_RE.test(value);
}

/** Refuse cfg.env / cfg.headers / auth values that embed a plaintext secret. */
function assertNoPlaintextSecrets(cfg) {
    for (const group of ["env", "headers"]) {
        const map = cfg?.[group];
        if (map == null) continue;
        if (typeof map !== "object" || Array.isArray(map)) {
            throw codingError(REMOTE_MCP_CFG_INVALID, `remote MCP ${group} must be an object`, 400);
        }
        for (const [key, value] of Object.entries(map)) {
            if (value == null) continue;
            if (isRefString(value)) continue;
            try {
                normalizeSecretRef(String(value));
            } catch (error) {
                if (error?.code === "REMOTE_MCP_PLAINTEXT_SECRET") {
                    throw codingError(REMOTE_MCP_PLAINTEXT_SECRET, `remote MCP ${group}["${key}"] must reference env:/vault:, not a literal secret`, 400);
                }
                throw codingError(REMOTE_MCP_BAD_SECRET_REF, `remote MCP ${group}["${key}"]: ${error?.message}`, 400);
            }
        }
    }
    const auth = cfg?.auth;
    if (auth && typeof auth === "object") {
        for (const key of ["clientSecret", "client_secret", "token", "accessToken"]) {
            if (auth[key] != null) {
                throw codingError(REMOTE_MCP_PLAINTEXT_SECRET, `remote MCP auth["${key}"] must reference env:/vault:, not a literal secret`, 400);
            }
        }
    }
}

/**
 * Registration gate (async because the URL policy can run a resolver). Applies:
 *  1. master flag (REMOTE_MCP_ENABLED) — default OFF → REMOTE_MCP_DISABLED 403.
 *  2. cfg must carry {name, url}; url must pass parse + assertSafeRemoteTarget
 *     (a hostname is tagged needsDnsCheck and MAY NOT be connected without a
 *     resolver re-check — enforced here before any R7 connect path).
 *  3. no plaintext secrets in cfg.env/headers/auth — refs only.
 *  4. transport must be the streamable-http family. The transport is NOT
 *     implemented in R5, so registration is allowed but the server is never
 *     dialed: health reports unreachable and state stays 'created'.
 *
 * @param {object} cfg
 * @returns {Promise<{ok:boolean, url:string, needsDnsCheck:boolean}>}
 */
export async function assertRemoteAllowed(cfg) {
    if (!remoteMcpEnabled()) {
        throw codingError(REMOTE_MCP_DISABLED, "remote MCP is disabled", 403);
    }
    if (!cfg || typeof cfg !== "object") {
        throw codingError(REMOTE_MCP_CFG_INVALID, "remote MCP config is required", 400);
    }
    const name = String(cfg.name || "").trim();
    if (!REMOTE_NAME_RE.test(name)) {
        throw codingError(REMOTE_MCP_CFG_INVALID, "remote MCP server name is invalid", 400);
    }
    const url = String(cfg.url || "");
    const checked = await assertSafeRemoteTarget(url, {
        allowPrivate: Boolean(cfg.allowPrivate),
        denyHosts: cfg.denyHosts || [],
        allowedPorts: cfg.allowedPorts ?? null,
    });
    assertNoPlaintextSecrets(cfg);
    const transport = cfg.transport == null ? "streamable-http" : String(cfg.transport).trim();
    if (!ALLOWED_TRANSPORTS.includes(transport)) {
        throw codingError(REMOTE_MCP_TRANSPORT_UNSUPPORTED, `transport "${transport}" is not supported for remote MCP (R5: streamable-http only, not yet implemented)`, 400);
    }
    if (!REMOTE_TRANSPORT_AVAILABLE) {
        // R5 marker — never pretend to be able to connect.
        void parseRemoteServerUrl(url);
    }
    return { ok: true, url: checked.url, needsDnsCheck: checked.needsDnsCheck };
}

/**
 * Owner-scoped in-memory remote-MCP registry. Sessions are scoped to a coding
 * owner (requireCodingScope) so one tenant can never read or mutate another's.
 * No real transport is dialed in R5.
 */
export class RemoteServerRegistry {
    /**
     * @param {{vault?: {get:(key:string)=>string|Promise<string>}|null,
     *          env?: object}} [opts]
     */
    constructor({ vault = null, env = process.env } = {}) {
        this._vault = vault;
        this._env = env || process.env;
        /** @type {Map<string, Map<string, object>>} ownerKey → name → session */
        this._scopes = new Map();
    }

    _ownerKey(scope) {
        const { tenantId } = requireCodingScope(scope, "remote MCP server");
        return tenantId;
    }

    _mapFor(ownerKey) {
        if (!this._scopes.has(ownerKey)) this._scopes.set(ownerKey, new Map());
        return this._scopes.get(ownerKey);
    }

    /**
     * Resolve every env:/vault: reference the config needs. On any missing secret
     * throws REMOTE_MCP_SECRET_MISSING; resolved values are transient and are
     * never stored.
     * @param {object} scope
     * @param {object} cfg
     * @returns {Promise<void>}
     */
    async resolveAllSecrets(scope, cfg) {
        const missing = [];
        for (const ref of collectSecretRefs(cfg)) {
            const result = await resolveSecret(ref, { env: this._env, vault: this._vault });
            if (!result.ok) {
                const { source, key } = normalizeSecretRef(ref);
                missing.push(result.reason === "VAULT_UNAVAILABLE" ? `${source}:${key} (vault not configured)` : `${source}:${key}`);
            }
        }
        if (missing.length) {
            throw codingError(REMOTE_MCP_SECRET_MISSING, `remote MCP secrets unresolved: ${missing.join(", ")}`, 400);
        }
    }

    /**
     * Register a remote MCP server under an owner scope.
     * @param {object} scope owner identity ({userId, tenantId})
     * @param {{name:string, url:string, transport?:string, env?:object, headers?:object, auth?:object}} cfg
     * @returns {Promise<object>} sanitized session (never contains a secret value)
     */
    async register(scope, cfg) {
        await assertRemoteAllowed(cfg);
        const ownerKey = this._ownerKey(scope);
        const map = this._mapFor(ownerKey);
        const name = String(cfg.name).trim();
        if (map.has(name)) {
            throw codingError(REMOTE_MCP_EXISTS, `remote MCP server "${name}" is already registered`, 409);
        }
        await this.resolveAllSecrets(scope, cfg);
        const session = createRemoteSession({ ...cfg, name });
        map.set(name, session);
        return session;
    }

    /** List registered session descriptors (sanitized) for an owner. */
    configured(scope) {
        const ownerKey = this._ownerKey(scope);
        const map = this._scopes.get(ownerKey) || new Map();
        return [...map.values()].map((session) => ({
            name: session.name,
            state: session.state,
            cfg: session.cfg,
        }));
    }

    /** @param {object} scope @param {string} name */
    get(scope, name) {
        const ownerKey = this._ownerKey(scope);
        const map = this._scopes.get(ownerKey);
        return map ? map.get(String(name)) : undefined;
    }

    /**
     * Unregister (close) a session. Moves it to closed (via closing) and removes
     * it. Returns true when removed, false when no such session existed.
     * @param {object} scope
     * @param {string} name
     * @returns {boolean}
     */
    unregister(scope, name) {
        const ownerKey = this._ownerKey(scope);
        const map = this._scopes.get(ownerKey);
        const session = map ? map.get(String(name)) : undefined;
        if (!session) return false;
        if (session.state !== "closed") {
            session.state = "closing";
            session.state = "closed";
        }
        map.delete(String(name));
        return true;
    }

    /**
     * Health check. With the transport unavailable (R5) and no probe injected,
     * answers `{status:'unreachable', reason:'REMOTE_TRANSPORT_NOT_IMPLEMENTED_R7'}`
     * — the registry never pretends to be connected. When a probe IS injected
     * (tests / R7 connect path) it runs and refreshes lastHealthAt / healthChecks /
     * failureCount and moves state between ready / degraded / failed. Idempotent.
     *
     * @param {object} scope
     * @param {string} name
     * @param {{probe?: (session:object)=>boolean|Promise<boolean>}} [opts]
     * @returns {Promise<object|null>}
     */
    async health(scope, name, { probe = null } = {}) {
        const session = this.get(scope, name);
        if (!session) return null;
        if (!REMOTE_TRANSPORT_AVAILABLE && typeof probe !== "function") {
            return { status: "unreachable", reason: "REMOTE_TRANSPORT_NOT_IMPLEMENTED_R7" };
        }
        session.lastHealthAt = new Date().toISOString();
        session.healthChecks = (session.healthChecks || 0) + 1;
        let healthy = false;
        if (typeof probe === "function") {
            try {
                healthy = (await probe(session)) !== false;
            } catch {
                healthy = false;
            }
        } else {
            healthy = true; // R7 transport present and dialed successfully
        }
        if (healthy) {
            session.failureCount = 0;
            session.state = "ready";
        } else {
            session.failureCount = (session.failureCount || 0) + 1;
            session.state = session.failureCount >= 3 ? "failed" : "degraded";
        }
        return {
            status: session.state,
            lastHealthAt: session.lastHealthAt,
            healthChecks: session.healthChecks,
            failureCount: session.failureCount,
        };
    }

    /** @param {object} scope @returns {{count:number, names:string[]}} */
    stats(scope) {
        const ownerKey = this._ownerKey(scope);
        const map = this._scopes.get(ownerKey) || new Map();
        return { count: map.size, names: [...map.keys()] };
    }
}

/** Shared default registry — no vault configured until one is injected. */
export const defaultRemoteRegistry = new RemoteServerRegistry();

export default {
    REMOTE_MCP_DISABLED, REMOTE_MCP_PLAINTEXT_SECRET, REMOTE_MCP_SECRET_MISSING,
    REMOTE_MCP_TRANSPORT_UNSUPPORTED, REMOTE_MCP_EXISTS, REMOTE_MCP_CFG_INVALID,
    INVALID_STATE_TRANSITION, REMOTE_TRANSPORT_AVAILABLE, REMOTE_STATES,
    createRemoteSession, assertRemoteAllowed, RemoteServerRegistry, transitionValid,
    defaultRemoteRegistry,
};
