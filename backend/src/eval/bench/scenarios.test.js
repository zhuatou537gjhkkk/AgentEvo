import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeBenchDir, rmBenchDir, buildBenchRepo } from "./fixtures.js";
import { BENCH_CATEGORIES, listScenarioIds, resolveScenario, validateCatalog, publicScenarioMeta } from "./scenarios.js";

/**
 * Phase 7 / R6 (roadmap #1 + DoD) — the scenario catalog is structurally sound and
 * every scenario's seed repo is reproducible at a FIXED revision. Building the same
 * scenario twice in different directories must yield the SAME commit SHA (git
 * identity + dates pinned), which is the "fixed repo revision" every bench run and
 * offline re-eval anchors to.
 */

const tmp = [];
const bases = [];

beforeAll(() => {
    // validate every scenario/golden once up front
    validateCatalog();
});

afterAll(() => {
    for (const dir of tmp) rmBenchDir(dir);
});

function scenarioBase(prefix) {
    const base = makeBenchDir(prefix);
    bases.push(base);
    return base;
}

describe("catalog integrity — 11 categories, goldens, unique ids", () => {
    it("covers all eleven R6 categories with unique ids and known drivers", () => {
        const ids = listScenarioIds();
        expect(new Set(ids).size).toBe(ids.length);
        const categories = ids.map((id) => resolveScenario(id).category);
        expect(new Set(categories).size).toBe(BENCH_CATEGORIES.length);
        for (const category of BENCH_CATEGORIES) {
            expect(categories).toContain(category);
        }
    });

    it("each scenario carries a full meta (goal/mode/flow/budget/expect)", () => {
        for (const id of listScenarioIds()) {
            const meta = publicScenarioMeta(resolveScenario(id));
            expect(meta.id).toBe(id);
            expect(meta.name.length).toBeGreaterThan(0);
            expect(meta.goal.length).toBeGreaterThan(0);
            expect(["observe", "edit", "trusted"]).toContain(meta.mode);
            expect(["auto", "approve", "reconnect", "cancel"]).toContain(meta.flow);
            expect(meta.goldenChecks.length).toBeGreaterThan(0);
            expect(meta.budget.maxTurns).toBeGreaterThan(0);
        }
    });

    it("command goldens declare an allowlist that actually includes the executable", () => {
        for (const id of listScenarioIds()) {
            const scenario = resolveScenario(id);
            for (const check of scenario.golden?.checks || []) {
                if (check.type === "command") {
                    expect(scenario.allowlist).toContain(check.executable);
                }
            }
        }
    });
});

describe("fixed-revision reproducibility — same scenario, same HEAD sha", () => {
    it("every scenario builds the identical seed revision twice", () => {
        for (const id of listScenarioIds()) {
            const scenario = resolveScenario(id);
            const baseA = scenarioBase(`agentevo-bench-sha-${id.replace(/[^a-z0-9-]/g, "")}-a-`);
            const baseB = scenarioBase(`agentevo-bench-sha-${id.replace(/[^a-z0-9-]/g, "")}-b-`);
            const a = buildBenchRepo(baseA, scenario.files);
            const b = buildBenchRepo(baseB, scenario.files);
            expect(a.headSha).toBeTruthy();
            expect(a.headSha).toHaveLength(40);
            expect(b.headSha).toBe(a.headSha);
            tmp.push(a.repoDir, b.repoDir);
        }
    }, 60_000);

    it("different scenarios produce different revisions", () => {
        const [idA, idB] = listScenarioIds();
        const a = buildBenchRepo(scenarioBase("agentevo-bench-diff-a-"), resolveScenario(idA).files);
        const b = buildBenchRepo(scenarioBase("agentevo-bench-diff-b-"), resolveScenario(idB).files);
        tmp.push(a.repoDir, b.repoDir);
        expect(a.headSha).not.toBe(b.headSha);
    });
});
