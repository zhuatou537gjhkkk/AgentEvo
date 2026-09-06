/**
 * Phase 7 / R3 — Batch op scheduler for the Code Agent.
 *
 * The R2 coding loop executes ops one-at-a-time (`begin`/`run`/`resume`), which is
 * safe but serial: an agent that must survey a directory, grep a tree and read a
 * handful of files does it in N round-trips. R3 batching keeps the loop bounded but
 * lets INDEPENDENT READ ops share a single step while every write / exec / verify
 * stays strictly serial.
 *
 * The rule that makes this safe is conservative:
 *   - an op is parallelizable ONLY when it classifies as a `read`;
 *   - two reads may share a wave only when they touch DIFFERENT, non-overlapping
 *     target paths (a `list_tree src/` and a `read_file src/a.js` CONFLICT);
 *   - any write/exec/verify (or an unknown op) starts its own sequential wave;
 *   - ops keep their original relative order across waves (a stable partition), so
 *     results come back in the order the agent issued them.
 *
 * This module is PURE and deterministic — nothing here executes an op. Planning is
 * separated from execution so the exact wave layout is unit-testable; execution is
 * injected: the caller hands each op to a dispatch function and the scheduler runs
 * a wave's reads with `Promise.all`, returning outcomes in original op order.
 */
import { READ_OPS, WRITE_OPS, EXEC_OPS } from "./runner/protocol.js";

// Keyword tables mirror BOTH the project's structured op names (read_file, run_command,
// git.status, …) and the generic vocabulary a model harness may emit (cat/grep/glob,
// bash/npm/python, …). Exact membership in the protocol op sets always wins; keyword
// tokens are a fallback for anything not yet in the registry.
const READ_KEYWORDS = new Set(["read", "cat", "view", "glob", "grep", "ls", "list", "search", "status", "diff", "show", "tree"]);
const WRITE_KEYWORDS = new Set(["write", "edit", "patch", "create", "delete", "mv", "cp", "apply"]);
const EXEC_KEYWORDS = new Set(["command", "run", "exec", "bash", "sh", "shell", "npm", "npx", "node", "python", "python3", "make", "yarn", "pnpm"]);
const VERIFY_KEYWORDS = new Set(["verify", "test", "assert"]);

