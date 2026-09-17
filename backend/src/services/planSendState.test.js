import { describe, expect, it } from "vitest";
import {
    MAX_REPLAN_TIMES,
    MAX_SUPERSTEP_ROUND,
    buildTaskDepsMap,
    classifySynthesizerAction,
    prepareTaskRetry,
    selectRetryableTaskIds,
    prepareTaskExecution,
    reducerMergeDict,
    resetDict,
    settleTaskResult,
    validatePlanSyntax,
} from "./planSendState.js";

describe("Plan/Send state helpers", () => {
    const tasks = [
        { id: "a", type: "agent", agent: "search", dependsOn: [], status: "completed" },
        { id: "b", type: "agent", agent: "code", dependsOn: ["a"], status: "pending" },
    ];

    it("builds an immutable dependency table and validates valid plans", () => {
        expect(buildTaskDepsMap(tasks)).toEqual({ a: [], b: ["a"] });
        expect(validatePlanSyntax(tasks).ok).toBe(true);
    });

    it.each([
        [[{ id: "a", type: "agent", agent: "search" }, { id: "a", type: "agent", agent: "code" }], "DUPLICATE_TASK_ID"],
        [[{ id: "a", type: "agent", agent: "search", dependsOn: ["missing"] }], "MISSING_DEPENDENCY"],
        [[{ id: "a", type: "agent", agent: "search", dependsOn: ["b"] }, { id: "b", type: "agent", agent: "code", dependsOn: ["a"] }], "DEPENDENCY_CYCLE"],
        [[{ id: "a", type: "agent", agent: "unknown" }], "INVALID_AGENT"],
    ])("rejects plan errors (%s)", (plan, code) => {
        const result = validatePlanSyntax(plan);
        expect(result.ok).toBe(false);
        expect(result.errors.some((error) => error.code === code)).toBe(true);
    });

    it("uses explicit reset semantics for merge reducers", () => {
        const first = reducerMergeDict({}, { a: 1, __generation: 1 });
        expect(reducerMergeDict(first, { b: 2 })).toMatchObject({ a: 1, b: 2, __generation: 1 });
        expect(reducerMergeDict(first, resetDict(2))).toEqual({ __generation: 2 });
    });

    it("records first entry, waits idempotently, then detects limits", () => {
        const initial = prepareTaskExecution({ subTasks: [{ id: "b", status: "pending" }], task_meta: {}, task_deps_map: { b: [] } }, "b", { now: 10 });
        expect(initial.action).toBe("record_start");
        const state = { subTasks: [{ id: "b", status: "pending" }], task_meta: initial.taskMeta, task_deps_map: { b: ["a"] } };
        const waiting = prepareTaskExecution(state, "b", { now: 11 });
        expect(waiting.action).toBe("wait");
        expect(waiting.meta.wait_round).toBe(1);
        const timeout = prepareTaskExecution({ ...state, task_meta: { b: { task_start_ts: 0, wait_round: 0 } } }, "b", { now: 60 });
        expect(timeout.action).toBe("timeout");
        const deadlock = prepareTaskExecution({ ...state, task_meta: { b: { task_start_ts: 10, wait_round: MAX_SUPERSTEP_ROUND } } }, "b", { now: 11 });
        expect(deadlock.action).toBe("deadlock");
    });

    it("does not overwrite a terminal result and classifies retry tasks", () => {
        const state = { subTasks: [{ id: "a", type: "agent", status: "error" }], planResults: { a: "old" }, agentResults: { a: { status: "error" } } };
        expect(settleTaskResult(state, "a", "new").idempotent).toBe(true);
        expect(classifySynthesizerAction(state)).toEqual({ action: "retry_tasks", taskIds: ["a"] });
        expect(MAX_REPLAN_TIMES).toBe(3);
    });

    it("retries only failed executable tasks and preserves completed siblings", () => {
        const state = {
            plan_generation: 4,
            subTasks: [
                { id: "done", type: "agent", status: "completed" },
                { id: "retry", type: "agent", status: "error", statusReason: "temporary" },
                { id: "downstream", type: "agent", status: "blocked", dependsOn: ["retry"] },
                { id: "reason", type: "reasoning", status: "pending" },
            ],
            agentResults: {
                done: { status: "completed", text: "keep" },
                retry: { status: "error", text: "retry me" },
            },
            task_meta: { retry: { task_start_ts: 4, wait_round: 3, business_retry_count: 0 } },
        };
        expect(selectRetryableTaskIds(state)).toEqual(["retry"]);
        const retry = prepareTaskRetry(state, ["retry"], { retryRound: 0 });
        expect(retry.retry_round).toBe(1);
        expect(retry.subTasks.find((task) => task.id === "done").status).toBe("completed");
        expect(retry.subTasks.find((task) => task.id === "retry")).toMatchObject({ status: "pending", statusReason: null });
        expect(retry.subTasks.find((task) => task.id === "downstream")).toMatchObject({ status: "pending", statusReason: null });
        expect(retry.task_meta.retry).toMatchObject({ task_start_ts: null, wait_round: 0, business_retry_count: 1, dispatch_attempt: 1 });
        expect(classifySynthesizerAction({ ...state, task_meta: { retry: { business_retry_count: 1 } } })).toEqual({ action: "replan", reason: "TASK_RETRY_EXHAUSTED" });
    });
});
