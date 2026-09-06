import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer } from "node:http";
import { registerSkillRoutes } from "./skillRoutes.js";
import { clearExtensibilityFlags } from "../extensibility/flags.js";

/**
 * Phase 7 / R5 (roadmap #1/#2) — /skills HTTP contract over a real server.
 *
 * The registrar is exercised standalone (it is not yet mounted in app.js): we
 * build a minimal express app, attach registerSkillRoutes with a requireAuth
 * STUB that injects req.userId / req.tenantId / req.requestId. Default OFF:
 * every /skills route is 403 SKILLS_DISABLED. With SKILLS_ENABLED the list /
 * get / match / 404 contract holds.
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

/** Stub auth: requires "Bearer x", then injects the owner scope + requestId. */
function requireAuthStub(req, res, next) {
    const auth = String(req.headers.authorization || "");
    if (!auth.startsWith("Bearer ")) {
        return res.status(401).json({
            ok: false,
            error: "UNAUTHORIZED",
            errorCode: "UNAUTHORIZED",
            message: "unauthorized",
            retryable: false,
            requestId: req.requestId || null,
        });
    }
    req.userId = 1;
    req.tenantId = "user:1";
    req.requestId = String(req.headers["x-request-id"] || "") || "req-test";
    return next();
}

function buildApp() {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerSkillRoutes(router, { requireAuth: requireAuthStub });
    app.use(router);
    return app;
}

async function get(base, path, headers = {}) {
    const response = await fetch(base + path, {
        headers: {
            Authorization: "Bearer 1",
            "X-Request-Id": "req-abc",
            ...headers,
        },
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: response.status, body: json, text };
}

describe("R5 /skills registrar — authentication gate", () => {
    it("401 without a bearer token on every /skills route", async () => {
        const base = await open(buildApp());
        for (const p of ["/skills", "/skills/bug-fix", "/skills/match?q=bug"]) {
            const response = await fetch(base + p);
            expect(response.status).toBe(401);
        }
    });
});

describe("R5 /skills registrar — default dark (SKILLS_ENABLED off)", () => {
    it("403 SKILLS_DISABLED on list / get / match with the exact envelope", async () => {
        clearExtensibilityFlags();
        const base = await open(buildApp());
        const paths = ["/skills", "/skills/bug-fix", "/skills/match?q=bug"];
        for (const p of paths) {
            const res = await get(base, p);
            expect(res.status).toBe(403);
            expect(res.body).toEqual({
                ok: false,
                error: "SKILLS_DISABLED",
                errorCode: "SKILLS_DISABLED",
                message: "product skills runtime is disabled",
                retryable: false,
                requestId: "req-abc",
            });
        }
    });
});

describe("R5 /skills registrar — SKILLS_ENABLED on", () => {
    it("GET /skills lists the five builtin manifests (declared fields only, no extra)", async () => {
        process.env.SKILLS_ENABLED = "true";
        const base = await open(buildApp());
        const res = await get(base, "/skills");
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.skills.map((s) => s.name)).toEqual([
            "repo-onboarding", "bug-fix", "add-tests", "explain-module", "review-diff",
        ]);
        const sample = res.body.skills.find((s) => s.name === "bug-fix");
        expect(sample).toBeTruthy();
        // Only the public declared manifest surface is exposed.
        expect(Object.keys(sample).sort()).toEqual([
            "audit", "capability", "description", "enabledByDefault", "graph",
            "id", "name", "preset", "schema", "scope", "tags", "version", "workflow",
        ]);
        expect(sample.capability.effects).toEqual(["read", "write"]);
        expect(Array.isArray(sample.workflow.steps)).toBe(true);
        expect(sample.workflow.steps.length).toBeGreaterThanOrEqual(3);
    });

    it("GET /skills/:name returns the single manifest, 404 SKILL_NOT_FOUND otherwise", async () => {
        process.env.SKILLS_ENABLED = "true";
        const base = await open(buildApp());

        const hit = await get(base, "/skills/explain-module");
        expect(hit.status).toBe(200);
        expect(hit.body.ok).toBe(true);
        expect(hit.body.skill.name).toBe("explain-module");
        expect(hit.body.skill.version).toBe("1.0.0");
        expect(hit.body.skill.audit.events).toContain("skill.activated");

        const miss = await get(base, "/skills/not-a-skill");
        expect(miss.status).toBe(404);
        expect(miss.body.ok).toBe(false);
        expect(miss.body.errorCode).toBe("SKILL_NOT_FOUND");
        expect(miss.body.retryable).toBe(false);
        expect(miss.body.requestId).toBe("req-abc");
    });

    it("GET /skills/match?q= returns deterministic {name,version,score} matches", async () => {
        process.env.SKILLS_ENABLED = "true";
        const base = await open(buildApp());
        const res = await get(base, "/skills/match?q=" + encodeURIComponent("fix the login bug"));
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.matches.length).toBeGreaterThan(0);
        expect(res.body.matches[0]).toEqual({
            name: "bug-fix",
            version: "1.0.0",
            score: expect.any(Number),
        });

        const empty = await get(base, "/skills/match?q=" + encodeURIComponent("zzz 99121"));
        expect(empty.status).toBe(200);
        expect(empty.body.matches).toEqual([]);
    });
});
