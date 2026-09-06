import { describe, expect, it } from "vitest";
import {
    SKILL_AGENT_HINTS, SKILL_EFFECTS, SKILL_GRAPH_NODES, SKILL_PRESETS,
    SKILL_SCOPES, SKILL_SCHEMA_VERSION, SKILL_TYPES,
    normalizeSkillManifest, validateSkillManifest, cleanSkillString,
} from "./manifest.js";
import { builtinSkills } from "./builtin/index.js";

/**
 * Phase 7 / R5 (roadmap #1/#2/#3) — manifest normalize/validate contract and the
 * structural completeness of the five builtin coding skills (#3).
 */

const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);
const US = String.fromCharCode(0x1f);
const DEL = String.fromCharCode(0x7f);

/** A valid canonical manifest to mutate per failing rule. */
function validManifest(overrides = {}) {
    return {
        id: "sample",
        name: "sample-skill",
        description: "A sample skill description.",
        version: "1.0.0",
        schema: SKILL_SCHEMA_VERSION,
        workflow: { title: "Sample", steps: [{ step: "Do the thing", goal: "Complete the thing" }] },
        capability: { effects: ["read"], agents: ["code"], types: ["coding"] },
        preset: "observe",
        graph: { nodes: ["code_agent"], send: "general_chat" },
        scope: "owner",
        audit: { events: ["skill.activated"], retentionDays: 90 },
        tags: ["sample"],
        enabledByDefault: false,
        ...overrides,
    };
}

describe("normalizeSkillManifest — defaults, cleaning, intersection", () => {
    it("fills every canonical field with safe defaults for an empty input", () => {
        const m = normalizeSkillManifest({});
        expect(m).toMatchObject({
            id: "",
            name: "",
            description: "",
            version: SKILL_SCHEMA_VERSION,
            schema: SKILL_SCHEMA_VERSION,
            preset: null,
            scope: "owner",
            enabledByDefault: false,
        });
        expect(m.workflow).toEqual({ title: "", steps: [] });
        expect(m.capability).toEqual({ effects: [], agents: [], types: [] });
        expect(m.graph).toEqual({ nodes: [], send: "" });
        expect(m.audit).toEqual({ events: [], retentionDays: 90 });
        expect(m.tags).toEqual([]);
        expect(m.extra).toBeUndefined();
    });

    it("strips control chars and truncates overlong user-controlled strings", () => {
        const dirty = "head" + NUL + SOH + US + String.fromCharCode(9) + "ok" + DEL;
        const m = normalizeSkillManifest({
            name: dirty + "x".repeat(300), // name cap is 128
            description: "a".repeat(5000), // description cap is 2000
        });
        expect(m.name.includes(NUL)).toBe(false);
        expect(m.name.includes(SOH)).toBe(false);
        expect(m.name.includes(US)).toBe(false);
        expect(m.name.includes(DEL)).toBe(false);
        expect(m.name.includes("ok")).toBe(true);
        expect(m.name.length).toBeLessThanOrEqual(128);
        expect(m.description.length).toBe(2000);
        expect(cleanSkillString("a" + NUL + "b", 10)).toBe("ab");
    });

    it("intersects effects/agents/types/graph nodes to the known vocabulary and de-dupes", () => {
        const m = normalizeSkillManifest({
            name: "x",
            capability: {
                effects: ["write", "read", "nuke", "read", "READ"],
                agents: ["code", "wizard", "code"],
                types: ["coding", "magic", "CODING"],
            },
            graph: { nodes: ["code_agent", "new_agent", "general_chat", "code_agent"], send: "general_chat" },
            scope: "planet", // unknown scope falls back to owner
        });
        expect(m.capability.effects).toEqual(["read", "write"]); // known order, de-duped
        expect(m.capability.agents).toEqual(["code"]);
        expect(m.capability.types).toEqual(["coding"]);
        expect(m.graph.nodes).toEqual(["code_agent", "general_chat"]);
        expect(m.scope).toBe("owner");
    });

    it("preset only keeps observe|edit|trusted, else null", () => {
        expect(normalizeSkillManifest({ name: "a", preset: "edit" }).preset).toBe("edit");
        expect(normalizeSkillManifest({ name: "a", preset: "TRUSTED" }).preset).toBe("trusted");
        expect(normalizeSkillManifest({ name: "a", preset: "trust" }).preset).toBe(null);
        expect(normalizeSkillManifest({ name: "a" }).preset).toBe(null);
    });

    it("workflow steps normalize to {step,goal,agent?,tool?,verify?} with hints-only agents", () => {
        const m = normalizeSkillManifest({
            name: "x",
            workflow: {
                title: "Flow",
                steps: [
                    "bare step string",
                    {
                        step: "Read code", goal: "Understand it", agent: "wizard", // not a hint → dropped
                        verify: "Done", tool: { tool: "web_search" },
                    },
                    { step: "Search", goal: "Find docs", agent: "knowledge" },
                ],
            },
        });
        expect(m.workflow.title).toBe("Flow");
        const [s1, s2, s3] = m.workflow.steps;
        expect(s1).toEqual({ step: "bare step string", goal: "" });
        expect(s2.step).toBe("Read code");
        expect(s2.goal).toBe("Understand it");
        expect(s2.agent).toBeUndefined(); // non-hint agent dropped
        expect(s2.tool).toBe("web_search"); // {tool:{...}} → tool name string
        expect(s2.verify).toBe("Done");
        expect(s3.agent).toBe("knowledge");
    });

    it("parks unknown top-level fields under extra but never credential-like keys", () => {
        const m = normalizeSkillManifest({
            name: "x",
            secretValue: "shhh",
            apiKey: "shhh2",
            pluginMeta: { color: "blue", nested: { note: "kept" } },
            tail: [1, 2, 3],
        });
        expect(m.extra).toBeDefined();
        expect(m.extra.pluginMeta).toEqual({ color: "blue", nested: { note: "kept" } });
        expect(m.extra.tail).toEqual([1, 2, 3]);
        expect(m.extra.secretValue).toBeUndefined();
        expect(m.extra.apiKey).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(m, "name")).toBe(true);
    });

    it("tags are cleaned, de-duped and capped at 16", () => {
        const many = Array.from({ length: 30 }, (_, i) => "tag-" + (i % 3)); // repeats after 3
        const m = normalizeSkillManifest({ name: "x", tags: [...many, "  spaced  ", "spaced"] });
        expect(m.tags.length).toBeLessThanOrEqual(16);
        expect(new Set(m.tags).size).toBe(m.tags.length);
        expect(m.tags).not.toContain("  spaced  ");
    });
});

