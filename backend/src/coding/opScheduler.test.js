import { describe, expect, it } from "vitest";
import {
    classifyOp,
    conflict,
    targetOf,
    scheduleOps,
    canParallelize,
    applyBatchBudget,
    createOpScheduler,
} from "./opScheduler.js";

/**
 * Phase 7 / R3 — batch op scheduler (opScheduler.js).
 *
 * Pure planning is unit-tested directly (classify / conflict / waves / budget); the
 * parallel-execution smoke test drives the injected-executor path (`executeWaves`)
 * and proves a read wave really runs concurrently and results come back in original
 * order. No filesystem, no DB, no service loop — this file only exercises the module.
 */

// read helpers: a small factory so the tests read like the decider would emit them.
const readFile = (path) => ({ op: "read_file", args: { path } });
const writeFile = (path) => ({ op: "write_file", args: { path, content: "x" } });
const listDir = (path) => ({ op: "list_tree", args: { path } });
const runCmd = () => ({ op: "run_command", args: { executable: "node", args: ["--version"] } });

describe("classifyOp — effect classification (read/write/exec/verify/unknown)", () => {
    it("classifies the project structured read ops", () => {
        expect(classifyOp("read_file")).toBe("read");
        expect(classifyOp("list_tree")).toBe("read");
        expect(classifyOp("search_text")).toBe("read");
        expect(classifyOp("git.status")).toBe("read");
        expect(classifyOp("git.diff")).toBe("read");
        expect(classifyOp("git.show_file")).toBe("read");
        expect(classifyOp(readFile("src/a.js"))).toBe("read");
    });

    it("classifies the generic read vocabulary a harness may emit", () => {
        for (const op of ["cat", "view", "glob", "grep", "ls", "read"]) {
            expect(classifyOp(op)).toBe("read");
        }
    });

    it("classifies write ops (structured + generic)", () => {
        for (const op of ["write_file", "create_file", "delete_file", "apply_patch"]) {
            expect(classifyOp(op)).toBe("write");
        }
        expect(classifyOp(writeFile("src/a.js"))).toBe("write");
        for (const op of ["write", "edit", "patch", "create", "delete", "mv", "cp"]) {
            expect(classifyOp(op)).toBe("write");
        }
    });

    it("classifies exec ops (structured + generic)", () => {
        expect(classifyOp("run_command")).toBe("exec");
        expect(classifyOp(runCmd())).toBe("exec");
        expect(classifyOp({ type: "op", op: "run_command", args: {} })).toBe("exec");
        for (const op of ["command", "run", "exec", "bash", "npm", "node", "python", "sh"]) {
            expect(classifyOp(op)).toBe("exec");
        }
    });

    it("classifies verify", () => {
        expect(classifyOp("verify")).toBe("verify");
        expect(classifyOp("test")).toBe("verify");
        expect(classifyOp({ type: "verify", op: "run_command" })).toBe("verify");
        expect(classifyOp({ type: "op", kind: "verify", op: "read_file" })).toBe("verify");
    });

    it("maps effect/type-bearing object descriptors directly", () => {
        expect(classifyOp({ effect: "read" })).toBe("read");
        expect(classifyOp({ effect: "write" })).toBe("write");
        expect(classifyOp({ type: "write", path: "x" })).toBe("write");
    });

    it("is conservative for unknown input → exec (never parallelized)", () => {
        expect(classifyOp("something_weird")).toBe("exec");
        expect(classifyOp(null)).toBe("exec");
        expect(classifyOp(undefined)).toBe("exec");
        expect(classifyOp({})).toBe("exec");
        expect(classifyOp({ op: "magic_operation" })).toBe("exec");
    });
});

