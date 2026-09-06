/**
 * Phase 7 / R2 — Structured command runner tests.
 *
 * Pure runner tests (no HTTP, no DB). Every command is spawned as a validated
 * `{ executable, args[], cwd, timeoutMs, outputLimit }` with `shell:false`; the
 * allowlist is enforced via the test override. Windows-portable throughout —
 * only `node` (on PATH) is ever executed. Long-running children are always
 * killed (timeout / cap overrun / cancel / tree kill) so no test leaks a stray
 * process; completion is awaited.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
    DEFAULT_COMMAND_LIMITS,
    DEFAULT_EXEC_ALLOWLIST,
    EXEC_TIMEOUT_MS,
    SECRET_ENV,
    ALLOWED_EXECUTABLE_RE,
    clearCommandAllowlistOverride,
    configuredCommandAllowlist,
    executeStructuredCommand,
    isCommandAllowed,
    killProcessTree,
    prepareCommand,
    runCommand,
    scrubbedCommandEnv,
    setCommandAllowlistOverride,
} from "./commandRunner.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond, timeoutMs = 3000) {
    const started = Date.now();
    while (!cond()) {
        if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
        await delay(10);
    }
}

/** Sync codingError checker for prepareCommand (it throws synchronously). */
function expectCodingError(fn, code, status) {
    try {
        fn();
    } catch (error) {
        expect(error.code).toBe(code);
        expect(error.statusCode).toBe(status);
        return;
    }
    throw new Error(`expected coding error ${code} (${status}) but none was thrown`);
}

/** Run the callback with `node` allowlisted; always restores the default. */
async function withNode(fn) {
    setCommandAllowlistOverride(["node"]);
    try {
        await fn();
    } finally {
        clearCommandAllowlistOverride();
    }
}

const INFINITE = "setInterval(()=>{},1e9)";

afterEach(() => {
    clearCommandAllowlistOverride();
    delete process.env.CODING_COMMAND_ALLOWLIST;
    delete process.env.MY_API_TOKEN;
});

describe("allowlist configuration", () => {
    it("defaults to [] (nothing allowed) and reads CODING_COMMAND_ALLOWLIST at call time", () => {
        expect(configuredCommandAllowlist()).toEqual([]);
        process.env.CODING_COMMAND_ALLOWLIST = "node, git   ; pnpm;;npx";
        expect(configuredCommandAllowlist()).toEqual(["node", "git", "pnpm", "npx"]);
    });

    it("the test override wins over env and can be cleared", () => {
        process.env.CODING_COMMAND_ALLOWLIST = "git";
        setCommandAllowlistOverride(["node"]);
        expect(configuredCommandAllowlist()).toEqual(["node"]);
        clearCommandAllowlistOverride();
        expect(configuredCommandAllowlist()).toEqual(["git"]);
    });

    it("isCommandAllowed requires both bare-name syntax and allowlist membership", () => {
        process.env.CODING_COMMAND_ALLOWLIST = "node, git";
        expect(isCommandAllowed("node")).toBe(true);
        expect(isCommandAllowed("git")).toBe(true);
        expect(isCommandAllowed("rm")).toBe(false);
        expect(isCommandAllowed("/usr/bin/env")).toBe(false);
        expect(isCommandAllowed("../bin/x")).toBe(false);
        expect(isCommandAllowed("C:\\x")).toBe(false);
        expect(isCommandAllowed("")).toBe(false);
        expect(isCommandAllowed("a b")).toBe(false);
    });

    it("ALLOWED_EXECUTABLE_RE and DEFAULT_COMMAND_LIMITS are as specced", () => {
        expect(ALLOWED_EXECUTABLE_RE.test("node")).toBe(true);
        expect(ALLOWED_EXECUTABLE_RE.test("python3")).toBe(true);
        expect(ALLOWED_EXECUTABLE_RE.test("cmd.exe")).toBe(true);
        expect(ALLOWED_EXECUTABLE_RE.test("..")).toBe(false);
        expect(ALLOWED_EXECUTABLE_RE.test(".")).toBe(false);
        expect(ALLOWED_EXECUTABLE_RE.test("/bin/ls")).toBe(false);
        expect(ALLOWED_EXECUTABLE_RE.test("a/b")).toBe(false);
        expect(Object.isFrozen(DEFAULT_COMMAND_LIMITS)).toBe(true);
        expect(DEFAULT_COMMAND_LIMITS.defaultTimeoutMs).toBe(30_000);
        expect(DEFAULT_COMMAND_LIMITS.maxTimeoutMs).toBe(300_000);
        expect(DEFAULT_COMMAND_LIMITS.defaultOutputLimit).toBe(256 * 1024);
        expect(DEFAULT_COMMAND_LIMITS.maxOutputLimit).toBe(1024 * 1024);
        expect(DEFAULT_COMMAND_LIMITS.maxArgs).toBe(256);
        expect(DEFAULT_COMMAND_LIMITS.maxArgLength).toBe(4096);
        expect(DEFAULT_COMMAND_LIMITS.maxExecutableLength).toBe(64);
    });
});

