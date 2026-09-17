import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession, createUser, initDB, getMemorySummary } from '../db/index.js';
import { MemoryService } from './memory.js';

const previousFlag = process.env.MEMORY_WORKING_CONTEXT_V1;

describe('working memory maintenance', () => {
    let userId;
    let sessionId;
    let memory;

    beforeEach(() => {
        process.env.MEMORY_WORKING_CONTEXT_V1 = 'true';
        initDB();
        userId = createUser(`working-${Date.now()}-${Math.random()}`, 'test');
        sessionId = createSession(userId, 'working-memory-test');
        memory = new MemoryService(userId);
    });

    afterEach(() => {
        if (previousFlag == null) delete process.env.MEMORY_WORKING_CONTEXT_V1;
        else process.env.MEMORY_WORKING_CONTEXT_V1 = previousFlag;
    });

    it('creates exactly four fixed-key records and reuses them idempotently', () => {
        const state = {
            current_goal: '完成工作记忆自动维护',
            constraints: ['必须保持默认关闭', '不要调用额外模型'],
            completed_steps: [{ id: '1', content: '完成数据库设计' }],
            next_step: '接入 ContextBuilder',
        };
        const first = memory.upsertSessionWorkingState(sessionId, state, { source: 'test', planGeneration: 2 });
        const records = memory.getSessionWorkingState(sessionId).records;
        expect(records).toHaveLength(4);
        expect(records.map((record) => record.memory_key).sort()).toEqual([
            'working_constraints',
            'working_current_goal',
            'working_next_step',
            'working_progress',
        ]);
        expect(first.created).toBe(4);

        const second = memory.upsertSessionWorkingState(sessionId, state, { source: 'test', planGeneration: 2 });
        expect(second.created).toBe(0);
        expect(second.updated).toBe(0);
        expect(second.unchanged).toBe(4);
        expect(memory.getSessionWorkingState(sessionId).records.map((record) => record.id)).toEqual(records.map((record) => record.id));

        const changed = memory.upsertSessionWorkingState(sessionId, { ...state, next_step: '补充回归测试' }, { source: 'test', planGeneration: 2 });
        expect(changed.updated).toBe(4);
        expect(memory.getSessionWorkingState(sessionId).records).toHaveLength(4);
        expect(getMemorySummary(userId, 20, 'active')).toHaveLength(4);
    });

    it('enforces owner/session isolation and filters sensitive or noisy values', () => {
        memory.upsertSessionWorkingState(sessionId, {
            current_goal: 'api_key=sk-secret 不应进入工作记忆',
            constraints: ['必须保留这个限制', 'BEGIN PRIVATE KEY noisy value'],
            completed_steps: [{ id: '1', content: 'Traceback (most recent call last)' }],
            next_step: '继续处理普通步骤',
        });
        const own = memory.getSessionWorkingState(sessionId).records;
        expect(own.find((record) => record.memory_key === 'working_current_goal').content).toBe('当前任务');
        expect(own.every((record) => !record.content.includes('sk-secret'))).toBe(true);

        const anotherUser = createUser(`working-other-${Date.now()}-${Math.random()}`, 'test');
        const anotherMemory = new MemoryService(anotherUser);
        expect(() => anotherMemory.getSessionWorkingState(sessionId)).toThrow(/session not found/);
        expect(() => anotherMemory.upsertSessionWorkingState(sessionId, { current_goal: '越权' })).toThrow(/session not found/);
    });

    it('soft-invalidates expired state and keeps an auditable row', () => {
        memory.upsertSessionWorkingState(sessionId, { current_goal: '短期任务' }, {
            expiresAt: new Date(Date.now() - 1000).toISOString(),
        });
        expect(memory.getSessionWorkingState(sessionId).records).toHaveLength(0);
        const invalidated = getMemorySummary(userId, 20, 'invalidated')
            .filter((record) => record.memory_type === 'working');
        expect(invalidated).toHaveLength(4);
        expect(invalidated.every((record) => record.invalidate_reason === 'working_memory_ttl')).toBe(true);
    });

    it('soft-invalidates terminal state without deleting history', () => {
        memory.upsertSessionWorkingState(sessionId, { current_goal: '已完成任务' });
        const result = memory.invalidateSessionWorkingState(sessionId, 'task_completed');
        expect(result.invalidated).toBe(4);
        expect(memory.getSessionWorkingState(sessionId).records).toHaveLength(0);
        expect(getMemorySummary(userId, 20, 'invalidated').filter((record) => record.session_id === sessionId)).toHaveLength(4);
    });
});
