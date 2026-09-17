import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createApp } from "../app.js";
import { issueAuthToken } from "../auth.js";
import {
    initDB,
    createUser,
    createSession,
    getHistoryMessages,
} from "../db/index.js";

/**
 * Phase 7 / R3 — 主 Graph 依赖感知多波调度（真实 LangGraph + 真实 HTTP /chat）。
 *
 * 与 W4-R2 reliability 矩阵同构：唯一注入点是 `services.makeLlm`，其余全部真实
 * （真 LangGraph 编译的 buildAgentGraph 拓扑、真 SSE、真 DB 落库）。差异是：
 *   - GRAPH_DAG_SCHEDULER_ENABLED=true → planner 走 R3 依赖校验，fanout 进 plan_send_dispatcher；
 *   - plan_mode=true → planner LLM 由 fake 返回一个“Knowledge → Code”的两波计划
 *     （code 步骤 dependsOn knowledge 步骤）；
 *   - 断言两件 DoD 关键事实：
 *       1) code 真的在 knowledge 完成之后才执行（依赖驱动排序）；
 *       2) code 节点的 LLM 消息里真实收到了 knowledge 的检索结果（依赖注入），
 *          且 knowledge 失败时 code 依赖不触发（失败不触发后继）。
 *
 * Secrets：只用合成 marker，绝不含真实密钥/用户内容。真实 DB 为 vitest per-worker
 * 临时空库，不触碰 backend/agent_data.db。
 */

const KB_GOAL = "检索学习率设定的相关资料（KBGOAL1）";
const CODE_GOAL = "基于检索结果实现学习率配置代码（CODESRC_LR）";
const KB_HIT = "检索结果：模型训练学习率建议 0.001，并随 epoch 衰减（KBHIT）";
const KB_ERR = '{"ok":false,"data":null,"errorCode":"KB_SEARCH_FAILED","message":"检索不可用","retryable":true}';
// 注意：CODESRC_LR 只出现在 code 子任务的 goal（node 消息），绝不能进 USER_MSG，
// 否则会随聊天历史泄漏到 router/planner/synthesizer，使 marker 无法定位 code 节点。
const USER_MSG = "请先检索学习率设定知识，再基于检索结果写一段配置学习率的代码";

const PLAN_JSON = JSON.stringify([
    { id: "1", type: "agent", agent: "knowledge", goal: KB_GOAL, content: "检索学习率资料", dependsOn: [], status: "pending" },
    { id: "2", type: "agent", agent: "code", goal: CODE_GOAL, content: "编写学习率配置代码", dependsOn: ["1"], status: "pending" },
    { id: "3", type: "reasoning", content: "综合检索与代码并给出最终说明", dependsOn: ["1", "2"], status: "pending" },
]);
const ROUTER_JSON = JSON.stringify({
    intents: ["knowledge", "code"],
    primarySource: null,
    analysis: "R3 dag e2e",
    searchQuery: null,
});

const PREV_ENV = {
    langgraph: process.env.USE_LANGGRAPH,
    dag: process.env.GRAPH_DAG_SCHEDULER_ENABLED,
    planSend: process.env.GRAPH_PLAN_SEND_STATE_ENABLED,
    contextBuilder: process.env.CONTEXT_BUILDER_ENABLED,
};

const servers = [];
let base = "";

const DAG_USER = { username: "r3_dag_user" };

