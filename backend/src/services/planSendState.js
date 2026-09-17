/**
 * Plan/Send runtime state helpers.
 *
 * This module is deliberately pure: it owns dependency-table validation and the
 * bounded task lifecycle used by the static main graph. It never calls an LLM,
 * runner, database, or sleeps, so the graph can use it without creating a
 * second orchestration system.
 */

export const TASK_ABS_TIMEOUT = 60;
export const MAX_SUPERSTEP_ROUND = 50;
export const MAX_REPLAN_TIMES = 3;
// `withRetry({ retries: LOCAL_RETRY_MAX })` means one initial request plus two
// bounded retry attempts. Existing graph nodes use this value for transient IO.
export const LOCAL_RETRY_MAX = 2;

export const TASK_STATUS = Object.freeze({
    PENDING: "pending",
    WAITING: "waiting",
    RUNNING: "in_progress",
    SUCCESS: "success",
    ERROR: "error",
    TIMEOUT: "timeout",
    DEPEND_FAILED: "depend_failed",
    DEADLOCK: "deadlock",
});

export const PLAN_CONTROL = Object.freeze({
    REPLAN: "replan",
    TERMINAL_ERROR: "terminal_error",
    RETRY_TASKS: "retry_tasks",
});

export function reducerMergeDict(current = {}, update = null) {
    if (!update || typeof update !== "object" || Array.isArray(update)) return current || {};
    // A generation reset is explicit because a plain {} cannot clear a merge reducer.
    if (update.__reset === true) return { __generation: update.__generation || 0 };
    const out = { ...(current || {}) };
    const generation = update.__generation ?? out.__generation;
    for (const [key, value] of Object.entries(update)) {
        if (key === "__reset" || key === "__generation") continue;
        out[key] = value;
    }
    if (generation != null) out.__generation = generation;
    return out;
}

export function resetDict(generation) {
    return { __reset: true, __generation: Number(generation) || 0 };
}

export function buildTaskDepsMap(subTasks = []) {
    const map = {};
    for (const task of Array.isArray(subTasks) ? subTasks : []) {
        const id = String(task?.id ?? "");
        if (!id) continue;
        map[id] = Array.isArray(task.dependsOn)
            ? [...new Set(task.dependsOn.map(String).filter((dep) => dep && dep !== id))]
            : [];
    }
    return map;
}

function syntaxError(code, taskId = null, detail = null) {
    return { code, taskId: taskId == null ? null : String(taskId), detail };
}

/** Strict, deterministic planner validation. It never mutates the plan. */
export function validatePlanSyntax(subTasks, { allowedAgents = ["search", "knowledge", "code", "general"] } = {}) {
    if (!Array.isArray(subTasks) || subTasks.length === 0) {
        return { ok: false, errors: [syntaxError("EMPTY_PLAN")] };
    }
    const ids = new Set();
    const errors = [];
    for (const task of subTasks) {
        const id = String(task?.id ?? "");
        if (!id) errors.push(syntaxError("INVALID_TASK_ID", id));
        else if (ids.has(id)) errors.push(syntaxError("DUPLICATE_TASK_ID", id));
        ids.add(id);
        if (!["agent", "tool", "reasoning"].includes(task?.type)) {
            errors.push(syntaxError("INVALID_TASK_TYPE", id));
        }
        if (task?.type === "agent" && !allowedAgents.includes(task.agent)) {
            errors.push(syntaxError("INVALID_AGENT", id, task.agent));
        }
        if (task?.dependsOn != null && !Array.isArray(task.dependsOn)) {
            errors.push(syntaxError("INVALID_DEPENDENCIES", id));
        }
    }
    for (const task of subTasks) {
        const id = String(task?.id ?? "");
        for (const dep of Array.isArray(task?.dependsOn) ? task.dependsOn : []) {
            const depId = String(dep);
            if (!ids.has(depId)) errors.push(syntaxError("MISSING_DEPENDENCY", id, depId));
            if (depId === id) errors.push(syntaxError("DEPENDENCY_CYCLE", id, depId));
        }
    }
    // Kahn cycle check, deterministic and independent of task order.
    const indegree = new Map([...ids].map((id) => [id, 0]));
    const edges = new Map([...ids].map((id) => [id, []]));
    for (const task of subTasks) {
        const id = String(task?.id ?? "");
        for (const dep of Array.isArray(task?.dependsOn) ? task.dependsOn : []) {
            const depId = String(dep);
            if (!ids.has(depId) || depId === id) continue;
            indegree.set(id, (indegree.get(id) || 0) + 1);
            edges.get(depId).push(id);
        }
    }
    const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id);
    let visited = 0;
    while (queue.length) {
        const id = queue.shift();
        visited += 1;
        for (const next of edges.get(id) || []) {
            indegree.set(next, indegree.get(next) - 1);
            if (indegree.get(next) === 0) queue.push(next);
        }
    }
    if (visited !== ids.size) errors.push(syntaxError("DEPENDENCY_CYCLE"));
    return { ok: errors.length === 0, errors, taskDepsMap: buildTaskDepsMap(subTasks) };
}

