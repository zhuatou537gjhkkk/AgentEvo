import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { issueAuthToken } from '../auth.js';
import { createServer } from 'node:http';
import { parseCompactionResult } from '../services/workingMemory.js';

const previousFlag = process.env.MEMORY_WORKING_CONTEXT_V1;
const servers = [];

afterEach(async () => {
    if (previousFlag == null) delete process.env.MEMORY_WORKING_CONTEXT_V1;
    else process.env.MEMORY_WORKING_CONTEXT_V1 = previousFlag;
    while (servers.length) {
        await new Promise((resolve) => servers.pop().close(resolve));
    }
});

async function open(app) {
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
}

function history() {
    return Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `历史消息${index + 1}`,
        created_at: new Date().toISOString(),
    }));
}

describe('working-memory compaction contract', () => {
    it('parses structured output and remains compatible with plain-string mocks', () => {
        const structured = parseCompactionResult('{"summary":"保留结论","task_state":{"current_goal":"完成任务","next_step":"验证"}}');
        expect(structured.summary).toBe('保留结论');
        expect(structured.taskState.current_goal).toBe('完成任务');
        expect(parseCompactionResult('旧摘要')).toEqual({ summary: '旧摘要', taskState: null });
    });

    it('persists the summary message and structured task state with one builder call', async () => {
        process.env.MEMORY_WORKING_CONTEXT_V1 = 'true';
        const saves = [];
        let buildCalls = 0;
        const upsertSessionWorkingState = async (...args) => { saves.push({ type: 'working', args }); };
        const user = { id: 31, username: 'compact-user', tenant_id: 'user:31' };
        const base = await open(createApp({ dependencies: {
            auth: { getUserById: () => user },
            db: {
                getHistoryMessages: () => history(),
                saveMessage: (...args) => saves.push({ type: 'message', args }),
            },
            services: {
                buildCompactionSummary: async () => {
                    buildCalls += 1;
                    return {
                    summary: '已完成需求澄清，下一步验证实现。',
                    task_state: { current_goal: '完成工作记忆功能', constraints: ['必须默认关闭'], next_step: '运行测试' },
                    };
                },
                createMemoryService: () => ({ upsertSessionWorkingState }),
            },
        } }));
        const response = await fetch(`${base}/sessions/77/compact`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${issueAuthToken(user)}` },
        });
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(buildCalls).toBe(1);
        expect(body.data.summary).toContain('需求澄清');
        expect(saves.find((item) => item.type === 'message').args).toEqual([
            31,
            77,
            'system',
            expect.stringContaining('[上下文压缩摘要'),
        ]);
        expect(saves.find((item) => item.type === 'working').args.slice(0, 2)).toEqual([
            77,
            expect.objectContaining({ current_goal: '完成工作记忆功能' }),
        ]);
    });
});
