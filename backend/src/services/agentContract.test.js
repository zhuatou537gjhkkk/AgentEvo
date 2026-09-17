import { describe, it, expect } from "vitest";
import {
    SUBTASK_OK, SUBTASK_BAD_TERMINAL, legacyResultFieldFor,
    normalizeSubTask, normalizeSubTasks, analyzeDependencyGraph,
    completedIds, computeSchedulerView, markBlocked,
    dependencyContext, toAgentResult, mergeAgentResults,
    hasCrossAgentDependencies,
} from "./agentContract.js";

describe("normalizeSubTask — canonical AgentTask shape", () => {
    it("derives defaults for a bare reasoning task (id/type/content)", () => {
        const st = normalizeSubTask({ type: "reasoning", dependsOn: ["1"] }, { index: 2 });
        expect(st.id).toBe("3");
        expect(st.type).toBe("reasoning");
        expect(st.agent).toBeNull();
        expect(st.content).toBe("reasoning");
        expect(st.dependsOn).toEqual(["1"]);
        expect(st.status).toBe("pending");
    });

    it("type derives from toolName when type omitted; agent defaults to general for unknown", () => {
        const st = normalizeSubTask({ toolName: "web_search" });
        expect(st.type).toBe("tool");
        const st2 = normalizeSubTask({ type: "agent", agent: "bogus" });
        expect(st2.agent).toBe("general");
    });

    it("preserves unknown/legacy fields while overwriting canonical keys", () => {
        const st = normalizeSubTask({ id: "9", type: "agent", agent: "search", goal: "查", content: "x", status: "in_progress", legacy: "keep-me", extra: { a: 1 } });
        expect(st.legacy).toBe("keep-me");
        expect(st.extra).toEqual({ a: 1 });
        expect(st.agent).toBe("search");
        expect(st.goal).toBe("查");
        expect(st.result).toBeNull();
    });

    it("drops self-dependency references and de-dupes dependsOn", () => {
        const st = normalizeSubTask({ id: "2", dependsOn: ["2", "1", "1"] });
        expect(st.dependsOn).toEqual(["1"]);
    });
});

describe("normalizeSubTasks — id collision repair", () => {
    it("assigns unique ids when the plan repeats one", () => {
        const list = normalizeSubTasks([
            { id: "1", type: "reasoning" },
            { id: "1", type: "reasoning" },
        ]);
        expect(list[0].id).toBe("1");
        expect(list[1].id).toBe("1-1");
    });

    it("handles empty/null plan", () => {
        expect(normalizeSubTasks(undefined)).toEqual([]);
        expect(normalizeSubTasks([])).toEqual([]);
    });
});

describe("analyzeDependencyGraph — DAG validation", () => {
    const chain = () => [
        { id: "1", type: "agent", agent: "search", dependsOn: [] },
        { id: "2", type: "agent", agent: "code", dependsOn: ["1"] },
        { id: "3", type: "reasoning", dependsOn: ["1", "2"] },
    ];

    it("accepts a DAG and yields a stable topological order (executables first)", () => {
        const a = analyzeDependencyGraph(chain());
        expect(a.ok).toBe(true);
        expect(a.cyclicIds).toEqual([]);
        expect(a.missingDepIds).toEqual([]);
        expect(a.order).toEqual(["1", "2", "3"]);
    });

    it("rejects a cycle and reports exactly the cyclic ids", () => {
        const cyclic = [
            { id: "1", type: "agent", dependsOn: ["2"] },
            { id: "2", type: "agent", dependsOn: ["1"] },
            { id: "3", type: "reasoning", dependsOn: ["1", "2"] },
        ];
        const a = analyzeDependencyGraph(cyclic);
        expect(a.ok).toBe(false);
        expect(a.cyclicIds.sort()).toEqual(["1", "2"]);
        // order excludes cyclic nodes but keeps acyclics
        expect(a.order).toEqual(["3"]);
    });

    it("reports a missing dependency id", () => {
        const a = analyzeDependencyGraph([
            { id: "1", type: "agent", dependsOn: ["ghost"] },
        ]);
        expect(a.ok).toBe(false);
        expect(a.missingDepIds).toEqual(["1->ghost"]);
    });

    it("treats a missing dep id as a non-constraint for the topological order", () => {
        const a = analyzeDependencyGraph([
            { id: "1", type: "agent", dependsOn: ["ghost"] },
            { id: "2", type: "reasoning", dependsOn: ["1"] },
        ]);
        expect(a.order).toEqual(["1", "2"]);
    });
});

