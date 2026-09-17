import { describe, expect, it } from "vitest";
import {
    createCodingDecider,
    DECIDER_ALLOWED_OPS,
    CODING_DECIDER_PROMPT_MARKER,
    DECIDER_UNPARSEABLE_SUMMARY,
    DECIDER_EXEC_BLOCKED_NOTE,
} from "./llmDecider.js";

/**
 * Phase 7 / R5 — llmDecider: the production decide() that turns one LLM round-trip
 * (goal + steps + observations) into the next legal decision. These tests use a
 * deterministic fake makeLlm, so every prompt/parse/retry/degrade path is asserted
 * without a model. Safety under test: the decider can NEVER emit run_command
 * (forbidExec), and one bad model output never fails the session.
 *
 * createCodingDecider calls `makeLlm(llmOpts)` once per decide() and expects the
 * returned object to expose `invoke(messages, {signal})` — mirroring makeLlm used
 * elsewhere in the graph.
 */
function fakeFrom(sequence) {
    let call = 0;
    const calls = [];
    const makeLlm = () => ({
        async invoke(messages) {
            calls.push(messages);
            const next = sequence[Math.min(call++, sequence.length - 1)];
            if (typeof next === "function") return next(messages);
            return { content: next };
        },
    });
    return { makeLlm, calls };
}

const baseCtx = {
    goal: "fix the wrong sign in calc.js",
    projectId: "proj_1",
    stepIndex: 0,
    turn: 1,
    steps: [{ type: "op", op: "read_file", ok: true, note: "read bug" }],
    observations: ["read_file src/calc.js L1-4 (4 lines)\n2|return a - b;"],
};

describe("createCodingDecider — happy paths", () => {
    it("forces the requested plain-text smoke-file write before allowing completion", async () => {
        const fake = fakeFrom([JSON.stringify({ type: "done", summary: "already done" })]);
        const decide = createCodingDecider({ makeLlm: fake.makeLlm });
        const decision = await decide({
            goal: "请在当前项目根目录创建一个文件 coding-agent-smoke.txt，只写入一行：coding-agent smoke test。不要修改其他文件，也不要执行命令。",
            steps: [{ type: "op", op: "git.status", ok: true }],
            observations: [],
        });
        expect(decision.op).toBe("create_file");
        expect(decision.args).toEqual({ path: "coding-agent-smoke.txt", content: "coding-agent smoke test\n" });
        expect(fake.calls).toHaveLength(0);
    });

    it("forces the requested smoke-file write before allowing completion", async () => {
        const fake = fakeFrom([JSON.stringify({ type: "done", summary: "already done" })]);
        const decide = createCodingDecider({ makeLlm: fake.makeLlm });
        const decision = await decide({
            goal: "请在当前项目根目录创建一个文件 `coding-agent-smoke.txt`，只写入一行：`coding-agent smoke test`。不要修改其他文件。",
            steps: [{ type: "op", op: "list_tree", ok: true }],
            observations: [],
        });
        expect(decision).toEqual({
            type: "op",
            op: "create_file",
            args: { path: "coding-agent-smoke.txt", content: "coding-agent smoke test\n" },
            note: "落实用户要求创建文件",
        });
        expect(fake.calls).toHaveLength(0);
    });

    it("requires a makeLlm function", () => {
        expect(() => createCodingDecider({})).toThrow(TypeError);
    });

    it("returns a legal single op decision", async () => {
        const fake = fakeFrom([JSON.stringify({ type: "op", op: "read_file", args: { path: "src/calc.js" }, note: "see the bug" })]);
        const decide = createCodingDecider({ makeLlm: fake.makeLlm });
        const decision = await decide(baseCtx);
        expect(decision).toEqual({ type: "op", op: "read_file", args: { path: "src/calc.js" }, note: "see the bug" });
    });

    it("returns a legal done decision", async () => {
        const fake = fakeFrom(["sure: " + JSON.stringify({ type: "done", summary: "changed calc.js" })]);
        const decide = createCodingDecider({ makeLlm: fake.makeLlm });
        expect(await decide(baseCtx)).toEqual({ type: "done", summary: "changed calc.js" });
    });

    it("strips ```json fences (router-style extraction)", async () => {
        const fake = fakeFrom(["```json\n" + JSON.stringify({ type: "ops", ops: [{ op: "read_file", args: { path: "a" } }, { op: "read_file", args: { path: "b" } }] }) + "\n```"]);
        const decide = createCodingDecider({ makeLlm: fake.makeLlm });
        const decision = await decide(baseCtx);
        expect(decision.type).toBe("ops");
        expect(decision.ops.map((o) => o.op)).toEqual(["read_file", "read_file"]);
    });

    it("emits a default allowed list that includes reads + writes but never run_command", () => {
        expect(DECIDER_ALLOWED_OPS).toContain("read_file");
        expect(DECIDER_ALLOWED_OPS).toContain("write_file");
        expect(DECIDER_ALLOWED_OPS).toContain("git.diff");
        expect(DECIDER_ALLOWED_OPS).not.toContain("run_command");
    });
});

