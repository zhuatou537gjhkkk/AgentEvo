import { describe, expect, it } from "vitest";
import { createSkillRegistry } from "./registry.js";
import { builtinSkills } from "./builtin/index.js";

/**
 * Phase 7 / R5 (roadmap #1) — registry list/get/match contract. `match` must be
 * deterministic and hit the right builtin for both English and Chinese queries.
 */

function setup() {
    return createSkillRegistry();
}

describe("createSkillRegistry — list/get", () => {
    it("lists the five builtin skills in product order", () => {
        const registry = setup();
        const names = registry.list().map((s) => s.name);
        expect(names).toEqual([
            "repo-onboarding", "bug-fix", "add-tests", "explain-module", "review-diff",
        ]);
        expect(names.length).toBe(builtinSkills.length);
    });

    it("get returns a copy by exact name and undefined for unknown names", () => {
        const registry = setup();
        const skill = registry.get("bug-fix");
        expect(skill.name).toBe("bug-fix");
        expect(skill.capability.effects).toEqual(["read", "write"]);
        expect(registry.get("repo-onboarding")).toBeTruthy();
        expect(registry.get("nope-skill")).toBeUndefined();
        expect(registry.get("")).toBeUndefined();
    });

    it("list/get return copies so callers cannot mutate the registry", () => {
        const registry = setup();
        const first = registry.list()[0];
        first.name = "mutated";
        expect(registry.get("repo-onboarding")).toBeTruthy();
        expect(registry.get("mutated")).toBeUndefined();
        const got = registry.get("bug-fix");
        got.description = "changed";
        expect(registry.get("bug-fix").description).not.toBe("changed");
    });
});

describe("createSkillRegistry — match scoring", () => {
    it("hits bug-fix first for an English bug report query", () => {
        const registry = setup();
        const matches = registry.match("fix the login bug");
        expect(matches.length).toBeGreaterThan(0);
        expect(matches[0].skill.name).toBe("bug-fix");
        expect(matches[0].score).toBeGreaterThan(0);
        expect(matches[0].matchedTags).toEqual(expect.arrayContaining(["bug", "fix"]));
    });

    it("hits repo-onboarding first for a Chinese onboarding query", () => {
        const registry = setup();
        const matches = registry.match("这个新项目代码库怎么上手");
        expect(matches.length).toBeGreaterThan(0);
        expect(matches[0].skill.name).toBe("repo-onboarding");
        expect(matches[0].score).toBeGreaterThan(0);
    });

    it("hits bug-fix first for a Chinese bug report query", () => {
        const registry = setup();
        const matches = registry.match("帮我修复这个登录报错的 bug");
        expect(matches.length).toBeGreaterThan(0);
        expect(matches[0].skill.name).toBe("bug-fix");
    });

    it("returns matches sorted by score descending", () => {
        const registry = setup();
        // Both add-tests and bug-fix should score; add-tests should lead on
        // "tests", bug-fix on "bug".
        const matches = registry.match("add unit tests and fix a bug");
        expect(matches.length).toBeGreaterThanOrEqual(2);
        for (let i = 1; i < matches.length; i += 1) {
            expect(matches[i - 1].score).toBeGreaterThanOrEqual(matches[i].score);
        }
        expect(matches[0].score).toBeGreaterThan(0);
    });

    it("respects the limit option", () => {
        const registry = setup();
        const matches = registry.match("bug", { limit: 2 });
        expect(matches.length).toBeLessThanOrEqual(2);
    });

    it("returns an empty array when nothing matches (EN and ZH gibberish / empty)", () => {
        const registry = setup();
        expect(registry.match("zebra purple quantum 98123")).toEqual([]);
        expect(registry.match("紫罗兰星球探险记")).toEqual([]);
        expect(registry.match("")).toEqual([]);
        expect(registry.match("   ")).toEqual([]);
    });

    it("deterministic — identical queries yield identical ordering", () => {
        const registry = setup();
        const a = registry.match("为什么登录报错 想修复").map((m) => m.skill.name);
        const b = registry.match("为什么登录报错 想修复").map((m) => m.skill.name);
        expect(a).toEqual(b);
    });
});
