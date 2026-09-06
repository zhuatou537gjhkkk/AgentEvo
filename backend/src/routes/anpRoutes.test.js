import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import express from "express";
import { clearExtensibilityFlags } from "../extensibility/flags.js";
import { createAnpRegistry } from "../anp/registry.js";
import { registerAnpRoutes } from "./anpRoutes.js";

/**
 * Phase 7 / R5 (roadmap #9) — ANP discovery/identity HTTP surface. Default OFF:
 * 403 ANP_DISABLED while the flag is dark; when ON the routes expose trusted
 * identities only and resolve single names to PURE identity (never a grant).
 */
const servers = [];

async function open(app) {
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
    while (servers.length) {
        const server = servers.pop();
        await new Promise((resolve) => server.close(resolve));
    }
    clearExtensibilityFlags();
});

function makeApp(registry) {
    const app = express();
    app.locals.dependencies = { services: { anpRegistry: registry } };
    const router = express.Router();
    const requireAuth = (req, res, next) => {
        req.user = { id: 7, username: "owner", tenantId: "user:7" };
        req.requestContext = { userId: 7, tenantId: "user:7" };
        req.requestId = "req-anp-1";
        next();
    };
    registerAnpRoutes(router, { requireAuth });
    app.use(router);
    return app;
}

function makeRegistry() {
    const registry = createAnpRegistry({ trustedNames: ["agent-evo-self"] });
    registry.advertise("peer-trusted", {
        name: "peer-trusted", kind: "server", url: "https://peer-trusted.dev",
        capabilities: { effects: ["read"], agents: ["search"] },
    });
    registry.registerTrusted("peer-trusted");
    registry.advertise("evil", {
        name: "evil", kind: "agent", url: "https://evil.example",
        capabilities: { effects: ["exec"], agents: [] },
    });
    return registry;
}

async function get(base, path) {
    const response = await fetch(`${base}${path}`);
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: response.status, body: json };
}

describe("anpRoutes — default dark", () => {
    it("answers 403 ANP_DISABLED while ANP_ENABLED is unset", async () => {
        const base = await open(makeApp(makeRegistry()));
        for (const path of ["/anp/cards", "/anp/identity?name=peer-trusted"]) {
            const res = await get(base, path);
            expect(res.status).toBe(403);
            expect(res.body).toMatchObject({ ok: false, error: "ANP_DISABLED", errorCode: "ANP_DISABLED" });
        }
    });
});

describe("anpRoutes — enabled", () => {
    it("lists only trusted identities on /anp/cards", async () => {
        process.env.ANP_ENABLED = "true";
        const base = await open(makeApp(makeRegistry()));
        const res = await get(base, "/anp/cards");
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.count).toBe(2);
        const names = res.body.cards.map((c) => c.name).sort();
        expect(names).toEqual(["agent-evo-self", "peer-trusted"]);
        // The untrusted 'evil' advertisement is never listed as a trusted card.
        expect(names).not.toContain("evil");
    });

    it("resolves a trusted advertised peer to pure identity (no capabilities)", async () => {
        process.env.ANP_ENABLED = "true";
        const base = await open(makeApp(makeRegistry()));
        const res = await get(base, "/anp/identity?name=peer-trusted");
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            ok: true, name: "peer-trusted", advertised: true, trusted: true,
            identity: { name: "peer-trusted", kind: "server", trust: "trusted", url: "https://peer-trusted.dev" },
        });
        // identity surface never advertises capabilities (identity ≠ authorization).
        expect(res.body.identity.advertisedCapabilities).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toContain("exec");
    });

    it("resolves an untrusted advertised name as identity-only and clearly untrusted", async () => {
        process.env.ANP_ENABLED = "true";
        const base = await open(makeApp(makeRegistry()));
        const res = await get(base, "/anp/identity?name=evil");
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, name: "evil", advertised: true, trusted: false });
        expect(res.body.identity.trust).toBe("untrusted");
    });

    it("404s an unknown name and 400s a missing name", async () => {
        process.env.ANP_ENABLED = "true";
        const base = await open(makeApp(makeRegistry()));
        const notFound = await get(base, "/anp/identity?name=ghost");
        expect(notFound.status).toBe(404);

        const missing = await get(base, "/anp/identity");
        expect(missing.status).toBe(400);
        expect(missing.body).toMatchObject({ errorCode: "ANP_NAME_REQUIRED" });
    });
});