describe("targetOf + conflict — dependency detection between ops", () => {
    it("resolves the conflict target from args.path / top-level path", () => {
        expect(targetOf(readFile("src/a.js"))).toBe("src/a.js");
        expect(targetOf({ op: "read_file", path: "src/a.js" })).toBe("src/a.js");
        expect(targetOf({ op: "read_file" })).toBeNull();
        expect(targetOf("read_file")).toBeNull();
    });

    it("two reads on different files never conflict", () => {
        expect(conflict(readFile("src/a.js"), readFile("lib/b.js"))).toBe(false);
    });

    it("reads on the same path conflict", () => {
        expect(conflict(readFile("src/a.js"), readFile("src/a.js"))).toBe(true);
    });

    it("a directory read conflicts with a read of a file under it (prefix overlap)", () => {
        expect(conflict(listDir("src"), readFile("src/a.js"))).toBe(true);
        expect(conflict(listDir("src"), listDir("src/sub"))).toBe(true);
        expect(conflict(listDir("src/a"), listDir("src/b"))).toBe(false);
    });

    it("a read with no target conservatively conflicts with everything", () => {
        expect(conflict({ op: "search_text", args: { query: "x" } }, readFile("a.js"))).toBe(true);
    });

    it("any non-read op conflicts with every other op (never parallel)", () => {
        expect(conflict(readFile("a.js"), writeFile("b.js"))).toBe(true);
        expect(conflict(runCmd(), readFile("a.js"))).toBe(true);
        expect(conflict({ type: "verify", op: "read_file" }, readFile("a.js"))).toBe(true);
        expect(conflict(writeFile("a.js"), writeFile("b.js"))).toBe(true);
    });
});

describe("scheduleOps — stable wave partition", () => {
    it("puts two independent reads in a single wave", () => {
        const { waves } = scheduleOps([readFile("a/x.js"), readFile("b/y.js")]);
        expect(waves).toHaveLength(1);
        expect(waves[0]).toHaveLength(2);
    });

    it("keeps conflicting reads (same path) in separate waves", () => {
        const { waves } = scheduleOps([readFile("a/x.js"), readFile("a/x.js")]);
        expect(waves).toHaveLength(2);
        expect(waves[0]).toHaveLength(1);
        expect(waves[1]).toHaveLength(1);
    });

    it("serializes a write after reads that touched its target", () => {
        const { waves } = scheduleOps([readFile("a/x.js"), readFile("b/y.js"), writeFile("a/x.js")]);
        // reads a/x + b/y are disjoint → wave 0; the write on a/x comes next, alone.
        expect(waves).toHaveLength(2);
        expect(waves[0]).toHaveLength(2);
        expect(classifyOp(waves[1][0])).toBe("write");
        expect(targetOf(waves[1][0])).toBe("a/x.js");
    });

    it("preserves read → write → read ordering across waves", () => {
        const ops = [readFile("a/x.js"), writeFile("a/x.js"), readFile("a/x.js")];
        const { waves } = scheduleOps(ops);
        expect(waves).toHaveLength(3);
        expect(waves.map((w) => classifyOp(w[0]))).toEqual(["read", "write", "read"]);
        // flattened result is exactly the original order (stable partition)
        expect(waves.flat()).toEqual(ops);
    });

    it("never lets exec share a wave", () => {
        const ops = [readFile("a/x.js"), readFile("b/y.js"), runCmd(), readFile("c/z.js")];
        const { waves } = scheduleOps(ops);
        for (const wave of waves) {
            if (wave.some((op) => classifyOp(op) === "exec")) {
                expect(wave).toHaveLength(1);
            }
        }
        // batching happens between disjoint reads only when they are adjacent in the
        // plan (a read after exec can never leapfrog it back into an earlier wave).
        expect(classifyOp(waves[0][0])).toBe("read"); // a/x + b/y batched
        expect(waves[0]).toHaveLength(2);
        expect(classifyOp(waves[1][0])).toBe("exec");
        expect(classifyOp(waves[2][0])).toBe("read"); // c/z runs after the exec
        expect(waves.flat()).toEqual(ops);
    });

    it("respects readConcurrency inside a single wave", () => {
        const reads = [readFile("a"), readFile("b"), readFile("c"), readFile("d"), readFile("e")];
        const { waves } = scheduleOps(reads, { readConcurrency: 2 });
        expect(Math.max(...waves.map((w) => w.length))).toBe(2);
        expect(waves.flat()).toEqual(reads);
    });

    it("readBatch=false produces one wave per op (pure sequential)", () => {
        const ops = [readFile("a/x.js"), readFile("b/y.js"), readFile("c/z.js")];
        const { waves } = scheduleOps(ops, { readBatch: false });
        expect(waves.map((w) => w.length)).toEqual([1, 1, 1]);
    });

    it("is deterministic across repeated calls", () => {
        const ops = [
            readFile("a/x.js"),
            readFile("a/x.js"),
            readFile("b/y.js"),
            writeFile("a/x.js"),
            readFile("c/z.js"),
            runCmd(),
            readFile("d/w.js"),
        ];
        const first = scheduleOps(ops);
        const second = scheduleOps(ops);
        expect(second.waves).toEqual(first.waves);
        expect(JSON.stringify(second.waves)).toBe(JSON.stringify(first.waves));
    });

    it("never places two conflicting ops in the same wave", () => {
        const ops = [
            readFile("src/a.js"),
            readFile("src/b.js"),
            listDir("src"),
            readFile("src/sub/c.js"),
            readFile("lib/d.js"),
            writeFile("src/a.js"),
            runCmd(),
            readFile("src/a.js"),
        ];
        const { waves } = scheduleOps(ops);
        for (const wave of waves) {
            for (let i = 0; i < wave.length; i += 1) {
                for (let j = i + 1; j < wave.length; j += 1) {
                    expect(conflict(wave[i], wave[j])).toBe(false);
                }
            }
        }
        expect(waves.flat()).toEqual(ops); // stable partition, nothing dropped/duplicated
    });
});