function nowSeconds(now) {
    return typeof now === "function" ? Number(now()) : Number(now ?? Date.now() / 1000);
}

function taskMeta(meta, id) {
    const raw = meta?.[id];
    return raw && typeof raw === "object" ? raw : null;
}

export function prepareTaskExecution(state, taskId, {
    now = Date.now() / 1000,
    taskTimeout = TASK_ABS_TIMEOUT,
    maxWaitRounds = MAX_SUPERSTEP_ROUND,
} = {}) {
    const id = String(taskId ?? "");
    const tasks = Array.isArray(state?.subTasks) ? state.subTasks : [];
    const task = tasks.find((candidate) => String(candidate?.id) === id);
    if (!task) return { action: "error", status: TASK_STATUS.ERROR, errorCode: "TASK_NOT_FOUND", taskId: id };
    const existing = taskMeta(state?.task_meta, id);
    const start = Number(existing?.task_start_ts);
    const meta = existing
        ? { task_start_ts: Number.isFinite(start) ? start : nowSeconds(now), wait_round: Math.max(0, Number(existing.wait_round) || 0) }
        : { task_start_ts: nowSeconds(now), wait_round: 0 };
    const metaUpdate = { [id]: meta };
    // Planner normally initializes every task's metadata. A start timestamp is
    // the marker that this executor has yielded once; an initial zero-only entry
    // must still take the first-entry path.
    if (!existing || !Number.isFinite(start)) return { action: "record_start", taskId: id, meta, taskMeta: metaUpdate };

    const status = String(task.status || "pending");
    if (["completed", "success", "error", "failed", "timeout", "depend_failed", "blocked", "deadlock"].includes(status)) {
        return { action: "already_terminal", taskId: id, status, meta, taskMeta: metaUpdate };
    }
    const elapsed = nowSeconds(now) - meta.task_start_ts;
    if (elapsed >= taskTimeout) return { action: "timeout", taskId: id, status: TASK_STATUS.TIMEOUT, errorCode: "TASK_TIMEOUT", meta, taskMeta: metaUpdate };
    if (meta.wait_round >= maxWaitRounds) return { action: "deadlock", taskId: id, status: TASK_STATUS.DEADLOCK, errorCode: "TASK_WAIT_ROUND_EXCEEDED", meta, taskMeta: metaUpdate };

    const deps = state?.task_deps_map?.[id] ?? task.dependsOn ?? [];
    const byId = new Map(tasks.map((candidate) => [String(candidate?.id), candidate]));
    const failed = deps.map(String).map((depId) => ({ id: depId, task: byId.get(depId) })).find(({ task: dep }) =>
        dep && ["error", "failed", "timeout", "depend_failed", "blocked", "deadlock"].includes(String(dep.status))
    );
    if (failed) return { action: "depend_failed", taskId: id, status: TASK_STATUS.DEPEND_FAILED, errorCode: "DEPENDENCY_FAILED", dependencyId: failed.id, meta, taskMeta: metaUpdate };
    const ready = deps.every((depId) => String(byId.get(String(depId))?.status) === "completed" || String(byId.get(String(depId))?.status) === "success");
    if (!ready) {
        const nextMeta = { ...meta, wait_round: meta.wait_round + 1 };
        return { action: "wait", taskId: id, status: "waiting", meta: nextMeta, taskMeta: { [id]: nextMeta } };
    }
    return { action: "execute", taskId: id, status: TASK_STATUS.RUNNING, meta, taskMeta: metaUpdate };
}