describe("validateSkillManifest — each failure rule", () => {
    it("rejects non-object manifests", () => {
        expect(validateSkillManifest(null).ok).toBe(false);
        expect(validateSkillManifest("x").ok).toBe(false);
        expect(validateSkillManifest(42).ok).toBe(false);
    });

    it("requires a name matching the skill name pattern", () => {
        expect(validateSkillManifest(validManifest({ name: "" })).ok).toBe(false);
        expect(validateSkillManifest(validManifest({ name: "-bad" })).ok).toBe(false);
        expect(validateSkillManifest(validManifest({ name: "bad name" })).ok).toBe(false);
        const v = validateSkillManifest(validManifest({ name: "" }));
        expect(v.errors.join(" ")).toMatch(/name/);
    });

    it("requires a non-empty description", () => {
        const v = validateSkillManifest(validManifest({ description: "   " }));
        expect(v.ok).toBe(false);
        expect(v.errors.join(" ")).toMatch(/description/);
    });

    it("requires version of the form N.N or N.N.N", () => {
        const v = validateSkillManifest(validManifest({ version: "v1.0" }));
        expect(v.ok).toBe(false);
        expect(v.errors.join(" ")).toMatch(/version/);
    });

    it("requires a non-empty workflow.steps array", () => {
        expect(validateSkillManifest(validManifest({ workflow: { title: "x", steps: [] } })).ok).toBe(false);
        expect(validateSkillManifest(validManifest({ workflow: { title: "x" } })).ok).toBe(false);
        const v = validateSkillManifest(validManifest({ workflow: { title: "x", steps: [] } }));
        expect(v.errors.join(" ")).toMatch(/workflow\.steps/);
    });

    it("rejects audit.events that are not an array", () => {
        const v = validateSkillManifest(validManifest({ audit: { events: "skill.activated", retentionDays: 90 } }));
        expect(v.ok).toBe(false);
        expect(v.errors.join(" ")).toMatch(/audit\.events/);
    });

    it("rejects audit event types outside the lowercase dotted grammar", () => {
        const bad1 = validateSkillManifest(validManifest({ audit: { events: ["Bad.Type"], retentionDays: 90 } }));
        expect(bad1.ok).toBe(false);
        const bad2 = validateSkillManifest(validManifest({ audit: { events: ["has space"], retentionDays: 90 } }));
        expect(bad2.ok).toBe(false);
        const bad3 = validateSkillManifest(validManifest({ audit: { events: [7], retentionDays: 90 } }));
        expect(bad3.ok).toBe(false);
        const good = validateSkillManifest(
            validManifest({ audit: { events: [{ type: "skill.activated", on: "activated" }], retentionDays: 90 } }),
        );
        expect(good.ok).toBe(true);
    });

    it("requires capability.effects to stay inside the known vocabulary", () => {
        const v = validateSkillManifest(validManifest({ capability: { effects: ["explode"], agents: [], types: [] } }));
        expect(v.ok).toBe(false);
        expect(v.errors.join(" ")).toMatch(/unknown effect/);
    });

    it("accepts a fully valid canonical manifest", () => {
        expect(validateSkillManifest(validManifest())).toEqual({ ok: true, errors: [] });
    });
});

