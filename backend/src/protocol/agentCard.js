/**
 * Phase 7 / R5 — canonical AgentCard (protocol/agentCard.js).
 *
 * One identity/capability card shape shared by A2A (#7), ANP (#9) and remote-MCP
 * trust (#5), so a local trusted agent, an A2A peer and an ANP-discovered agent
 * all describe themselves with the SAME vocabulary. The card is declarative only:
 *
 *   - `capabilities` names EFFECTS (read|write|exec|network|external) and AGENT
 *     types the peer may carry out. It is a server-side claim the *caller* then
 *     narrows with `capabilitySubset` — a card never grants anything by itself.
 *   - `authentication` describes how the peer authenticates; it is metadata, not
 *     proof. Trust still comes from the server's explicit trust list, never from
 *     discovery (roadmap R5 #9: discovery ≠ authorization).
 *
 * Everything here is a pure deterministic transform (normalize/validate/subset) —
 * no DB, no network, no LLM.
 */
import { codingError } from "../coding/util.js";

export const CARD_VERSION = "1.0";
export const EFFECT_TYPES = Object.freeze(["read", "write", "exec", "network", "external"]);
export const KNOWN_AGENTS = Object.freeze(["search", "knowledge", "code", "general"]);

export const AUTH_TYPES = Object.freeze(["none", "bearer", "oauth", "mtls"]);

function cleanString(value, max = 200) {
    if (value == null) return "";
    let out = "";
    for (const ch of String(value)) {
        const code = ch.charCodeAt(0);
        if (code === 9 || code === 10 || code === 13) { out += ch; continue; }
        if (code < 32 || code === 127) continue;
        out += ch;
    }
    return out.slice(0, max).trim();
}

function cleanUrl(value, max = 500) {
    if (value == null) return "";
    const s = String(value).trim();
    if (s.length === 0) return "";
    // Card URLs are informational; policy enforcement (SSRF/IP) lives in
    // mcp/remotePolicy.js when the URL is actually dialed. Keep only http(s).
    try {
        const u = new URL(s);
        if (u.protocol !== "http:" && u.protocol !== "https:") return "";
        return s.slice(0, max);
    } catch {
        return "";
    }
}

function cleanEffects(value) {
    if (value == null) return [];
    const list = Array.isArray(value) ? value : [value];
    const seen = new Set();
    for (const item of list) {
        const e = String(item || "").trim();
        if (EFFECT_TYPES.includes(e) && !seen.has(e)) seen.add(e);
    }
    return EFFECT_TYPES.filter((e) => seen.has(e));
}

function cleanAgents(value) {
    if (value == null) return [];
    const list = Array.isArray(value) ? value : [value];
    const seen = new Set();
    for (const item of list) {
        const a = String(item || "").trim();
        if (KNOWN_AGENTS.includes(a) && !seen.has(a)) seen.add(a);
    }
    return seen.size ? KNOWN_AGENTS.filter((a) => seen.has(a)) : [];
}

/**
 * Normalize an arbitrary card-like object into the canonical AgentCard. Unknown
 * fields are preserved under `extra`. Unknown effects/agents are dropped (never
 * invented), and a missing capability defaults to an empty (least-capable) card.
 */
export function normalizeAgentCard(input = {}) {
    const { extra = {}, ...rest } = input && typeof input === "object" ? input : {};
    const card = {
        name: cleanString(input?.name || input?.agentName),
        displayName: cleanString(input?.displayName || input?.display_name, 200) || cleanString(input?.name),
        description: cleanString(input?.description, 2000),
        version: cleanString(input?.version) || CARD_VERSION,
        kind: cleanString(input?.kind, 32) || "agent", // agent | server | skill
        url: cleanUrl(input?.url),
        capabilities: {
            effects: cleanEffects(input?.capabilities?.effects ?? input?.effects),
            agents: cleanAgents(input?.capabilities?.agents ?? input?.agents),
        },
        authentication: {
            type: AUTH_TYPES.includes(cleanString(input?.authentication?.type, 16)) ? cleanString(input?.authentication?.type, 16) : "none",
            // `secretRef` names an env/vault indirection ONLY; plaintext never.
            secretRef: cleanString(input?.authentication?.secretRef, 128),
        },
        trust: cleanString(input?.trust, 16) || "untrusted", // trusted | untrusted | explicit
        tags: Array.isArray(input?.tags) ? input.tags.map((t) => cleanString(t, 64)).filter(Boolean).slice(0, 16) : [],
        extra,
    };
    return card;
}

/**
 * Validate a normalized card. Returns { ok: true } or { ok: false, errors: [] }.
 * A card must have a name, a valid version, and a capability/effect surface that
 * is a subset of the known vocabulary.
 */
export function validateAgentCard(card) {
    const errors = [];
    if (!card || typeof card !== "object") return { ok: false, errors: ["card must be an object"] };
    if (!card.name) errors.push("name is required");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(card.name || "")) errors.push("name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$");
    if (card.version && !/^\d+\.\d+(\.\d+)?$/.test(card.version)) errors.push("version must be semver-ish (N.N or N.N.N)");
    if (!Array.isArray(card?.capabilities?.effects)) errors.push("capabilities.effects must be an array");
    if (card?.url && !/^https?:\/\//.test(card.url)) errors.push("url must be http(s)");
    return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

/**
 * The capability surface actually granted when delegating TO this card.
 * Delegation always narrows: intersection with the caller-chosen allow set and
 * never widens. `effect` filters use the five known effect types; `agents` the
 * known agent vocabulary.
 */
export function capabilitySubset(card, { effects = null, agents = null } = {}) {
    const normalized = normalizeAgentCard(card);
    const allowEffects = effects == null ? EFFECT_TYPES : cleanEffects(effects);
    const allowAgents = agents == null ? KNOWN_AGENTS : cleanAgents(agents);
    const granted = {
        effects: EFFECT_TYPES.filter((e) => normalized.capabilities.effects.includes(e) && allowEffects.includes(e)),
        agents: KNOWN_AGENTS.filter((a) => normalized.capabilities.agents.includes(a) && allowAgents.includes(a)),
    };
    return { ...normalized, capabilities: granted };
}

/**
 * Whether a delegated task body stays within a granted card subset. Used to
 * refuse an A2A/ANP task that asks for an effect/agent outside the subset the
 * server actually delegated (roadmap R5 #7 "delegation 只传 capability 子集").
 */
export function withinCapability(card, { effects = [], agents = [] } = {}) {
    const granted = card?.capabilities || { effects: [], agents: [] };
    const askedEffects = Array.isArray(effects) ? effects : [effects];
    const askedAgents = Array.isArray(agents) ? agents : [agents];
    const badEffect = askedEffects.find((e) => !granted.effects.includes(e));
    const badAgent = askedAgents.find((a) => !granted.agents.includes(a));
    if (badEffect) throw codingError("CAPABILITY_NOT_GRANTED", `effect "${badEffect}" is outside the delegated capability subset`, 403);
    if (badAgent) throw codingError("AGENT_NOT_GRANTED", `agent "${badAgent}" is outside the delegated capability subset`, 403);
    return true;
}

export default {
    CARD_VERSION, EFFECT_TYPES, KNOWN_AGENTS, AUTH_TYPES,
    normalizeAgentCard, validateAgentCard, capabilitySubset, withinCapability,
};
