/**
 * Phase 7 / R5 — llmDecider: a REAL model-tool decision layer for the bounded
 * coding loop.
 *
 * CodeAgentService (codingAgent.js) is LLM-agnostic: it loops over an injected
 * `decide(ctx)` and executes whatever op the decider returns (through the same
 * owner-scoped run surface → disposable worktree / action executor). The tests
 * use scripted deciders for determinism; this module supplies the production
 * decider — a single LLM round-trip per turn that turns `ctx` (goal + step
 * history + the R5 in-memory read observations) into the next legal decision.
 *
 * SAFETY (MVP agreed with the owner): the decider is READS + WRITES ONLY.
 * `forbidExec=true` by default means the decider NEVER emits an exec op
 * (`run_command`), even if the model asks for one — a forbidden exec triggers a
 * corrective retry, then degrades to a `note`, and is never passed through. The
 * server gate (`resolveCodingRunTask`) + this guard are defense-in-depth; a model
 * can never escalate to command execution through this mode.
 *
 * Resilience: one malformed/illegal model output never fails the session. Bounded
 * retries (schema reminders) then a graceful degradation to a `done`/`note` so
 * the loop terminates normally instead of crashing the graph turn.
 */
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { READ_OPS, WRITE_OPS, isExecOp } from "./runner/protocol.js";

/** Ops the coding decider is allowed to emit (reads + writes, NO exec). */
export const DECIDER_ALLOWED_OPS = Object.freeze([...READ_OPS, ...WRITE_OPS]);

/** Marker embedded in every prompt so e2e / fake-LLM tests can route deterministically. */
export const CODING_DECIDER_PROMPT_MARKER = "coding-decider-session";

/** Graceful-degradation summaries (kept as constants so tests can assert them). */
export const DECIDER_UNPARSEABLE_SUMMARY =
    "模型返回的编码决策无法解析,会话已安全结束(已写入的改动保留在运行工作树)。";
export const DECIDER_EXEC_BLOCKED_NOTE =
    "run_command 被禁用,已跳过(本编码模式不支持命令)。";

const OP_NAMES = [...DECIDER_ALLOWED_OPS].join(", ");

function toText(content) {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (part == null) return "";
                if (typeof part === "string") return part;
                if (typeof part.text === "string") return part.text;
                return "";
            })
            .join("");
    }
    return String(content);
}