describe("prepareCommand validation", () => {
    it("rejects non-allowlisted executables with COMMAND_NOT_ALLOWED", () => {
        expectCodingError(() => prepareCommand({ executable: "rm" }), "COMMAND_NOT_ALLOWED", 403);
        expectCodingError(() => prepareCommand({ executable: "bash", args: ["-c", "whoami"] }), "COMMAND_NOT_ALLOWED", 403);
        expectCodingError(() => prepareCommand({ executable: "cmd.exe", args: ["/c", "whoami"] }), "COMMAND_NOT_ALLOWED", 403);
        // python3 -c style misuse: python3 is a valid bare name, just not allowlisted.
        expectCodingError(() => prepareCommand({ executable: "python3", args: ["-c", "print(1)"] }), "COMMAND_NOT_ALLOWED", 403);
        // a per-call allowlist replaces the configured one: node allowed, git not.
        setCommandAllowlistOverride(["node"]);
        try {
            expect(prepareCommand({ executable: "node", args: ["-v"] }, { allowlist: ["node"] }).executable).toBe("node");
            expectCodingError(() => prepareCommand({ executable: "git" }), "COMMAND_NOT_ALLOWED", 403);
        } finally {
            clearCommandAllowlistOverride();
        }
    });

    it("rejects syntactically invalid executables and malformed input with INVALID_COMMAND", () => {
        setCommandAllowlistOverride(["node"]); // so malformed-arg cases reach arg/cwd validation
        try {
            expectCodingError(() => prepareCommand({ executable: "../bin/x" }), "INVALID_COMMAND", 400);
            expectCodingError(() => prepareCommand({ executable: "/usr/bin/env" }), "INVALID_COMMAND", 400);
            expectCodingError(() => prepareCommand({ executable: "C:\\x" }), "INVALID_COMMAND", 400);
            expectCodingError(() => prepareCommand({ executable: "" }), "INVALID_COMMAND", 400);
            expectCodingError(() => prepareCommand({ executable: "a b" }), "INVALID_COMMAND", 400);
            expectCodingError(() => prepareCommand({ executable: "node", args: [42] }), "INVALID_COMMAND", 400); // non-string arg
            expectCodingError(() => prepareCommand({ executable: "node", args: "nope" }), "INVALID_COMMAND", 400); // args not array
            expectCodingError(() => prepareCommand("node"), "INVALID_COMMAND", 400); // non-object input
            expectCodingError(() => prepareCommand(null), "INVALID_COMMAND", 400);
            expectCodingError(() => prepareCommand({ executable: "node", args: ["x".repeat(4097)] }), "INVALID_COMMAND", 400); // arg too long
            expectCodingError(() => prepareCommand({ executable: "node", args: Array.from({ length: 257 }, () => "a") }), "INVALID_COMMAND", 400); // too many args
            expectCodingError(() => prepareCommand({ executable: "node", cwd: "x".repeat(513) }), "INVALID_COMMAND", 400); // cwd too long
            expectCodingError(() => prepareCommand({ executable: "node", cwd: 123 }), "INVALID_COMMAND", 400); // non-string cwd
            expectCodingError(() => prepareCommand({ executable: "n".repeat(65) }), "INVALID_COMMAND", 400); // executable too long
        } finally {
            clearCommandAllowlistOverride();
        }
    });

    it("accepts an allowlisted executable, normalizes cwd type and clamps limits", () => {
        setCommandAllowlistOverride(["node"]);
        try {
            const prepped = prepareCommand({
                executable: "node",
                args: ["-e", "x"],
                cwd: "some/path", // NOT resolved here — caller validates containment
                timeoutMs: 500,     // clamped up to the 1000ms floor
                outputLimit: 6000,  // clamped up to the 4096 floor? no: 6000 >= 4096 stays
            });
            expect(prepped).toEqual({ executable: "node", args: ["-e", "x"], timeoutMs: 1000, outputLimit: 6000 });

            const defaults = prepareCommand({ executable: "node" });
            expect(defaults.timeoutMs).toBe(DEFAULT_COMMAND_LIMITS.defaultTimeoutMs);
            expect(defaults.outputLimit).toBe(DEFAULT_COMMAND_LIMITS.defaultOutputLimit);

            // absurd values clamp to the ceilings; never throws.
            const capped = prepareCommand({ executable: "node", timeoutMs: 9e9, outputLimit: 9e9 });
            expect(capped.timeoutMs).toBe(DEFAULT_COMMAND_LIMITS.maxTimeoutMs);
            expect(capped.outputLimit).toBe(DEFAULT_COMMAND_LIMITS.maxOutputLimit);

            const floored = prepareCommand({ executable: "node", timeoutMs: 1, outputLimit: 1 });
            expect(floored.timeoutMs).toBe(1000);
            expect(floored.outputLimit).toBe(4096);

            // "" cwd is allowed (caller resolves it to process.cwd()).
            expect(prepareCommand({ executable: "node", cwd: "" }).executable).toBe("node");
        } finally {
            clearCommandAllowlistOverride();
        }
    });
});

