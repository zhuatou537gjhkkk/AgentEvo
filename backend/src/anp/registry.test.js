import { describe, expect, it } from "vitest";
import { createAnpRegistry, defaultAnpRegistry } from "./registry.js";

/**
 * Phase 7 / R5 (roadmap #9) — ANP discovery/identity registry (default OFF).
 * Advertisement records identity only; trust is server-decided.
 */
function readCard(name) {
    return { name, kind: "server", capabilities: { effects: ["read"] }, url: `https://${name}.dev` };
}

describe("anp.registry advertise / resolve", () => {
    it("advertises a card and resolves identity without trusting it", () => {
        const registry = createAnpRegistry();
        const resolved = registry.advertise("peer-x", readCard("peer-x"));
        expect(resolved).toMatchObject({ name: "peer-x", advertised: true, trusted: false });
        expect(resolved.identity).toMatchObject({
            name: "peer-x", kind: "server", trust: "untrusted", url: "https://peer-x.dev",
            advertisedCapabilities: { effects: ["read"] },
        });

        const again = registry.resolveIdentity("peer-x");
        expect(again.trusted).toBe(false);
        expect(again.advertised).toBe(true);
        expect(again.identity.advertisedCapabilities.effects).toEqual(["read"]);
    });

    it("rejects an unknown / never-advertised name with no identity", () => {
        const registry = createAnpRegistry();
        expect(registry.resolveIdentity("nobody")).toEqual({
            name: "nobody", advertised: false, trusted: false, identity: null,
        });
    });

    it("rejects an invalid advertise name or card", () => {
        const registry = createAnpRegistry();
        expect(() => registry.advertise("p!x", readCard("p!x"))).toThrowError(expect.objectContaining({ code: "ANP_NAME_INVALID" }));
        expect(() => registry.advertise("peer", { description: "no name" })).toThrowError(expect.objectContaining({ code: "ANP_CARD_INVALID" }));
    });
});

describe("anp.registry trust is server-decided", () => {
    it("registerTrusted/forgetTrusted flips trust without touching the advertisement", () => {
        const registry = createAnpRegistry();
        registry.advertise("peer-x", readCard("peer-x"));
        registry.registerTrusted("peer-x");
        expect(registry.resolveIdentity("peer-x").trusted).toBe(true);
        expect(registry.resolveIdentity("peer-x").identity.trust).toBe("trusted");
        expect(registry.forgetTrusted("peer-x")).toBe(true);
        expect(registry.resolveIdentity("peer-x").trusted).toBe(false);
        expect(registry.resolveIdentity("peer-x").identity.trust).toBe("untrusted");
    });
});

describe("anp.registry list scoping", () => {
    it("lists only trusted identities by default; discovery alone is hidden", () => {
        const registry = createAnpRegistry({ trustedNames: ["trusted-a"] });
        registry.advertise("trusted-a", readCard("trusted-a"));
        registry.advertise("disco-b", { ...readCard("disco-b"), capabilities: { effects: ["exec"] } });

        const cards = registry.list();
        expect(cards.map((c) => c.name)).toEqual(["trusted-a"]);

        const all = registry.list({ onlyTrusted: false });
        expect(new Set(all.map((c) => c.name))).toEqual(new Set(["trusted-a", "disco-b"]));
        const disco = all.find((c) => c.name === "disco-b");
        expect(disco.trust).toBe("untrusted");
    });

    it("default registry only trusts the host itself", () => {
        expect(defaultAnpRegistry.resolveIdentity("agent-evo-self")).toMatchObject({
            name: "agent-evo-self", advertised: false, trusted: true, identity: null,
        });
        const cards = defaultAnpRegistry.list();
        expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject({ name: "agent-evo-self", trust: "trusted" });
    });
});