function tokenize(name) {
    return String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Classify one op descriptor into its effect class.
 * A descriptor may be a bare string (`"run_command"`), a decision
 * (`{type:"op"|"verify", op, args}`), a registry record (`{op, effect}`), or a
 * result-shaped object. Unknown → `"exec"` (conservative: never parallelized).
 *
 * @param {string|object} op
 * @returns {"read"|"write"|"exec"|"verify"}
 */
export function classifyOp(op) {
    if (op == null) return "exec";
    if (typeof op === "string") return classifyByName(op);
    if (typeof op !== "object") return "exec";

    // `effect` and `type` are authoritative when they are actual effect words.
    if (op.effect === "read" || op.effect === "write") return op.effect;
    const typeWord = typeof op.type === "string" ? op.type.trim().toLowerCase() : "";
    const kindWord = typeof op.kind === "string" ? op.kind.trim().toLowerCase() : "";
    for (const word of [typeWord, kindWord]) {
        if (word === "verify") return "verify";
        if (word === "read" || word === "write" || word === "exec") return word;
        if (word === "command" || word === "run") return "exec";
        if (word === "test") return "verify";
    }

    // Fall through to the innermost op/name field.
    const name = typeof op.op === "string" && op.op ? op.op : (typeof op.name === "string" && op.name ? op.name : null);
    if (name != null) return classifyByName(name);
    return "exec"; // object with no recognizable op/type/effect/name
}

function classifyByName(name) {
    const word = String(name).trim().toLowerCase();
    if (!word) return "exec";
    if (READ_OPS.includes(word)) return "read";
    if (WRITE_OPS.includes(word)) return "write";
    if (EXEC_OPS.includes(word)) return "exec";
    const tokens = tokenize(word);
    if (tokens.length === 0) return "exec";
    for (const t of tokens) if (READ_KEYWORDS.has(t)) return "read";
    for (const t of tokens) if (VERIFY_KEYWORDS.has(t)) return "verify";
    for (const t of tokens) if (EXEC_KEYWORDS.has(t)) return "exec";
    for (const t of tokens) if (WRITE_KEYWORDS.has(t)) return "write";
    return "exec";
}

/**
 * Resolve the conflict target (path/key) an op reads or mutates. Returns the
 * normalized target string, or null when the descriptor carries no target info
 * (e.g. a bare op name, a search across the whole tree, or an unknown shape).
 */
export function targetOf(op) {
    if (op == null) return null;
    let target = null;
    if (typeof op === "object") {
        for (const key of ["args", "params"]) {
            const inner = op[key];
            if (inner && typeof inner === "object") {
                target = inner.path ?? inner.key ?? inner.file ?? null;
                if (target != null) break;
            }
        }
        if (target == null) {
            target = op.path ?? op.key ?? op.file ?? op.target ?? null;
        }
    }
    if (typeof target !== "string" || !target.trim()) return null;
    let norm = target.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
    return norm || null;
}

/**
 * Conflict predicate: two ops may NOT share a wave when either is non-read, when
 * they share the same normalized target, or when one target is a path-prefix of the
 * other (`a/` vs `a/b.js`). Unknown targets are treated as conflicting with
 * everything (conservative — a root-less read like a whole-tree grep is assumed to
 * overlap any other read).
 *
 * @returns {boolean} true when the two ops must not run concurrently
 */
export function conflict(a, b) {
    if (classifyOp(a) !== "read" || classifyOp(b) !== "read") return true;
    const ta = targetOf(a);
    const tb = targetOf(b);
    if (ta === null || tb === null) return true;
    if (ta === tb) return true;
    const pa = `${ta}/`;
    const pb = `${tb}/`;
    return pa.startsWith(pb) || pb.startsWith(pa);
}

/**
 * Stable, deterministic partition of an op list into waves. A wave is a set of ops
 * that may run in parallel; waves execute strictly one after another.
 *
 * @param {Array<object|string>} ops descriptors in the order the agent issued them
 * @param {{ readBatch?: boolean, readConcurrency?: number }} [options]
 * @returns {{ waves: Array<Array<object|string>> }} each wave keeps original order
 */
export function scheduleOps(ops, { readBatch = true, readConcurrency = 3 } = {}) {
    const list = Array.isArray(ops) ? ops.filter(Boolean) : [];
    const cap = Math.max(1, Math.trunc(Number(readConcurrency)) || 1);
    const waves = [];
    for (const op of list) {
        if (readBatch && classifyOp(op) === "read") {
            const last = waves[waves.length - 1];
            const lastReadCount = last ? last.filter((m) => classifyOp(m) === "read").length : 0;
            if (last && lastReadCount < cap && last.every((m) => !conflict(m, op))) {
                last.push(op);
                continue;
            }
        }
        waves.push([op]);
    }
    return { waves };
}

/**
 * Whether a wave may be executed as one concurrent group: it must be non-empty,
 * entirely reads, pairwise conflict-free, and within `maxConcurrent`.
 *
 * @returns {boolean}
 */
export function canParallelize(wave, { maxConcurrent = 3 } = {}) {
    if (!Array.isArray(wave) || wave.length === 0) return false;
    const mc = Math.max(1, Math.trunc(Number(maxConcurrent)) || 1);
    if (wave.length > mc) return false;
    if (!wave.every((op) => classifyOp(op) === "read")) return false;
    for (let i = 0; i < wave.length; i += 1) {
        for (let j = i + 1; j < wave.length; j += 1) {
            if (conflict(wave[i], wave[j])) return false;
        }
    }
    return true;
}

/**
 * Bound a wave plan. Truncation only ever drops the TAIL of the plan (in wave
 * order, then within the last wave), so a write/exec that was scheduled earlier is
 * never skipped while a later op still runs.
 *
 * @returns {{ waves: Array<Array>, truncated: boolean, skipped: number }}
 */
export function applyBatchBudget(waves, { maxWaves = 20, maxOps = 50 } = {}) {
    const source = Array.isArray(waves) ? waves : [];
    const waveCap = Math.max(1, Math.trunc(Number(maxWaves)) || 1);
    const opCap = Math.max(1, Math.trunc(Number(maxOps)) || 1);
    const kept = [];
    let skipped = 0;
    let keptOps = 0;
    for (const wave of source) {
        if (!Array.isArray(wave) || wave.length === 0) continue;
        if (kept.length >= waveCap) {
            skipped += wave.length;
            continue;
        }
        const out = [];
        for (const op of wave) {
            if (keptOps >= opCap) {
                skipped += 1;
                continue;
            }
            out.push(op);
            keptOps += 1;
        }
        if (out.length > 0) kept.push(out);
    }
    return { waves: kept, truncated: skipped > 0, skipped };
}

/**
 * Factory for an injected scheduler used by the coding service seam. Every helper
 * is overridable so tests (and the service) can supply their own classify/plan
 * strategy while the shape of the result stays stable.
 *
 * The returned object NEVER executes ops by itself — the caller drives execution
 * through {@link executeWaves} with an injected dispatch function.
 */
export function createOpScheduler({
    classify = classifyOp,
    schedule = scheduleOps,
    isConflict = conflict,
    parallelizable = canParallelize,
    budget = applyBatchBudget,
} = {}) {
    return {
        classifyOp: classify,
        scheduleOps: schedule,
        conflict: isConflict,
        canParallelize: parallelizable,
        applyBatchBudget: budget,

        /** Plan `ops` and clamp to batch budget in one call. */
        plan(ops, { readBatch = true, readConcurrency = 3, maxWaves = 20, maxOps = 50 } = {}) {
            const { waves } = schedule(ops, { readBatch, readConcurrency });
            const bounded = budget(waves, { maxWaves, maxOps });
            return { waves: bounded.waves, truncated: bounded.truncated, skipped: bounded.skipped };
        },

        /**
         * Execute a plan with an injected dispatch. Within each wave, when the wave
         * is parallelizable all of its reads dispatch concurrently via `Promise.all`;
         * otherwise (single write/exec/verify wave, or caller passes an un-shareable
         * wave) ops dispatch one-by-one. Results are returned in original op order.
         *
         * @param {{ waves: Array<Array> }|Array<Array>} plan output of {@link plan}
         * @param {(op: object|string, indexInWave?: number) => Promise<object>} dispatch
         * @returns {Promise<Array<object>>} outcomes aligned with the flattened plan
         */
        async executeWaves(plan, dispatch, { maxConcurrent = 3 } = {}) {
            const waves = Array.isArray(plan) ? plan : (plan && plan.waves) || [];
            const results = [];
            for (const wave of waves) {
                if (parallelizable(wave, { maxConcurrent })) {
                    const batch = await Promise.all(wave.map((op, i) => Promise.resolve(dispatch(op, i))));
                    results.push(...batch);
                } else {
                    for (const op of wave) {
                        results.push(await Promise.resolve(dispatch(op)));
                    }
                }
            }
            return results;
        },
    };
}

export const defaultOpScheduler = createOpScheduler();
export default defaultOpScheduler;