describe("runCommand execution", () => {
    it("executes an allowlisted command and streams its stdout", async () => {
        await withNode(async () => {
            const res = await runCommand({
                executable: "node",
                args: ["-e", "console.log('hello command')"],
                timeoutMs: 15_000,
            });
            expect(res.ok).toBe(true);
            expect(res.exitCode).toBe(0);
            expect(res.timedOut).toBe(false);
            expect(res.truncated).toBe(false);
            expect(res.stdout).toContain("hello command");
            expect(res.byteLength).toBeGreaterThan(0);
        });
    });

    it("surfaces a non-zero exit with stderr without rejecting", async () => {
        await withNode(async () => {
            const res = await runCommand({
                executable: "node",
                args: ["-e", "console.error('boom'); process.exit(3)"],
            });
            expect(res.ok).toBe(true);
            expect(res.exitCode).toBe(3);
            expect(res.stderr).toContain("boom");
            expect(res.timedOut).toBe(false);
        });
    });

    it("kills the child when stdout overruns the output limit and truncates", async () => {
        await withNode(async () => {
            const res = await runCommand({
                executable: "node",
                args: ["-e", "for(let i=0;i<1e6;i++) console.log('x'.repeat(200))"],
                outputLimit: 8192,
                timeoutMs: 15_000,
            });
            expect(res.truncated).toBe(true);
            expect(res.ok).toBe(true);
            expect(res.exitCode).toBe(null);
            expect(res.byteLength).toBeLessThanOrEqual(9000);
        });
    });

    it("times out a hung child and resolves with timedOut, not a rejection", async () => {
        await withNode(async () => {
            const res = await runCommand({
                executable: "node",
                args: ["-e", INFINITE],
                timeoutMs: 500,
            });
            expect(res.timedOut).toBe(true);
            expect(res.exitCode).toBe(null);
            expect(res.ok).toBe(true);
            expect(res.durationMs).toBeGreaterThanOrEqual(400);
        });
    });

    it("cancel() stops a long-running child promptly", async () => {
        await withNode(async () => {
            let p;
            try {
                p = runCommand({ executable: "node", args: ["-e", INFINITE], timeoutMs: 30_000 });
                expect(typeof p.cancel).toBe("function");
                await waitFor(() => p.childPid > 0);
                expect(p.childPid).toBeGreaterThan(0);
                await delay(150);
                const started = Date.now();
                p.cancel();
                const res = await p;
                expect(Date.now() - started).toBeLessThan(5_000);
                expect(res.timedOut === true || res.exitCode === null).toBe(true);
            } finally {
                // No stray child even if an assertion above failed mid-flight.
                if (p && typeof p.cancel === "function") p.cancel();
            }
        });
    });

    it("kills the whole process tree (a grandchild too) on timeout", async () => {
        await withNode(async () => {
            const script =
                "const{spawn}=require('child_process');" +
                "const c=spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{stdio:'ignore',windowsHide:true});" +
                "console.log('GRANDCHILD='+c.pid);" +
                "setInterval(()=>{},1e9);";
            const p = runCommand({ executable: "node", args: ["-e", script], timeoutMs: 800 });
            const res = await p;
            expect(res.timedOut).toBe(true);
            const m = String(res.stdout).match(/GRANDCHILD=(\d+)/);
            expect(m).toBeTruthy();
            const grandPid = Number(m[1]);
            expect(grandPid).toBeGreaterThan(0);

            // taskkill /T can take a beat on win32 — settle before asserting.
            await delay(200);
            const alive = (pid) => {
                try { process.kill(pid, 0); return true; } catch { return false; }
            };
            let grandAlive = alive(grandPid);
            if (process.platform === "win32" && grandAlive) {
                await delay(500);
                grandAlive = alive(grandPid);
            }
            expect(grandAlive).toBe(false);
            // At minimum the direct child is gone (it is the one runCommand closed on).
            expect(alive(p.childPid)).toBe(false);
        });
    });

    it("does not leak secret-like env vars to the child", async () => {
        process.env.MY_API_TOKEN = "should-not-leak";
        await withNode(async () => {
            const res = await runCommand({
                executable: "node",
                args: [
                    "-e",
                    "console.log(Object.keys(process.env).filter(k=>/token|secret|key/i.test(k)).join(','))",
                ],
            });
            expect(res.exitCode).toBe(0);
            expect(res.stdout).not.toContain("MY_API_TOKEN");
        });
    });

    it("rejects COMMAND_FAILED_TO_START when the executable cannot be spawned", async () => {
        setCommandAllowlistOverride(["definitely_missing_bin_9f3"]);
        try {
            await expect(
                runCommand({ executable: "definitely_missing_bin_9f3", args: [], timeoutMs: 5_000 }),
            ).rejects.toMatchObject({ code: "COMMAND_FAILED_TO_START", statusCode: 422 });
        } finally {
            clearCommandAllowlistOverride();
        }
    });

    it("surfaces prepareCommand failures as a rejection, not a sync throw", async () => {
        await expect(runCommand({ executable: "rm" })).rejects.toMatchObject({
            code: "COMMAND_NOT_ALLOWED",
            statusCode: 403,
        });
    });
});

