/**
 * Phase 7 / R2 — Structured command runner for the coding agent.
 *
 * A "command" is NEVER a shell string. It is a validated structured object
 * `{ executable, args[], cwd, timeoutMs, outputLimit }` executed through
 * `spawn(..., { shell: false })` with argument order always under our control.
 * Security properties, all enforced here:
 *   - the executable must be a bare name (ALLOWED_EXECUTABLE_RE) present on an
 *     explicit allowlist (env `CODING_COMMAND_ALLOWLIST`, read at call time like
 *     coding/flags.js, or a test-only override) — nothing else can be spawned;
 *   - the child env is scrubbed of secret-like keys (same regex as
 *     runner/git.js) plus any caller-supplied extras, so credentials never leak;
 *   - stdout/stderr are hard-capped per stream, and the whole process tree is
 *     killed on timeout, cap overrun, or caller `cancel()`.
 *
 * This module never writes to disk itself — only the spawned child does.
 *
 * Two public surfaces:
 *   - the engine layer (`runCommand`, `prepareCommand`, `configuredCommandAllowlist`,
 *     `scrubbedCommandEnv`, `killProcessTree`, ...) — the structured, validated
 *     runner with a combined output budget;
 *   - the executor layer (`executeStructuredCommand`) — the integration entry the
 *     workspace runner imports. It delegates to `runCommand`, honors an external
 *     `AbortSignal` cancel (whole-tree kill), caps each stream individually, and
 *     resolves a slim `{ code, stdout, stderr, timedOut, truncated, durationMs,
 *     cancelled }` result.
 */
import { spawn, spawnSync } from "node:child_process";
import { codingError } from "../util.js";

/**
 * Secret-like env-key pattern. Must stay in sync with the identical regex in
 * runner/git.js so a scrubbed env never leaks a credential into a command child.
 */
export const SECRET_ENV = /(api[_-]?key|secret|token|passwd|password|authorization|credential|bearer|private[_-]?key)/i;

/**
 * Bare executable names only: no path separators (`/` `\`), no traversal (`.` /
 * `..`), no spaces, no drive letters/colons. Length bound (1 + 63 = 64) matches
 * `DEFAULT_COMMAND_LIMITS.maxExecutableLength`.
 */
export const ALLOWED_EXECUTABLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const DEFAULT_COMMAND_LIMITS = Object.freeze({
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 300_000,
    defaultOutputLimit: 256 * 1024,
    maxOutputLimit: 1024 * 1024,
    maxArgs: 256,
    maxArgLength: 4096,
    maxExecutableLength: 64,
    maxEnvPairs: 32,
});

/** Default execution timeout for `executeStructuredCommand` when opts omit one. */
export const EXEC_TIMEOUT_MS = DEFAULT_COMMAND_LIMITS.defaultTimeoutMs;

/**
 * Reference default allowlist (executable base names, no extensions) for the
 * executor layer. It is a *documented policy* constant for operators/upstream to
 * mirror into `CODING_COMMAND_ALLOWLIST` (or to pre-filter against) — it is NOT
 * auto-applied: `configuredCommandAllowlist()` stays fail-closed ([]) until
 * something is actually configured. Shell interpreters are deliberately absent.
 */
export const DEFAULT_EXEC_ALLOWLIST = Object.freeze(["node", "git", "python3", "python"]);

const MIN_TIMEOUT_MS = 1_000;
const MIN_OUTPUT_LIMIT = 4_096;
const MAX_CWD_LENGTH = 512;

// ── command allowlist config (env read at call time, like coding/flags.js) ──
let commandAllowlistOverride = null; // test-only: array of executable names

export function setCommandAllowlistOverride(names) {
    commandAllowlistOverride = Array.isArray(names) ? names.map(String) : null;
}

export function clearCommandAllowlistOverride() {
    commandAllowlistOverride = null;
}

/**
 * Allowlisted executable names; [] = nothing allowed. `CODING_COMMAND_ALLOWLIST`
 * is comma/semicolon separated; entries are trimmed and empties dropped.
 */
export function configuredCommandAllowlist() {
    if (commandAllowlistOverride != null) return commandAllowlistOverride.slice();
    const raw = process.env.CODING_COMMAND_ALLOWLIST;
    if (raw == null || String(raw).trim() === "") return [];
    const names = String(raw).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    return [...new Set(names)];
}

