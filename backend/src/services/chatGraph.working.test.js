import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    invalidateWorkingMemoryAtTerminal,
    planSendDispatcherNode,
    plannerNode,
} from './chatGraph.js';

const previousWorking = process.env.MEMORY_WORKING_CONTEXT_V1;
const previousDag = process.env.GRAPH_DAG_SCHEDULER_ENABLED;
const previousPlanSend = process.env.GRAPH_PLAN_SEND_STATE_ENABLED;

afterEach(() => {
    if (previousWorking == null) delete process.env.MEMORY_WORKING_CONTEXT_V1;
    else process.env.MEMORY_WORKING_CONTEXT_V1 = previousWorking;
    if (previousDag == null) delete process.env.GRAPH_DAG_SCHEDULER_ENABLED;
    else process.env.GRAPH_DAG_SCHEDULER_ENABLED = previousDag;
    if (previousPlanSend == null) delete process.env.GRAPH_PLAN_SEND_STATE_ENABLED;
    else process.env.GRAPH_PLAN_SEND_STATE_ENABLED = previousPlanSend;
});

function serviceSpy() {
    return {
        upsertSessionWorkingState: vi.fn(async (...args) => ({ enabled: true, args })),
        invalidateSessionWorkingState: vi.fn(async (...args) => ({ enabled: true, invalidated: 4, args })),
    };
}

describe('ChatGraph working-memory hooks', () => {
    it('updates working state after planner output without an extra LLM call', async () => {
        process.env.MEMORY_WORKING_CONTEXT_V1 = 'true';
        delete process.env.GRAPH_DAG_SCHEDULER_ENABLED;
        delete process.env.GRAPH_PLAN_SEND_STATE_ENABLED;
        const service = serviceSpy();
        const llmCalls = [];
        const sse = { todoUpdated: vi.fn() };
        const state = {
            planMode: true,
            intent: 'knowledge',
            intents: ['knowledge'],
            userInput: '整理知识库中的 Agent 资料',
            enableWebSearch: false,
            enableMemory: true,
            modelName: 'test-model',
            plan_generation: 0,
        };
        const result = await plannerNode(state, {
            configurable: {
                sse,
                userId: 5,
                sessionId: 6,
                createMemoryService: () => service,
                makeLlm: () => ({ invoke: async () => {
                    llmCalls.push('planner');
                    return { content: JSON.stringify([{ id: '1', type: 'agent', agent: 'general', goal: '整理资料', content: '整理资料', dependsOn: [], status: 'pending' }]) };
                } }),
            },
        });
        expect(llmCalls).toEqual(['planner']);
        expect(result.subTasks).toHaveLength(1);
        expect(service.upsertSessionWorkingState).toHaveBeenCalledTimes(1);
        expect(service.upsertSessionWorkingState.mock.calls[0][0]).toBe(6);
        expect(service.upsertSessionWorkingState.mock.calls[0][2]).toMatchObject({ source: 'planner' });
    });

    it('persists deterministic completed steps at the scheduler rendezvous', async () => {
        process.env.MEMORY_WORKING_CONTEXT_V1 = 'true';
        delete process.env.GRAPH_DAG_SCHEDULER_ENABLED;
        delete process.env.GRAPH_PLAN_SEND_STATE_ENABLED;
        const service = serviceSpy();
        const result = await planSendDispatcherNode({
            enableMemory: true,
            userInput: '完成一个两步任务',
            plan_generation: 1,
            subTasks: [
                { id: '1', type: 'agent', agent: 'general', content: '第一步', status: 'completed', dependsOn: [] },
                { id: '2', type: 'agent', agent: 'general', content: '第二步', status: 'pending', dependsOn: ['1'] },
            ],
        }, {
            configurable: { userId: 5, sessionId: 6, createMemoryService: () => service },
        });
        expect(result.subTasks.find((task) => task.id === '2').status).toBe('in_progress');
        expect(service.upsertSessionWorkingState).toHaveBeenCalledTimes(1);
        const state = service.upsertSessionWorkingState.mock.calls[0][1];
        expect(state.completed_steps[0].content).toBe('第一步');
        expect(state.next_step).toBe('第二步');
        expect(service.upsertSessionWorkingState.mock.calls[0][2].source).toBe('step_complete');
    });

    it('only invalidates terminal states and keeps approval states active', async () => {
        process.env.MEMORY_WORKING_CONTEXT_V1 = 'true';
        const service = serviceSpy();
        const config = { configurable: { userId: 5, sessionId: 6, createMemoryService: () => service } };
        await invalidateWorkingMemoryAtTerminal({ enableMemory: true, subTasks: [{ id: '1', type: 'agent', status: 'completed' }] }, config);
        expect(service.invalidateSessionWorkingState).toHaveBeenCalledWith(6, 'task_completed');
        service.invalidateSessionWorkingState.mockClear();
        await invalidateWorkingMemoryAtTerminal({ enableMemory: true, subTasks: [{ id: '1', type: 'agent', status: 'waiting_approval' }] }, config);
        expect(service.invalidateSessionWorkingState).not.toHaveBeenCalled();
    });
});