export function settleTaskResult(state, taskId, result, { status = "completed", errorCode = null } = {}) {
    const id = String(taskId ?? "");
    const text = String(result ?? "");
    const current = state?.planResults?.[id];
    const currentStatus = state?.agentResults?.[id]?.status;
    if (["completed", "success", "error", "failed", "timeout", "depend_failed", "blocked", "deadlock"].includes(String(currentStatus || ""))) {
        return { idempotent: true, planResults: {}, taskMeta: {} };
    }
    return {
        idempotent: false,
        planResults: { [id]: text },
        agentResults: { [id]: { subTaskId: id, status, text, errorCode } },
        subTasks: (state?.subTasks || []).map((task) => String(task.id) === id ? { ...task, status } : task),
    };
}

export function replanUpdate(replanCount = 0, generation = 0) {
    const next = Number(replanCount) + 1;
    return { replan_count: next, generation: Number(generation) + 1, exceeded: next >= MAX_REPLAN_TIMES };
}

export function taskRetryable(result) {
    return ["error", "failed", "timeout", "depend_failed"].includes(String(result?.status || ""));
}

/**
 * Pick one bounded business retry wave. `task_meta[taskId].business_retry_count`
 * belongs to a plan generation, so a replan starts with a clean retry budget.
 */
export function selectRetryableTaskIds(state, { maxRetries = 1 } = {}) {
    const tasks = Array.isArray(state?.subTasks) ? state.subTasks : [];
    const results = state?.agentResults || {};
    const meta = state?.task_meta || {};
    return tasks
        .filter((task) => task?.type === "agent" || task?.type === "tool")
        .map((task) => String(task.id))
        .filter((id) => {
            const result = results[id];
            // A scheduler-propagated failure can have no AgentResult packet; the
            // task status is still authoritative for a business retry decision.
            const task = tasks.find((candidate) => String(candidate?.id) === id);
            return taskRetryable(result) || ["error", "failed", "timeout", "depend_failed"].includes(String(task?.status || ""));
        })
        .filter((id) => Number(meta[id]?.business_retry_count || 0) < maxRetries);
}

/**
 * Reset only failed executable steps for one new business attempt. Successful
 * siblings are retained. Reducer reset markers are not used here because this
 * update intentionally preserves unrelated task metadata/results.
 */
export function prepareTaskRetry(state, taskIds, { retryRound = 0 } = {}) {
    const ids = new Set((taskIds || []).map(String));
    const meta = state?.task_meta || {};
    const generation = Number(state?.plan_generation || meta.__generation || 0);
    const taskMeta = { __generation: generation };
    for (const id of ids) {
        const previous = meta[id] && typeof meta[id] === "object" ? meta[id] : {};
        taskMeta[id] = {
            ...previous,
            task_start_ts: null,
            wait_round: 0,
            business_retry_count: Number(previous.business_retry_count || 0) + 1,
            dispatch_attempt: Number(previous.dispatch_attempt || 0) + 1,
        };
    }
    return {
        taskIds: [...ids],
        retry_round: Number(retryRound || 0) + 1,
        task_meta: taskMeta,
        subTasks: (state?.subTasks || []).map((task) => ids.has(String(task.id))
            ? { ...task, status: "pending", statusReason: null, dispatchId: null }
            // A prior scheduler may have propagated the failed task to this
            // downstream task. Once its dependency is retried, let the scheduler
            // derive readiness again instead of preserving that stale block.
            : (String(task.status) === "blocked" && (task.dependsOn || []).some((dep) => ids.has(String(dep))))
                ? { ...task, status: "pending", statusReason: null, dispatchId: null }
                : task),
    };
}

export function classifySynthesizerAction(state, { qualityCheck = null, maxTaskRetries = 1 } = {}) {
    const taskIds = selectRetryableTaskIds(state, { maxRetries: maxTaskRetries });
    if (taskIds.length) return { action: PLAN_CONTROL.RETRY_TASKS, taskIds };

    const tasks = Array.isArray(state?.subTasks) ? state.subTasks : [];
    const results = state?.agentResults || {};
    const unrecoveredFailure = tasks.some((task) => {
        if (task?.type !== "agent" && task?.type !== "tool") return false;
        const id = String(task.id);
        return taskRetryable(results[id]) || ["error", "failed", "timeout", "depend_failed"].includes(String(task.status || ""));
    });
    if (unrecoveredFailure) return { action: PLAN_CONTROL.REPLAN, reason: "TASK_RETRY_EXHAUSTED" };

    if (typeof qualityCheck === "function") {
        const verdict = qualityCheck(state);
        if (verdict?.replan === true) return { action: PLAN_CONTROL.REPLAN, reason: verdict.reason || "QUALITY_CHECK_FAILED" };
    }
    return { action: "synthesize" };
}
