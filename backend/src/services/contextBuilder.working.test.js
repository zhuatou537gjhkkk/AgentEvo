import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextBuilder, ContextConfig } from './contextBuilder.js';

const previousFlag = process.env.MEMORY_WORKING_CONTEXT_V1;

function workingRecords(sessionId, suffix = '') {
    const metadata = { snapshot_hash: `hash-${suffix || sessionId}`, working_state: { current_goal: '构建当前任务' } };
    return [
        { id: 1, session_id: sessionId, memory_key: 'working_current_goal', content: '当前目标：完成当前任务', metadata, created_at: new Date().toISOString() },
        { id: 2, session_id: sessionId, memory_key: 'working_constraints', content: '临时约束：必须保持向后兼容', metadata, created_at: new Date().toISOString() },
        { id: 3, session_id: sessionId, memory_key: 'working_progress', content: '执行进度：已完成数据库设计', metadata, created_at: new Date().toISOString() },
        { id: 4, session_id: sessionId, memory_key: 'working_next_step', content: '下一步：接入上下文注入', metadata, created_at: new Date().toISOString() },
    ];
}

describe('ContextBuilder working-memory context', () => {
    beforeEach(() => {
        process.env.MEMORY_WORKING_CONTEXT_V1 = 'true';
    });

    afterEach(() => {
        if (previousFlag == null) delete process.env.MEMORY_WORKING_CONTEXT_V1;
        else process.env.MEMORY_WORKING_CONTEXT_V1 = previousFlag;
    });

    it('injects only the explicit session working state before long-term memory', async () => {
        const getSessionWorkingState = vi.fn(async (sessionId) => ({ records: workingRecords(sessionId) }));
        const builder = new ContextBuilder(new ContextConfig({ maxTokens: 4000, enableCompression: false }), {
            getSessionWorkingState,
            recall: () => ({ memories: [{ id: 90, content: '长期记忆：用户偏好简洁风格', memory_type: 'semantic', created_at: new Date().toISOString(), relevanceScore: 0.9 }], diagnostics: null }),
            search: () => [{ id: 90, content: '长期记忆：用户偏好简洁风格', memory_type: 'semantic', created_at: new Date().toISOString(), relevanceScore: 0.9 }],
        });

        const context = await builder.build('当前任务', [], '系统规则', { sessionId: 42 });
        expect(getSessionWorkingState).toHaveBeenCalledWith(42);
        expect(context).toContain('## [State] 当前工作状态');
        expect(context).toContain('当前目标：完成当前任务');
        expect(context).toContain('## 长期记忆（用户过去发生的事件和长期偏好）');
        expect(context.indexOf('## [State] 当前工作状态')).toBeLessThan(context.indexOf('## 长期记忆'));
        expect(context).not.toContain('session-43');
    });

    it('uses the same working state path in provenance mode with an independent budget', async () => {
        const records = workingRecords(7, 'large');
        records[0].content = '目标'.repeat(300);
        const builder = new ContextBuilder(new ContextConfig({ maxTokens: 5000, enableCompression: false, workingMemoryBudgetTokens: 120 }), {
            getSessionWorkingState: async () => ({ records }),
        });
        const result = await builder.buildProvenance('查询', [], '', { sessionId: 7 });
        expect(result.context).toContain('## [State] 当前工作状态');
        expect(result.context.match(/\[工作记忆\]/g)?.length || 0).toBeLessThanOrEqual(4);
        expect(builder.lastWorkingMemoryRecall.selectedTokens).toBeLessThanOrEqual(120);
    });

    it('does not query or change output when the feature flag is off', async () => {
        delete process.env.MEMORY_WORKING_CONTEXT_V1;
        const getSessionWorkingState = vi.fn(async () => ({ records: workingRecords(42) }));
        const builder = new ContextBuilder(new ContextConfig({ enableCompression: false }), { getSessionWorkingState });
        const context = await builder.build('查询', [], '', { sessionId: 42 });
        expect(getSessionWorkingState).not.toHaveBeenCalled();
        expect(context).not.toContain('[工作记忆]');
    });

    it('treats working-memory query failures as nonfatal', async () => {
        const builder = new ContextBuilder(new ContextConfig({ enableCompression: false }), {
            getSessionWorkingState: async () => { throw new Error('db unavailable'); },
        });
        await expect(builder.build('仍然回答', [], '', { sessionId: 42 })).resolves.toContain('## 当前任务');
        expect(builder.lastWorkingMemoryRecall.error).toBe('working_memory_unavailable');
    });

    it('reuses a prefetched snapshot without issuing a second session read', async () => {
        const getSessionWorkingState = vi.fn(async () => ({ records: workingRecords(42) }));
        const builder = new ContextBuilder(new ContextConfig({ enableCompression: false }), {
            getSessionWorkingState,
        });
        const snapshot = { records: workingRecords(42) };
        const context = await builder.build('这个怎么修改', [], '', {
            sessionId: 42,
            workingMemorySnapshot: snapshot,
        });

        expect(getSessionWorkingState).not.toHaveBeenCalled();
        expect(context).toContain('当前目标：完成当前任务');
        expect(builder.lastWorkingMemoryRecall.selected).toHaveLength(4);
    });
});