/** Router-style JSON extraction: strip fences, grab first {...}, parse. */
function extractJson(text) {
    const cleaned = String(text || "").replace(/```(?:json)?/gi, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function coerceArgs(args) {
    return isPlainObject(args) ? args : {};
}

// Keep the common "create one file" smoke path deterministic. A model may
// prematurely answer `done` after only listing the tree; that is not completion
// of a user-requested mutation. We only infer a write when both a filename and
// explicit content are present in the goal, and still execute it through the
// normal run-scoped runner.
function inferRequiredFileWrite(ctx) {
    const goal = String(ctx?.goal || "");
    if (!/(创建|新建|新增|create|添加).*(文件|file)/i.test(goal)) return null;
    // Accept both UI-formatted backticks and the plain Chinese sentence used by
    // the chat smoke test: “创建一个文件 coding-agent-smoke.txt，只写入一行：...”。
    const pathMatch = goal.match(/[`「“"]([^`」”"]+)[`」”"]/) || goal.match(/文件\s+([\w./-]+)(?=[，,。\s]|$)/i);
    const contentMatch = goal.match(/(?:(?:只)?写入(?:一行)?|内容(?:为|是)?|content\s*[:：])\s*[:：]?\s*[`「“"]([^`」”"]+)[`」”"]/i)
        || goal.match(/(?:(?:只)?写入(?:一行)?|内容(?:为|是)?|content\s*[:：])\s*[:：]?\s*([^。\n]+?)(?=。|$)/i);
    if (!pathMatch || !contentMatch) return null;
    const steps = Array.isArray(ctx?.steps) ? ctx.steps : [];
    const wrote = steps.some((step) => step?.ok === true && ["write_file", "create_file", "apply_patch"].includes(String(step.op)));
    if (wrote) return null;
    // A create intent names a brand-new path; write_file is rejected on a missing
    // target by the runner, so a create must go through create_file. (Mirrors the
    // server-side guard in codingAgent.requiredFileWrite.)
    return { type: "op", op: "create_file", args: { path: pathMatch[1].trim(), content: `${contentMatch[1]}\n` }, note: "落实用户要求创建文件" };
}

/**
 * Validate a parsed model decision against the allowed-op set.
 * @returns {{valid:true, decision:object} | {valid:false, kind:'malformed'|'exec'|'unknownOp'}}
 */
function validateDecision(parsed, forbidExec, allowedSet) {
    if (!isPlainObject(parsed)) return { valid: false, kind: "malformed" };
    const { type } = parsed;

    if (type === "done") {
        const summary = String(parsed.summary == null ? "" : parsed.summary);
        return { valid: true, decision: { type: "done", summary } };
    }
    if (type === "note") {
        const text = String(parsed.text == null ? "" : parsed.text);
        return { valid: true, decision: { type: "note", text } };
    }
    if (type === "op" || type === "verify") {
        const op = parsed.op;
        if (typeof op !== "string") return { valid: false, kind: "malformed" };
        if (isExecOp(op)) {
            return forbidExec ? { valid: false, kind: "exec" } : { valid: true, decision: { type: "op", op, args: coerceArgs(parsed.args) } };
        }
        if (!allowedSet.has(op)) return { valid: false, kind: "unknownOp" };
        return { valid: true, decision: { type, op, args: coerceArgs(parsed.args), note: parsed.note == null ? null : String(parsed.note) } };
    }
    if (type === "ops") {
        const raw = Array.isArray(parsed.ops) ? parsed.ops : [];
        const entries = [];
        for (const entry of raw) {
            if (!isPlainObject(entry) || typeof entry.op !== "string") return { valid: false, kind: "malformed" };
            if (isExecOp(entry.op)) {
                if (forbidExec) return { valid: false, kind: "exec" };
                entries.push({ op: entry.op, args: coerceArgs(entry.args), note: entry.note == null ? null : String(entry.note) });
            } else if (allowedSet.has(entry.op)) {
                entries.push({ op: entry.op, args: coerceArgs(entry.args), note: entry.note == null ? null : String(entry.note) });
            } else {
                return { valid: false, kind: "unknownOp" };
            }
        }
        if (entries.length === 0) return { valid: false, kind: "malformed" };
        return { valid: true, decision: { type: "ops", ops: entries, note: parsed.note == null ? null : String(parsed.note) } };
    }
    return { valid: false, kind: "malformed" };
}

function renderSteps(steps) {
    const rows = (steps || []).map((s) => {
        const status = s.ok === false ? "FAILED" : s.ok === true ? "ok" : "pending";
        const label = s.type === "note" ? "note" : String(s.op || s.type || "");
        return `- [${status}] ${label}${s.errorCode ? ` (${s.errorCode})` : ""}${s.note ? ` — ${s.note}` : ""}`;
    });
    return rows.length ? rows.join("\n") : "(no steps yet)";
}

function buildSystemPrompt({ projectId, allowedList, forbidExec }) {
    return [
        `你是运行在一次性 git worktree 上的自主编码 Agent(项目 ${projectId || "(未指定)"})。`,
        `你的目标是完成用户给定的编码任务:先读代码理解现状,形成改动方案,再写文件落地,最后重读或 git.diff 确认,然后用 {"type":"done","summary":…} 总结改动了哪些文件。`,
        ``,
        `可用的操作(op)只有这些:${allowedList}。`,
        `- 读操作立即可见,结果会作为 observations 在下一轮提供给你。`,
        `- 写操作(write_file/create_file/delete_file/apply_patch)会写入一次性 worktree(主仓库不会被触碰),可靠 teardown 回滚。`,
        forbidExec
            ? `- 命令执行(run_command)在本模式被禁用,即使你要求也会被拒绝——验证请用 git.status / git.diff 或重读文件。`
            : ``,
        ``,
        `每次只能返回一个 JSON 决策对象,不要包含任何其他文字:`,
        `- 执行单个操作:{"type":"op","op":"<操作名>","args":{...},"note":"这一步在做什么"}`,
        `- 写多个文件的准备/一次多个读:{"type":"ops","ops":[{"op":"read_file","args":{...}}, ...]}`,
        `- 说明性备注:{"type":"note","text":"…"}`,
        `- 任务完成:{"type":"done","summary":"改动了哪些文件、做了什么"}`,
        ``,
        `编码会话标记:${CODING_DECIDER_PROMPT_MARKER}`,
    ].filter(Boolean).join("\n");
}

function buildUserText(ctx, correction) {
    const history = ctx.steps?.length ? renderSteps(ctx.steps) : "(no steps yet)";
    const observations = Array.isArray(ctx.observations) && ctx.observations.length
        ? ctx.observations.join("\n\n")
        : "(暂无读结果;先用 read_file / list_tree / search_text 观察)";
    const lines = [
        `# 编码目标`,
        String(ctx.goal || "(空)"),
        ``,
        `# 已执行的步骤`,
        history,
        ``,
        `# 最近的读结果(observations)`,
        observations,
    ];
    if (correction) {
        lines.push(``, `# 需要纠正`, correction);
    }
    return lines.join("\n");
}

