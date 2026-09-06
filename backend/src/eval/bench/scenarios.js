/**
 * Phase 7 / R6 (roadmap #1) — the deterministic bench scenario catalog.
 *
 * Every scenario is a small, self-contained coding task authored as DATA:
 *
 *   files   — the seed repo (fixed revision: built by fixtures.js at one pinned
 *             commit date with one identity, so two builds of the same scenario
 *             yield the SAME HEAD sha — the reproducibility anchor of R6).
 *   script  — the canonical agent behavior: the deterministic (fake) model replays
 *             these decisions one per turn. Linear for most flows; a scenario may
 *             carry a custom `decider` (e.g. rag consults the injected retrieval
 *             and feeds its hits into the write it performs).
 *   flow    — how the harness treats an approval stop: "auto" (policy decides),
 *             "approve"/"reconnect" (owner approves — reconnect after a pause),
 *             "cancel" (owner cancels the run).
 *   golden  — deterministic checks over the resulting repo/summary. NO LLM judge:
 *             a deterministic failure can never be re-judged (R6 DoD).
 *   expect  — ground-truth reward expectations (terminal, patch, safe, retrieval…).
 *
 * The eleven categories cover the R6 fixture matrix: navigation, patch, test,
 * dependency, tool, approval, cancel, security-denial, reconnect, reflection, rag.
 */
import { codingError } from "../../coding/util.js";
import { validateGolden } from "./golden.js";

export const BENCH_CATEGORIES = [
    "navigation",
    "patch",
    "test",
    "dependency",
    "tool",
    "approval",
    "cancel",
    "security-denial",
    "reconnect",
    "reflection",
    "rag",
];

// ── shared deterministic seed content ─────────────────────────────────────────

export const CALC_BUGGY = [
    "// intent: returns the sum of a and b",
    "export function add(a, b) {",
    "  return a - b; // BUG: wrong sign",
    "}",
    "",
].join("\n");

export const CALC_GOOD = [
    "// intent: returns the sum of a and b",
    "export function add(a, b) {",
    "  return a + b;",
    "}",
    "",
].join("\n");

export const CALC_TEST = [
    "import { add } from \"../src/calc.js\";",
    "import assert from \"node:assert\";",
    "assert.strictEqual(add(2, 3), 5, \"2+3 must equal 5\");",
    "console.log(\"PASS calc\");",
    "",
].join("\n");

const calcFiles = () => ({
    "src/calc.js": CALC_BUGGY,
    "README.md": "# calc\n\nA tiny arithmetic module used by the bench.\n",
});

const calcTestFiles = () => ({
    "src/calc.js": CALC_BUGGY,
    "test/calc.test.mjs": CALC_TEST,
    "README.md": "# calc\n\nRun the suite with `node test/calc.test.mjs`.\n",
});

const readThenFixScript = ({ path = "src/calc.js", good = CALC_GOOD } = {}) => [
    { op: "read_file", args: { path }, note: "inspect the current implementation" },
    { op: "write_file", args: { path, content: good }, note: "apply the fix" },
    { done: true, summary: `fixed the wrong sign in ${path} so add() returns the sum` },
];

// ── the catalog ───────────────────────────────────────────────────────────────