/** True only when the executable is syntactically a bare name AND on the allowlist. */
export function isCommandAllowed(executable) {
    if (typeof executable !== "string" || !ALLOWED_EXECUTABLE_RE.test(executable)) return false;
    return configuredCommandAllowlist().includes(executable);
}

function clampInt(value, fallback, min, max) {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * `{ ...process.env, ...extra }` minus keys matching SECRET_ENV (both the parent
 * env and caller extras are scrubbed — an extra can never reintroduce a
 * secret-like name).
 */
export function scrubbedCommandEnv(extra = {}) {
    const env = { ...process.env };
    const additions = (extra != null && typeof extra === "object" && !Array.isArray(extra)) ? extra : {};
    for (const [key, value] of Object.entries(additions)) {
        if (value === undefined) continue;
        env[String(key)] = String(value);
    }
    for (const key of Object.keys(env)) {
        if (SECRET_ENV.test(key)) delete env[key];
    }
    return env;
}

/**
 * Best-effort kill of a process tree. On win32 `taskkill /pid <pid> /T /F`
 * (children spawned with `detached:false` still form a tree there); on POSIX the
 * child was spawned `detached`, making it its own process-group leader, so we
 * SIGKILL the negative pid (the whole group). Never throws.
 */
export function killProcessTree(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
        if (process.platform === "win32") {
            spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
            });
        } else {
            try {
                process.kill(-pid, "SIGKILL");
            } catch {
                try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
            }
        }
    } catch {
        // best effort — never propagates
    }
}

/**
 * Validate + normalize a structured command request.
 *
 * `input` shape: `{ executable, args = [], cwd = "", timeoutMs = null,
 * outputLimit = null }`. Returns `{ executable, args, timeoutMs, outputLimit }`.
 * Throws `codingError`:
 *   - INVALID_COMMAND (400): non-object input; missing/blank executable; an
 *     executable that is not a syntactically valid bare name; executable longer
 *     than `maxExecutableLength` (regex-bound); args not an array; any non-string
 *     arg; an arg longer than `maxArgLength`; more than `maxArgs` args; an
 *     overlong cwd / non-string cwd.
 *   - COMMAND_NOT_ALLOWED (403): a syntactically valid bare name that is not on
 *     the allowlist (per-call `allowlist`, else `configuredCommandAllowlist()`).
 *
 * `cwd` is NOT resolved here (the caller resolves + validates containment); only
 * `typeof cwd === "string" && cwd.length <= 512` is asserted ("" is allowed).
 * timeoutMs/outputLimit are clamped (never thrown on).
 */
export function prepareCommand(input, { allowlist = null } = {}) {
    if (input == null || typeof input !== "object" || Array.isArray(input)) {
        throw codingError("INVALID_COMMAND", "command must be a structured { executable, args, ... } object", 400);
    }
    const { executable, args = [], cwd = "", timeoutMs = null, outputLimit = null } = input;

    // executable: syntax first (bare-name), then allowlist membership.
    if (typeof executable !== "string" || executable.trim() === "") {
        throw codingError("INVALID_COMMAND", "command executable is required", 400);
    }
    if (!ALLOWED_EXECUTABLE_RE.test(executable)) {
        throw codingError(
            "INVALID_COMMAND",
            "executable must be a bare command name (no path separators, traversal, spaces or drive letters)",
            400,
        );
    }
    const allowed = allowlist == null
        ? configuredCommandAllowlist()
        : (Array.isArray(allowlist) ? allowlist.map(String) : []);
    if (!allowed.includes(executable)) {
        throw codingError("COMMAND_NOT_ALLOWED", `executable '${executable}' is not on the command allowlist`, 403);
    }

    // args
    if (!Array.isArray(args)) {
        throw codingError("INVALID_COMMAND", "command args must be an array", 400);
    }
    if (args.length > DEFAULT_COMMAND_LIMITS.maxArgs) {
        throw codingError("INVALID_COMMAND", `too many command args (max ${DEFAULT_COMMAND_LIMITS.maxArgs})`, 400);
    }
    for (const arg of args) {
        if (typeof arg !== "string") {
            throw codingError("INVALID_COMMAND", "every command arg must be a string", 400);
        }
        if (arg.length > DEFAULT_COMMAND_LIMITS.maxArgLength) {
            throw codingError("INVALID_COMMAND", `command arg exceeds ${DEFAULT_COMMAND_LIMITS.maxArgLength} chars`, 400);
        }
    }

    // cwd: type/length only — containment is the caller's job.
    if (typeof cwd !== "string" || cwd.length > MAX_CWD_LENGTH) {
        throw codingError("INVALID_COMMAND", `cwd must be a string no longer than ${MAX_CWD_LENGTH} chars`, 400);
    }

    return {
        executable,
        args,
        timeoutMs: clampInt(
            timeoutMs,
            DEFAULT_COMMAND_LIMITS.defaultTimeoutMs,
            MIN_TIMEOUT_MS,
            DEFAULT_COMMAND_LIMITS.maxTimeoutMs,
        ),
        outputLimit: clampInt(
            outputLimit,
            DEFAULT_COMMAND_LIMITS.defaultOutputLimit,
            MIN_OUTPUT_LIMIT,
            DEFAULT_COMMAND_LIMITS.maxOutputLimit,
        ),
    };
}

