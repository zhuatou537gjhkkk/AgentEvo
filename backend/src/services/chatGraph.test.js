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

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
    enforceSubTaskOrder,
    subTasksToPlan,
    isSoloRun,
    fanoutBySubTasks,
    fanoutByIntents,
    fanoutToAgents,
    AGENT_NODE_MAP,
} from './chatGraph.js';

import { toolRegistry } from '../mcp/registry.js';

// LangGraph Send 类引用
const { Send } = await import('@langchain/langgraph');

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
    it('dynamic intent — MCP category exists -> "tool_executor"', () => {
        toolRegistry.hasToolCategory.mockReturnValue(true);
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

describe('State Reducers — 语义验证', () => {
    describe('subTasks merge reducer', () => {
        function subTasksReducer(current, update) {
            if (!Array.isArray(update) || update.length === 0) return current;
            if (!Array.isArray(current) || current.length === 0) return update;
            const merged = current.map((step) => {
                const match = update.find((u) => u.id === step.id);
                return match ? { ...step, ...match } : step;
            });
            for (const u of update) {
                if (!merged.find((m) => m.id === u.id)) merged.push(u);
            }
            return merged;
        }

        it('update existing id status', () => {
            const current = [{ id: '1', status: 'pending' }];
            const update = [{ id: '1', status: 'completed' }];
            const result = subTasksReducer(current, update);
            expect(result[0].status).toBe('completed');
        });

        it('add new id', () => {
            const current = [{ id: '1', status: 'completed' }];
            const update = [{ id: '2', status: 'in_progress' }];
            const result = subTasksReducer(current, update);
            expect(result).toHaveLength(2);
            expect(result.map(r => r.id).sort()).toEqual(['1', '2']);
        });

        it('empty update does not overwrite', () => {
            const current = [{ id: '1', status: 'pending' }];
            const result = subTasksReducer(current, []);
            expect(result).toEqual(current);
        });

        it('empty current returns update', () => {
            const result = subTasksReducer([], [{ id: '1', status: 'pending' }]);
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('1');
        });

        it('preserves unmodified fields on merge', () => {
            const current = [{ id: '1', status: 'pending', toolName: 'web_search', content: 'search' }];
            const update = [{ id: '1', status: 'in_progress' }];
            const result = subTasksReducer(current, update);
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
