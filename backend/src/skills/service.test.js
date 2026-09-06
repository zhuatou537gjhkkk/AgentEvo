import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, initDB } from "../db/index.js";
import { defaultEventStore } from "../coding/events.js";
import { defaultRunService } from "../coding/runs.js";
import { clearCodingFlags } from "../coding/flags.js";
import { clearExtensibilityFlags } from "../extensibility/flags.js";
import { SkillsService, defaultSkillsService, renderSkillGuidance } from "./service.js";
import { builtinSkills } from "./builtin/index.js";

/**
 * Phase 7 / R5 (roadmap #1/#2) — SkillsService planning + audit contract.
 *
 * Planning is default-OFF: SKILLS_ENABLED unset → resolvePlanning returns null so
 * the legacy path is untouched. When enabled the service returns process-only
 * guidance + a skill packet and NEVER over-promises tool execution or extra
 * permission. auditActivation writes coding events (skill.activated /
 * skill.denied) best-effort behind CODING_EVENT_LOG_ENABLED and never throws.
 */

let scope;
let logSpy;

beforeAll(() => {
    initDB();
    const userId = createUser("Skill Service", "hash-svc");
    scope = { userId, tenantId: "user:" + userId };
});

beforeEach(() => {
    clearCodingFlags();
    clearExtensibilityFlags();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(() => {
    clearCodingFlags();
    clearExtensibilityFlags();
});

function bugFix() {
    return builtinSkills.find((s) => s.name === "bug-fix");
}

describe("resolvePlanning — default OFF (legacy path untouched)", () => {
    it("returns null for any input while SKILLS_ENABLED is unset", () => {
        clearExtensibilityFlags();
        expect(defaultSkillsService.resolvePlanning({ userInput: "帮我修复登录报错" })).toBe(null);
        expect(defaultSkillsService.resolvePlanning({ userInput: "fix the bug" })).toBe(null);
    });

    it("returns null even when the coding event flag is on (skills are independent)", () => {
        process.env.CODING_EVENT_LOG_ENABLED = "true";
        expect(defaultSkillsService.resolvePlanning({ userInput: "explain a module" })).toBe(null);
    });
});

describe("resolvePlanning — SKILLS_ENABLED on", () => {
    it("returns process-only guidance + a skill packet for a hit", () => {
        process.env.SKILLS_ENABLED = "true";
        const ref = bugFix();
        const result = defaultSkillsService.resolvePlanning({
            userInput: "帮我修复这个登录报错的 bug",
            intents: ["coding"],
            agent: "code",
        });

        expect(result).not.toBe(null);
        expect(result.matched[0]).toEqual({
            name: "bug-fix",
            version: ref.version,
            score: expect.any(Number),
        });

        // Guidance is Markdown and carries the mandated flow text.
        expect(typeof result.guidance).toBe("string");
        expect(result.guidance.includes(ref.workflow.title)).toBe(true);
        expect(result.guidance.includes(ref.workflow.steps[0].step)).toBe(true);
        expect(result.guidance.includes(ref.workflow.steps[0].goal)).toBe(true);
        expect(result.guidance.includes("本指引仅为流程/规则知识，不授予任何工具或额外权限")).toBe(true);

        // It must NOT promise execution, tool calls, writes, or extra authority.
        const overPromises = [
            "将调用工具", "将自动执行", "自动修复", "直接修改", "写入文件",
            "授予你", "代表你执行", "拥有写权限", "可以执行写", "将应用补丁",
        ];
        for (const phrase of overPromises) {
            expect(result.guidance.includes(phrase)).toBe(false);
        }
        expect(/(执行|调用|获得).{0,12}(工具|权限)/.test(result.guidance)).toBe(false);

        // Single planner packet tagged type:"skill".
        expect(result.packets).toHaveLength(1);
        expect(result.packets[0].content).toBe(result.guidance);
        expect(result.packets[0].metadata).toEqual({
            type: "skill",
            source: "bug-fix",
            version: ref.version,
        });
    });

    it("returns empty matched shape when nothing matches", () => {
        process.env.SKILLS_ENABLED = "true";
        const result = defaultSkillsService.resolvePlanning({ userInput: "zzz 99121 nothing here" });
        expect(result).toEqual({ matched: [], guidance: null, packets: [] });
    });

    it("returns empty matched shape for empty userInput", () => {
        process.env.SKILLS_ENABLED = "true";
        expect(defaultSkillsService.resolvePlanning({})).toEqual({ matched: [], guidance: null, packets: [] });
    });

    it("guidance is pure process text and never renders the agent/tool hints", () => {
        const guidance = renderSkillGuidance(bugFix());
        expect(guidance.includes("**流程指引（仅流程/规则/知识）：**")).toBe(true);
        expect(guidance.includes("agent")).toBe(false); // hint field never leaks
        expect(guidance.includes("tool")).toBe(false);
        expect(guidance.includes("# ")).toBe(true);
    });
});

describe("SkillsService — construction with a custom registry", () => {
    it("accepts an injected registry and forwards list/get", () => {
        const empty = {
            list: () => [],
            get: () => undefined,
            match: () => [],
        };
        const svc = new SkillsService({ registry: empty, now: () => new Date(0) });
        process.env.SKILLS_ENABLED = "true";
        expect(svc.list()).toEqual([]);
        expect(svc.get("x")).toBeUndefined();
        expect(svc.resolvePlanning({ userInput: "anything" }).matched).toEqual([]);
    });
});

describe("auditActivation — best-effort, no leaks, optional durable event", () => {
    it("logs a [skill] line but records nothing without a runId", async () => {
        const outcome = await defaultSkillsService.auditActivation(scope, {
            name: "bug-fix",
            version: "1.0.0",
            matched: true,
        });
        expect(outcome).toEqual({ recorded: false });
        expect(logSpy).toHaveBeenCalled();
        const line = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(line).toMatch(/\[skill\] name=bug-fix version=1\.0\.0 matched=true run=-/);
    });

    it("console line never prints reason or secrets", async () => {
        await defaultSkillsService.auditActivation(scope, {
            runId: null,
            name: "repo-onboarding",
            version: "1.0.0",
            matched: false,
            reason: "user typed a SECRET_TOKEN_XYZ in the denial reason",
        });
        const line = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(line.includes("SECRET_TOKEN_XYZ")).toBe(false);
        expect(line.includes("name=repo-onboarding")).toBe(true);
    });

    it("writes skill.activated / skill.denied coding events when runId + event log enabled", async () => {
        clearCodingFlags();
        clearExtensibilityFlags();
        // Run created while the log is dark so event_seq stays 0 (clean baseline).
        const run = defaultRunService.createRun(scope, { mode: "observe" });
        expect(run.eventSeq).toBe(0);

        process.env.CODING_EVENT_LOG_ENABLED = "true";

        const activated = await defaultSkillsService.auditActivation(scope, {
            runId: run.id, name: "bug-fix", version: "1.0.0", matched: true,
        });
        expect(activated).toEqual({ recorded: true });

        const denied = await defaultSkillsService.auditActivation(scope, {
            runId: run.id, name: "add-tests", version: "1.0.0", matched: false,
        });
        expect(denied).toEqual({ recorded: true });

        const events = defaultEventStore.listEvents(scope, run.id, {}).map((e) => e.type);
        expect(events).toEqual(["skill.activated", "skill.denied"]);
        const rows = defaultEventStore.listEvents(scope, run.id, {});
        expect(rows[0].payload).toEqual({ skill: "bug-fix", version: "1.0.0" });
        expect(rows[1].payload).toEqual({ skill: "add-tests", version: "1.0.0" });
    });

    it("records nothing when the coding event log flag is off", async () => {
        clearCodingFlags();
        const run = defaultRunService.createRun(scope, { mode: "observe" });
        const outcome = await defaultSkillsService.auditActivation(scope, {
            runId: run.id, name: "bug-fix", version: "1.0.0", matched: true,
        });
        expect(outcome).toEqual({ recorded: false });
        expect(defaultEventStore.listEvents(scope, run.id, {})).toEqual([]);
    });

    it("swallows store failures — an unknown run never breaks the caller", async () => {
        clearCodingFlags();
        process.env.CODING_EVENT_LOG_ENABLED = "true";
        const outcome = await defaultSkillsService.auditActivation(scope, {
            runId: "run_does_not_exist", name: "bug-fix", version: "1.0.0", matched: true,
        });
        expect(outcome).toEqual({ recorded: false });
    });
});
