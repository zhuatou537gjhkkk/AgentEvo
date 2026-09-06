/**
 * Phase 7 / R5 (roadmap #7) — local trusted card registry tests (a2a/registry.test.js).
 *
 * Proves the three default local cards validate as canonical AgentCards and only
 * declare a CONTROLLED capability subset (the "同实例/本地可信 agent card 只暴露
 * 可控子集" demo), plus registration/overwrite/narrowing behaviour. Pure — no
 * flags / DB / network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createA2ARegistry, localTrustedCards, sanitizeCardForWire } from "./registry.js";
import { normalizeAgentCard, validateAgentCard, capabilitySubset, withinCapability, EFFECT_TYPES, KNOWN_AGENTS } from "../protocol/agentCard.js";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("localTrustedCards — 3 default local trusted cards", () => {
    it("returns three cards named agent-evo-self / local-status / local-memory", () => {
        const cards = localTrustedCards();
        expect(cards.map((c) => c.name).sort()).toEqual(["agent-evo-self", "local-memory", "local-status"]);
    });

    it("every card is a valid canonical AgentCard", () => {
        for (const card of localTrustedCards()) {
            expect(validateAgentCard(card).ok).toBe(true);
            expect(card.trust).toBe("explicit");
            expect(card.authentication.type).toBe("none");
        }
    });

    it("declares only the controllable read/knowledge subset (never write/exec)", () => {
        const byName = Object.fromEntries(localTrustedCards().map((c) => [c.name, c]));
        for (const name of ["agent-evo-self", "local-memory", "local-status"]) {
            const effects = byName[name].capabilities.effects;
            expect(effects).toEqual(["read"]);
            expect(effects.some((e) => ["write", "exec", "network", "external"].includes(e))).toBe(false);
        }
        expect(byName["local-status"].capabilities.agents).toEqual(["general"]);
        expect(byName["agent-evo-self"].capabilities.agents).toEqual(["knowledge"]);
        expect(byName["local-memory"].capabilities.agents).toEqual(["knowledge"]);
    });

    it("agent-evo-self (host mirror) exposes only its declared subset to capabilitySubset callers", () => {
        const self = localTrustedCards().find((c) => c.name === "agent-evo-self");
        // A caller asking for read+write only gets read back (narrowing never widens).
        const granted = capabilitySubset(self, { effects: ["read", "write"], agents: null });
        expect(granted.capabilities.effects).toEqual(["read"]);
        // And the host cannot claim an effect its own card never declared.
        expect(() => withinCapability(granted, { effects: ["write"] })).toThrowError(
            expect.objectContaining({ code: "CAPABILITY_NOT_GRANTED" }),
        );
    });
});

describe("createA2ARegistry — register / look up / overwrite", () => {
    it("starts empty and reports names + cards after registration", () => {
        const registry = createA2ARegistry();
        expect(registry.names()).toEqual([]);
        const registered = registry.registerCard({
            name: "local-echo",
            displayName: "Local echo",
            capabilities: { effects: ["read"], agents: ["general"] },
        });
        expect(registered.name).toBe("local-echo");
        expect(registry.names()).toEqual(["local-echo"]);
        expect(registry.getCard("local-echo").capabilities.effects).toEqual(["read"]);
    });

    it("seeds from constructor cards", () => {
        const registry = createA2ARegistry({ cards: localTrustedCards() });
        expect(registry.names()).toHaveLength(3);
        expect(registry.getCard("local-status")).not.toBeNull();
    });

    it("getCard returns null for an unknown card", () => {
        const registry = createA2ARegistry({ cards: localTrustedCards() });
        expect(registry.getCard("not-registered")).toBeNull();
    });

    it("re-registering an existing name overwrites it (with a warning)", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const registry = createA2ARegistry({ cards: localTrustedCards() });
        registry.registerCard({
            name: "local-status",
            displayName: "Local status v2",
            capabilities: { effects: ["read"], agents: ["general"] },
            version: "2.0",
        });
        expect(registry.getCard("local-status").version).toBe("2.0");
        expect(registry.getCard("local-status").displayName).toBe("Local status v2");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("local-status"));
    });

    it("rejects an invalid card (no name) with INVALID_AGENT_CARD", () => {
        const registry = createA2ARegistry();
        expect(() => registry.registerCard({ capabilities: { effects: ["read"] } })).toThrowError(
            expect.objectContaining({ code: "INVALID_AGENT_CARD", statusCode: 400 }),
        );
        expect(() => registry.registerCard(null)).toThrowError(expect.objectContaining({ code: "INVALID_AGENT_CARD" }));
    });

    it("normalizes unknown capability vocabulary away", () => {
        const registry = createA2ARegistry();
        registry.registerCard({
            name: "local-weird",
            capabilities: { effects: ["read", "teleport"], agents: ["general", "skynet"] },
        });
        const card = registry.getCard("local-weird");
        expect(card.capabilities.effects).toEqual(["read"]);
        expect(card.capabilities.agents).toEqual(["general"]);
    });
});

describe("sanitizeCardForWire — wire-safe card view", () => {
    it("strips the server-internal extra payload", () => {
        const registry = createA2ARegistry();
        registry.registerCard({
            name: "local-extra",
            capabilities: { effects: ["read"] },
            extra: { internalOnly: true, secretNote: "x" },
        });
        const wire = sanitizeCardForWire(registry.getCard("local-extra"));
        expect(wire.name).toBe("local-extra");
        expect(wire.extra).toBeUndefined();
        expect(JSON.stringify(wire)).not.toContain("secretNote");
    });

    it("leaves capability vocabulary and trust intact on the wire", () => {
        const wire = sanitizeCardForWire(normalizeAgentCard({
            name: "local-t",
            trust: "explicit",
            capabilities: { effects: ["read"], agents: ["knowledge"] },
        }));
        expect(wire.capabilities).toEqual({ effects: ["read"], agents: ["knowledge"] });
        expect(wire.trust).toBe("explicit");
        expect(EFFECT_TYPES).toContain("read");
        expect(KNOWN_AGENTS).toContain("knowledge");
    });
});
