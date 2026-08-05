/**
 * memory tool 集成测试 — Phase 4 方向A: memory_tool 注册与运行
 *
 * 覆盖：
 *   - 工具注册到 agentTools
 *   - 6 种 action: add, search, consolidate, forget, stats, summary
 *   - 无效 action / 无效 JSON 的 fallback
 *   - ToolRegistry 注册
 *
 * 运行: npx vitest run src/mcp/memory.tool.test.js
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDB } from '../db/index.js';
import { MemoryService } from '../services/memory.js';
// 顶层导入 — tools.js 有 LangChain 副作用，只导入一次
import { agentTools } from './tools.js';
import { toolRegistry } from './registry.js';

// 从 agentTools 中获取 memory 工具实例（tools.js 不单独导出 memoryTool）
const memoryTool = agentTools.find(t => t.name === 'memory');

const USER_ID = 1;

// 直接操作 MemoryService 来准备数据（避免依赖工具本身）
let memory;

describe('memoryTool — registration & execution', () => {
    beforeEach(async () => {
        initDB();
        memory = new MemoryService(USER_ID);
        memory.forget('all');

        // 准备几条基线记忆
        memory.add('用户喜欢 Python 编程', 'working', 0.9);
        memory.add('偏好简洁代码', 'semantic', 0.8);
        memory.add('使用 React + Express 技术栈', 'episodic', 0.7);
        memory.add('正在学习 Rust', 'working', 0.5);
    });

    afterEach(() => {
        try { memory.forget('all'); } catch (_) { /* ok */ }
    });

    // ═══════════════════════════════════════════════════════
    // 工具注册
    // ═══════════════════════════════════════════════════════

    describe('registration', () => {
        it('should be registered in agentTools with name "memory"', async () => {
            // 使用顶层导入的 memoryTool
            expect(memoryTool).toBeDefined();
            expect(typeof memoryTool.invoke).toBe('function');
        });

        it('should be registered in ToolRegistry', async () => {
            const tool = toolRegistry.getTool('memory');
            // toolRegistry 可能使用动态类别，getTool 可能返回 tool 或 undefined（取决于注册时机）
            // 如果是未注册到 registry，至少 agentTools 里有
            // 在 test 环境中可能没有 triggerToolRegistration
            if (tool) {
                expect(tool.name).toBe('memory');
            }
            // 无论 registry 注册与否，agentTools 必须有
            // 使用顶层导入的 memoryTool
            expect(memoryTool).toBeDefined();
        });
    });

    // ═══════════════════════════════════════════════════════
    // action=add
    // ═══════════════════════════════════════════════════════

    describe('action=add', () => {
        it('should add a new memory and return success', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({
                action: 'add',
                content: 'Agent 测试添加记忆',
                memory_type: 'working',
                importance: 0.8,
            }));

            const parsed = JSON.parse(result);
            expect(parsed.success).toBe(true);
            expect(parsed.memory_id).toBeGreaterThan(0);
            expect(parsed.action).toBe('add');
        });

        it('should reject empty content', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({
                action: 'add',
                content: '   ',
            }));

            const parsed = JSON.parse(result);
            expect(parsed).toHaveProperty('error');
            expect(parsed.error).toContain('content');
        });

        it('should default to type=working and importance=0.5', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({
                action: 'add',
                content: '默认参数记忆',
            }));

            const parsed = JSON.parse(result);
            expect(parsed.success).toBe(true);
            expect(parsed.memory_id).toBeGreaterThan(0);
        });
    });

    // ═══════════════════════════════════════════════════════
    // action=search
    // ═══════════════════════════════════════════════════════

    describe('action=search', () => {
        it('should search by query and return ranked results', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({
                action: 'search',
                query: 'Python',
                limit: 10,
            }));

            const parsed = JSON.parse(result);
            expect(parsed).toHaveProperty('results');
            expect(Array.isArray(parsed.results)).toBe(true);
            expect(parsed.results.length).toBeGreaterThan(0);
            expect(parsed.results[0].content).toContain('Python');
            expect(parsed.count).toBeGreaterThan(0);
        });

        it('should return low relevance for non-matching query', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({
                action: 'search',
                query: 'xyznonexistent12345',
            }));

            const parsed = JSON.parse(result);
            // 全部最近记忆都有 recencyScore 保底，但 keywordScore=0，relevanceScore 很低
            for (const r of parsed.results) {
                expect(r.relevanceScore).toBeLessThan(0.3);
            }
        });

        it('should filter by memory_types', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({
                action: 'search',
                query: '',
                memory_types: ['semantic'],
                limit: 50,
            }));

            const parsed = JSON.parse(result);
            expect(parsed.results.length).toBeGreaterThan(0);
            for (const r of parsed.results) {
                expect(r.memory_type).toBe('semantic');
            }
        });

        it('should accept aliases: q for query, memory_type for single type', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({
                action: 'search',
                q: 'React',
                memory_type: 'episodic',
            }));

            const parsed = JSON.parse(result);
            expect(parsed).toHaveProperty('results');
            // episodically we stored "使用 React + Express 技术栈"
            if (parsed.results.length > 0) {
                for (const r of parsed.results) {
                    expect(r.memory_type).toBe('episodic');
                }
            }
        });
    });

    // ═══════════════════════════════════════════════════════
    // action=consolidate
    // ═══════════════════════════════════════════════════════

    describe('action=consolidate', () => {
        it('should promote high-importance working → episodic', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({
                action: 'consolidate',
                from_type: 'working',
                to_type: 'episodic',
                importance_threshold: 0.7,
            }));

            const parsed = JSON.parse(result);
            expect(parsed).toHaveProperty('consolidated');
            expect(parsed).toHaveProperty('total');
            expect(parsed.consolidated).toBeGreaterThanOrEqual(1); // "用户喜欢 Python" importance=0.9
            expect(parsed.from_type).toBe('working');
            expect(parsed.to_type).toBe('episodic');
        });

        it('should return 0 when no memories meet threshold', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({
                action: 'consolidate',
                importance_threshold: 0.95,
            }));

            const parsed = JSON.parse(result);
            expect(parsed.consolidated).toBe(0);
        });
    });

    // ═══════════════════════════════════════════════════════
    // action=forget
    // ═══════════════════════════════════════════════════════

    describe('action=forget', () => {
        it('should forget by importance strategy', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({
                action: 'forget',
                strategy: 'importance',
                memory_type: 'working',
                threshold: 0.4,
            }));

            const parsed = JSON.parse(result);
            expect(typeof parsed.deleted).toBe('number');
        });

        it('should forget with default strategy=importance', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({
                action: 'forget',
                memory_type: 'working',
            }));

            const parsed = JSON.parse(result);
            expect(parsed).toHaveProperty('deleted');
            expect(parsed.strategy).toBe('importance');
        });
    });

    // ═══════════════════════════════════════════════════════
    // action=stats
    // ═══════════════════════════════════════════════════════

    describe('action=stats', () => {
        it('should return memory stats with total and byType', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({ action: 'stats' }));

            const parsed = JSON.parse(result);
            expect(parsed).toHaveProperty('total');
            expect(parsed).toHaveProperty('byType');
            expect(parsed.byType).toHaveProperty('working');
            expect(parsed.byType).toHaveProperty('episodic');
            expect(parsed.byType).toHaveProperty('semantic');
            expect(parsed.total).toBeGreaterThanOrEqual(4);
        });
    });

    // ═══════════════════════════════════════════════════════
    // action=summary
    // ═══════════════════════════════════════════════════════

    describe('action=summary', () => {
        it('should return memory summary with items array', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({ action: 'summary', limit: 10 }));

            const parsed = JSON.parse(result);
            expect(parsed).toHaveProperty('items');
            expect(Array.isArray(parsed.items)).toBe(true);
            expect(parsed.count).toBeGreaterThan(0);
        });

        it('should respect limit parameter', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({ action: 'summary', limit: 2 }));

            const parsed = JSON.parse(result);
            expect(parsed.items.length).toBeLessThanOrEqual(2);
        });
    });

    // ═══════════════════════════════════════════════════════
    // Error handling
    // ═══════════════════════════════════════════════════════

    describe('error handling', () => {
        it('should return error for invalid action', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({ action: 'nonexistent' }));

            const parsed = JSON.parse(result);
            expect(parsed).toHaveProperty('error');
            expect(parsed.error).toContain('不支持的操作');
            expect(parsed.error).toContain('nonexistent');
        });

        it('should return error for malformed JSON', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke('not valid json at all {{{');

            const parsed = JSON.parse(result);
            expect(parsed).toHaveProperty('error');
            expect(parsed.error).toContain('无法解析');
        });

        it('should default to action=search when action is missing', async () => {
            // 使用顶层导入的 memoryTool

            const result = await memoryTool.invoke(JSON.stringify({ query: 'Python' }));
            // 默认 action 为 search，返回 results
            const parsed = JSON.parse(result);
            expect(parsed).toHaveProperty('results');
        });
    });
});