describe("canParallelize — wave eligibility helper", () => {
    it("accepts a wave of disjoint reads within maxConcurrent", () => {
        expect(canParallelize([readFile("a"), readFile("b"), readFile("c")])).toBe(true);
    });
    it("rejects a wave that is too large for maxConcurrent", () => {
        expect(canParallelize([readFile("a"), readFile("b"), readFile("c"), readFile("d")], { maxConcurrent: 3 })).toBe(false);
    });
    it("rejects waves containing any non-read or conflicting read", () => {
        expect(canParallelize([readFile("a"), runCmd()])).toBe(false);
        expect(canParallelize([writeFile("a")])).toBe(false);
        expect(canParallelize([readFile("a"), readFile("a")])).toBe(false);
        expect(canParallelize([])).toBe(false);
    });
});

describe("applyBatchBudget — truncation never reorders, never drops a head write", () => {
    it("truncates to maxWaves from the tail", () => {
        const reads = [readFile("a1"), readFile("a2"), readFile("a3"), readFile("b1"), readFile("b2"), readFile("b3"), readFile("c1"), readFile("c2"), readFile("c3"), readFile("d1")];
        const { waves } = scheduleOps(reads);
        expect(waves).toHaveLength(4);
        const out = applyBatchBudget(waves, { maxWaves: 2, maxOps: 50 });
        expect(out.truncated).toBe(true);
        expect(out.skipped).toBe(4);
        expect(out.waves).toHaveLength(2);
        expect(out.waves[0]).toHaveLength(3);
        expect(out.waves[1]).toHaveLength(3);
        // kept ops are exactly the original head, in order.
        expect(out.waves.flat()).toEqual(reads.slice(0, 6));
    });

    it("truncates to maxOps (even mid-wave)", () => {
        const reads = [readFile("a1"), readFile("a2"), readFile("a3"), readFile("b1"), readFile("b2"), readFile("b3"), readFile("c1"), readFile("c2"), readFile("c3")];
        const { waves } = scheduleOps(reads);
        const out = applyBatchBudget(waves, { maxWaves: 20, maxOps: 5 });
        expect(out.truncated).toBe(true);
        expect(out.skipped).toBe(4);
        expect(out.waves.flat()).toEqual(reads.slice(0, 5));
        expect(out.waves[0]).toHaveLength(3); // first wave intact
        expect(out.waves[1]).toHaveLength(2); // second wave cut mid-way
    });

    it("never drops an early write while a later op still runs", () => {
        const ops = [writeFile("src/a.js"), readFile("src/a.js"), readFile("b.js")];
        const { waves } = scheduleOps(ops, { readBatch: true });
        // Greedy: [[write], [read src/a, read b]] — the read after a write cannot rejoin
        // the write wave, but the two disjoint reads batch into their own wave.
        const out = applyBatchBudget(waves, { maxWaves: 1, maxOps: 50 });
        expect(out.truncated).toBe(true);
        expect(out.skipped).toBe(2); // both reads dropped from the tail
        expect(out.waves).toHaveLength(1);
        expect(classifyOp(out.waves[0][0])).toBe("write"); // the write is never skipped
    });

    it("is a no-op when everything fits", () => {
        const { waves } = scheduleOps([readFile("a"), readFile("b")]);
        const out = applyBatchBudget(waves, { maxWaves: 20, maxOps: 50 });
        expect(out.truncated).toBe(false);
        expect(out.skipped).toBe(0);
        expect(out.waves).toEqual(waves);
    });
});

