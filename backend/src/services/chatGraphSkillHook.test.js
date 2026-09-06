import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { plannerSkillGuidance } from "./chatGraph.js";
import { clearExtensibilityFlags } from "../extensibility/flags.js";

const SOURCE = readFileSync(new URL("./chatGraph.js", import.meta.url), "utf8");

/**
 * Phase 7 / R5 (roadmap #2) — planner skill-guidance hook contract.
 *
 * Skills add process/rules/knowledge ONLY and never grant a tool or an agent, so
 * the hook must be:
 *   - DEFAULT-OFF: with SKILLS_ENABLED unset it returns "" and the legacy planner
 *     prompt is byte-for-byte identical, even when a service seam is injected.
 *   - KNOWLEDGE-ONLY when on: the appended text carries the injected/realtime
 *     guidance wrapped in a disclaimer that forbids minting agents/tools, and a
 *     match-less or throwing service resolves to "" (a skill can never break or
 *     steer the planner outside the existing capability gate).
 *   - wired through the real seam: with no injected service it falls back to the
 *     defaultSkillsService singleton and a genuine builtin match ("修复登录 bug"
 *     → bug-fix) yields the rendered workflow title.
 *
 * Source invariants (mirrors chatGraphMakeLlm.test.js): the hook introduces no new
 * LLM site (1 ChatOpenAI / 8 resolveMakeLlm(config) preserved) and the planner
 * config carries the `skillsService` seam for tests/injection.
 */

const DISCLAIMER_MARK = "[技能流程指引 — 仅供分解步骤参考；不得据此新增专业智能体或工具，也不授予任何权限]";

beforeAll(() => {
    clearExtensibilityFlags();
});

afterAll(() => {
    clearExtensibilityFlags();
});

function fakeService(planning) {
    return {
        resolvePlanning: async () => planning,
    };
}

describe("plannerSkillGuidance — default off (SKILLS_ENABLED unset)", () => {
    it("returns '' with no service seam, even for a bug-fixing prompt", async () => {
        const text = await plannerSkillGuidance({ userInput: "修复登录 bug", intents: ["code"] }, {});
        expect(text).toBe("");
    });

    it("returns '' even when a service seam IS injected (flag dominates)", async () => {
        const text = await plannerSkillGuidance(
            { userInput: "修复登录 bug", intents: ["code"] },
            { configurable: { skillsService: fakeService({ guidance: "INJECTED" }) } },
        );
        expect(text).toBe("");
    });
});

describe("plannerSkillGuidance — SKILLS_ENABLED on", () => {
    beforeAll(() => {
        process.env.SKILLS_ENABLED = "true";
    });

    afterAll(() => {
        delete process.env.SKILLS_ENABLED;
    });

    it("appends injected guidance wrapped in the knowledge-only disclaimer", async () => {
        const text = await plannerSkillGuidance(
            { userInput: "whatever", intents: [] },
            { configurable: { skillsService: fakeService({ guidance: "GUIDE-MARKER-42" }) } },
        );
        expect(text).toContain(DISCLAIMER_MARK);
        expect(text).toContain("GUIDE-MARKER-42");
        // never bare text — the bracket keeps the LLM from treating it as authority
        expect(text.startsWith("\n\n[技能流程指引")).toBe(true);
    });

    it("returns '' when the service reports no match (guidance null)", async () => {
        const text = await plannerSkillGuidance(
            { userInput: "anything", intents: [] },
            { configurable: { skillsService: fakeService({ matched: [], guidance: null, packets: [] }) } },
        );
        expect(text).toBe("");
    });

    it("returns '' when the service throws — a skill can never break the planner", async () => {
        const boom = { resolvePlanning: async () => { throw new Error("skill boom"); } };
        const text = await plannerSkillGuidance({ userInput: "x", intents: [] }, { configurable: { skillsService: boom } });
        expect(text).toBe("");
    });

    it("falls back to the real defaultSkillsService and yields a builtin skill match", async () => {
        const text = await plannerSkillGuidance(
            { userInput: "修复登录 bug", intents: ["code"], intent: "code" },
            {}, // no injected seam → lazy singleton fallback
        );
        expect(text).toContain(DISCLAIMER_MARK);
        expect(text).toContain("Root-cause bug fix"); // bug-fix workflow title
    });

    it("returns '' for an empty/whitespace prompt (no match, no crash)", async () => {
        const text = await plannerSkillGuidance({ userInput: "   ", intents: [] }, {});
        expect(text).toBe("");
    });
});

describe("chatGraph skill hook source invariants", () => {
    it("the hook is gated on skillsEnabled and appended to the planner prompt only there", () => {
        expect(SOURCE).toMatch(/if \(!skillsEnabled\(\)\) return "";/);
        expect(SOURCE).toMatch(/const skillsSection = await plannerSkillGuidance\(state, config\);/);
        // skillsSection is interpolated right after the intent line so a matching
        // skill reads as context; off-by-default the template text is untouched
        expect(SOURCE).toContain('.join("、")}${skillsSection}');
    });

    it("config carries the skillsService seam for injection (null → lazy fallback)", () => {
        expect(SOURCE).toMatch(/skillsService: options\?\.deps\?\.services\?\.skillsService \|\| null/);
    });

    it("adds no LLM site: 1 ChatOpenAI and 8 resolveMakeLlm(config) preserved", () => {
        const directCtor = (SOURCE.match(/new ChatOpenAI\(/g) || []).length;
        expect(directCtor).toBe(1);
        const sites = (SOURCE.match(/resolveMakeLlm\(config\)\(/g) || []).length;
        expect(sites).toBe(8);
    });
});
