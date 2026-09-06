/**
 * Phase 7 / R5 (roadmap #7) — local trusted AgentCard registry (a2a/registry.js).
 *
 * Same-instance / local-trusted agent cards. Trust is ALWAYS `explicit` — these
 * cards are declared by this server, never discovered (roadmap R5 #9: discovery
 * ≠ authorization). No LLM / network / filesystem anywhere in this module; the
 * deterministic "dispatcher" for each card is a plain injected executor in the
 * runtime (agent-evo-self / local-memory ship without one → executor-unavailable,
 * which is a legal service-unavailable state until an injector is wired).
 *
 * The three default cards deliberately declare only a CONTROLLED capability
 * subset of the hosting agent — agent-evo-self is the host's mirror but its
 * public card claims only `read`/`knowledge`, demonstrating "同实例/本地可信
 * agent card 只暴露可控子集".
 */
import { codingError } from "../coding/util.js";
import { normalizeAgentCard, validateAgentCard } from "../protocol/agentCard.js";

function cleanName(value) {
    return String(value || "").trim().slice(0, 128);
}

function buildLocalTrustedCards() {
    return [
        {
            name: "agent-evo-self",
            displayName: "AgentEvo (self)",
            kind: "agent",
            version: "1.0",
            description: "同实例宿主 Agent 的受控镜像：虽宿主能力更强，对外 card 只声明只读/知识库可控子集，供 capability 收窄演示",
            url: "",
            capabilities: { effects: ["read"], agents: ["knowledge"] },
            authentication: { type: "none", secretRef: "" },
            trust: "explicit",
            tags: ["local", "same-instance", "trusted"],
        },
        {
            name: "local-status",
            displayName: "Local status (read-only)",
            kind: "agent",
            version: "1.0",
            description: "只读 status 镜像：检查同实例服务可用性，无写入/执行副作用",
            url: "",
            capabilities: { effects: ["read"], agents: ["general"] },
            authentication: { type: "none", secretRef: "" },
            trust: "explicit",
            tags: ["local", "read-only", "trusted"],
        },
        {
            name: "local-memory",
            displayName: "Local memory (R4 project memory)",
            kind: "agent",
            version: "1.0",
            description: "只读 R4 project memory 语义镜像：dispatcher 注入式，默认未注入→服务不可用也合法",
            url: "",
            capabilities: { effects: ["read"], agents: ["knowledge"] },
            authentication: { type: "none", secretRef: "" },
            trust: "explicit",
            tags: ["local", "read-only", "trusted"],
        },
    ];
}

/**
 * The default same-instance trusted card set (3 cards), each normalised to the
 * canonical AgentCard shape. Import-safe and side-effect free.
 */
export function localTrustedCards() {
    return buildLocalTrustedCards().map((card) => normalizeAgentCard(card));
}

/**
 * A name→card registry instance. `registerCard` normalises + validates before
 * storing; re-registering an existing name overwrites it (with a warning). The
 * registry is declarative only — storing a card grants nothing by itself.
 */
export function createA2ARegistry({ cards = [] } = {}) {
    const store = new Map();

    function registerCard(rawCard) {
        const card = normalizeAgentCard(rawCard);
        const validation = validateAgentCard(card);
        if (!validation.ok) {
            throw codingError(
                "INVALID_AGENT_CARD",
                `invalid agent card: ${(validation.errors || []).join("; ")}`,
                400,
            );
        }
        const name = cleanName(card.name);
        if (!name) throw codingError("INVALID_AGENT_CARD", "agent card name is required", 400);
        if (store.has(name)) {
            console.warn(`[a2a][registry] re-registering agent card "${name}" — previous card overwritten`);
        }
        store.set(name, card);
        return card;
    }

    function listCards() {
        return Array.from(store.values());
    }

    function getCard(name) {
        return store.get(cleanName(name)) || null;
    }

    function names() {
        return Array.from(store.keys());
    }

    if (Array.isArray(cards)) {
        for (const card of cards) registerCard(card);
    }

    return { listCards, getCard, registerCard, names };
}

/**
 * Wire-safe card view for GET /a2a/cards: normalised card minus any `extra`
 * payload (which is server-internal and could carry arbitrary keys).
 */
export function sanitizeCardForWire(card) {
    const normalized = normalizeAgentCard(card);
    const { extra: _ignored, ...safe } = normalized;
    return safe;
}

export default {
    createA2ARegistry,
    localTrustedCards,
    sanitizeCardForWire,
};
