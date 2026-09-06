/**
 * Phase 7 / R5 (roadmap #5) — remote MCP secret indirection + OAuth metadata.
 *
 * Secrets are NEVER embedded as plaintext in a remote-MCP config or audit trail:
 * every secret is referenced as `env:NAME` or `vault:KEY` and resolved at the
 * moment a capability needs it (values are transient and never stored). OAuth
 * client credentials are configured the same way. R5 only validates the OAuth
 * *metadata*; the actual token exchange belongs to the R7 remote transport.
 */
import { codingError } from "../coding/util.js";
import { AUTH_TYPES } from "../protocol/agentCard.js";
import { REMOTE_MCP_URL_INVALID, assertSafeRemoteTarget, parseRemoteServerUrl } from "./remotePolicy.js";

export const REMOTE_MCP_PLAINTEXT_SECRET = "REMOTE_MCP_PLAINTEXT_SECRET";
export const REMOTE_MCP_BAD_SECRET_REF = "REMOTE_MCP_BAD_SECRET_REF";

/** env:NAME / vault:KEY — key starts letter/underscore, then up to 127 [A-Za-z0-9_]. */
export const SECRET_REF_RE = /^(env|vault):([A-Za-z_][A-Za-z0-9_]{0,127})$/;
const KNOWN_PREFIXES = Object.freeze(["env", "vault"]);

/**
 * Normalize a secret reference string. Rejects plaintext literals used as a
 * secret (no `:` reference form) and unknown prefixes.
 * @param {string} ref
 * @returns {{source: "env"|"vault", key: string}}
 */
export function normalizeSecretRef(ref) {
    const text = String(ref ?? "");
    const match = SECRET_REF_RE.exec(text);
    if (match) return { source: match[1], key: match[2] };
    const colon = text.indexOf(":");
    if (colon > 0 && KNOWN_PREFIXES.includes(text.slice(0, colon))) {
        throw codingError(REMOTE_MCP_BAD_SECRET_REF, `malformed secret reference "${text.slice(0, colon)}:…"`, 400);
    }
    if (colon === -1 && text.length > 0) {
        throw codingError(REMOTE_MCP_PLAINTEXT_SECRET, "plaintext secret values are not allowed; use env:NAME or vault:KEY", 400);
    }
    throw codingError(REMOTE_MCP_BAD_SECRET_REF, `unknown secret reference prefix in "${text}"`, 400);
}

/**
 * Resolve a secret reference. `env:NAME` reads the provided env map (default
 * process.env); `vault:KEY` calls the injected vault.get(KEY). A missing value
 * returns {ok:false, missing:true} and the value never appears in any return,
 * log, or audit field. vault == null means no vault is configured yet.
 *
 * @param {string} ref
 * @param {{env?: object, vault?: {get:(key:string)=>string|null|Promise<string|null>}|null}} [deps]
 * @returns {Promise<{ok:true, value:string}|{ok:false, missing:true, reason?:string}>}
 */
export async function resolveSecret(ref, { env = process.env, vault = null } = {}) {
    const { source, key } = normalizeSecretRef(ref);
    if (source === "env") {
        const value = env?.[key];
        if (value != null && value !== "") return { ok: true, value: String(value) };
        return { ok: false, missing: true };
    }
    // vault:KEY
    if (!vault || typeof vault.get !== "function") {
        return { ok: false, missing: true, reason: "VAULT_UNAVAILABLE" };
    }
    const value = await vault.get(key);
    if (value != null && value !== "") return { ok: true, value: String(value) };
    return { ok: false, missing: true };
}

/**
 * Audit/display-safe description of a secret reference. Carries source+key so a
 * reviewer can see *which* secret is referenced, with the value always redacted.
 * @param {string} ref
 * @returns {{source: "env"|"vault", key: string, redacted: "***"}}
 */
export function describeSecret(ref) {
    const { source, key } = normalizeSecretRef(ref);
    return { source, key, redacted: "***" };
}

/**
 * Pure OAuth config validation (R5 = metadata only; no token exchange, that is
 * the R7 remote transport). cfg: { type:'oauth', tokenUrl?, clientRef, scope? }.
 *  - type must be 'oauth' and be an allowed AUTH_TYPES value.
 *  - clientRef must be a valid env:/vault: secret reference.
 *  - tokenUrl (if present) must be https and pass the remote-policy base check.
 * Returns { ok:boolean, errors:string[] } — never throws.
 * @param {object} cfg
 * @returns {Promise<{ok:boolean, errors:string[]}>}
 */
export async function validateOAuthConfig(cfg) {
    const errors = [];
    const c = cfg && typeof cfg === "object" ? cfg : {};
    if (c.type !== "oauth") errors.push("type must be 'oauth'");
    else if (!AUTH_TYPES.includes(c.type)) errors.push("type is not an allowed AUTH_TYPES value");
    if (c.clientRef == null) {
        errors.push("clientRef is required");
    } else {
        try {
            normalizeSecretRef(c.clientRef);
        } catch (error) {
            errors.push(`clientRef: ${error?.message || "invalid secret reference"}`);
        }
    }
    if (c.tokenUrl != null && String(c.tokenUrl).trim() !== "") {
        try {
            const parsed = parseRemoteServerUrl(c.tokenUrl);
            if (parsed.protocol !== "https:") {
                errors.push("tokenUrl must be https");
            } else {
                await assertSafeRemoteTarget(parsed); // base SSRF/port/host policy
            }
        } catch (error) {
            errors.push(`tokenUrl: ${error?.message || "not a safe https endpoint"}`);
        }
    }
    if (c.scope != null && typeof c.scope !== "string") errors.push("scope must be a string");
    return { ok: errors.length === 0, errors };
}

/** Safe default vault — `get` always returns null (no vault configured). */
export const DEFAULT_VAULT = Object.freeze({
    get: async () => null,
});

export default {
    SECRET_REF_RE, REMOTE_MCP_PLAINTEXT_SECRET, REMOTE_MCP_BAD_SECRET_REF,
    normalizeSecretRef, resolveSecret, describeSecret, validateOAuthConfig, DEFAULT_VAULT,
};