/**
 * Build a real-LLM decide() for CodeAgentService.
 *
 * @param {object} opts
 * @param {Function} opts.makeLlm — `(opts) => ChatOpenAI-like` with `invoke(messages,{signal})`.
 * @param {boolean} [opts.forbidExec=true] — NEVER return an exec op.
 * @param {string[]} [opts.allowedOps=DECIDER_ALLOWED_OPS]
 * @param {string|null} [opts.modelName=null]
 * @param {AbortSignal|null} [opts.signal=null]
 * @param {number} [opts.maxRetries=1] — corrective retries before graceful degradation.
 * @returns {(ctx: object) => Promise<object>} a decide() implementation.
 */
export function createCodingDecider({
    makeLlm,
    forbidExec = true,
    allowedOps = DECIDER_ALLOWED_OPS,
    modelName = null,
    signal = null,
    maxRetries = 1,
} = {}) {
    if (typeof makeLlm !== "function") {
        throw new TypeError("createCodingDecider requires a makeLlm(llmOpts) function");
    }
    const allowedSet = new Set(allowedOps || []);
    const allowedList = (allowedOps && allowedOps.length ? allowedOps : DECIDER_ALLOWED_OPS).join(", ");
    const llmOpts = { temperature: 0 };
    if (modelName) llmOpts.modelName = modelName;

    return async function llmDecide(ctx) {
        const inferredWrite = inferRequiredFileWrite(ctx);
        if (inferredWrite) return inferredWrite;

        const llm = makeLlm(llmOpts);
        const system = new SystemMessage(buildSystemPrompt({ projectId: ctx?.projectId, allowedList, forbidExec }));
        const retryBudget = Math.max(0, Number.isFinite(maxRetries) ? maxRetries : 0);

        let correction = "";
        for (let attempt = 0; attempt <= retryBudget; attempt++) {
            let response;
            try {
                response = await llm.invoke([system, new HumanMessage(buildUserText(ctx, correction))], { signal });
            } catch (error) {
                if (attempt < retryBudget) {
                    correction = `模型调用失败(${String(error?.message || error).slice(0, 120)}),请仅返回一个合法 JSON 决策。`;
                    continue;
                }
                return { type: "done", summary: DECIDER_UNPARSEABLE_SUMMARY };
            }

            const parsed = extractJson(toText(response?.content));
            const verdict = validateDecision(parsed, forbidExec, allowedSet);

            if (verdict.valid) return verdict.decision;

            if (verdict.kind === "exec" && attempt < retryBudget) {
                correction = "上一个响应包含了被禁用的 run_command。本编码模式不允许执行命令,请只使用读/写操作或返回 done。";
                continue;
            }
            if (verdict.kind === "unknownOp" && attempt < retryBudget) {
                correction = `上一个响应使用了非白名单操作。可用的 op 只有:${allowedList}。`;
                continue;
            }
            if (attempt < retryBudget) {
                correction = `上一个响应不是合法的编码决策 JSON。请只返回一个 JSON 对象,例如 {"type":"op","op":"read_file","args":{"path":"…"}} 或 {"type":"done","summary":"…"}。`;
                continue;
            }

            // Budget exhausted — degrade gracefully, never crash the turn.
            if (verdict.kind === "exec") return { type: "note", text: DECIDER_EXEC_BLOCKED_NOTE };
            return { type: "done", summary: DECIDER_UNPARSEABLE_SUMMARY };
        }

        return { type: "done", summary: DECIDER_UNPARSEABLE_SUMMARY };
    };
}

export default createCodingDecider;
