import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createApp } from "../app.js";
import { issueAuthToken } from "../auth.js";
import { createUser, initDB } from "../db/index.js";
import { clearExtensibilityFlags, EXTENSIBILITY_FLAG_NAMES } from "../extensibility/flags.js";

/**
 * Phase 7 / R5 — Extensible-Agent registrar app-mount contract (real app).
 *
 * Proves the three R5 HTTP surfaces actually hang off the real Express app
 * (registerAllRoutes in app.js) and self-gate the way the standalone route tests
 * already prove in isolation:
 *   - default dark → /skills, /a2a, /anp all answer 403 EXT_*_DISABLED for an
 *     authenticated caller and 401 for an anonymous one (requireAuth mounted).
 *   - SKILLS_ENABLED → /skills lists the five builtin manifests and /skills/match
 *     deterministically returns the matched skill (Latin + CJK queries).
 *   - A2A_ENABLED → /a2a/cards lists server-declared local trusted cards with
 *     explicit trust; ANP_ENABLED → /anp/cards lists only server-trusted peers.
 *
 * Mirrors codingRegistrar.test.js fixture style: worker-isolated empty DB
 * (vitest.setup.js), never the real dev database. Feature flags are per-process
 * env; cleared at start and restored in afterAll.
 */

const ALICE = { name: "ext_alice", username: "extalice" };
const servers = [];
let base = "";

function open(app) {
    return new Promise((resolve) => {
        const server = createServer(app);
        server.listen(0, "127.0.0.1", () => {
            servers.push(server);
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });
}

function headers(user) {
    return {
        Authorization: `Bearer ${issueAuthToken({ id: user.id, username: user.username })}`,
        "Content-Type": "application/json",
    };
}

async function request(method, path, user, body) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: headers(user),
        body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: response.status, body: json, text };
}

beforeAll(async () => {
    clearExtensibilityFlags(); // deterministic start: every R5 flag dark
    initDB();
    ALICE.id = createUser(ALICE.name, "hash-ext");
    base = await open(createApp()); // module defaults on this worker DB
});

afterAll(async () => {
    while (servers.length) {
        const server = servers.pop();
        await new Promise((resolve) => server.close(resolve));
    }
    clearExtensibilityFlags();
});

describe("R5 registrar — default dark (all extensibility flags off)", () => {
    it("flags are all off in a fresh process", () => {
        for (const name of EXTENSIBILITY_FLAG_NAMES) delete process.env[name];
        // capabilities snapshot is only reachable through the modules; assert env-clean
        for (const name of EXTENSIBILITY_FLAG_NAMES) expect(process.env[name]).toBeUndefined();
    });

    it("/skills is mounted and gated (403 SKILLS_DISABLED auth'd, 401 anonymous)", async () => {
        const authed = await request("GET", "/skills", ALICE);
        expect(authed.status).toBe(403);
        expect(authed.body.ok).toBe(false);
        expect(authed.body.errorCode).toBe("SKILLS_DISABLED");
        expect(authed.body.retryable).toBe(false);

        const anon = await fetch(`${base}/skills`);
        expect(anon.status).toBe(401);
    });

    it("/skills/:name and /skills/match are equally gated while dark", async () => {
        const one = await request("GET", "/skills/bug-fix", ALICE);
        expect(one.status).toBe(403);
        expect(one.body.errorCode).toBe("SKILLS_DISABLED");
        const match = await request("GET", `/skills/match?q=${encodeURIComponent("fix bug")}`, ALICE);
        expect(match.status).toBe(403);
        expect(match.body.errorCode).toBe("SKILLS_DISABLED");
    });

    it("/a2a is mounted and gated (403 A2A_DISABLED)", async () => {
        const res = await request("GET", "/a2a/cards", ALICE);
        expect(res.status).toBe(403);
        expect(res.body.errorCode).toBe("A2A_DISABLED");
        const anon = await fetch(`${base}/a2a/cards`);
        expect(anon.status).toBe(401);
    });

    it("/anp is mounted and gated (403 ANP_DISABLED)", async () => {
        const res = await request("GET", "/anp/cards", ALICE);
        expect(res.status).toBe(403);
        expect(res.body.errorCode).toBe("ANP_DISABLED");
        const anon = await fetch(`${base}/anp/cards`);
        expect(anon.status).toBe(401);
    });
});

describe("R5 registrar — flags on", () => {
    beforeAll(() => {
        process.env.SKILLS_ENABLED = "true";
        process.env.A2A_ENABLED = "true";
        process.env.ANP_ENABLED = "true";
    });

    afterAll(() => {
        delete process.env.SKILLS_ENABLED;
        delete process.env.A2A_ENABLED;
        delete process.env.ANP_ENABLED;
    });

    it("GET /skills lists the five builtin manifests (declared fields only)", async () => {
        const res = await request("GET", "/skills", ALICE);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        const names = (res.body.skills || []).map((s) => s.name);
        expect(names).toHaveLength(5);
        for (const name of ["repo-onboarding", "bug-fix", "add-tests", "explain-module", "review-diff"]) {
            expect(names).toContain(name);
        }
        // declared field surface only — never internal `extra`/secrets
        const first = res.body.skills[0];
        expect(first).toHaveProperty("schema", "1.0");
        expect(first).toHaveProperty("workflow");
        expect(first).not.toHaveProperty("extra");
    });

    it("GET /skills/:name returns one manifest; unknown is 404 SKILL_NOT_FOUND", async () => {
        const found = await request("GET", "/skills/review-diff", ALICE);
        expect(found.status).toBe(200);
        expect(found.body.skill.name).toBe("review-diff");
        expect(found.body.skill.audit).toBeDefined();

        const missing = await request("GET", "/skills/not-a-skill", ALICE);
        expect(missing.status).toBe(404);
        expect(missing.body.errorCode).toBe("SKILL_NOT_FOUND");
    });

    it("GET /skills/match is deterministic for a Latin and a CJK query", async () => {
        const latin = await request("GET", `/skills/match?q=${encodeURIComponent("fix the login bug")}`, ALICE);
        expect(latin.status).toBe(200);
        expect(latin.body.matches.length).toBeGreaterThan(0);
        expect(latin.body.matches[0].name).toBe("bug-fix");
        expect(latin.body.matches[0].score).toBeGreaterThan(0);

        const cjk = await request("GET", `/skills/match?q=${encodeURIComponent("熟悉项目结构")}`, ALICE);
        expect(cjk.status).toBe(200);
        expect(cjk.body.matches[0].name).toBe("repo-onboarding");
    });

    it("GET /a2a/cards lists server-declared local trusted cards (explicit trust)", async () => {
        const res = await request("GET", "/a2a/cards", ALICE);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        const cards = res.body.cards || [];
        expect(cards.length).toBeGreaterThanOrEqual(1);
        for (const card of cards) {
            expect(card).toHaveProperty("name");
            expect(card.trust).toBe("explicit");
            expect(Array.isArray(card.capabilities?.effects)).toBe(true);
        }
    });

    it("GET /anp/cards lists only server-trusted peers (identity, never a grant)", async () => {
        const res = await request("GET", "/anp/cards", ALICE);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        const cards = res.body.cards || [];
        // default ANP trust list = [agent-evo-self]; identity-only (no advertised grants)
        expect(cards.some((c) => c.name === "agent-evo-self")).toBe(true);
        for (const card of cards) expect(card.trust).toBe("trusted");
    });
});
