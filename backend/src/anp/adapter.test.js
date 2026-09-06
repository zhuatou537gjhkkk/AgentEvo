import { describe, expect, it } from "vitest";
import {
    anpCardToIdentity,
    assertIdentityNotAuthorization,
    grantedCapabilityFor,
    identityOnly,
} from "./adapter.js";

const ANP_NOT_AUTHORIZED = "ANP_NOT_AUTHORIZED";

/**
 * Phase 7 / R5 (roadmap #9) — proof that ANP discovery is identity, never
 * authorization. A peer may advertise anything; only the server grant counts.
 */
function cardWith(name, effects, agents = []) {
    return { name, kind: "server", capabilities: { effects, agents } };
}

describe("anp.adapter identity helpers", () => {
    it("reduces a card to identity and keeps advertised capabilities display-only", () => {
        const identity = anpCardToIdentity(cardWith("peer", ["read", "exec"], ["search"]));
        expect(identity).toMatchObject({
            name: "peer", kind: "server", trust: "untrusted",
            advertisedCapabilities: { effects: ["read", "exec"], agents: ["search"] },
        });
    });

    it("identityOnly strips advertised capabilities to pure identification", () => {
        const identity = anpCardToIdentity(cardWith("peer", ["exec"]));
        const pure = identityOnly(identity);
        expect(pure).toEqual({ name: "peer", kind: "server", version: "1.0", trust: "untrusted", url: null });
        expect(pure.advertisedCapabilities).toBeUndefined();
    });
});

describe("anp.adapter grantedCapabilityFor (server grant only)", () => {
    const serverCards = {
        peer: cardWith("peer", ["read"]),
    };
    const trust = { trustedNames: ["peer"], cardsByTrust: serverCards };

    it("returns the normalized server card only for a trusted peer with an admin card", () => {
        const granted = grantedCapabilityFor("peer", trust);
        expect(granted).not.toBeNull();
        expect(granted.capabilities.effects).toEqual(["read"]);
    });

    it("returns null for untrusted peers, unknown cards, or absent grants", () => {
        expect(grantedCapabilityFor("peer", { trustedNames: [], cardsByTrust: serverCards })).toBeNull();
        expect(grantedCapabilityFor("stranger", trust)).toBeNull();
        expect(grantedCapabilityFor("peer", { trustedNames: ["peer"], cardsByTrust: {} })).toBeNull();
    });
});

describe("anp.adapter assertIdentityNotAuthorization (discovery ≠ authorization)", () => {
    const identity = { name: "peer", advertisedCapabilities: { effects: ["exec"] } };

    it("refuses when there is no server grant even though ANP identity exists", () => {
        expect(() => assertIdentityNotAuthorization(identity, null, { effects: ["read"] }))
            .toThrowError(expect.objectContaining({ code: ANP_NOT_AUTHORIZED, statusCode: 403 }));
    });

    it("refuses when an ANP-advertised exec is not backed by a grant", () => {
        // ANP says exec; the server never granted it.
        expect(() => assertIdentityNotAuthorization(identity, null, { effects: ["exec"] }))
            .toThrowError(expect.objectContaining({ code: ANP_NOT_AUTHORIZED }));
    });

    it("refuses a write task when the server grant only covers read", () => {
        const granted = grantedCapabilityFor("peer", {
            trustedNames: ["peer"],
            cardsByTrust: { peer: cardWith("peer", ["read"]) },
        });
        expect(() => assertIdentityNotAuthorization(identity, granted, { effects: ["write"] }))
            .toThrowError(expect.objectContaining({ code: ANP_NOT_AUTHORIZED }));
    });

    it("refuses exec claimed by ANP even when the trusted peer is granted read only", () => {
        const granted = grantedCapabilityFor("peer", {
            trustedNames: ["peer"],
            cardsByTrust: { peer: cardWith("peer", ["read"]) },
        });
        expect(() => assertIdentityNotAuthorization(identity, granted, { effects: ["exec"] }))
            .toThrowError(expect.objectContaining({ code: ANP_NOT_AUTHORIZED }));
    });

    it("allows a task inside the server grant", () => {
        const granted = grantedCapabilityFor("peer", {
            trustedNames: ["peer"],
            cardsByTrust: { peer: cardWith("peer", ["read"]) },
        });
        expect(assertIdentityNotAuthorization(identity, granted, { effects: ["read"], agents: [] })).toBe(true);
    });
});