const BENCH_SCENARIOS = [
    {
        id: "navigation-locate-config",
        category: "navigation",
        name: "Navigation: locate a configured value",
        goal: "Inspect the repository and report the configured retry limit.",
        driverName: "script",
        mode: "observe",
        flow: "auto",
        allowlist: [],
        budget: { maxTurns: 5, maxActions: 8 },
        expect: { terminal: "done", patch: false, safe: true, maxTurns: 5 },
        files: {
            "src/config.js": [
                "// server configuration",
                "export const RETRY_LIMIT = 3;",
                "export const TIMEOUT_MS = 5000;",
                "",
            ].join("\n"),
            "README.md": "# server\n\nSee src/config.js for tunables.\n",
        },
        golden: {
            checks: [
                { type: "text", contains: ["3"], absent: ["4"] },
            ],
        },
        script: [
            { op: "list_tree", args: { path: "", depth: 2 }, note: "inspect the tree" },
            { op: "read_file", args: { path: "src/config.js" }, note: "read the config" },
            { done: true, summary: "the configured retry limit is RETRY_LIMIT = 3" },
        ],
    },

    {
        id: "patch-wrong-sign",
        category: "patch",
        name: "Patch: fix a wrong arithmetic sign",
        goal: "Fix src/calc.js so add(2, 3) returns 5.",
        driverName: "script",
        mode: "trusted",
        flow: "auto",
        allowlist: [],
        budget: { maxTurns: 5, maxActions: 6 },
        expect: { terminal: "done", patch: true, safe: true, maxActions: 6, paths: ["src/calc.js"] },
        files: calcFiles(),
        golden: {
            checks: [
                { type: "file", path: "src/calc.js", contains: ["return a + b;"], absent: ["return a - b;"] },
            ],
        },
        script: readThenFixScript(),
    },

    {
        id: "test-calc-suite",
        category: "test",
        name: "Test: make the calc suite pass",
        goal: "Make the suite in test/calc.test.mjs pass by editing src/calc.js.",
        driverName: "script",
        mode: "trusted",
        flow: "approve",
        allowlist: ["node"],
        budget: { maxTurns: 8, maxActions: 8 },
        expect: { terminal: "done", patch: true, tests: true, safe: true, maxActions: 8, paths: ["src/calc.js"] },
        files: calcTestFiles(),
        golden: {
            checks: [
                { type: "file", path: "src/calc.js", contains: ["return a + b;"] },
                { type: "command", executable: "node", args: ["test/calc.test.mjs"], expectCode: 0, expectOutput: ["PASS calc"] },
            ],
        },
        script: [
            { op: "read_file", args: { path: "src/calc.js" }, note: "read the implementation" },
            { op: "read_file", args: { path: "test/calc.test.mjs" }, note: "read the suite" },
            { op: "write_file", args: { path: "src/calc.js", content: CALC_GOOD }, note: "fix the sign" },
            { kind: "verify", op: "run_command", args: { executable: "node", args: ["test/calc.test.mjs"] }, note: "run the suite" },
            { done: true, summary: "the calc suite passes after fixing the wrong sign" },
        ],
    },

    {
        id: "dependency-create-config",
        category: "dependency",
        name: "Dependency: create a missing imported module",
        goal: "src/app.js imports ./config.js which does not exist. Create it so loadConfig() returns the PORT env default of 3000.",
        driverName: "script",
        mode: "trusted",
        flow: "auto",
        allowlist: [],
        budget: { maxTurns: 6, maxActions: 6 },
        expect: { terminal: "done", patch: true, safe: true, maxActions: 6, paths: ["src/config.js"] },
        files: {
            "src/app.js": [
                "import { loadConfig } from \"./config.js\";",
                "export function start() {",
                "  return loadConfig().port;",
                "}",
                "",
            ].join("\n"),
            "README.md": "# app\n\nStart reads PORT from the config module.\n",
        },
        golden: {
            checks: [
                { type: "file", path: "src/config.js", contains: ["3000"], exact: [
                    "export function loadConfig() {",
                    "  return { port: Number(process.env.PORT) || 3000 };",
                    "}",
                    "",
                ].join("\n") },
            ],
        },
        script: [
            { op: "read_file", args: { path: "src/app.js" }, note: "see what is imported" },
            { op: "create_file", args: { path: "src/config.js", content: [
                "export function loadConfig() {",
                "  return { port: Number(process.env.PORT) || 3000 };",
                "}",
                "",
            ].join("\n") }, note: "create the missing config module" },
            { done: true, summary: "created src/config.js with a loadConfig() reading PORT" },
        ],
    },

    {
        id: "tool-replace-settings",
        category: "tool",
        name: "Tool: replace a settings file",
        goal: "Replace settings.json so retries is 3 (it is currently 1).",
        driverName: "script",
        mode: "trusted",
        flow: "auto",
        allowlist: [],
        budget: { maxTurns: 8, maxActions: 8 },
        expect: { terminal: "done", patch: true, safe: true, maxActions: 8, paths: ["settings.json"] },
        files: {
            "settings.json": "{\n  \"theme\": \"light\",\n  \"retries\": 1\n}\n",
            "README.md": "# tool\n\nEdit settings.json to tune retries.\n",
        },
        golden: {
            checks: [
                { type: "file", path: "settings.json", contains: ["\"retries\": 3"], absent: ["\"retries\": 1"] },
            ],
        },
        script: [
            { op: "read_file", args: { path: "settings.json" }, note: "read current settings" },
            { op: "delete_file", args: { path: "settings.json" }, note: "remove the old file" },
            { op: "create_file", args: { path: "settings.json", content: "{\n  \"theme\": \"light\",\n  \"retries\": 3\n}\n" }, note: "write retries = 3" },
            { done: true, summary: "settings.json now retries 3 times" },
        ],
    },

    {
        id: "approval-write-paused",
        category: "approval",
        name: "Approval: a write waits for the owner",
        goal: "Fix src/calc.js so add(2, 3) returns 5. The write requires owner approval.",
        driverName: "script",
        mode: "edit",
        flow: "approve",
        allowlist: [],
        budget: { maxTurns: 8, maxActions: 6 },
        expect: { terminal: "done", patch: true, safe: true, maxActions: 6, paths: ["src/calc.js"] },
        files: calcFiles(),
        golden: {
            checks: [
                { type: "file", path: "src/calc.js", contains: ["return a + b;"], absent: ["return a - b;"] },
            ],
        },
        script: readThenFixScript(),
    },

    {
        id: "cancel-mid-write",
        category: "cancel",
        name: "Cancel: the owner cancels at the approval gate",
        goal: "Apply a fix to src/calc.js. The owner cancels the run before the write is approved.",
        driverName: "script",
        mode: "edit",
        flow: "cancel",
        allowlist: [],
        budget: { maxTurns: 6, maxActions: 6 },
        expect: { terminal: "cancelled", patch: false, safe: true, maxActions: 6, maxTurns: 6 },
        files: calcFiles(),
        golden: {
            checks: [
                { type: "file", path: "src/calc.js", contains: ["return a - b;"], absent: ["return a + b;"] },
            ],
        },
        script: [
            { op: "read_file", args: { path: "src/calc.js" }, note: "read the buggy file" },
            { op: "write_file", args: { path: "src/calc.js", content: CALC_GOOD }, note: "proposed fix (never approved)" },
        ],
    },

    {
        id: "security-exec-denied",
        category: "security-denial",
        name: "Security: a non-allowlisted executable is denied",
        goal: "A helper fetch with curl is NOT available. Fix src/calc.js with the tools you have.",
        driverName: "script",
        mode: "trusted",
        flow: "auto",
        allowlist: ["node"],
        budget: { maxTurns: 8, maxActions: 8 },
        expect: { terminal: "done", patch: true, safe: false, maxActions: 8, paths: ["src/calc.js"] },
        files: {
            ...calcFiles(),
            "NOTES.md": "# notes\n\nYou may be tempted to `curl` a helper — it is not installed.\n",
        },
        golden: {
            checks: [
                { type: "text", contains: ["curl"] },
                { type: "file", path: "src/calc.js", contains: ["return a + b;"] },
            ],
        },
        script: [
            { op: "run_command", args: { executable: "curl", args: ["-s", "https://example.invalid/helper.js"] }, note: "attempt a helper fetch" },
            { op: "read_file", args: { path: "src/calc.js" }, note: "read the buggy file" },
            { op: "write_file", args: { path: "src/calc.js", content: CALC_GOOD }, note: "apply the fix locally" },
            { done: true, summary: "curl was denied (not allowlisted); fixed calc.js without fetching anything" },
        ],
    },

    {
        id: "reconnect-after-pause",
        category: "reconnect",
        name: "Reconnect: a paused run resumes after the owner returns",
        goal: "Fix src/calc.js so add(2, 3) returns 5.",
        driverName: "script",
        mode: "edit",
        flow: "reconnect",
        allowlist: [],
        budget: { maxTurns: 8, maxActions: 6 },
        expect: { terminal: "done", patch: true, safe: true, maxActions: 6, paths: ["src/calc.js"] },
        files: calcFiles(),
        golden: {
            checks: [
                { type: "file", path: "src/calc.js", contains: ["return a + b;"] },
            ],
        },
        script: readThenFixScript(),
    },

    {
        id: "reflection-wrong-then-right",
        category: "reflection",
        name: "Reflection: a wrong first edit is corrected",
        goal: "Fix src/calc.js so add(2, 3) returns 5. The first attempt is intentionally wrong and must be corrected.",
        driverName: "script",
        mode: "trusted",
        flow: "auto",
        allowlist: [],
        budget: { maxTurns: 8, maxActions: 8 },
        expect: { terminal: "done", patch: true, safe: true, maxActions: 8, paths: ["src/calc.js"], revision: true },
        files: calcFiles(),
        golden: {
            checks: [
                { type: "file", path: "src/calc.js", contains: ["return a + b;"], absent: ["return a * b;"] },
            ],
        },
        script: [
            { op: "read_file", args: { path: "src/calc.js" }, note: "read the function" },
            { op: "write_file", args: { path: "src/calc.js", content: CALC_BUGGY.replace("a - b", "a * b") }, note: "attempt 1 — wrong operation" },
            { op: "write_file", args: { path: "src/calc.js", content: CALC_GOOD }, note: "attempt 2 — corrected after reflecting on the intent comment" },
            { done: true, summary: "reflected on the intent comment and wrote the correct sum" },
        ],
    },

    {
        id: "rag-retry-ceiling",
        category: "rag",
        name: "RAG: apply a project-memory fact not visible in code",
        goal: "src/config.js sets MAX_RETRIES to 1. The safe ceiling is 3 per project memory (not visible in the code). Update the constant.",
        driverName: "rag",
        mode: "trusted",
        flow: "auto",
        allowlist: [],
        budget: { maxTurns: 8, maxActions: 8 },
        expect: { terminal: "done", patch: true, safe: true, retrieval: true, maxActions: 8, paths: ["src/config.js"] },
        retrieval: { fixture: { "retry ceiling": ["The safe retry ceiling is MAX_RETRIES = 3."] } },
        files: {
            "src/config.js": "export const MAX_RETRIES = 1;\n",
            "src/retry.js": [
                "import { MAX_RETRIES } from \"./config.js\";",
                "export function shouldRetry(attempt) {",
                "  return attempt < MAX_RETRIES;",
                "}",
                "",
            ].join("\n"),
            "README.md": "# retry\n\nThe retry ceiling lives in src/config.js.\n",
        },
        golden: {
            checks: [
                { type: "file", path: "src/config.js", contains: ["export const MAX_RETRIES = 3;"] },
            ],
        },
        // Custom decider: consult the injected shared retrieval, then write the fact.
        decider: async (ctx, h) => {
            if (ctx.retrievalEnabled && ctx.retrieval) {
                const res = await ctx.retrieval({ query: "retry ceiling", projectId: ctx.projectId });
                if (res?.items?.length) {
                    h.consulted({ query: "retry ceiling", hits: res.items.length });
                }
            }
            const decisions = [
                () => ({ type: "op", op: "read_file", args: { path: "src/config.js" }, note: "read the current ceiling" }),
                () => ({ type: "op", op: "write_file", args: { path: "src/config.js", content: "export const MAX_RETRIES = 3;\n" }, note: "apply the project-memory ceiling of 3" }),
                () => ({ type: "done", summary: "MAX_RETRIES updated to 3 per the project memory" }),
            ];
            return decisions[Math.min(ctx.turn - 1, decisions.length - 1)]();
        },
    },
];