function startMessage(error) {
    const raw = error && (error.code || error.message) ? (error.code || error.message) : String(error || "spawn failed");
    return `command failed to start: ${String(raw).slice(0, 120)}`;
}

/**
 * Run a validated command. Resolves on exit (never rejects on non-zero exit or
 * timeout); rejects only on validation failure or spawn failure.
 *
 * `env` (optional) is merged into a scrubbed copy of the parent env.
 *
 * Resolution shape: `{ ok, exitCode, stdout, stderr, output, truncated,
 * timedOut, signal, durationMs, byteLength }`. On timeout / overrun / cancel the
 * process tree is killed and the promise resolves with `exitCode: null`.
 *
 * The returned promise also carries:
 *   - `cancel()` — kill the process tree mid-flight;
 *   - `childPid` — live read of the spawned child's pid.
 */
export function runCommand({ executable, args = [], cwd = "", timeoutMs = null, outputLimit = null, env = null } = {}) {
    let child = null;
    let pid = 0;
    let pendingKill = null; // kill reason held until the pid is known ('spawn')
    let killedFor = null;   // 'timeout' | 'truncate' | 'cancel' | null
    let settled = false;
    let truncated = false;
    let stdoutStopped = false;
    let stderrStopped = false;
    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let timer = null;
    const startedAt = Date.now();

    const killTree = (reason) => {
        if (killedFor) return;
        killedFor = reason;
        if (reason === "truncate") truncated = true;
        if (pid > 0) {
            killProcessTree(pid);
        } else if (child && child.pid) {
            pid = child.pid;
            killProcessTree(pid);
        } else {
            pendingKill = reason; // spawn not finished yet — kill once pid lands
        }
    };

    const promise = new Promise((resolve, reject) => {
        let prepped;
        try {
            prepped = prepareCommand({ executable, args, cwd, timeoutMs, outputLimit });
        } catch (error) {
            reject(error);
            return;
        }
        const budget = prepped.outputLimit;
        const perStreamCap = Math.max(2 * 1024, budget >> 1); // each stream: outputLimit/2 (min 2KB)

        try {
            child = spawn(prepped.executable, prepped.args, {
                cwd: cwd || process.cwd(),
                env: scrubbedCommandEnv(env || {}),
                windowsHide: true,
                detached: process.platform !== "win32",
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (error) {
            reject(codingError("COMMAND_FAILED_TO_START", startMessage(error), 422));
            return;
        }
        if (child.pid) pid = child.pid;
        child.once("spawn", () => {
            if (child.pid) pid = child.pid;
            if (pendingKill) {
                const reason = pendingKill;
                pendingKill = null;
                killTree(reason);
            }
        });

        // Hard byte cap per stream; on overrun kill the tree, mark truncated and
        // stop capturing that stream (keep what already fit).
        child.stdout.on("data", (chunk) => {
            if (stdoutStopped) return;
            const room = perStreamCap - stdoutBuf.length;
            if (room <= 0) {
                stdoutStopped = true;
                killTree("truncate");
                return;
            }
            if (chunk.length <= room) {
                stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
            } else {
                stdoutBuf = Buffer.concat([stdoutBuf, chunk.subarray(0, room)]);
                stdoutStopped = true;
                killTree("truncate");
            }
        });
        child.stderr.on("data", (chunk) => {
            if (stderrStopped) return;
            const room = perStreamCap - stderrBuf.length;
            if (room <= 0) {
                stderrStopped = true;
                killTree("truncate");
                return;
            }
            if (chunk.length <= room) {
                stderrBuf = Buffer.concat([stderrBuf, chunk]);
            } else {
                stderrBuf = Buffer.concat([stderrBuf, chunk.subarray(0, room)]);
                stderrStopped = true;
                killTree("truncate");
            }
        });

        timer = setTimeout(() => killTree("timeout"), prepped.timeoutMs);

        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(codingError("COMMAND_FAILED_TO_START", startMessage(error), 422));
        });
        child.on("close", (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const killed = killedFor != null;
            const stdout = stdoutBuf.toString("utf8");
            const stderr = stderrBuf.toString("utf8");
            const separator = stdoutBuf.length > 0 && stderrBuf.length > 0 ? Buffer.from("\n", "utf8") : Buffer.alloc(0);
            let outBuf = Buffer.concat([stdoutBuf, separator, stderrBuf]);
            if (outBuf.length > budget) {
                // stdout+stderr together exceeded the combined budget.
                truncated = true;
                outBuf = outBuf.subarray(0, budget);
            }
            const output = outBuf.toString("utf8");
            resolve({
                ok: true,
                exitCode: killed ? null : (code == null ? null : code),
                stdout,
                stderr,
                output,
                truncated,
                timedOut: killedFor === "timeout",
                signal: killed ? null : signal,
                durationMs: Date.now() - startedAt,
                byteLength: Buffer.byteLength(output, "utf8"),
            });
        });
    });

    promise.cancel = () => { if (!settled) killTree("cancel"); };
    Object.defineProperty(promise, "childPid", { get: () => pid, enumerable: true, configurable: true });
    return promise;
}

/**
 * Executor-layer entry point. `opts = { cwd, executable, args, timeoutMs,
 * outputLimitBytes, env, signal }`. Allowlist is checked HERE (it flows through
 * `runCommand` -> `prepareCommand` -> `configuredCommandAllowlist()`; the caller
 * may additionally pre-filter against `DEFAULT_EXEC_ALLOWLIST`, but the
 * authoritative gate is the configured allowlist, fail-closed when unset).
 *
 * Spawns the executable directly (`shell:false`), resolves on exit (never
 * rejects on non-zero), and kills the WHOLE process tree on timeout or on
 * external cancel via `signal` (AbortSignal). stdout and stderr are each capped
 * at `outputLimitBytes` (default `defaultOutputLimit`), `truncated:true` when a
 * stream overruns. Throws `codingError` on invalid opts / spawn failure /
 * missing executable on PATH (via the underlying `runCommand`).
 *
 * Resolves: `{ code, stdout, stderr, timedOut, truncated, durationMs, cancelled }`.
 */
export async function executeStructuredCommand(opts = {}) {
    const {
        executable,
        args = [],
        cwd = "",
        timeoutMs = null,
        outputLimitBytes = null,
        env = null,
        signal = null,
    } = opts || {};
    const timeout = timeoutMs == null ? EXEC_TIMEOUT_MS : timeoutMs;
    // Give each stream its own outputLimitBytes: runCommand splits its combined
    // outputLimit budget in half, so request 2x the desired per-stream cap.
    const perStream = outputLimitBytes == null
        ? DEFAULT_COMMAND_LIMITS.defaultOutputLimit
        : Math.max(2 * 1024, Math.trunc(Number(outputLimitBytes) || 0));

    const p = runCommand({
        executable,
        args,
        cwd,
        timeoutMs: timeout,
        outputLimit: perStream * 2,
        env,
    });

    let cancelledBySignal = false;
    if (signal && typeof signal.addEventListener === "function") {
        const onAbort = () => {
            cancelledBySignal = true;
            p.cancel(); // whole-tree kill
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        try {
            return await finish();
        } finally {
            signal.removeEventListener("abort", onAbort);
        }
    }
    return await finish();

    async function finish() {
        const r = await p;
        return {
            code: r.exitCode,
            stdout: r.stdout,
            stderr: r.stderr,
            timedOut: r.timedOut,
            truncated: r.truncated,
            durationMs: r.durationMs,
            // An abort only reads as `cancelled` when it actually killed the child.
            cancelled: cancelledBySignal && r.exitCode == null,
        };
    }
}