describe("createCodingDecider — prompts carry goal + observations + marker", () => {
    it("embeds the marker and the goal/observations in the prompt", async () => {
        const fake = fakeFrom([JSON.stringify({ type: "note", text: "ok" })]);
        const decide = createCodingDecider({ makeLlm: fake.makeLlm });
        await decide(baseCtx);
        const [system, human] = fake.calls[0];
        expect(system.content).toContain(CODING_DECIDER_PROMPT_MARKER);
        expect(system.content).toContain("write_file");
        expect(human.content).toContain("# 编码目标");
        expect(human.content).toContain("fix the wrong sign in calc.js");
        expect(human.content).toContain("read_file src/calc.js L1-4");
    });

    it("respects an allowedOps subset (write passes when listed, otherwise unknownOp)", async () => {
        const subset = ["read_file", "write_file"];
        const fake = fakeFrom([JSON.stringify({ type: "op", op: "write_file", args: { path: "f", content: "c" } })]);
        const decide = createCodingDecider({ makeLlm: fake.makeLlm, allowedOps: subset });
        expect(await decide(baseCtx)).toEqual({ type: "op", op: "write_file", args: { path: "f", content: "c" }, note: null });

        const fake2 = fakeFrom([JSON.stringify({ type: "op", op: "delete_file", args: { path: "f" } })]);
        const decide2 = createCodingDecider({ makeLlm: fake2.makeLlm, allowedOps: subset });
        expect((await decide2(baseCtx)).type).toBe("done"); // delete_file not in subset
    });
});

describe("createCodingDecider — resilience (bad output never kills the session)", () => {
    it("retries once on malformed JSON then degrades to a done summary", async () => {
        const fake = fakeFrom(["not json at all", "also not json", "still not json"]);
        const decide = createCodingDecider({ makeLlm: fake.makeLlm, maxRetries: 1 });
        const decision = await decide(baseCtx);
        expect(decision).toEqual({ type: "done", summary: DECIDER_UNPARSEABLE_SUMMARY });
        expect(fake.calls.length).toBe(2); // original + one corrective retry
    });

    it("intercepts a forbidden run_command, corrects once, then degrades to a note — never passes exec through", async () => {
        const exec = JSON.stringify({ type: "op", op: "run_command", args: { executable: "rm" } });
        const fake = fakeFrom([exec, exec, exec]);
        const decide = createCodingDecider({ makeLlm: fake.makeLlm, maxRetries: 1 });
        const decision = await decide(baseCtx);
        expect(decision.type).toBe("note");
        expect(decision.text).toBe(DECIDER_EXEC_BLOCKED_NOTE);
        // The corrective retry told the model run_command is forbidden.
        const [, human2] = fake.calls[1];
        expect(human2.content).toContain("run_command");
        expect(human2.content).toContain("被禁用");
    });

    it("degrades on a model call throwing after the retry budget", async () => {
        let n = 0;
        const makeLlm = () => ({ async invoke() { n += 1; throw new Error("upstream down"); } });
        const decide = createCodingDecider({ makeLlm, maxRetries: 1 });
        expect(await decide(baseCtx)).toEqual({ type: "done", summary: DECIDER_UNPARSEABLE_SUMMARY });
    });

    it("rejects an unknown (non-whitelist) op after a corrective retry", async () => {
        const fake = fakeFrom([
            JSON.stringify({ type: "op", op: "delete_everything", args: {} }),
            JSON.stringify({ type: "op", op: "delete_everything", args: {} }),
        ]);
        const decide = createCodingDecider({ makeLlm: fake.makeLlm, maxRetries: 1 });
        const decision = await decide(baseCtx);
        expect(decision.type).toBe("done");
        expect(decision.summary).toBe(DECIDER_UNPARSEABLE_SUMMARY);
    });

    it("passes exec through when forbidExec is explicitly false", async () => {
        const fake = fakeFrom([JSON.stringify({ type: "op", op: "run_command", args: { executable: "node" } })]);
        const decide = createCodingDecider({ makeLlm: fake.makeLlm, forbidExec: false });
        const decision = await decide(baseCtx);
        expect(decision.op).toBe("run_command");
    });
});