describe("computeSchedulerView + markBlocked — wave dispatch decisions", () => {
    it("two independent pending executables are both ready", () => {
        const view = computeSchedulerView([
            { id: "1", type: "agent", status: "pending", dependsOn: [] },
            { id: "2", type: "agent", status: "pending", dependsOn: [] },
        ]);
        expect(view.ready.map((s) => s.id).sort()).toEqual(["1", "2"]);
        expect(view.blocked).toEqual([]);
        expect(view.terminal).toBe(false);
    });

    it("an executable whose dep is not done is stuck, not ready", () => {
        const view = computeSchedulerView([
            { id: "1", type: "agent", status: "pending", dependsOn: [] },
            { id: "2", type: "agent", status: "pending", dependsOn: ["1"] },
        ]);
        expect(view.ready.map((s) => s.id)).toEqual(["1"]);
        expect(view.stuck.map((s) => s.id)).toEqual(["2"]);
        expect(view.blocked).toEqual([]);
    });

    it("after the dep completes the dependent becomes ready", () => {
        const view = computeSchedulerView([
            { id: "1", type: "agent", status: SUBTASK_OK, dependsOn: [] },
            { id: "2", type: "agent", status: "pending", dependsOn: ["1"] },
        ]);
        expect(view.ready.map((s) => s.id)).toEqual(["2"]);
    });

    it("a dependent of a failed dep is classified blocked and markBlocked applies it", () => {
        const list = [
            { id: "1", type: "agent", status: "failed", dependsOn: [] },
            { id: "2", type: "agent", status: "pending", dependsOn: ["1"] },
            { id: "3", type: "reasoning", status: "pending", dependsOn: ["1", "2"] },
        ];
        const view = computeSchedulerView(list);
        expect(view.blocked.map((s) => s.id)).toEqual(["2"]);
        const out = markBlocked(list, { blocked: view.blocked, stuck: view.stuck });
        expect(out.find((s) => s.id === "2").status).toBe("blocked");
        expect(out.find((s) => s.id === "2").statusReason).toContain("前置步骤");
        expect(out.find((s) => s.id === "3").status).toBe("pending"); // reasoning untouched
    });

    it("terminates once every executable is settled", () => {
        const view = computeSchedulerView([
            { id: "1", type: "agent", status: SUBTASK_OK, dependsOn: [] },
            { id: "2", type: "reasoning", status: "pending", dependsOn: ["1"] },
        ]);
        expect(view.terminal).toBe(true);
    });

    it("cascades: blocking a task lets its dependents be blocked on the next view", () => {
        const base = [
            { id: "a", type: "agent", status: "failed", dependsOn: [] },
            { id: "b", type: "agent", status: "pending", dependsOn: ["a"] },
            { id: "c", type: "agent", status: "pending", dependsOn: ["b"] },
        ];
        let list = base;
        for (let i = 0; i < 5; i++) {
            const view = computeSchedulerView(list);
            if (view.blocked.length === 0 && view.stuck.length === 0) break;
            list = markBlocked(list, { blocked: view.blocked, stuck: view.stuck });
        }
        expect(list.find((s) => s.id === "b").status).toBe("blocked");
        expect(list.find((s) => s.id === "c").status).toBe("blocked");
    });
});

describe("completedIds + dependencyContext — downstream result injection", () => {
    it("lists only completed ids", () => {
        expect(completedIds([
            { id: "1", status: "completed" },
            { id: "2", status: "failed" },
        ])).toEqual(["1"]);
    });

    it("returns empty for a task with no deps", () => {
        expect(dependencyContext({ dependsOn: [] }, {})).toBe("");
    });

    it("injects only completed deps, labeled by agent when present", () => {
        const text = dependencyContext(
            { id: "2", dependsOn: ["1"] },
            { "1": { agent: "search", text: "找到 A" } },
        );
        expect(text).toContain("[依赖步骤 1 · search]");
        expect(text).toContain("找到 A");
    });

    it("accepts a plain-string result and is bounded by maxChars", () => {
        const big = "x".repeat(10000);
        const text = dependencyContext({ dependsOn: ["1"] }, { "1": big }, { maxChars: 120 });
        expect(text).toContain("[依赖步骤 1]");
        expect(text.length).toBeLessThan(200);
        // a missing dep contributes nothing
        expect(dependencyContext({ dependsOn: ["9"] }, {})).toBe("");
    });
});

describe("toAgentResult / mergeAgentResults — provenance result contract", () => {
    it("builds a canonical AgentResult", () => {
        const r = toAgentResult({ agentType: "code", subTaskId: "2", text: "done", artifact: { id: "a1" } });
        expect(r.subTaskId).toBe("2");
        expect(r.agent).toBe("code");
        expect(r.source).toBe("code");
        expect(r.status).toBe("completed");
        expect(r.text).toBe("done");
        expect(r.artifact).toEqual({ id: "a1" });
        expect(typeof r.at).toBe("string");
    });

    it("merge is per-subTaskId and additive", () => {
        let results = mergeAgentResults(undefined, { "1": { text: "a" } });
        results = mergeAgentResults(results, { "2": { text: "b" } });
        results = mergeAgentResults(results, { "1": { text: "a2" } });
        expect(results).toEqual({ "1": { text: "a2" }, "2": { text: "b" } });
    });

    it("explicitly resets stale packets at a new plan generation", () => {
        const old = { "1": { status: "completed", text: "old output" } };
        const reset = mergeAgentResults(old, { __reset: true, __generation: 2 });
        expect(reset).toEqual({ __generation: 2 });
        expect(mergeAgentResults(reset, { "1": { status: "completed", text: "new output" } })).toEqual({
            __generation: 2,
            "1": { status: "completed", text: "new output" },
        });
    });
});

describe("legacy + cross-agent detection", () => {
    it("maps agent type to its legacy result field", () => {
        expect(legacyResultFieldFor("search")).toBe("searchResults");
        expect(legacyResultFieldFor("knowledge")).toBe("knowledgeResults");
        expect(legacyResultFieldFor("code")).toBe("codeResults");
        expect(legacyResultFieldFor("general")).toBeNull();
    });

    it("detects cross-agent dependency chains only when executable→executable", () => {
        expect(hasCrossAgentDependencies([
            { id: "1", type: "agent", dependsOn: [] },
            { id: "2", type: "agent", dependsOn: ["1"] },
        ])).toBe(true);
        expect(hasCrossAgentDependencies([
            { id: "1", type: "agent", dependsOn: [] },
            { id: "2", type: "reasoning", dependsOn: ["1"] },
        ])).toBe(false);
    });

    it("SUBTASK_BAD_TERMINAL excludes completed", () => {
        expect(SUBTASK_BAD_TERMINAL).not.toContain(SUBTASK_OK);
        expect(SUBTASK_BAD_TERMINAL).toContain("failed");
    });
});