function open(app) {
    return new Promise((resolve) => {
        const server = createServer(app);
        server.listen(0, "127.0.0.1", () => {
            servers.push(server);
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });
}

function headers(user) {
    return {
        Authorization: `Bearer ${issueAuthToken({ id: user.id, username: user.username })}`,
        "Content-Type": "application/json",
    };
}

async function postChat(user, sessionId, message, { planMode = true } = {}) {
    const response = await fetch(`${base}/chat`, {
        method: "POST",
        headers: headers(user),
        body: JSON.stringify({
            session_id: sessionId,
            message,
            enable_web_search: false,
            plan_mode: planMode,
            enable_memory: false,
        }),
    });
    return response;
}

function assistantTextsOf(userId, sessionId) {
    return getHistoryMessages(userId, sessionId, 50)
        .filter((m) => m.role === "assistant")
        .map((m) => String(m.content));
}

/**
 * 确定性 fake makeLlm：按“各节点独有的 system 提示词”分流——这些 marker 只出现在
 * 各自节点的 SystemMessage 里，不会随聊天历史串味（CODESRC_LR 若放进 USER_MSG 会
 * 泄漏到 router/planner/synthesizer，无法定位 code 节点）。记录每次 invoke/stream
 * 的调用全文与次序，供断言依赖时序与注入。
 * @param {{ knowledgeOutcome: 'ok'|'fail' }} cfg
 */
function makeDagFake({ knowledgeOutcome = "ok", plan = PLAN_JSON } = {}) {
    const log = []; // {kind, joined, at}
    const join = (msgs) => (msgs || [])
        .map((m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "")))
        .join("\n");

    const invoke = async (msgs) => {
        const joined = join(msgs);
        log.push({ kind: "invoke", joined, at: log.length });
        if (joined.includes("智能路由助手")) return { content: ROUTER_JSON };
        if (joined.includes("任务规划助手")) return { content: plan };
        // knowledge 子任务节点（plan 并行态 firstResponse invoke）→ 检索结果
        if (joined.includes("知识库检索专家")) {
            const knowledgeAttempt = log.filter((entry) => (
                entry.kind === "invoke" && entry.joined.includes("知识库检索专家。使用 search_knowledge_base 工具")
            )).length;
            return {
                content: knowledgeOutcome === "ok" || (knowledgeOutcome === "retry_once" && knowledgeAttempt >= 2)
                    ? KB_HIT
                    : KB_ERR,
            };
        }
        // code 子任务节点（plan 并行态 invoke）→ 判别是否收到依赖注入（KBHIT）
        if (joined.includes("你是代码助手")) {
            return { content: joined.includes("KBHIT")
                ? "代码：按检索到的 0.001 学习率实现（CODE_SAW_DEP=1）"
                : "代码：未拿到检索结果（CODE_SAW_DEP=0）" };
        }
        return { content: '{"intents":["general"]}' };
    };

    const stream = async function* (msgs) {
        const joined = join(msgs);
        log.push({ kind: "stream", joined, at: log.length });
        yield { content: `SYNTH_FINAL：已综合检索与代码结果。` };
    };

    const makeLlm = (opts) => {
        if (opts?.streaming !== true) return { invoke, stream: async function* () {} };
        return { stream, bindTools: () => ({ stream }) };
    };

    // 实时查询（log 在运行中被填充，不能构造时快照）；marker 均为节点独有 system 提示词
    const callsFor = (marker) => log.filter((e) => e.joined.includes(marker));
    // A knowledge response can be generated by both the retrieval and the
    // presentation prompt. Only the former is the executable subtask call.
    const knowledgeCalls = () => callsFor("知识库检索专家。使用 search_knowledge_base 工具");

    return {
        makeLlm,
        log,
        callsFor,
        knowledgeCalls,
        codeCalls: () => callsFor("你是代码助手"),
        synthCalls: () => callsFor("综合处理助手"),
    };
}

describe("R3 主 Graph DAG 多波调度（真实 LangGraph + HTTP）", () => {
    beforeAll(() => {
        initDB();
        DAG_USER.id = createUser(DAG_USER.username, "hash-r3");
    });

    beforeEach(() => {
        process.env.USE_LANGGRAPH = "true";
        process.env.CONTEXT_BUILDER_ENABLED = "false";
        process.env.GRAPH_DAG_SCHEDULER_ENABLED = "true";
        delete process.env.GRAPH_PLAN_SEND_STATE_ENABLED;
    });

    afterEach(async () => {
        for (const [k, v] of Object.entries(PREV_ENV)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        while (servers.length) {
            const server = servers.pop();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    afterAll(() => {
        servers.length = 0;
    });

    it("两波依赖驱动：Knowledge 完成 → Code 收到依赖结果才执行（真实 wave 排序）", async () => {
        const fake = makeDagFake({ knowledgeOutcome: "ok" });
        base = await open(createApp({ dependencies: { services: { makeLlm: fake.makeLlm } } }));
        const sessionId = createSession(DAG_USER.id, `r3 dag session ${Date.now()}`);

        const resp = await postChat(DAG_USER, sessionId, USER_MSG);
        expect(resp.status).toBe(200);
        expect(resp.headers.get("content-type")).toContain("text/event-stream");
        const body = await resp.text();

        // Synthesizer 融合输出 + 落库
        expect(body).toContain("data: [DONE]");
        expect(assistantTextsOf(DAG_USER.id, sessionId).join("\n")).toContain("SYNTH_FINAL");

        // knowledge 确实执行了一次（invoke：知识库检索专家系统提示词）
        const kbCalls = fake.knowledgeCalls();
        expect(kbCalls.length).toBeGreaterThanOrEqual(1);
        // code 节点恰好被调度一次（invoke：你是代码助手系统提示词）
        const codeCalls = fake.codeCalls();
        expect(codeCalls.length).toBe(1);
        // DoD 依赖注入：code 的调用消息里含 KBHIT（真实收到前置检索结果）
        expect(codeCalls[0].joined).toContain("KBHIT");
        // DoD 依赖排序：knowledge invoke 先于 code invoke
        expect(codeCalls[0].at).toBeGreaterThan(kbCalls[0].at);
    });

    it("R7 Plan/Send：首次 gate 只记录状态，随后每个步骤恰好执行业务一次", async () => {
        process.env.GRAPH_PLAN_SEND_STATE_ENABLED = "true";
        const fake = makeDagFake({ knowledgeOutcome: "ok" });
        base = await open(createApp({ dependencies: { services: { makeLlm: fake.makeLlm } } }));
        const sessionId = createSession(DAG_USER.id, `r7 plan-send happy ${Date.now()}`);

        const resp = await postChat(DAG_USER, sessionId, USER_MSG);
        expect(resp.status).toBe(200);
        const body = await resp.text();

        expect(body).toContain("data: [DONE]");
        // The static scheduler re-enters each Send target once after the pure
        // first-entry gate has written task_start_ts. It must not duplicate the
        // real business invoke on that bookkeeping pass.
        expect(fake.knowledgeCalls()).toHaveLength(1);
        expect(fake.codeCalls()).toHaveLength(1);
        expect(fake.codeCalls()[0].joined).toContain("KBHIT");
        expect(fake.codeCalls()[0].at).toBeGreaterThan(fake.knowledgeCalls()[0].at);
        expect(assistantTextsOf(DAG_USER.id, sessionId).join("\n")).toContain("SYNTH_FINAL");
    });

    it("失败不触发后继：Knowledge 检索失败 → Code 不被调度（不执行、不注入）", async () => {
        const fake = makeDagFake({ knowledgeOutcome: "fail" });
        base = await open(createApp({ dependencies: { services: { makeLlm: fake.makeLlm } } }));
        const sessionId = createSession(DAG_USER.id, `r3 dag fail ${Date.now()}`);

        const resp = await postChat(DAG_USER, sessionId, USER_MSG);
        expect(resp.status).toBe(200);
        const body = await resp.text();

        // knowledge 执行了
        expect(fake.knowledgeCalls().length).toBeGreaterThanOrEqual(1);
        // code 从未被调度（失败依赖不触发后继）
        expect(fake.codeCalls().length).toBe(0);
        // 仍然正常结束 + 落库（Synthesizer 报告 blocked/错误）
        expect(body).toContain("data: [DONE]");
        expect(assistantTextsOf(DAG_USER.id, sessionId).join("\n")).toContain("SYNTH_FINAL");
    });
});
