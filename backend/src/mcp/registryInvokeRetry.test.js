/**
 * ToolRegistry.invokeTool — withRetry 集成契约（W4-R4 T3）。
 *
 * §22 标注的缺口：invokeTool 内部 `withRetry(retries:1, signal:config?.signal)`
 * 只有实现没有集成契约——耗尽后抛什么分类（retryable/code）、退避中 abort 是否
 * 唤醒（第二次尝试不被触发）都未在真实 registry.invokeTool 调用链上断言。
 *
 * 本文件用 fresh ToolRegistry + 注入 flaky DynamicTool（func 数调用、按次抛 503），
 * 走真实 invokeTool → getTool → DynamicTool.invoke → withRetry 全链。零生产改动。
 *
 * raw invokeTool 耗尽时 rethrow classifyError 结果（AppError UPSTREAM_UNAVAILABLE，
 * 保留脱敏责任在调用方——graph/legacy 层负责把 5xx 收敛成固定中文文案），本文件只
 * 断言 registry 层的分类语义，不做 secret 泄漏断言（那归 T1/T2 调用方层）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DynamicTool } from '@langchain/core/tools';
import { classifyError } from '../services/resilience.js';

const { connectToMCPServerMock } = vi.hoisted(() => ({
    connectToMCPServerMock: vi.fn(),
}));

vi.mock('./client.js', () => ({
    connectToMCPServer: connectToMCPServerMock,
}));

import { ToolRegistry } from './registry.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Flaky DynamicTool：func 数调用，前 failTimes 次抛带 status=503 的错，之后成功。 */
function makeFlakyTool({ name = 'flaky_tool', failTimes, onFirstCall } = {}) {
    let calls = 0;
    const tool = new DynamicTool({
        name,
        description: 'flaky test tool',
        func: async () => {
            calls += 1;
            if (calls === 1) onFirstCall?.();
            if (calls <= failTimes) {
                throw Object.assign(new Error('upstream 503'), { status: 503 });
            }
            return 'ok-result';
        },
    });
    return { tool, callCount: () => calls };
}

describe('ToolRegistry.invokeTool × withRetry contract (W4-R4 T3)', () => {
    let registry;

    beforeEach(() => {
        registry = new ToolRegistry();
        connectToMCPServerMock.mockReset();
    });

    it('fail-once → retries (calls==2) and resolves', async () => {
        const { tool, callCount } = makeFlakyTool({ failTimes: 1 });
        registry.registerLocalTools([tool]);

        const result = await registry.invokeTool('flaky_tool', 'ping');

        expect(result).toBe('ok-result');
        expect(callCount()).toBe(2); // withRetry retries:1 → 真重试发生
    });

    it('persistent 503 → exhausted (calls==2), rejects classified AppError retryable + UPSTREAM_UNAVAILABLE', async () => {
        const { tool, callCount } = makeFlakyTool({ failTimes: Number.MAX_SAFE_INTEGER });
        registry.registerLocalTools([tool]);

        // 单次调用，捕获实际 rejection 断言分类语义（与 raw invokeTool 直接调用者等价）
        let classified = null;
        try {
            await registry.invokeTool('flaky_tool', 'ping');
        } catch (err) {
            classified = classifyError(err);
        }
        expect(classified).not.toBeNull();
        expect(callCount()).toBe(2); // 耗尽（两次尝试）
        expect(classified).not.toBeNull();
        expect(classified.retryable).toBe(true);
        expect(classified.code).toBe('UPSTREAM_UNAVAILABLE');
    });

    it('abort during retry backoff wakes withRetry (calls stays 1, rejects ABORTED)', async () => {
        let firstCall = null;
        const firstCallPromise = new Promise((resolve) => { firstCall = resolve; });
        const { tool, callCount } = makeFlakyTool({
            failTimes: Number.MAX_SAFE_INTEGER,
            onFirstCall: () => firstCall(),
        });
        registry.registerLocalTools([tool]);

        const controller = new AbortController();
        const pending = registry.invokeTool('flaky_tool', 'ping', { signal: controller.signal });

        await firstCallPromise;   // attempt1 已进入 func 并抛 503
        await sleep(40);          // 让 withRetry 进入退避 sleep 窗口
        controller.abort();

        let classified = null;
        try {
            await pending;
        } catch (err) {
            classified = classifyError(err);
        }
        expect(callCount()).toBe(1); // 第二次尝试未被触发（退避被 abort 唤醒）
        expect(classified).not.toBeNull();
        expect(classified.code).toBe('ABORTED');
        expect(classified.statusCode).toBe(499);
    });

    it('missing tool → synchronous reject, no retry', async () => {
        await expect(registry.invokeTool('ghost_tool', 'ping')).rejects.toThrow('不可用');
    });
});
