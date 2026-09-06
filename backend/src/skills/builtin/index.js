/**
 * Phase 7 / R5 (roadmap #3) — first batch of product coding skills.
 *
 * Five manifests, each already normalized to the canonical shape (see
 * normalizeSkillManifest) and validate-clean. They are plain OBJECTS, not
 * factories — importing this module has no side effects and never touches the
 * network/DB/LLM.
 *
 * Each skill is process knowledge only (#2): it names read/write intent and an
 * existing agent hint, but grants nothing. `preset` states the minimum coding-run
 * preset the flow assumes (`observe` = read-only; `edit` = a write-capable run
 * the server must already have decided to allow). `audit.events` declares which
 * coding events the runtime records when the skill is used.
 *
 * Description + tags are chosen so real English AND Chinese user queries match:
 * e.g. repo-onboarding should be hit by "get familiar with this new codebase" or
 * "这个新项目代码库怎么上手", bug-fix by "fix the login bug" or "修复登录报错".
 */
import { normalizeSkillManifest } from "../manifest.js";

const shared = {
    schema: "1.0",
    version: "1.0.0",
    scope: "owner",
    enabledByDefault: true,
    audit: { events: ["skill.activated"], retentionDays: 90 },
};

/** Build + normalize each raw manifest once at module load (pure transform). */
function skill(raw) {
    return normalizeSkillManifest({ ...shared, ...raw });
}