describe("executeStructuredCommand (executor layer)", () => {
    it("defaults and reference allowlist are exported for the runner layer", () => {
        expect(EXEC_TIMEOUT_MS).toBe(DEFAULT_COMMAND_LIMITS.defaultTimeoutMs);
        expect(Array.isArray(DEFAULT_EXEC_ALLOWLIST)).toBe(true);
        expect(DEFAULT_EXEC_ALLOWLIST).toContain("node");
        expect(Object.isFrozen(DEFAULT_EXEC_ALLOWLIST)).toBe(true);
    });

    it("resolves { code, stdout, stderr, ... } on a normal run and on non-zero exit", async () => {
        await withNode(async () => {
            const ok = await executeStructuredCommand({ executable: "node", args: ["-e", "console.log('exec hi')"] });
            expect(ok.code).toBe(0);
            expect(ok.stdout).toContain("exec hi");
            expect(ok.timedOut).toBe(false);
            expect(ok.cancelled).toBe(false);
            expect(ok.durationMs).toBeGreaterThanOrEqual(0);

            const boom = await executeStructuredCommand({
                executable: "node",
                args: ["-e", "console.error('kaboom'); process.exit(7)"],
            });
            expect(boom.code).toBe(7);
            expect(boom.stderr).toContain("kaboom");
            expect(boom.truncated).toBe(false);
        });
    });

    it("caps each stream at outputLimitBytes and marks truncated", async () => {
        await withNode(async () => {
            const res = await executeStructuredCommand({
                executable: "node",
                args: [
                    "-e",
                    "for(let i=0;i<1e6;i++){console.log('o'.repeat(200));console.error('e'.repeat(200));}",
                ],
                outputLimitBytes: 8192,
            });
            expect(res.truncated).toBe(true);
            expect(res.code).toBe(null);
            expect(Buffer.byteLength(res.stdout, "utf8")).toBeLessThanOrEqual(9000);
            expect(Buffer.byteLength(res.stderr, "utf8")).toBeLessThanOrEqual(9000);
        });
    });

    it("kills the process tree on external AbortSignal cancel", async () => {
        await withNode(async () => {
            const controller = new AbortController();
            let p;
            try {
                p = executeStructuredCommand({
                    executable: "node",
                    args: ["-e", INFINITE],
                    signal: controller.signal,
                });
                await delay(150);
                const started = Date.now();
                controller.abort();
                const res = await p;
                expect(Date.now() - started).toBeLessThan(5_000);
                expect(res.cancelled).toBe(true);
                expect(res.code).toBe(null);
            } finally {
                controller.abort(); // no stray child even if an assertion failed
            }
        });
    });

    it("rejects codingError on spawn failure / missing executable", async () => {
        setCommandAllowlistOverride(["definitely_missing_exec_2c8"]);
        try {
            await expect(
                executeStructuredCommand({ executable: "definitely_missing_exec_2c8", args: [] }),
            ).rejects.toMatchObject({ code: "COMMAND_FAILED_TO_START", statusCode: 422 });
        } finally {
            clearCommandAllowlistOverride();
        }
    });
});

describe("scrubbedCommandEnv + killProcessTree", () => {
    it("strips secret-like keys from process.env and from extras", () => {
        process.env.MY_API_TOKEN = "x";
        process.env.PLAIN_VAR = "keep-me";
        const env = scrubbedCommandEnv({ FOO: "bar", ALSO_SECRET_KEY: "nope", ALSO_SECRET_TOKEN: "no" });
        expect(env.MY_API_TOKEN).toBeUndefined();
        expect(env.ALSO_SECRET_KEY).toBeUndefined();
        expect(env.ALSO_SECRET_TOKEN).toBeUndefined();
        expect(env.FOO).toBe("bar");
        expect(env.PLAIN_VAR).toBe("keep-me");
        expect(SECRET_ENV.test("MY_API_TOKEN")).toBe(true);
    });

    it("killProcessTree never throws, even for bogus pids", () => {
        expect(() => killProcessTree(0)).not.toThrow();
        expect(() => killProcessTree(-5)).not.toThrow();
        expect(() => killProcessTree(999_999_999)).not.toThrow();
    });
});
