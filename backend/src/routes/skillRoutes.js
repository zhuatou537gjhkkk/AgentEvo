/**
 * Phase 7 / R5 (roadmap #1 + #2) — product Skills Runtime HTTP surface.
 *
 * Three read-only, authenticated endpoints over the skill registry:
 *   GET /skills          list of canonical manifests (declared fields only)
 *   GET /skills/:name    one manifest by exact name (404 SKILL_NOT_FOUND)
 *   GET /skills/match?q= deterministic matches [{name,version,score}]
 *
 * Everything is DEFAULT OFF (extensibility/flags.js SKILLS_ENABLED): while the
 * flag is dark the whole /skills tree answers 403 SKILLS_DISABLED and no skill
 * service is imported. Skills are process knowledge — they never execute tools,
 * so these routes only ever READ the registry.
 *
 * The service is resolved per request like the /rag registrar: an injected
 * dependency-bag `skillsService` first (createApp dependencies.services.
 * skillsService), then a lazy `import()` of the sibling module default. No
 * static import of the service here, so this file stays import-safe while the
 * feature is dark.
 *
 * NOT mounted by this file — the integrator registers registerSkillRoutes.
 */
import express from "express";
import { sendError, svcFn } from "./deps.js";
// Static import of the pure extensibility flags module (no side effects); the
// getter reads process.env per call, keeping the gate live at request time.
import { skillsEnabled } from "../extensibility/flags.js";

/** Manifest fields we expose over HTTP (keeps `extra` and internals private). */
const PUBLIC_FIELDS = [
    "id", "name", "description", "version", "schema", "workflow", "capability",
    "preset", "graph", "scope", "audit", "tags", "enabledByDefault", "module",
];

function toPublicSkill(skill) {
    if (!skill || typeof skill !== "object") return null;
    const out = {};
    for (const key of PUBLIC_FIELDS) {
        if (skill[key] !== undefined && skill[key] !== null) out[key] = skill[key];
    }
    return out;
}

function disabledResponse(req, res) {
    return res.status(403).json({
        ok: false,
        error: "SKILLS_DISABLED",
        errorCode: "SKILLS_DISABLED",
        message: "product skills runtime is disabled",
        retryable: false,
        requestId: req.requestId || null,
    });
}

function notFoundResponse(req, res, name) {
    return res.status(404).json({
        ok: false,
        error: "SKILL_NOT_FOUND",
        errorCode: "SKILL_NOT_FOUND",
        message: `skill not found: ${String(name || "").slice(0, 128)}`,
        retryable: false,
        requestId: req.requestId || null,
    });
}

/** Bag lookup that returns null instead of throwing when the dep is absent. */
function bagService(req, name) {
    try {
        return svcFn(req, name);
    } catch {
        return null;
    }
}

/**
 * Resolve the skills service: injected dependency-bag instance first, then the
 * lazy module default singleton (builtin registry).
 */
async function resolveSkillService(req) {
    const injected = bagService(req, "skillsService");
    if (injected) return injected;
    const mod = await import("../skills/service.js");
    return mod.defaultSkillsService || mod.default;
}

export function registerSkillRoutes(router, { requireAuth }) {
    const skills = express.Router();
    skills.use(requireAuth);
    skills.use((req, res, next) => {
        if (!skillsEnabled()) return disabledResponse(req, res);
        return next();
    });

    skills.get("/", async (req, res) => {
        try {
            const svc = await resolveSkillService(req);
            const names = svc.list().map((s) => s.name);
            const publicSkills = names
                .map((name) => toPublicSkill(svc.get(name)))
                .filter((s) => s !== null);
            return res.json({ ok: true, skills: publicSkills });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    skills.get("/match", async (req, res) => {
        try {
            const svc = await resolveSkillService(req);
            const q = String(req.query.q ?? req.query.query ?? "");
            const matches = svc.registry.match(q, { limit: 5 });
            return res.json({
                ok: true,
                matches: matches.map((m) => ({
                    name: m.skill.name,
                    version: m.skill.version,
                    score: m.score,
                })),
            });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    skills.get("/:name", async (req, res) => {
        try {
            const svc = await resolveSkillService(req);
            const name = String(req.params.name || "");
            const found = svc.get(name);
            if (!found) return notFoundResponse(req, res, name);
            return res.json({ ok: true, skill: toPublicSkill(found) });
        } catch (error) {
            return sendError(res, req.requestId, error);
        }
    });

    router.use("/skills", skills);
}