describe("createOpScheduler — injected-executor parallel smoke test", () => {
    it("runs a read wave concurrently and returns results in original order", async () => {
        const scheduler = createOpScheduler();
        const reads = [readFile("a.js"), readFile("b.js"), readFile("c.js")];
        const plan = scheduler.plan(reads);

        const started = [];
        const finished = [];
        let active = 0;
        let maxActive = 0;
        const dispatch = async (op, indexInWave) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            started.push(`${op.op}#${indexInWave}`);
            await new Promise((resolve) => setTimeout(resolve, 25));
            active -= 1;
            finished.push(`${op.op}:${targetOf(op)}`);
            return { op: op.op, data: targetOf(op) };
        };

        const results = await scheduler.executeWaves(plan, dispatch);

        expect(plan.truncated).toBe(false);
        expect(maxActive).toBe(3); // all three dispatched before any resolved
        expect(started).toHaveLength(3);
        expect(results).toHaveLength(3);
        // outcomes come back in the original op order
        expect(results.map((r) => r.data)).toEqual(["a.js", "b.js", "c.js"]);
        // ... even though they overlap in real time
        expect(finished).toHaveLength(3);
    });

    it("serializes when a wave cannot parallelize (write) while still preserving order", async () => {
        const scheduler = createOpScheduler();
        const ops = [readFile("a.js"), readFile("b.js"), writeFile("c.js"), readFile("d.js")];
        const plan = scheduler.plan(ops);
        const order = [];
        let active = 0;
        let maxActive = 0;
        const dispatch = async (op) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            order.push(targetOf(op));
            await new Promise((resolve) => setTimeout(resolve, 10));
            active -= 1;
            return { op: op.op };
        };
        const results = await scheduler.executeWaves(plan, dispatch, { maxConcurrent: 3 });
        expect(maxActive).toBe(2); // first wave has 2 disjoint reads
        expect(order).toEqual(["a.js", "b.js", "c.js", "d.js"]);
        expect(results.map((r) => r.op)).toEqual(["read_file", "read_file", "write_file", "read_file"]);
    });

    it("honors overridden classify/schedule injected into the factory", () => {
        const alwaysRead = () => "read";
        const customSchedule = (ops) => ({ waves: ops.map((op) => [op]) }); // never batch
        const scheduler = createOpScheduler({ classify: alwaysRead, schedule: customSchedule });
        expect(scheduler.classifyOp("run_command")).toBe("read");
        const plan = scheduler.plan([readFile("a"), readFile("b")]);
        expect(plan.waves).toHaveLength(2); // custom schedule used → one wave per op
    });
});
