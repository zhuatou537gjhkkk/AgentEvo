/**
 * chatGraph 单元测试 — Phase 4 P0
 *
 * 覆盖：
 *   - mapIntentToNode() 动态路由映射 (M1.x)
 *   - fanoutByIntents() 意图扇出 (F1.x)
 *   - fanoutBySubTasks() subTask 扇出 (F2.x)
 *   - fanoutToAgents() 双路径路由 (F3.x)
 *   - enforceSubTaskOrder() 排序 (E1.x)
 *   - subTasksToPlan() 兼容转换
 *   - isSoloRun() 模式判断
 *   - State Reducers (S1.x)
 *
 * 运行: npx vitest run src/services/chatGraph.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ============================================================
// Mock 外部依赖（避免数据库连接等副作用）
// vi.mock 被提升到文件顶部 — 工厂必须是自包含的
// ============================================================

vi.mock('@langchain/openai', () => ({
    ChatOpenAI: vi.fn(),
}));

vi.mock('@langchain/core/messages', () => ({
    HumanMessage: vi.fn((opts) => opts),
    AIMessage: vi.fn((opts) => opts),
    SystemMessage: vi.fn((opts) => opts),
    ToolMessage: vi.fn((opts) => opts),
}));

vi.mock('@langchain/langgraph', () => {
    class MockSend {
        constructor(node, state) {
            this.node = node;
            this.state = state;
        }
    }

    // Annotation 既是函数又是对象(Annotation.Root)
    function Annotation(cfg) {
        return cfg;
    }
    Annotation.Root = (def) => {
        const state = {};
        for (const [key, cfg] of Object.entries(def)) {
            state[key] = cfg;
        }
        return state;
    };

    return {
        StateGraph: vi.fn(),
        START: '__start__',
        END: '__end__',
        Annotation,
        addMessages: vi.fn(),
        MemorySaver: vi.fn(),
        Send: MockSend,
    };
});

vi.mock('../db/index.js', () => ({
    saveMessage: vi.fn(),
    getHistoryMessages: vi.fn(() => []),
}));

vi.mock('../mcp/tools.js', () => ({
    agentTools: [],
    consumePendingQuestion: vi.fn(() => null),
    cancelAllPendingQuestions: vi.fn(),
}));

// toolRegistry mock
vi.mock('../mcp/registry.js', () => {
    const registry = {
        hasToolCategory: vi.fn(),
        getToolCategories: vi.fn(() => []),
        getTool: vi.fn(),
        hasTool: vi.fn(),
        getMCPServerNames: vi.fn(() => []),
    };
    return { toolRegistry: registry };
});

vi.mock('./chatUtils.js', () => ({
    WEB_SEARCH_TOOL_NAME: 'web_search',
    FORCED_WEB_SEARCH_MAX_CHARS: 12000,
    TOOL_ACTIVE_FORMS: {},
    normalizeChunkContent: (c) => (typeof c === 'string' ? c : String(c ?? '')),
    normalizeTemperature: (t) => t ?? 0.7,
    resolveSystemPrompt: (s) => s || 'You are a helpful assistant.',
    resolveModelName: () => 'test-model',
    buildChatOpenAIConfig: () => ({}),
    estimateTokens: () => 0,
    emitThought: vi.fn(),
    toLangChainMessage: (m) => m,
    isCreativeTask: () => false,
    buildDirectAnswerSystemInstruction: () => '',
    streamDirectChat: vi.fn(),
    buildHumanInputMessage: (m) => m,
    PLAN_MODE_INSTRUCTION: '',
}));

// ============================================================
// 现在可以安全 import chatGraph 模块
// ============================================================

import {
    mapIntentToNode,
    resolveSubTaskNode,
    enforceSubTaskOrder,
    orderSubTasksByType,
    subTasksToPlan,
    isSoloRun,
    fanoutBySubTasks,
    fanoutByIntents,
    mergeSubTasks,
    fanoutToAgents,
    AGENT_NODE_MAP,
    // Phase 7 / R3 — DAG scheduler + helpers
    estimateTaskComplexity,
    subTaskOutcomeFromText,
    fanoutDag,
    agentExitRoute,
    planSendDispatcherNode,
    planSendDispatcherExit,
    synthesizerExitRoute,
    emitPlanProgress,
    depContextForSubTask,
    subTaskSettledStatus,
    // Phase 7 / R3 — Synthesizer 融合上下文（provenance/artifact/status）
    buildFusionContext,
    createSSEEmitter,
    buildTaskDepsMap,
    validatePlanSyntax,
    prepareTaskExecution,
} from './chatGraph.js';

import { toolRegistry } from '../mcp/registry.js';

// LangGraph Send 类引用
const { Send } = await import('@langchain/langgraph');

// ============================================================
// R7 Plan/Send state contract
// ============================================================

describe('R7 Plan/Send state contract', () => {
    it('keeps a separate dependency table and rejects planner cycles', () => {
        const plan = [
            { id: 'search', type: 'agent', agent: 'search', dependsOn: [] },
            { id: 'code', type: 'agent', agent: 'code', dependsOn: ['search'] },
        ];
        expect(buildTaskDepsMap(plan)).toEqual({ search: [], code: ['search'] });
        expect(validatePlanSyntax(plan).ok).toBe(true);
        expect(validatePlanSyntax([{ ...plan[0], dependsOn: ['code'] }, plan[1]]).ok).toBe(false);
    });

    it('yields before executing a task and never calls business code while waiting', () => {
        const initial = { subTasks: [{ id: 'code', status: 'pending', dependsOn: ['search'] }], task_deps_map: { code: ['search'] }, task_meta: {} };
        expect(prepareTaskExecution(initial, 'code', { now: 10 }).action).toBe('record_start');
        const waiting = prepareTaskExecution({ ...initial, task_meta: { code: { task_start_ts: 10, wait_round: 0 } } }, 'code', { now: 11 });
        expect(waiting.action).toBe('wait');
        const ready = prepareTaskExecution({
            ...initial,
            subTasks: [{ id: 'search', status: 'completed' }, { id: 'code', status: 'pending', dependsOn: ['search'] }],
            task_meta: { code: { task_start_ts: 10, wait_round: 1 } },
        }, 'code', { now: 11 });
        expect(ready.action).toBe('execute');
    });
});

// ============================================================
// mapIntentToNode — 动态意图→节点映射 (M1.x)
// ============================================================

describe('mapIntentToNode — 动态路由映射', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // M1.1
    it('"search" -> "search_agent"', () => {
        expect(mapIntentToNode('search')).toBe('search_agent');
    });

    // M1.2
    it('"knowledge" -> "knowledge_agent"', () => {
        expect(mapIntentToNode('knowledge')).toBe('knowledge_agent');
    });

    // M1.3
    it('"code" -> "code_agent"', () => {
        expect(mapIntentToNode('code')).toBe('code_agent');
    });

    // M1.4
    it('"general" -> "general_chat"', () => {
        expect(mapIntentToNode('general')).toBe('general_chat');
    });

    // M1.5 KEY
    it('dynamic intent — 单工具 MCP 类别 -> "tool_executor"', () => {
        toolRegistry.hasToolCategory.mockReturnValue(true);
        toolRegistry.getToolCategories.mockReturnValue([
            { category: 'filesystem', tools: [{ name: 'read_file' }] },
        ]);
        expect(mapIntentToNode('filesystem')).toBe('tool_executor');
    });

    // M1.6
    it('dynamic intent — MCP category missing -> fallback "general_chat"', () => {
        toolRegistry.hasToolCategory.mockReturnValue(false);
        expect(mapIntentToNode('aliens')).toBe('general_chat');
    });

    // M1.7
    it('已知 intent 不走 hasToolCategory 检查', () => {
        const result = mapIntentToNode('search');
        expect(result).toBe('search_agent');
    });

    // M1.8 KEY（多工具 MCP 类别需要 LLM 工具选择，不能盲目取第一个工具）
    it('dynamic intent — 多工具 MCP 类别 -> "general_chat"', () => {
        toolRegistry.hasToolCategory.mockReturnValue(true);
        toolRegistry.getToolCategories.mockReturnValue([
            { category: 'amap', tools: [{ name: 'maps_geo' }, { name: 'maps_direction_transit_integrated' }] },
        ]);
        expect(mapIntentToNode('amap')).toBe('general_chat');
    });
});

// ============================================================
// fanoutByIntents — 意图驱动扇出 (F1.x)
// ============================================================

describe('fanoutByIntents — 意图驱动扇出 (路径B)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        toolRegistry.hasToolCategory.mockReturnValue(false);
    });

    // F1.1
    it('单 intent general -> 返回 "general_chat"', () => {
        const result = fanoutByIntents({ intents: ['general'], intent: 'general' });
        expect(result).toBe('general_chat');
    });

    // F1.2
    it('单 intent search -> 返回 "search_agent"', () => {
        const result = fanoutByIntents({ intents: ['search'], intent: 'search' });
        expect(result).toBe('search_agent');
    });

    // F1.3 KEY
    it('单 intent filesystem (动态) -> 返回 "tool_executor"', () => {
        toolRegistry.hasToolCategory.mockReturnValue(true);
        const result = fanoutByIntents({ intents: ['filesystem'], intent: 'filesystem' });
        expect(result).toBe('tool_executor');
    });

    // F1.4
    it('多 intent search + code -> Send[] length 2', () => {
        const result = fanoutByIntents({ intents: ['search', 'code'], intent: 'search' });
        expect(Array.isArray(result)).toBe(true);
        expect(result.every(r => r instanceof Send)).toBe(true);
        expect(result).toHaveLength(2);
        expect(result.map(s => s.node)).toEqual(
            expect.arrayContaining(['search_agent', 'code_agent'])
        );
    });

    // F1.5
    it('多 intent 含 general -> general removed, remaining solo', () => {
        const result = fanoutByIntents({ intents: ['search', 'general'], intent: 'search' });
        expect(typeof result).toBe('string');
        expect(result).toBe('search_agent');
    });

    // F1.6
    it('去重', () => {
        const result = fanoutByIntents({ intents: ['search', 'search', 'code'], intent: 'search' });
        expect(result).toHaveLength(2);
    });

    // F1.7
    it('空 intents -> fallback "general_chat"', () => {
        const result = fanoutByIntents({ intents: [], intent: 'general' });
        expect(result).toBe('general_chat');
    });

    it('mixed known + dynamic intent', () => {
        toolRegistry.hasToolCategory.mockImplementation((name) => name === 'filesystem');
        const result = fanoutByIntents({ intents: ['search', 'filesystem'], intent: 'search' });
        expect(result).toHaveLength(2);
        expect(result.map(s => s.node)).toEqual(
            expect.arrayContaining(['search_agent', 'tool_executor'])
        );
    });

    it('fallback: intent field instead of intents array', () => {
        const result = fanoutByIntents({ intent: 'search' });
        expect(result).toBe('search_agent');
    });
});

// ============================================================
// fanoutBySubTasks — subTask 驱动扇出 (F2.x)
// ============================================================

describe('fanoutBySubTasks — subTask 驱动扇出 (路径A)', () => {
    // F2.1
    it('single tool subTask -> Send with currentSubTask', () => {
        const result = fanoutBySubTasks({
            subTasks: [
                { id: '1', type: 'tool', toolName: 'web_search', status: 'pending', content: 'search' },
            ],
        });
        expect(result).toBeInstanceOf(Send);
        expect(result.node).toBe('tool_executor');
        expect(result.state.currentSubTask).toBeDefined();
        expect(result.state.currentSubTask.toolName).toBe('web_search');
        expect(result.state.currentSubTask.status).toBe('in_progress');
    });

    // F2.2 KEY
    it('multiple tool subTasks -> Send[] length 2 with in_progress', () => {
        const result = fanoutBySubTasks({
            subTasks: [
                { id: '1', type: 'tool', toolName: 'web_search', status: 'pending', content: 'search' },
                { id: '2', type: 'tool', toolName: 'filesystem/read_file', status: 'pending', content: 'read' },
            ],
        });
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(2);

        for (const send of result) {
            expect(send).toBeInstanceOf(Send);
            expect(send.node).toBe('tool_executor');
            expect(send.state.currentSubTask).toBeDefined();
            expect(send.state.currentSubTask.status).toBe('in_progress');
        }
    });

    // F2.3
    it('all blocked -> "synthesizer"', () => {
        const result = fanoutBySubTasks({
            subTasks: [
                { id: '1', type: 'tool', toolName: 'blocked_tool', status: 'blocked',
                  blockedReason: 'unavailable', content: 'attempt' },
            ],
        });
        expect(result).toBe('synthesizer');
    });

    // F2.4
    it('all reasoning -> "synthesizer"', () => {
        const result = fanoutBySubTasks({
            subTasks: [
                { id: '1', type: 'reasoning', status: 'pending', content: 'analyze' },
                { id: '2', type: 'reasoning', status: 'pending', content: 'summarize' },
            ],
        });
        expect(result).toBe('synthesizer');
    });

    // F2.5
    it('1 tool + 1 reasoning -> tool fanned via Send', () => {
        const result = fanoutBySubTasks({
            subTasks: [
                { id: '1', type: 'tool', toolName: 'web_search', status: 'pending', content: 'search' },
                { id: '2', type: 'reasoning', status: 'pending', content: 'summarize' },
            ],
        });
        expect(result).toBeInstanceOf(Send);
        expect(result.node).toBe('tool_executor');
        expect(result.state.currentSubTask.toolName).toBe('web_search');
    });

    // F2.6
    it('completed subTask not re-fanned', () => {
        const result = fanoutBySubTasks({
            subTasks: [
                { id: '1', type: 'tool', toolName: 'web_search', status: 'completed', content: 'search' },
            ],
        });
        expect(result).toBe('synthesizer');
    });

    // F2.7
    it('blocked + completed -> synthesizer', () => {
        const result = fanoutBySubTasks({
            subTasks: [
                { id: '1', type: 'tool', toolName: 'blocked_tool', status: 'blocked', blockedReason: 'x', content: 'a' },
                { id: '2', type: 'tool', toolName: 'web_search', status: 'completed', content: 'b' },
            ],
        });
        expect(result).toBe('synthesizer');
    });

    it('empty subTasks -> "synthesizer"', () => {
        const result = fanoutBySubTasks({ subTasks: [] });
        expect(result).toBe('synthesizer');
    });

    // Phase 4: agent routing tests
    it('single agent subTask -> Send to agent node', () => {
        const result = fanoutBySubTasks({
            subTasks: [
                { id: '1', type: 'agent', agent: 'search', goal: 'search for news', status: 'pending', content: 'search' },
            ],
        });
        expect(result).toBeInstanceOf(Send);
        expect(result.node).toBe('search_agent');
        expect(result.state.currentSubTask.goal).toBe('search for news');
        expect(result.state.currentSubTask.status).toBe('in_progress');
    });

    it('multiple agent subTasks -> Send[] to respective nodes', () => {
        const result = fanoutBySubTasks({
            subTasks: [
                { id: '1', type: 'agent', agent: 'search', goal: 's1', status: 'pending', content: 'c1' },
                { id: '2', type: 'agent', agent: 'knowledge', goal: 'k1', status: 'pending', content: 'c2' },
            ],
        });
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(2);
        expect(result[0].node).toBe('search_agent');
        expect(result[1].node).toBe('knowledge_agent');
    });

    it('mixed agent + tool subTasks -> Send[] to respective nodes', () => {
        const result = fanoutBySubTasks({
            subTasks: [
                { id: '1', type: 'agent', agent: 'search', goal: 's1', status: 'pending', content: 'c1' },
                { id: '2', type: 'tool', toolName: 'web_search', status: 'pending', content: 'c2' },
            ],
        });
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(2);
        expect(result[0].node).toBe('search_agent');
        expect(result[1].node).toBe('tool_executor'); // backward compat
    });

    it('unknown agent -> fallback to tool_executor', () => {
        const result = fanoutBySubTasks({
            subTasks: [
                { id: '1', type: 'agent', agent: 'unknown_xyz', goal: 'x', status: 'pending', content: 'c1' },
            ],
        });
        expect(result).toBeInstanceOf(Send);
        expect(result.node).toBe('tool_executor');
    });
});

// ============================================================
// resolveSubTaskNode — subTask 类型→节点名解析
// ============================================================

describe('resolveSubTaskNode — 节点解析', () => {
    it('agent "search" -> "search_agent"', () => {
        expect(resolveSubTaskNode({ type: 'agent', agent: 'search' })).toBe('search_agent');
    });
    it('agent "knowledge" -> "knowledge_agent"', () => {
        expect(resolveSubTaskNode({ type: 'agent', agent: 'knowledge' })).toBe('knowledge_agent');
    });
    it('agent "code" -> "code_agent"', () => {
        expect(resolveSubTaskNode({ type: 'agent', agent: 'code' })).toBe('code_agent');
    });
    it('agent "general" -> "general_chat"', () => {
        expect(resolveSubTaskNode({ type: 'agent', agent: 'general' })).toBe('general_chat');
    });
    it('unknown agent -> "tool_executor"', () => {
        expect(resolveSubTaskNode({ type: 'agent', agent: 'nonexistent' })).toBe('tool_executor');
    });
    it('type "tool" -> "tool_executor"', () => {
        expect(resolveSubTaskNode({ type: 'tool', toolName: 'web_search' })).toBe('tool_executor');
    });
});

// ============================================================
// fanoutToAgents — 双路径路由 (F3.x)
// ============================================================

describe('fanoutToAgents — 双路径路由', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        toolRegistry.hasToolCategory.mockReturnValue(false);
    });

    // F3.1
    it('subTasks non-empty -> path A (fanoutBySubTasks) returns Send', () => {
        const result = fanoutToAgents({
            subTasks: [{ id: '1', type: 'tool', toolName: 'web_search', status: 'pending', content: 'search' }],
            intents: ['search'],
            intent: 'search',
        });
        expect(result).toBeInstanceOf(Send);
        expect(result.node).toBe('tool_executor');
    });

    // F3.2
    it('subTasks empty -> path B (fanoutByIntents)', () => {
        const result = fanoutToAgents({
            subTasks: [],
            intents: ['search'],
            intent: 'search',
        });
        expect(result).toBe('search_agent');
    });

    it('subTasks empty + single general -> path B', () => {
        const result = fanoutToAgents({
            subTasks: [],
            intents: ['general'],
            intent: 'general',
        });
        expect(result).toBe('general_chat');
    });
});

// ============================================================
// enforceSubTaskOrder — tool 在前 reasoning 在后 (E1.x)
// ============================================================

describe('enforceSubTaskOrder — 步骤排序', () => {
    // E1.1
    it('tool first reasoning last (already sorted) -> unchanged', () => {
        const input = [
            { id: '1', type: 'tool', content: 'search' },
            { id: '2', type: 'reasoning', content: 'summarize' },
        ];
        const output = enforceSubTaskOrder(input);
        expect(output).toHaveLength(2);
        expect(output[0].type).toBe('tool');
        expect(output[1].type).toBe('reasoning');
        expect(output[0].id).toBe('1');
        expect(output[1].id).toBe('2');
    });

    // E1.2
    it('reasoning first tool last -> reordered', () => {
        const input = [
            { id: '1', type: 'reasoning', content: 'summarize' },
            { id: '2', type: 'tool', content: 'search' },
        ];
        const output = enforceSubTaskOrder(input);
        expect(output[0].type).toBe('tool');
        expect(output[1].type).toBe('reasoning');
    });

    // E1.3
    it('interleaved -> all tools first', () => {
        const input = [
            { id: '1', type: 'tool', content: 'search' },
            { id: '2', type: 'reasoning', content: 'analyze' },
            { id: '3', type: 'tool', content: 'read file' },
        ];
        const output = enforceSubTaskOrder(input);
        expect(output.map(s => s.type)).toEqual(['tool', 'tool', 'reasoning']);
    });

    // E1.4
    it('single element -> unchanged', () => {
        const input = [{ id: '1', type: 'tool', content: 'search' }];
        const output = enforceSubTaskOrder(input);
        expect(output).toHaveLength(1);
        expect(output[0].content).toBe('search');
    });

    it('empty array -> empty', () => {
        expect(enforceSubTaskOrder([])).toEqual([]);
    });

    it('non-array -> return as-is', () => {
        expect(enforceSubTaskOrder(null)).toBe(null);
    });

    it('IDs renumbered after sort', () => {
        const input = [
            { id: '5', type: 'reasoning', content: 'last' },
            { id: '3', type: 'tool', content: 'first' },
        ];
        const output = enforceSubTaskOrder(input);
        expect(output[0].id).toBe('1');
        expect(output[1].id).toBe('2');
    });
    // Phase 4: agent type
    it('agent tasks sorted before reasoning', () => {
        const input = [
            { id: '1', type: 'reasoning', content: 'r', status: 'pending' },
            { id: '2', type: 'agent', agent: 'search', goal: 's', content: 'a', status: 'pending' },
        ];
        const result = enforceSubTaskOrder(input);
        expect(result[0].type).toBe('agent');
        expect(result[1].type).toBe('reasoning');
    });
    it('agent + tool + reasoning -> agents/tools first', () => {
        const input = [
            { id: '1', type: 'reasoning', content: 'r', status: 'pending' },
            { id: '2', type: 'agent', agent: 'search', goal: 's', content: 'a', status: 'pending' },
            { id: '3', type: 'tool', toolName: 'web_search', content: 't', status: 'pending' },
        ];
        const result = enforceSubTaskOrder(input);
        expect(result.filter(s => s.type === 'reasoning')).toHaveLength(1);
        expect(result[0].type !== 'reasoning').toBe(true);
        expect(result[1].type !== 'reasoning').toBe(true);
        expect(result[2].type).toBe('reasoning');
    });
});

// ============================================================
// subTasksToPlan — 兼容转换
// ============================================================

describe('subTasksToPlan — 转 plan steps', () => {
    it('extracts id, content, status correctly', () => {
        const subTasks = [
            { id: '1', type: 'tool', toolName: 'web_search', content: '搜索AI新闻', status: 'pending' },
            { id: '2', type: 'reasoning', content: '整理总结', status: 'pending' },
        ];
        const plan = subTasksToPlan(subTasks);
        expect(plan).toEqual([
            { id: '1', content: '搜索AI新闻', status: 'pending' },
            { id: '2', content: '整理总结', status: 'pending' },
        ]);
    });

    it('empty array -> empty', () => {
        expect(subTasksToPlan([])).toEqual([]);
    });

    it('non-array -> empty', () => {
        expect(subTasksToPlan(null)).toEqual([]);
    });
});

// ============================================================
// isSoloRun — 模式判断
// ============================================================

describe('isSoloRun — Solo/Parallel 判断', () => {
    it('single intent -> true', () => {
        expect(isSoloRun({ intents: ['search'], intent: 'search' })).toBe(true);
    });

    it('multiple intents -> false', () => {
        expect(isSoloRun({ intents: ['search', 'code'], intent: 'search' })).toBe(false);
    });

    it('fallback uses intent field', () => {
        expect(isSoloRun({ intent: 'general' })).toBe(true);
    });

    it('defaults to general', () => {
        expect(isSoloRun({})).toBe(true);
    });
});

// ============================================================
// AGENT_NODE_MAP — 已知映射表不变
// ============================================================

describe('AGENT_NODE_MAP — 向后兼容验证', () => {
    it('search -> search_agent', () => {
        expect(AGENT_NODE_MAP.search).toBe('search_agent');
    });
    it('knowledge -> knowledge_agent', () => {
        expect(AGENT_NODE_MAP.knowledge).toBe('knowledge_agent');
    });
    it('code -> code_agent', () => {
        expect(AGENT_NODE_MAP.code).toBe('code_agent');
    });
    it('general -> general_chat', () => {
        expect(AGENT_NODE_MAP.general).toBe('general_chat');
    });
});

// ============================================================
// State Reducers 行为验证 (S1.x)
// ============================================================

describe('SSE agent lifecycle identity', () => {
    it('preserves subTaskId when same-type spans end out of order', () => {
        const writes = [];
        const res = {
            writableEnded: false,
            write(frame) { writes.push(frame); },
            once() {},
        };
        const traceCollector = {
            getTrace: () => ({ ok: true }),
            startSpan: vi.fn()
                .mockReturnValueOnce('span-1')
                .mockReturnValueOnce('span-2'),
            endSpan: vi.fn(),
        };
        const sse = createSSEEmitter(res, traceCollector, 'trace-1');
        sse.agentStart('code', '1');
        sse.agentStart('code', '2');
        sse.agentEnd('code', 'span-1');
        sse.agentEnd('code', 'span-2');
        const events = writes.map((frame) => {
            const text = String(frame);
            const start = text.indexOf('data: ');
            if (start < 0) return null;
            const end = text.indexOf('\\n', start);
            return JSON.parse(text.slice(start + 6, end < 0 ? undefined : end));
        }).filter(Boolean);
        expect(events.filter((event) => event.type === 'agent_start').map((event) => event.subTaskId)).toEqual(['1', '2']);
        expect(events.filter((event) => event.type === 'agent_end').map((event) => event.subTaskId)).toEqual(['1', '2']);
    });
});

describe('State Reducers — 语义验证', () => {
    describe('target-aware plan progress', () => {
        it('marks the dispatched step instead of the first active step', () => {
            const events = [];
            const sse = { todoUpdated: (todos) => events.push(todos) };
            const plan = [
                { id: '1', content: '检索资料', status: 'in_progress' },
                { id: '2', content: '编写代码', status: 'pending' },
            ];
            const result = emitPlanProgress(sse, plan, 'agent_start', '2');
            expect(result.map((step) => step.status)).toEqual(['in_progress', 'in_progress']);
            expect(events[0].find((step) => step.id === '2').status).toBe('in_progress');
        });

        it('completes only the identified step for a DAG branch', () => {
            const events = [];
            const sse = { todoUpdated: (todos) => events.push(todos) };
            const plan = [
                { id: '1', content: '检索资料', status: 'completed' },
                { id: '2', content: '编写代码', status: 'in_progress' },
            ];
            const result = emitPlanProgress(sse, plan, 'all_done', '2');
            expect(result.map((step) => step.status)).toEqual(['completed', 'completed']);
        });

        it('tools_done targets only the emitting parallel branch', () => {
            const events = [];
            const sse = { todoUpdated: (todos) => events.push(todos) };
            const plan = [
                { id: '1', content: '搜索新闻', status: 'in_progress' },
                { id: '2', content: '检索知识库', status: 'in_progress' },
                { id: '3', content: '综合结果', status: 'pending' },
            ];
            const result = emitPlanProgress(sse, plan, 'tools_done', '1');
            expect(result.map((step) => step.status)).toEqual(['completed', 'in_progress', 'pending']);
            expect(events).toHaveLength(1);
        });

        it('tools_done does not overwrite a failed or approval-waiting branch', () => {
            const failed = emitPlanProgress(null, [
                { id: '1', status: 'failed' },
            ], 'tools_done', '1');
            const waiting = emitPlanProgress(null, [
                { id: '2', status: 'waiting_approval' },
            ], 'tools_done', '2');
            expect(failed[0].status).toBe('failed');
            expect(waiting[0].status).toBe('waiting_approval');
        });
    });

    describe('subTasks merge reducer', () => {
        it('update existing id status', () => {
            const current = [{ id: '1', status: 'pending' }];
            const update = [{ id: '1', status: 'completed' }];
            const result = mergeSubTasks(current, update);
            expect(result[0].status).toBe('completed');
        });

        it('preserves terminal statuses across stale sibling snapshots', () => {
            const base = [
                { id: '1', status: 'pending' },
                { id: '2', status: 'pending' },
            ];
            const branchA = [
                { id: '1', status: 'completed' },
                { id: '2', status: 'pending' },
            ];
            const branchB = [
                { id: '1', status: 'pending' },
                { id: '2', status: 'completed' },
            ];

            expect(mergeSubTasks(mergeSubTasks(base, branchA), branchB))
                .toEqual([
                    { id: '1', status: 'completed' },
                    { id: '2', status: 'completed' },
                ]);
            expect(mergeSubTasks(mergeSubTasks(base, branchB), branchA))
                .toEqual([
                    { id: '1', status: 'completed' },
                    { id: '2', status: 'completed' },
                ]);
        });

        it('add new id', () => {
            const current = [{ id: '1', status: 'completed' }];
            const update = [{ id: '2', status: 'in_progress' }];
            const result = mergeSubTasks(current, update);
            expect(result).toHaveLength(2);
            expect(result.map(r => r.id).sort()).toEqual(['1', '2']);
        });

        it('empty update does not overwrite', () => {
            const current = [{ id: '1', status: 'pending' }];
            const result = mergeSubTasks(current, []);
            expect(result).toEqual(current);
        });

        it('empty current returns update', () => {
            const result = mergeSubTasks([], [{ id: '1', status: 'pending' }]);
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('1');
        });

        it('preserves unmodified fields on merge', () => {
            const current = [{ id: '1', status: 'pending', toolName: 'web_search', content: 'search' }];
            const update = [{ id: '1', status: 'in_progress' }];
            const result = mergeSubTasks(current, update);
            expect(result[0]).toEqual({
                id: '1', status: 'in_progress', toolName: 'web_search', content: 'search',
            });
        });
    });

    describe('planResults reducer', () => {
        function planResultsReducer(current, update) {
            if (!update || typeof update !== 'object') return current;
            return { ...current, ...update };
        }

        it('merges two independent keys', () => {
            const result = planResultsReducer({ '1': 'result1' }, { '2': 'result2' });
            expect(result).toEqual({ '1': 'result1', '2': 'result2' });
        });

        it('same key overwrites', () => {
            const result = planResultsReducer({ '1': 'old' }, { '1': 'new' });
            expect(result).toEqual({ '1': 'new' });
        });

        it('empty object update is no-op', () => {
            const result = planResultsReducer({ '1': 'result1' }, {});
            expect(result).toEqual({ '1': 'result1' });
        });

        it('non-object update returns current', () => {
            const result = planResultsReducer({ '1': 'result1' }, null);
            expect(result).toEqual({ '1': 'result1' });
        });

        it('multi-key merge', () => {
            const result = planResultsReducer({ '1': 'a', '2': 'b' }, { '3': 'c', '4': 'd' });
            expect(Object.keys(result)).toHaveLength(4);
        });
    });

    describe('currentSubTask reducer (overwrite)', () => {
        function currentSubTaskReducer(_, update) {
            return update;
        }

        it('new value replaces old', () => {
            const result = currentSubTaskReducer(
                { id: '1', toolName: 'web_search' },
                { id: '2', toolName: 'read_file' }
            );
            expect(result.id).toBe('2');
        });

        it('set to null', () => {
            const result = currentSubTaskReducer({ id: '1' }, null);
            expect(result).toBeNull();
        });
    });
});

// ============================================================
// 回归：确认源码语法正确
// ============================================================

describe('chatGraph source integrity', () => {
    it('chatGraph module can be imported', () => {
        expect(true).toBe(true);
    });
});

// ============================================================
// Phase 7 / R3 — Router complexity + subTask outcome helpers
// ============================================================

describe('estimateTaskComplexity — 任务复杂度启发式 (R3 #5)', () => {
    it('≥3 intents → complex', () => {
        expect(estimateTaskComplexity('x', ['a', 'b', 'c'])).toBe('complex');
    });
    it('2 intents + 排序词 → complex; 2 intents 无提示 → compound', () => {
        expect(estimateTaskComplexity('先查资料再写代码', ['search', 'code'])).toBe('complex');
        expect(estimateTaskComplexity('x', ['search', 'knowledge'])).toBe('compound');
    });
    it('单意图 + 长 pipeline 提示词 → complex; 其余 → simple', () => {
        expect(estimateTaskComplexity('请先设计一个完整的架构方案，然后再逐步实现各个模块的代码，最后编写测试并逐步验证每一步的结果是否与预期完全一致', ['code'])).toBe('complex');
        expect(estimateTaskComplexity('你好', ['general'])).toBe('simple');
    });
});

describe('subTaskOutcomeFromText — 结果文本 → completed|failed', () => {
    it('正常文本 → completed; 空 → failed; 错误/不可用标记 → failed', () => {
        expect(subTaskOutcomeFromText('搜索到三篇文章……')).toBe('completed');
        expect(subTaskOutcomeFromText('')).toBe('failed');
        expect(subTaskOutcomeFromText('{"ok":false,"data":null}')).toBe('failed');
        expect(subTaskOutcomeFromText('(web_search 工具不可用)')).toBe('failed');
    });
});

// ============================================================
// Phase 7 / R3 — 稳定排序（不重编号）
// ============================================================

describe('orderSubTasksByType — R3 稳定排序', () => {
    it('executable 在前 reasoning 在后，且 id/dependsOn 引用原样保留', () => {
        const out = orderSubTasksByType([
            { id: '1', type: 'reasoning', dependsOn: ['2', '3'], status: 'pending' },
            { id: '2', type: 'agent', agent: 'search', dependsOn: [], status: 'pending' },
            { id: '3', type: 'agent', agent: 'code', dependsOn: ['2'], status: 'pending' },
        ]);
        expect(out.map((s) => s.id)).toEqual(['2', '3', '1']); // 无重编号
        expect(out[0].id).toBe('2');
        expect(out[2].dependsOn).toEqual(['2', '3']); // 引用保持
    });
});

// ============================================================
// Phase 7 / R3 — DAG 入口/出口路由（flag 门控）
// ============================================================

describe('fanoutDag / agentExitRoute — DAG 路由 (R3 #4/#5)', () => {
    afterEach(() => {
        delete process.env.GRAPH_DAG_SCHEDULER_ENABLED;
    });

    it('fanoutDag: pending executable → plan_send_dispatcher；全 blocked/仅 reasoning → synthesizer', () => {
        expect(fanoutDag({ subTasks: [{ id: '1', type: 'agent', agent: 'search', status: 'pending' }] })).toBe('plan_send_dispatcher');
        expect(fanoutDag({ subTasks: [
            { id: '1', type: 'agent', status: 'blocked' },
            { id: '2', type: 'reasoning', status: 'pending' },
        ] })).toBe('synthesizer');
        expect(fanoutDag({ subTasks: [{ id: '1', type: 'reasoning', status: 'pending' }] })).toBe('synthesizer');
    });

    it('agentExitRoute: flag ON + subTasks → plan_send_dispatcher；否则 synthesizer（零拓扑变化）', () => {
        const withSub = { subTasks: [{ id: '1', type: 'agent', agent: 'search', status: 'pending' }] };
        // flag off → synthesizer
        expect(agentExitRoute(withSub)).toBe('synthesizer');
        // flag on + subTasks → plan_send_dispatcher
        process.env.GRAPH_DAG_SCHEDULER_ENABLED = 'true';
        expect(agentExitRoute(withSub)).toBe('plan_send_dispatcher');
        // flag on + 无 subTasks（solo/非 plan 路径）→ synthesizer
        expect(agentExitRoute({ subTasks: [] })).toBe('synthesizer');
        expect(agentExitRoute({})).toBe('synthesizer');
    });
});

// ============================================================
// Phase 7 / R3 — 结果状态推导 + 依赖上下文注入
// ============================================================

describe('subTaskSettledStatus / depContextForSubTask — R3 结果门控', () => {
    afterEach(() => {
        delete process.env.GRAPH_DAG_SCHEDULER_ENABLED;
    });

    it('flag OFF: 一律 completed（与 R2 一致）', () => {
        expect(subTaskSettledStatus('{"ok":false,"data":null}')).toBe('completed');
        expect(subTaskSettledStatus('好结果')).toBe('completed');
    });

    it('flag ON: 按结果文本推导 completed|failed', () => {
        process.env.GRAPH_DAG_SCHEDULER_ENABLED = 'true';
        expect(subTaskSettledStatus('正常结果')).toBe('completed');
        expect(subTaskSettledStatus('{"errorCode":"MCP_TOOL_FAILED"}')).toBe('failed');
    });

    it('depContextForSubTask: flag OFF → ""；flag ON 无依赖 → ""', () => {
        const st = { id: '2', dependsOn: ['1'] };
        expect(depContextForSubTask({ currentSubTask: st, agentResults: { '1': { agent: 'search', text: '资料' } } })).toBe('');
        process.env.GRAPH_DAG_SCHEDULER_ENABLED = 'true';
        expect(depContextForSubTask({ currentSubTask: { id: '9', dependsOn: [] }, agentResults: {} })).toBe('');
    });

    it('flag ON 有已完成依赖 → 注入有界参考上下文', () => {
        process.env.GRAPH_DAG_SCHEDULER_ENABLED = 'true';
        const ctx = depContextForSubTask({
            currentSubTask: { id: '2', dependsOn: ['1'] },
            agentResults: { '1': { agent: 'search', text: '检索到的资料 A' } },
        });
        expect(ctx).toContain('依赖步骤 1');
        expect(ctx).toContain('检索到的资料 A');
        expect(ctx).toContain('参考用');
    });
});

// ============================================================
// Phase 7 / R3 — plan_send_dispatcherNode：多波就绪 + 失败传播 + 残留 settle
// ============================================================

describe('planSendDispatcherNode — 依赖感知多波调度 (R3 #2/#3)', () => {
    const agent = (id, agent, dependsOn, extra = {}) => ({ id, type: 'agent', agent, dependsOn: dependsOn || [], status: 'pending', ...extra });

    afterEach(() => {
        delete process.env.GRAPH_PLAN_SEND_STATE_ENABLED;
    });

    it('wave-1 只分发依赖满足的步骤（Search→Code 两波）', async () => {
        const subTasks = [
            agent('1', 'search', []),
            agent('2', 'code', ['1']),
            { id: '3', type: 'reasoning', dependsOn: ['1', '2'], status: 'pending' },
        ];
        const first = await planSendDispatcherNode({ subTasks, schedulerWaves: 0 }, {});
        expect(first._sends.map((s) => s.id)).toEqual(['1']); // code 留待下一波
        expect(first.schedulerWaves).toBe(1);

        // 波1 完成 → 再次调度 → code 就绪
        const afterWave1 = subTasks.map((s) => (s.id === '1' ? { ...s, status: 'completed' } : s));
        const second = await planSendDispatcherNode({ subTasks: afterWave1, schedulerWaves: 1 }, {});
        expect(second._sends.map((s) => s.id)).toEqual(['2']);

        // 波2 完成 → 无就绪 executable → 终止（reasoning 由 synthesizer 融合）
        const afterWave2 = afterWave1.map((s) => (s.id === '2' ? { ...s, status: 'completed' } : s));
        const third = await planSendDispatcherNode({ subTasks: afterWave2, schedulerWaves: 2 }, {});
        expect(third._sends).toEqual([]);
    });

    it('失败依赖不触发后继：上游 failed → 下游 blocked 且不入波', async () => {
        const subTasks = [
            agent('1', 'search', []),
            agent('2', 'code', ['1']),
        ];
        // 上游以失败收场
        const failed = subTasks.map((s) => (s.id === '1' ? { ...s, status: 'failed' } : s));
        const pass = await planSendDispatcherNode({ subTasks: failed, schedulerWaves: 1 }, {});
        const blockedTask = pass.subTasks.find((s) => s.id === '2');
        expect(blockedTask.status).toBe('blocked');
        expect(blockedTask.statusReason).toContain('前置步骤');
        expect(pass._sends.map((s) => s.id)).not.toContain('2');
        expect(pass._sends).toEqual([]);
    });

    it('并行：互不依赖的多步骤同一波就绪', async () => {
        const subTasks = [agent('1', 'search', []), agent('2', 'knowledge', []), agent('3', 'code', ['1', '2'])];
        const pass = await planSendDispatcherNode({ subTasks, schedulerWaves: 0 }, {});
        expect(pass._sends.map((s) => s.id).sort()).toEqual(['1', '2']);
    });

    it('残留 in_progress（节点返回未落定）→ blocked，避免永不收敛', async () => {
        const subTasks = [{ id: '1', type: 'agent', agent: 'search', status: 'in_progress', dependsOn: [] }];
        const pass = await planSendDispatcherNode({ subTasks, schedulerWaves: 1 }, {});
        const settled = pass.subTasks.find((s) => s.id === '1');
        expect(settled.status).toBe('blocked');
        expect(settled.statusReason).toContain('未落定');
        expect(pass._sends).toEqual([]);
    });

    it('R7 first-entry yield requeues once instead of R3-blocking', async () => {
        process.env.GRAPH_PLAN_SEND_STATE_ENABLED = 'true';
        const subTasks = [{ id: '1', type: 'agent', agent: 'search', status: 'in_progress', dependsOn: [] }];
        const pass = await planSendDispatcherNode({ subTasks, schedulerWaves: 1 }, {});
        expect(pass.subTasks.find((task) => task.id === '1').status).toBe('in_progress');
        expect(pass._sends.map((task) => task.id)).toEqual(['1']);
        delete process.env.GRAPH_PLAN_SEND_STATE_ENABLED;
    });

    it('死锁防御：无 ready 无 running 但仍有 stuck → blocked', async () => {
        // 两个互相 stuck（本不应出现——planner 已拒绝成环，防御兜底）
        const subTasks = [
            { id: 'a', type: 'agent', agent: 'code', status: 'pending', dependsOn: ['b'] },
            { id: 'b', type: 'agent', agent: 'code', status: 'pending', dependsOn: ['a'] },
        ];
        const pass = await planSendDispatcherNode({ subTasks, schedulerWaves: 0 }, {});
        expect(pass._sends).toEqual([]);
        const statuses = pass.subTasks.map((s) => s.status);
        expect(statuses.every((st) => st === 'blocked')).toBe(true);
    });
});

// ============================================================
// Phase 7 / R3 — planSendDispatcherExit：就绪波 → Send[] / synthesizer
// ============================================================

describe('planSendDispatcherExit — 波分发条件边 (R3 #2)', () => {
    afterEach(() => {
        delete process.env.GRAPH_PLAN_SEND_STATE_ENABLED;
    });

    it('无就绪步骤 → synthesizer', () => {
        expect(planSendDispatcherExit({ _sends: [] })).toBe('synthesizer');
    });

    it('R7 retry control leaves synthesizer through the static scheduler', () => {
        process.env.GRAPH_PLAN_SEND_STATE_ENABLED = 'true';
        expect(synthesizerExitRoute({ plan_control: { action: 'retry_tasks' } })).toBe('plan_send_dispatcher');
        expect(synthesizerExitRoute({ plan_control: { action: 'replan' } })).toBe('planner');
        expect(synthesizerExitRoute({ plan_control: null })).toBe('end');
    });

    it('有就绪步骤 → Send[]，各自带 in_progress 的 currentSubTask 与目标节点', () => {
        const state = {
            _sends: [
                { id: '1', type: 'agent', agent: 'search', status: 'pending', dependsOn: [] },
                { id: '2', type: 'agent', agent: 'code', status: 'pending', dependsOn: ['1'] },
            ],
            subTasks: [],
        };
        const sends = planSendDispatcherExit(state);
        expect(Array.isArray(sends)).toBe(true);
        expect(sends.length).toBe(2);
        const nodes = sends.map((s) => s.node).sort();
        expect(nodes).toEqual(['code_agent', 'search_agent']);
        for (const s of sends) {
            expect(s.state.currentSubTask.status).toBe('in_progress');
        }
    });

    it('tool 类型 → tool_executor 目标', () => {
        const sends = planSendDispatcherExit({
            _sends: [{ id: '5', type: 'tool', toolName: 'read_file', status: 'pending', dependsOn: [] }],
            subTasks: [],
        });
        expect(sends[0].node).toBe('tool_executor');
    });
});

// ============================================================
// Phase 7 / R3 — Synthesizer 融合上下文（provenance/artifact/status）
// ============================================================

describe('buildFusionContext — Synthesizer 融合上下文 (R3 #5)', () => {
    // 与旧实现完全一致的 subTask/result 输入
    const baseState = () => ({
        subTasks: [
            { id: '1', type: 'agent', agent: 'knowledge', content: '检索学习率资料', status: 'completed', dependsOn: [] },
            { id: '2', type: 'agent', agent: 'code', content: '编写学习率配置代码', status: 'completed', dependsOn: ['1'] },
            { id: '3', type: 'reasoning', content: '综合检索与代码并给出最终说明', status: 'pending', dependsOn: ['1', '2'] },
        ],
        planResults: {
            '1': '检索结果：学习率建议 0.001（KBHIT）',
            '2': '代码：学习率配置完成（CODE_DONE）',
        },
    });

    it('legacy（enableProvenance=false）: 逐字节复刻旧标签 — 无 agent 追加、错误结果进 blocked 提示', () => {
        const state = {
            ...baseState(),
            planResults: { ...baseState().planResults, '1': '{"ok":false,"errorCode":"KB_FAILED"}' },
        };
        const out = buildFusionContext(state, { enableProvenance: false });
        // code 步骤标签不带 · code / · completed 之类 provenance 后缀
        expect(out.contextBlock).toContain('[步骤2: 编写学习率配置代码]');
        expect(out.contextBlock).not.toContain('· code');
        // 错误结果（步骤1）不算 source，进入 errorResults → blockedNote
        expect(out.sources).toEqual(['编写学习率配置代码']);
        expect(out.contextBlock).not.toContain('KBHIT');
        expect(out.blockedNote).toContain('检索学习率资料(未知工具)');
        expect(out.reasoningGuide).toContain('综合检索与代码');
    });

    it('provenance（enableProvenance=true）: 标签叠加 agent · status · 有产物，source 优先 agent 名', () => {
        const state = {
            ...baseState(),
            agentResults: {
                '1': { subTaskId: '1', agent: 'knowledge', source: 'knowledge', status: 'completed', text: '检索结果：学习率建议 0.001（KBHIT）', artifact: null },
                '2': { subTaskId: '2', agent: 'code', source: 'code', status: 'completed', text: '代码：学习率配置完成（CODE_DONE）', artifact: { digest: 'a1' }, errorCode: null },
            },
        };
        const out = buildFusionContext(state, { enableProvenance: true });
        // 用 AgentResult.text 注入（与 planResults 同文本），标签含 agent
        expect(out.contextBlock).toContain('KBHIT');
        expect(out.contextBlock).toContain('· code');
        expect(out.contextBlock).toContain('· knowledge');
        // completed 不带 status，但 artifact 存在 → “有产物”
        expect(out.contextBlock).toContain('有产物');
        // code 步骤不含多余 status 标签（completed 不显示）
        expect(out.contextBlock).not.toMatch(/· completed/);
        expect(out.sources).toEqual(['knowledge', 'code']);
    });

    it('provenance: failed/error 状态的 packet 进 errorResults（不进 contextBlock）', () => {
        const state = {
            ...baseState(),
            planResults: {},
            agentResults: {
                '1': { subTaskId: '1', agent: 'knowledge', status: 'failed', text: '{"ok":false,"errorCode":"KB_SEARCH_FAILED","message":"检索不可用"}', artifact: null },
            },
        };
        const out = buildFusionContext(state, { enableProvenance: true });
        expect(out.sources).toEqual([]);
        // 来源标签优先 agent 名（不是“未知工具”）
        expect(out.blockedNote).toContain('knowledge');
        expect(out.contextBlock).not.toContain('KB_SEARCH_FAILED');
    });

    it('provenance 降级: 有 agentResults 但 enableProvenance=false 时完全忽略（旧路径不读新包）', () => {
        const state = {
            ...baseState(),
            agentResults: {
                '1': { subTaskId: '1', agent: 'knowledge', status: 'completed', text: 'PACKET_ONLY_TEXT', artifact: { digest: 'x' } },
            },
            planResults: {}, // legacy 无文本 → 不注入 PACKET_ONLY_TEXT
        };
        const out = buildFusionContext(state, { enableProvenance: false });
        expect(out.contextBlock).toBe('');
        expect(out.contextBlock).not.toContain('PACKET_ONLY_TEXT');
        // reasoning 仍在 → 不会触发 pass-through（node 侧由 caller 决定）
        expect(out.reasoningGuide).not.toBe('');
    });

    it('无 subTask 的 legacy 平行模式 fallback（searchResults/knowledgeResults/codeResults）', () => {
        const state = {
            subTasks: [],
            planResults: {},
            searchResults: '实时搜索命中（SRCH）',
            knowledgeResults: '{"ok":false,"errorCode":"KB_FAILED"}',
            codeResults: '',
        };
        const out = buildFusionContext(state, { enableProvenance: false });
        expect(out.sources).toEqual(['搜索']);
        expect(out.contextBlock).toContain('[搜索结果]');
        expect(out.contextBlock).toContain('SRCH');
        expect(out.contextBlock).not.toContain('[知识库结果]');
        // 错误来源进入 blockedNote（“知识库”）
        expect(out.blockedNote).toContain('知识库');
    });
});