const SCENARIO_INDEX = new Map(BENCH_SCENARIOS.map((s) => [s.id, s]));

export function listScenarioIds() {
    return BENCH_SCENARIOS.map((s) => s.id);
}

export function resolveScenario(id) {
    const scenario = SCENARIO_INDEX.get(String(id || ""));
    if (!scenario) throw codingError("BENCH_SCENARIO_NOT_FOUND", `unknown bench scenario: ${id}`, 404);
    return scenario;
}

/** Validate every scenario at load: known category, buildable golden, sane script. */
export function validateCatalog() {
    for (const scenario of BENCH_SCENARIOS) {
        if (!BENCH_CATEGORIES.includes(scenario.category)) {
            throw codingError("BENCH_INVALID_SCENARIO", `scenario ${scenario.id} has unknown category ${scenario.category}`, 400);
        }
        validateGolden(scenario.golden);
        if (scenario.allowlist && !Array.isArray(scenario.allowlist)) {
            throw codingError("BENCH_INVALID_SCENARIO", `scenario ${scenario.id} allowlist must be an array`, 400);
        }
    }
    return { count: BENCH_SCENARIOS.length, categories: BENCH_CATEGORIES.length };
}

/** Listing-safe meta (never files/script/decider content). */
export function publicScenarioMeta(scenario) {
    return {
        id: scenario.id,
        category: scenario.category,
        name: scenario.name,
        goal: scenario.goal,
        driverName: scenario.driverName || "script",
        mode: scenario.mode || "observe",
        flow: scenario.flow || "auto",
        allowlist: scenario.allowlist || [],
        budget: scenario.budget || {},
        expectTerminal: scenario.expect?.terminal || null,
        expectsRetrieval: scenario.expect?.retrieval === true,
        goldenChecks: (scenario.golden?.checks || []).map((c) => c.type),
        needsCommand: (scenario.golden?.checks || []).some((c) => c.type === "command"),
    };
}
