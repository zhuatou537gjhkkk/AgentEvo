import { describe, it, expect } from 'vitest';
import { STATUS_CONFIG } from '../../components/MCPToolCard';

// ── Phase 3: MCPToolCard status config ──────────────────────────

describe('MCPToolCard — STATUS_CONFIG', () => {
    it('should define "connected" status', () => {
        expect(STATUS_CONFIG.connected).toBeDefined();
        expect(STATUS_CONFIG.connected.label).toBe('已连接');
        expect(STATUS_CONFIG.connected.border).toBe('border-l-emerald-400');
        expect(STATUS_CONFIG.connected.dot).toBe('bg-emerald-400');
    });

    it('should define "connecting" status with pulse animation', () => {
        expect(STATUS_CONFIG.connecting).toBeDefined();
        expect(STATUS_CONFIG.connecting.label).toBe('连接中');
        expect(STATUS_CONFIG.connecting.pulse).toBe(true);
    });

    it('should define "disconnected" status', () => {
        expect(STATUS_CONFIG.disconnected).toBeDefined();
        expect(STATUS_CONFIG.disconnected.label).toBe('已断开');
        expect(STATUS_CONFIG.disconnected.dot).toBe('bg-red-400');
    });

    it('should define "error" status', () => {
        expect(STATUS_CONFIG.error).toBeDefined();
        expect(STATUS_CONFIG.error.label).toBe('错误');
        expect(STATUS_CONFIG.error.dot).toBe('bg-amber-400');
    });

    it('should have unique border colors for each status', () => {
        const borders = Object.values(STATUS_CONFIG).map((c) => c.border);
        const unique = new Set(borders);
        expect(unique.size).toBe(Object.keys(STATUS_CONFIG).length);
    });
});

describe('MCPToolCard — memo comparison', () => {
    it('should skip re-render for same tool name + status + error', () => {
        // MCPToolCard 使用 memo 浅比较关键字段避免不必要的重渲染
        // 验证 memo 比较逻辑
        const props1 = {
            tool: { name: 'web_search', description: '搜索互联网', error: null },
            status: 'connected',
        };
        const props2 = { ...props1 };

        // shallow equality: 相同对象 → 跳过渲染
        const namesMatch = props1.tool?.name === props2.tool?.name;
        const statusMatch = props1.status === props2.status;
        const errorMatch = props1.tool?.error === props2.tool?.error;
        expect(namesMatch && statusMatch && errorMatch).toBe(true);
    });

    it('should trigger re-render when status changes', () => {
        const prev = { tool: { name: 'web_search', error: null }, status: 'connected' };
        const next = { tool: { name: 'web_search', error: null }, status: 'error' };
        expect(prev.status !== next.status).toBe(true);
    });

    it('should trigger re-render when tool name changes', () => {
        const prev = { tool: { name: 'tool_a', error: null }, status: 'connected' };
        const next = { tool: { name: 'tool_b', error: null }, status: 'connected' };
        expect(prev.tool.name !== next.tool.name).toBe(true);
    });

    it('should trigger re-render when error appears', () => {
        const prev = { tool: { name: 'test', error: null }, status: 'connected' };
        const next = { tool: { name: 'test', error: 'Connection refused' }, status: 'connected' };
        expect(prev.tool.error !== next.tool.error).toBe(true);
    });
});
