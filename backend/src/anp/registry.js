/**
 * Phase 7 / R5 (roadmap #9) — ANP discovery/identity registry (default-OFF
 * experiment). Advertisements record identity ONLY. `trusted` is server-decided
 * from the constructor/registerTrusted trust list — it can never be self-asserted
 * by an advertisement. Identity is never authorization: dispatching to a peer
 * still requires a separate server grant (see anp/adapter.js).
 */
import { codingError } from "../coding/util.js";
import { CARD_VERSION, KNOWN_AGENTS, normalizeAgentCard, validateAgentCard } from "../protocol/agentCard.js";
import { anpCardToIdentity } from "./adapter.js";

export const ANP_NOT_AUTHORIZED = "ANP_NOT_AUTHORIZED";
export const ANP_CARD_INVALID = "ANP_CARD_INVALID";
export const ANP_NAME_INVALID = "ANP_NAME_INVALID";
export const ANP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The one default-trusted peer is the host itself. */
export const DEFAULT_TRUSTED_NAMES = Object.freeze(["agent-evo-self"]);

function normalizeTrustedNames(trustedNames) {
    const list = Array.isArray(trustedNames) ? trustedNames : [];
    const seen = new Set();
    for (const item of list) {
        const name = String(item || "").trim();
        if (name && ANP_NAME_RE.test(name) && !seen.has(name)) seen.add(name);
    }
    return seen;
}

/** @returns {object} an owner-less ANP discovery/identity registry */
export function createAnpRegistry({ trustedNames = [] } = {}) {
    const trusted = normalizeTrustedNames(trustedNames);
    /** @type {Map<string, {card: object, advertisedAt: string}>} */
    const discovered = new Map();

    function identityFor(name, isTrusted) {
        const record = discovered.get(name);
        if (record) {
            const base = anpCardToIdentity(record.card);
            return { ...base, trust: isTrusted ? "trusted" : "untrusted" };
        }
        return {
            name,
            kind: "agent",
            version: CARD_VERSION,
            trust: isTrusted ? "trusted" : "untrusted",
            url: null,
            advertisedCapabilities: { effects: [], agents: [] },
        };
    }

    /**
     * Advertise an AgentCard under `name`. The card is normalized + validated and
     * recorded as discovered identity. Advertisements never change trust.
     * @param {string} name
     * @param {object} card
     * @returns {{name:string, advertised:boolean, trusted:boolean, identity:object}}
     */
    function advertise(name, card) {
        const clean = String(name || "").trim();
        if (!ANP_NAME_RE.test(clean)) throw codingError(ANP_NAME_INVALID, `ANP advertise name is invalid`, 400);
        const normalized = normalizeAgentCard(card);
        const check = validateAgentCard(normalized);
        if (!check.ok) {
            throw codingError(ANP_CARD_INVALID, `ANP card is invalid: ${(check.errors || []).join("; ")}`, 400);
        }
        discovered.set(clean, { card: normalized, advertisedAt: new Date().toISOString() });
        return resolveIdentity(clean);
    }

    /**
     * Resolve the identity for a peer name.
     * @param {string} name
     * @returns {{name:string, advertised:boolean, trusted:boolean,
     *            identity: object|null}} identity null unless advertised.
     */
    function resolveIdentity(name) {
        const clean = String(name || "").trim();
        const isTrusted = trusted.has(clean);
        const advertised = discovered.has(clean);
        return {
            name: clean,
            advertised,
            trusted: isTrusted,
            identity: advertised ? identityFor(clean, isTrusted) : null,
        };
    }

    /**
     * List identities. Default onlyTrusted=true → only server-trusted peers (trusted
     * peers show a minimal identity even before they advertise). Untrusted
     * advertisements are only visible with onlyTrusted=false, for discovery UI.
     * @param {{onlyTrusted?: boolean}} [opts]
     * @returns {Array<object>}
     */
    function list({ onlyTrusted = true } = {}) {
        const names = onlyTrusted
            ? [...trusted]
            : [...new Set([...trusted, ...discovered.keys()])];
        return names
            .filter((n) => ANP_NAME_RE.test(n))
            .map((n) => identityFor(n, trusted.has(n)));
    }

    /** @param {string} name */
    function registerTrusted(name) {
        const clean = String(name || "").trim();
        if (!ANP_NAME_RE.test(clean)) throw codingError(ANP_NAME_INVALID, `ANP trust name is invalid`, 400);
        trusted.add(clean);
    }

    /** @param {string} name @returns {boolean} whether a trust entry was removed */
    function forgetTrusted(name) {
        return trusted.delete(String(name || "").trim());
    }

    return {
        advertise,
        resolveIdentity,
        list,
        registerTrusted,
        forgetTrusted,
        KNOWN_AGENTS: [...KNOWN_AGENTS],
        trustedNames: () => [...trusted],
    };
}

/** Default registry — the only default-trusted peer is the host itself. */
export const defaultAnpRegistry = createAnpRegistry({ trustedNames: [...DEFAULT_TRUSTED_NAMES] });

export default { createAnpRegistry, defaultAnpRegistry, DEFAULT_TRUSTED_NAMES };