export const builtinSkills = [
    skill({
        name: "repo-onboarding",
        description:
            "Onboard a new or unfamiliar codebase: read the repository layout, entry points and docs, " +
            "then summarise architecture and conventions before any edit. " +
            "适用于接手陌生代码库或新项目：先梳理目录结构、入口与关键模块，理解架构与工程约定，再决定改动范围。",
        tags: [
            "onboarding", "repo", "architecture", "codebase", "入门",
            "熟悉代码库", "新项目", "项目结构", "架构", "上手",
        ],
        capability: { effects: ["read"], agents: ["knowledge", "code"], types: ["coding"] },
        preset: "observe",
        graph: { nodes: ["knowledge_agent", "code_agent"], send: "general_chat" },
        workflow: {
            title: "Codebase onboarding",
            steps: [
                {
                    step: "Map the repository layout",
                    goal: "Read the top-level tree — README, package/manifest files and the src layout — to learn how the project is organised.",
                    agent: "knowledge",
                    verify: "You can name where entry points, configuration and tests live.",
                },
                {
                    step: "Read the entry points and docs",
                    goal: "Open the README/docs and the main entry module so the path from boot to a user-facing request is clear.",
                    agent: "code",
                },
                {
                    step: "Locate the core modules",
                    goal: "Identify the modules behind the main flows and note how they depend on one another.",
                    agent: "code",
                },
                {
                    step: "Record the conventions",
                    goal: "Note naming, error-handling and testing conventions you observe so later changes stay consistent.",
                    agent: "code",
                    verify: "A short convention list exists before any edit is proposed.",
                },
            ],
        },
    }),
    skill({
        name: "bug-fix",
        description:
            "Fix a bug in existing code: reproduce the failure, read the surrounding code, identify the " +
            "root cause, propose a minimal fix and verify it without unrelated rewrites. " +
            "定位并修复既有代码缺陷：先复现问题、再读相关代码、找到根因、给出最小改动并验证，避免顺手重写无关区域。",
        tags: [
            "bug", "fix", "debug", "defect", "修复", "报错", "排错", "调试", "缺陷", "故障",
        ],
        capability: { effects: ["read", "write"], agents: ["code"], types: ["coding"] },
        preset: "edit",
        graph: { nodes: ["code_agent"], send: "general_chat" },
        workflow: {
            title: "Root-cause bug fix",
            steps: [
                {
                    step: "Reproduce the failure",
                    goal: "Run the failing case or read the exact error so current behaviour is confirmed before anything changes.",
                    verify: "A concrete repro or error description exists.",
                },
                {
                    step: "Read the code around the failure",
                    goal: "Read the handler or function at the reported line plus its callers and tests to narrow the suspect range.",
                    agent: "code",
                    verify: "The suspect functions are identified by name.",
                },
                {
                    step: "Identify the root cause",
                    goal: "Explain why the behaviour diverges from intent — state, ordering, a boundary or a missing case — before editing.",
                    agent: "code",
                },
                {
                    step: "Propose the minimal fix",
                    goal: "Describe the smallest change that addresses the root cause without unrelated rewrites.",
                    agent: "code",
                    verify: "The change touches only the fault area.",
                },
                {
                    step: "Verify the fix",
                    goal: "Re-run the repro plus the adjacent tests to confirm the fix and check for regressions.",
                    verify: "The repro passes and no new failures appear.",
                },
            ],
        },
    }),
    skill({
        name: "add-tests",
        description:
            "Add tests for uncovered code: pick a coverage gap, follow the existing test framework and " +
            "conventions, write focused cases and run them. " +
            "为缺少覆盖的代码补测试：先找出未覆盖的函数或分支，沿用项目现有测试框架与命名约定，补充聚焦用例并运行验证。",
        tags: [
            "test", "tests", "testing", "coverage", "unit-test",
            "单元测试", "测试覆盖", "补测试", "测试用例", "测试",
        ],
        capability: { effects: ["read", "write"], agents: ["code"], types: ["coding"] },
        preset: "edit",
        graph: { nodes: ["code_agent"], send: "general_chat" },
        workflow: {
            title: "Add focused tests",
            steps: [
                {
                    step: "Find the coverage gap",
                    goal: "Identify a function or branch without tests, ideally tied to a recent fix or a reported behaviour.",
                    agent: "code",
                },
                {
                    step: "Read the existing tests",
                    goal: "Learn the project's test framework, file layout and naming conventions from the current specs.",
                    agent: "code",
                    verify: "The framework and conventions are named.",
                },
                {
                    step: "Write focused cases",
                    goal: "Add the smallest set of tests that cover the happy path plus the risky edge cases.",
                    agent: "code",
                    verify: "Each test asserts an observable outcome.",
                },
                {
                    step: "Run the suite",
                    goal: "Execute the new tests and the surrounding file so failures surface immediately.",
                    verify: "The new tests pass.",
                },
                {
                    step: "Report the coverage delta",
                    goal: "State which behaviours are now guarded and which remain untested.",
                    verify: "Remaining gaps are listed.",
                },
            ],
        },
    }),
    skill({
        name: "explain-module",
        description:
            "Explain a module: locate it, read its public API, trace one representative flow and relate it to " +
            "its callers, then summarise in plain language. " +
            "讲解某个模块：先定位模块文件，读懂其公开接口与签名，沿一条真实调用路径走通，再联系调用方，用通俗语言总结其职责与工作原理。",
        tags: [
            "explain", "module", "walkthrough", "explanation", "代码讲解", "模块", "讲解", "说明", "读代码", "工作原理",
        ],
        capability: { effects: ["read"], agents: ["knowledge", "code"], types: ["coding"] },
        preset: "observe",
        graph: { nodes: ["knowledge_agent", "code_agent"], send: "general_chat" },
        workflow: {
            title: "Explain a module",
            steps: [
                {
                    step: "Locate the module",
                    goal: "Find the module file and the exports and callers that define its public surface.",
                    agent: "code",
                },
                {
                    step: "Read the public API",
                    goal: "Read exports, signatures and doc comments to map the input-to-output contracts.",
                    agent: "knowledge",
                    verify: "The public symbols are listed.",
                },
                {
                    step: "Trace one representative flow",
                    goal: "Walk a single call path end to end so the explanation follows real execution rather than guesses.",
                    agent: "code",
                },
                {
                    step: "Relate it to the callers",
                    goal: "Note who calls the module and how a change here would ripple outward.",
                    agent: "knowledge",
                },
                {
                    step: "Summarise",
                    goal: "Write a plain-language explanation: responsibility, key functions, assumptions and how it connects to the rest of the code.",
                    verify: "The summary is grounded in the code that was actually read.",
                },
            ],
        },
    }),
    skill({
        name: "review-diff",
        description:
            "Review a code diff: read the changed files and the commit intent, check each hunk matches that " +
            "intent, scan for correctness risks and confirm test coverage, then summarise. " +
            "评审代码改动：先读 diff 与提交意图，核对每个变更块是否相符，检查正确性风险与测试覆盖，最后给出结论与必要的前置修改。",
        tags: [
            "review", "diff", "code-review", "pull-request", "审查", "评审", "代码评审", "改动", "差异",
        ],
        capability: { effects: ["read"], agents: ["knowledge", "code"], types: ["coding"] },
        preset: "observe",
        graph: { nodes: ["knowledge_agent", "code_agent"], send: "general_chat" },
        workflow: {
            title: "Review a diff",
            steps: [
                {
                    step: "Read the diff",
                    goal: "Open the changed files and lines plus the commit message to understand what was intended.",
                    agent: "code",
                    verify: "The set of changed files is listed.",
                },
                {
                    step: "Check the changes match the intent",
                    goal: "Compare each hunk against the stated goal so unrelated edits stand out.",
                    agent: "code",
                },
                {
                    step: "Look for correctness risks",
                    goal: "Scan the change for state, error-handling, boundary and concurrency concerns.",
                    agent: "code",
                    verify: "Risks — or their explicit absence — are stated per area.",
                },
                {
                    step: "Check test coverage of the change",
                    goal: "Confirm tests exist for the new behaviour, or note that a follow-up is required.",
                    agent: "knowledge",
                },
                {
                    step: "Summarise",
                    goal: "Deliver a short review: verdict, key risks and required changes before merge.",
                    verify: "The review lists explicit next steps.",
                },
            ],
        },
    }),
];

export default builtinSkills;
