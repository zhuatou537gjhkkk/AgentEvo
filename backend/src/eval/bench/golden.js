/**
 * Phase 7 / R6 (roadmap #1) — deterministic golden checks for a bench scenario.
 *
 * A scenario's `golden.checks` describes, in a small declarative language, what a
 * correct agent must have produced. Checks are DETERMINISTIC and free of any LLM
 * judge (R6 DoD: a deterministic failure can never be flipped by a judge — the
 * golden is the ground truth). Supported check kinds:
 *
 *   { type: "text",    contains: string[], absent?: string[] }  against the run summary
 *   { type: "file",    path, contains: string[], absent?: string[],
 *                      exact?: string }                          against a repo file
 *   { type: "command", executable, args?: string[], cwd?: string,
 *                      expectCode?: number, expectOutput?: string[] }  run in the repo
 *
 * `runGoldenChecks` takes an injected `api` so it stays pure/testable and the
 * harness supplies the real file/process surface.
 */
import { codingError } from "../../coding/util.js";

const KNOWN_KINDS = new Set(["text", "file", "command"]);

export function validateGolden(golden = {}) {
    const checks = Array.isArray(golden?.checks) ? golden.checks : [];
    for (const check of checks) {
        if (!check || typeof check !== "object" || !KNOWN_KINDS.has(check.type)) {
            throw codingError("BENCH_INVALID_GOLDEN", `unsupported golden check kind: ${check?.type}`, 400);
        }
        if (check.type === "text" && !Array.isArray(check.contains) && !Array.isArray(check.absent)) {
            throw codingError("BENCH_INVALID_GOLDEN", "text golden check needs contains and/or absent", 400);
        }
        if (check.type === "file" && !check.path) {
            throw codingError("BENCH_INVALID_GOLDEN", "file golden check requires path", 400);
        }
        if (check.type === "command" && !check.executable) {
            throw codingError("BENCH_INVALID_GOLDEN", "command golden check requires executable", 400);
        }
    }
    return { ok: true, count: checks.length };
}

function assertContains(text, needles, label) {
    const failures = [];
    for (const needle of needles) {
        if (!String(text).includes(needle)) failures.push(`missing ${needle}`);
    }
    return failures;
}

function assertAbsent(text, needles, label) {
    const failures = [];
    for (const needle of needles) {
        if (String(text).includes(needle)) failures.push(`unexpected ${needle}`);
    }
    return failures;
}

function runOne(check, api) {
    if (check.type === "text") {
        const text = String(api?.summary ?? "");
        const failures = [
            ...assertContains(text, check.contains || [], "text"),
            ...assertAbsent(text, check.absent || [], "text"),
        ];
        return { label: check.label || "text", ok: failures.length === 0, detail: failures.join("; ") };
    }
    if (check.type === "file") {
        const content = String(api?.readFile ? api.readFile(check.path) : "");
        const failures = [
            ...assertContains(content, check.contains || [], "file"),
            ...assertAbsent(content, check.absent || [], "file"),
        ];
        if (check.exact != null && content !== String(check.exact)) {
            failures.push("content not exact");
        }
        return { label: check.label || `file:${check.path}`, ok: failures.length === 0, detail: failures.join("; ") };
    }
    if (check.type === "command") {
        if (typeof api?.runCommand !== "function") {
            return { label: check.label || "command", ok: false, detail: "no command api" };
        }
        let result;
        try {
            result = api.runCommand(check.executable, check.args || [], check.cwd || null);
        } catch (error) {
            return {
                label: check.label || "command",
                ok: false,
                detail: `command failed to run: ${String(error?.message || error).slice(0, 200)}`,
            };
        }
        const failures = [];
        if (check.expectCode != null && Number(result.code) !== Number(check.expectCode)) {
            failures.push(`expected exit ${check.expectCode}, got ${result.code}`);
        }
        failures.push(...assertContains(result.output || "", check.expectOutput || [], "command"));
        return {
            label: check.label || `command:${check.executable}`,
            ok: failures.length === 0,
            detail: failures.join("; ") || `exit ${result.code}`,
            output: result.output,
        };
    }
    return { label: "unknown", ok: false, detail: "unsupported check" };
}

/**
 * Run every golden check against a resolved `api`. Returns
 * { ok, checks: [{label, ok, detail}], firstFailure }.
 *
 * @param {{checks?: object[]}} golden
 * @param {{ summary: string, readFile: (relPath: string) => string,
 *          runCommand: (executable, args, cwd) => {code, output} }} api
 */
export function runGoldenChecks(golden = {}, api = {}) {
    const checks = Array.isArray(golden?.checks) ? golden.checks : [];
    const results = checks.map((check) => runOne(check, api));
    const failed = results.filter((r) => !r.ok);
    return { ok: failed.length === 0, checks: results, firstFailure: failed[0] || null };
}