describe("builtin coding skills (#3) — validate + structure complete", () => {
    it("exports exactly five canonical manifests", () => {
        expect(builtinSkills).toHaveLength(5);
        expect(builtinSkills.map((s) => s.name)).toEqual([
            "repo-onboarding", "bug-fix", "add-tests", "explain-module", "review-diff",
        ]);
    });

    it("each builtin passes validateSkillManifest", () => {
        for (const skill of builtinSkills) {
            const v = validateSkillManifest(skill);
            expect(v, `${skill.name} errors: ${v.errors.join("; ")}`).toEqual({ ok: true, errors: [] });
        }
    });

    it("each builtin declares the full mandated manifest surface", () => {
        for (const skill of builtinSkills) {
            // version/schema/workflow/capability/preset/graph/scope/audit (#1)
            expect(skill.version).toMatch(/^\d+\.\d+(\.\d+)?$/);
            expect(skill.schema).toBe(SKILL_SCHEMA_VERSION);
            expect(typeof skill.workflow?.title).toBe("string");
            expect(skill.workflow.title.length).toBeGreaterThan(0);
            expect(Array.isArray(skill.workflow.steps)).toBe(true);
            expect(skill.workflow.steps.length).toBeGreaterThanOrEqual(3);
            expect(skill.workflow.steps.length).toBeLessThanOrEqual(6);
            for (const step of skill.workflow.steps) {
                expect(String(step.step).trim().length).toBeGreaterThan(0);
                expect(String(step.goal).trim().length).toBeGreaterThan(0);
                if (step.agent !== undefined) expect(SKILL_AGENT_HINTS).toContain(step.agent);
                if (step.tool !== undefined) expect(typeof step.tool).toBe("string");
            }
            expect(skill.capability).toBeDefined();
            expect(skill.capability.effects.length).toBeGreaterThan(0);
            for (const e of skill.capability.effects) expect(SKILL_EFFECTS).toContain(e);
            expect(skill.capability.agents.length).toBeGreaterThan(0);
            for (const a of skill.capability.agents) expect(SKILL_AGENT_HINTS).toContain(a);
            for (const t of skill.capability.types) expect(SKILL_TYPES).toContain(t);
            expect(SKILL_PRESETS).toContain(skill.preset);
            expect(SKILL_SCOPES).toContain(skill.scope);
            expect(Array.isArray(skill.graph.nodes)).toBe(true);
            for (const n of skill.graph.nodes) expect(SKILL_GRAPH_NODES).toContain(n);
            expect(typeof skill.audit?.retentionDays).toBe("number");
            expect(skill.audit.retentionDays).toBeGreaterThan(0);
            expect(Array.isArray(skill.audit.events)).toBe(true);
            expect(skill.audit.events).toContain("skill.activated");
            expect(Array.isArray(skill.tags)).toBe(true);
            expect(skill.tags.length).toBeGreaterThan(0);
            expect(typeof skill.enabledByDefault).toBe("boolean");
            expect(typeof skill.id).toBe("string");
        }
    });

    it("capabilities truthfully reflect read-only vs read+write coding flows", () => {
        const byName = Object.fromEntries(builtinSkills.map((s) => [s.name, s]));
        // read-only review/explore skills
        for (const name of ["repo-onboarding", "explain-module", "review-diff"]) {
            expect(byName[name].capability.effects).toEqual(["read"]);
            expect(byName[name].capability.agents).toEqual(["knowledge", "code"]);
            expect(byName[name].preset).toBe("observe");
        }
        // mutation skills honestly declare write intent + the edit preset
        for (const name of ["bug-fix", "add-tests"]) {
            expect(byName[name].capability.effects).toEqual(["read", "write"]);
            expect(byName[name].capability.agents).toEqual(["code"]);
            expect(byName[name].preset).toBe("edit");
        }
    });
});
