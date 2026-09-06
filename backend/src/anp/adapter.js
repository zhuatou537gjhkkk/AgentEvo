/**
 * Phase 7 / R5 (roadmap #9) — ANP discovery ⇏ authorization proof.
 *
 * ANP discovery yields IDENTITY only. Capabilities advertised on an agent card
 * are display metadata; the only capabilities that may ever be delegated come
 * from the server's explicit grant (a trust-list entry backed by an admin card),
 * never from an ANP advertisement. `assertIdentityNotAuthorization` is the choke
 * point every ANP dispatch must pass.
 */
import { codingError } from "../coding/util.js";
import { normalizeAgentCard, withinCapability } from "../protocol/agentCard.js";

/**
 * Reduce a normalized AgentCard to the ANP identity surface. `advertisedCapabilities`
 * are carried through verbatim for DISPLAY ONLY and are never treated as a grant.
 * @param {object} card
 * @returns {{name:string, kind:string, version:string, trust:string, url:string|null,
 *            advertisedCapabilities:{effects:string[], agents:string[]}}}
 */
export function anpCardToIdentity(card) {
    const c = normalizeAgentCard(card);
    return {
        name: c.name,
        kind: c.kind || "agent",
        version: c.version,
        trust: c.trust || "untrusted",
        url: c.url || null,
        advertisedCapabilities: {
            effects: [...(c.capabilities?.effects || [])],
            agents: [...(c.capabilities?.agents || [])],
        },
    };
}

/**
 * Strip an identity to pure identification (drop advertised capabilities so a
 * display/identity surface never looks like a grant).
 * @param {object} identity
 * @returns {{name:string, kind:string, version:string, trust:string, url:string|null}}
 */
export function identityOnly(identity) {
    const id = identity && typeof identity === "object" ? identity : {};
    return {
        name: id.name || "",
        kind: id.kind || "agent",
        version: id.version || "1.0",
        trust: id.trust || "untrusted",
        url: id.url || null,
    };
}

/**
 * The capability card the server ACTUALLY grants to `name`. Comes exclusively
 * from the server trust-list + admin-provided cards (`cardsByTrust`), never from
 * ANP advertisement. Returns null when the peer is untrusted or has no grant.
 *
 * @param {string} name
 * @param {{trustedNames?: string[], cardsByTrust?: Record<string,object>}} [source]
 * @returns {object|null} normalized AgentCard or null
 */
export function grantedCapabilityFor(name, { trustedNames = [], cardsByTrust = {} } = {}) {
    const peer = String(name || "");
    if (!peer || !(Array.isArray(trustedNames) ? trustedNames : []).includes(peer)) return null;
    if (!cardsByTrust || typeof cardsByTrust !== "object" || !cardsByTrust[peer]) return null;
    return normalizeAgentCard(cardsByTrust[peer]);
}

/**
 * Prove that discovery is not authorization: even when an ANP identity
 * advertised capabilities (or is otherwise known), a task may only proceed
 * within the server-granted card. Throws ANP_NOT_AUTHORIZED (403) when the
 * grant is absent or the task asks for an effect/agent outside it.
 *
 * @param {object|null} identity ANP-discovered identity (informational)
 * @param {object|null} granted server-granted card (from grantedCapabilityFor)
 * @param {{effects?: string[], agents?: string[]}} [task] requested capability declaration
 * @returns {true}
 */
export function assertIdentityNotAuthorization(identity, granted, task = {}) {
    const grant = granted ? normalizeAgentCard(granted) : null;
    if (!grant || !grant.name) {
        throw codingError("ANP_NOT_AUTHORIZED", `ANP discovery is identity-only; no server grant for "${identity?.name || "(unknown)"}"`, 403);
    }
    try {
        withinCapability(grant, {
            effects: Array.isArray(task?.effects) ? task.effects : [],
            agents: Array.isArray(task?.agents) ? task.agents : [],
        });
    } catch {
        throw codingError("ANP_NOT_AUTHORIZED", `task exceeds the server grant for "${grant.name}" (ANP advertisement does not authorize)`, 403);
    }
    return true;
}

export default {
    anpCardToIdentity, identityOnly, grantedCapabilityFor, assertIdentityNotAuthorization,
};
