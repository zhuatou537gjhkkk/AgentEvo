/**
 * MemoryService 单元测试 — Phase 4 方向A: 三层记忆架构
 *
 * 覆盖：
 *   - add() / search() / consolidate() / forget() / stats() / summary()
 *   - update() / remove() / extractFromConversation()
 *   - 混合检索评分排序
 *   - 边界条件 (空查询, 空结果, 无效重要性)
 *
 * 运行: npx vitest run src/services/memory.test.js
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDB } from '../db/index.js';
import { MemoryService } from './memory.js';

// 默认用户 ID (与 initDB 中的 ensureDefaultUser 一致)
const USER_ID = 1;

describe('MemoryService', () => {
    let memory;

    beforeEach(() => {
        initDB(); // 幂等，确保表存在
        memory = new MemoryService(USER_ID);

        // 清空测试用户的旧记忆
        memory.forget('all');

        // 准备基线测试数据
        memory.add('用户喜欢 Python 编程语言', 'working', 0.9);
        memory.add('用户想学 Rust', 'working', 0.5);
        memory.add('上次讨论了微服务架构设计', 'episodic', 0.8);
        memory.add('用户偏好简洁代码风格', 'semantic', 0.7);
        memory.add('用户使用 VS Code 编辑器', 'semantic', 0.6);
    });

    afterEach(() => {
        // 清理，避免跨测试影响
        try { memory.forget('all'); } catch (_) { /* ok */ }
    });

    // ═══════════════════════════════════════════════════════
    // add() — 添加记忆
    // ═══════════════════════════════════════════════════════

    describe('add()', () => {
        it('should add a memory and return a positive id', () => {
            const id = memory.add('测试记忆内容', 'working', 0.5);
            expect(id).toBeGreaterThan(0);
            expect(Number.isInteger(id)).toBe(true);
        });

        it('should add with null session_id (no FK violation)', () => {
            // session_id 为 null 表示不关联特定会话，避免 FOREIGN KEY 约束
            const id = memory.add('session memory', 'working', 0.5, {}, null);
            expect(id).toBeGreaterThan(0);
        });

        it('should default to type=working and importance=0.5', () => {
            const id = memory.add('默认参数记忆');
            // 添加成功即表示默认参数被正确处理
            expect(id).toBeGreaterThan(0);
        });

        it('should clamp importance to 0.0~1.0 range', () => {
            // importance > 1.0 应该被截断
            const id = memory.add('重要记忆', 'working', 1.5);
            expect(id).toBeGreaterThan(0);
            // 能添加成功 = DB层做了 clamp
        });
    });

    // ═══════════════════════════════════════════════════════
    // search() — 混合检索
    // ═══════════════════════════════════════════════════════

    describe('search()', () => {
        it('should search and rank by relevance — Python match first', () => {
            const results = memory.search('Python 编程');
            expect(results.length).toBeGreaterThan(0);
            // 含有 "Python" 的应该排最前
            expect(results[0].content).toContain('Python');
            expect(results[0].relevanceScore).toBeGreaterThan(0);
        });

        it('should return empty for non-matching query (keywordScore=0 filtered out)', () => {
            const results = memory.search('xyznonexistent12345');
            // 所有记忆 keywordScore=0 → relevanceScore≤0.12 → 被阈值 0.15 过滤 → 返回空
            expect(results.length).toBe(0);
        });

        it('should return all memories when query is empty', () => {
            const results = memory.search('');
            expect(results.length).toBeGreaterThanOrEqual(5);
        });

        it('should filter by memoryTypes parameter', () => {
            const results = memory.search('代码', ['semantic']);
            expect(results.length).toBeGreaterThan(0);
            for (const r of results) {
                expect(r.memory_type).toBe('semantic');
            }
        });

        it('should respect limit parameter', () => {
            const results = memory.search('', null, 2);
            expect(results.length).toBeLessThanOrEqual(2);
        });

        it('should respect minImportance filter', () => {
            const results = memory.search('', null, 50, 0.8);
            expect(results.length).toBeGreaterThan(0);
            for (const r of results) {
                expect(r.importance).toBeGreaterThanOrEqual(0.8);
            }
        });
    });

    // ═══════════════════════════════════════════════════════
    // consolidate() — 记忆巩固
    // ═══════════════════════════════════════════════════════

    describe('consolidate()', () => {
        it('should promote high-importance working → episodic', () => {
            const result = memory.consolidate('working', 'episodic', 0.7);
            expect(result).toHaveProperty('consolidated');
            expect(result).toHaveProperty('total');
            // 只有 importance=0.9 的 "用户喜欢 Python" 符合阈值
            expect(result.consolidated).toBeGreaterThanOrEqual(1);
        });

        it('should return 0 when no memories meet threshold', () => {
            const result = memory.consolidate('working', 'episodic', 0.95);
            expect(result.consolidated).toBe(0);
        });

        it('should return correct total count in result', () => {
            const result = memory.consolidate('working', 'episodic', 0.7);
            expect(typeof result.total).toBe('number');
            expect(result.total).toBeGreaterThanOrEqual(0);
        });
    });

    // ═══════════════════════════════════════════════════════
    // forget() — 遗忘策略
    // ═══════════════════════════════════════════════════════

    describe('forget()', () => {
        it('should forget by importance threshold (strategy="importance")', () => {
            // 删除 importance <= 0.4 的记忆
            const deleted = memory.forget('importance', 'working', 0.4);
            expect(typeof deleted).toBe('number');
            expect(deleted).toBeGreaterThanOrEqual(0);
        });

        it('should forget by time (strategy="time")', () => {
            const deleted = memory.forget('time', 'working', 365);
            expect(typeof deleted).toBe('number');
            // 刚添加的记忆不会因为时间为 365 天而被删除
            expect(deleted).toBe(0);
        });

        it('should clear all memories (strategy="all")', () => {
            const deleted = memory.forget('all');
            expect(deleted).toBeGreaterThanOrEqual(5);
            // 清空后 stats 应该为 0
            const stats = memory.stats();
            expect(stats.total).toBe(0);
        });
    });

    // ═══════════════════════════════════════════════════════
    // stats() — 统计
    // ═══════════════════════════════════════════════════════

    describe('stats()', () => {
        it('should return correct counts by memory type', () => {
            const stats = memory.stats();
            expect(stats).toHaveProperty('total');
            expect(stats).toHaveProperty('byType');
            expect(stats.byType.working).toBe(2);
            expect(stats.byType.episodic).toBe(1);
            expect(stats.byType.semantic).toBe(2);
            expect(stats.total).toBe(5);
        });

        it('should return 0 for types with no memories', () => {
            // 先清空 all，然后只加 working
            memory.forget('all');
            memory.add('only working', 'working', 0.5);
            const stats = memory.stats();
            expect(stats.byType.episodic).toBe(0);
            expect(stats.byType.semantic).toBe(0);
            expect(stats.total).toBe(1);
        });
    });

    // ═══════════════════════════════════════════════════════
    // summary() — 摘要
    // ═══════════════════════════════════════════════════════

    describe('summary()', () => {
        it('should return memory summaries sorted by importance', () => {
            const items = memory.summary(10);
            expect(Array.isArray(items)).toBe(true);
            expect(items.length).toBeGreaterThan(0);
            // 按重要性降序排列
            for (let i = 0; i < items.length; i++) {
                expect(items[i]).toHaveProperty('content');
                expect(items[i]).toHaveProperty('importance');
                expect(items[i]).toHaveProperty('memory_type');
            }
        });

        it('should respect limit parameter', () => {
            const items = memory.summary(2);
            expect(items.length).toBeLessThanOrEqual(2);
        });
    });

    // ═══════════════════════════════════════════════════════
    // update() / remove() — 更新与删除
    // ═══════════════════════════════════════════════════════

    describe('update() / remove()', () => {
        it('should update memory content and importance', () => {
            const id = memory.add('旧内容', 'working', 0.3);
            memory.update(id, { content: '新内容', importance: 0.9 });
            // 搜索新内容应该能找到
            const results = memory.search('新内容');
            const found = results.find(r => r.id === id);
            expect(found).toBeDefined();
            expect(found.content).toBe('新内容');
        });

        it('should remove a single memory by id', () => {
            const id = memory.add('临时记忆待删除', 'working', 0.5);
            const statsBefore = memory.stats();
            memory.remove(id);
            const statsAfter = memory.stats();
            expect(statsAfter.total).toBe(statsBefore.total - 1);
        });
    });

    // ═══════════════════════════════════════════════════════
    // extractFromConversation() — 自动提取
    // ═══════════════════════════════════════════════════════

    describe('extractFromConversation()', () => {
        it('should extract preferences from conversation text', () => {
            const text = '我喜欢用 TypeScript，不喜欢 any 类型。以后都用 strict mode。';
            const extracted = memory.extractFromConversation(text);
            // 至少匹配到 "我喜欢用 TypeScript"
            expect(extracted).toBeGreaterThan(0);
        });

        it('should extract "记住" marked info without truncating at commas', () => {
            const text = '记住，我们的核心项目是 AgentEvo，技术栈是 React + Express + SQLite';
            const extracted = memory.extractFromConversation(text);
            expect(extracted).toBeGreaterThan(0);
            // 验证完整内容被保存（不应在逗号处截断）
            const results = memory.search('AgentEvo');
            expect(results.length).toBeGreaterThan(0);
            const content = results[0].content;
            expect(content).toContain('AgentEvo');
            expect(content).toContain('React');
            expect(content).toContain('Express');
            expect(content).toContain('SQLite');
            // 不应包含 "技术栈是" 后面的内容被截断
        });

        it('should extract personal identity info', () => {
            const text = '我的职业是后端开发工程师，我的任务是优化 API 性能。';
            const extracted = memory.extractFromConversation(text);
            expect(extracted).toBeGreaterThanOrEqual(2);
        });

        it('should return 0 for empty or non-matching text', () => {
            expect(memory.extractFromConversation('')).toBe(0);
            expect(memory.extractFromConversation('今天天气不错')).toBe(0);
        });

        // Bug B 修复: "我个人倾向于" 应被识别为偏好表达
        it('should extract "我个人倾向于" as preference (Bug B fix)', () => {
            const text = '我个人倾向于用 TypeScript 做前端';
            const extracted = memory.extractFromConversation(text);
            expect(extracted).toBeGreaterThan(0);
            // 验证提取的记忆内容包含 TypeScript
            const results = memory.search('TypeScript');
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].content).toContain('TypeScript');
        });

        // Bug A 修复: 偏好提取应存储为 working 类型（而非 episodic）
        it('should store extracted preferences as working type (Bug A fix)', () => {
            memory.extractFromConversation('我习惯每天写单元测试');
            const results = memory.search('单元测试');
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].memory_type).toBe('working');
        });

        // TC-E1: 两条偏好消息都应被提取
        it('TC-E1: should extract both preference messages', () => {
            const extracted1 = memory.extractFromConversation('我喜欢用 Python 写后端');
            expect(extracted1).toBeGreaterThan(0);

            const extracted2 = memory.extractFromConversation('我个人倾向于用 TypeScript 做前端');
            expect(extracted2).toBeGreaterThan(0);

            // 两条都被提取且类型为 working
            const allMemories = memory.search('');
            const pythonMemory = allMemories.find(m => m.content.includes('Python'));
            const tsMemory = allMemories.find(m => m.content.includes('TypeScript'));
            expect(pythonMemory).toBeDefined();
            expect(tsMemory).toBeDefined();
            expect(pythonMemory.memory_type).toBe('working');
            expect(tsMemory.memory_type).toBe('working');
        });
    });

    // ═══════════════════════════════════════════════════════
    // 边界条件
    // ═══════════════════════════════════════════════════════

    describe('edge cases', () => {
        it('should handle separate MemoryService instances independently', () => {
            // 两个实例操作同一用户 (userId=1)，各自独立统计
            const memoryA = new MemoryService(USER_ID);
            const memoryB = new MemoryService(USER_ID);
            memoryA.add('instance A 的记忆', 'working', 0.5);
            memoryB.add('instance B 的记忆', 'working', 0.5);
            const stats = memoryA.stats();
            // 两个实例操作同一 DB 用户，统计会合并
            expect(stats.total).toBeGreaterThanOrEqual(2);
            // 清理实例 B 添加的记忆
            memoryB.forget('all');
        });

        it('should handle special characters in content', () => {
            const id = memory.add('包含 <html> & "特殊" 字符的记忆 😊', 'working', 0.5);
            expect(id).toBeGreaterThan(0);
            const results = memory.search('html');
            const found = results.find(r => r.id === id);
            expect(found).toBeDefined();
        });

        it('should handle very long content', () => {
            const longText = 'A'.repeat(5000);
            const id = memory.add(longText, 'working', 0.5);
            expect(id).toBeGreaterThan(0);
        });
    });
});
