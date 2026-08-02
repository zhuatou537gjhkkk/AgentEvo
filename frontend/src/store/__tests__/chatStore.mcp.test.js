import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../chatStore';

// 每个测试前重置 store
beforeEach(() => {
    useChatStore.setState({ mcpServers: [] });
});

// ── Phase 3: MCP Server store actions ──────────────────────────

describe('chatStore — MCP Servers', () => {
    describe('addMcpServer', () => {
        it('should add a new MCP server with connected=false', () => {
            useChatStore.getState().addMcpServer({
                name: 'test-server',
                command: 'node',
                args: ['server.js'],
            });

            const servers = useChatStore.getState().mcpServers;
            expect(servers).toHaveLength(1);
            expect(servers[0]).toMatchObject({
                name: 'test-server',
                command: 'node',
                args: ['server.js'],
                connected: false,
            });
        });

        it('should append servers to existing list', () => {
            const store = useChatStore.getState();
            store.addMcpServer({ name: 's1', command: 'npx' });
            store.addMcpServer({ name: 's2', command: 'python' });

            const servers = useChatStore.getState().mcpServers;
            expect(servers).toHaveLength(2);
            expect(servers.map((s) => s.name)).toEqual(['s1', 's2']);
        });
    });

    describe('removeMcpServer', () => {
        it('should remove server by name', () => {
            const store = useChatStore.getState();
            store.addMcpServer({ name: 'keep', command: 'node' });
            store.addMcpServer({ name: 'remove', command: 'npx' });
            store.removeMcpServer('remove');

            const servers = useChatStore.getState().mcpServers;
            expect(servers).toHaveLength(1);
            expect(servers[0].name).toBe('keep');
        });

        it('should be no-op when server name does not exist', () => {
            const store = useChatStore.getState();
            store.addMcpServer({ name: 'only', command: 'node' });
            store.removeMcpServer('no-such-server');

            expect(useChatStore.getState().mcpServers).toHaveLength(1);
        });
    });

    describe('toggleMcpServer', () => {
        it('should toggle enabled on/off', () => {
            const store = useChatStore.getState();
            store.addMcpServer({ name: 's1', command: 'cmd', enabled: true });
            store.toggleMcpServer('s1');

            expect(useChatStore.getState().mcpServers[0].enabled).toBe(false);

            store.toggleMcpServer('s1');
            expect(useChatStore.getState().mcpServers[0].enabled).toBe(true);
        });
    });

    describe('updateMcpServerStatus', () => {
        it('should update connected status', () => {
            const store = useChatStore.getState();
            store.addMcpServer({ name: 's1', command: 'cmd' });
            store.updateMcpServerStatus('s1', true);

            expect(useChatStore.getState().mcpServers[0].connected).toBe(true);

            store.updateMcpServerStatus('s1', false);
            expect(useChatStore.getState().mcpServers[0].connected).toBe(false);
        });

        it('should be no-op when server name does not exist', () => {
            const store = useChatStore.getState();
            store.addMcpServer({ name: 's1', command: 'cmd' });
            store.updateMcpServerStatus('unknown', true);

            expect(useChatStore.getState().mcpServers[0].connected).toBe(false);
        });
    });

    describe('partialize (persist)', () => {
        it('should include mcpServers in persisted state', () => {
            const store = useChatStore.getState();
            store.addMcpServer({ name: 'persist-me', command: 'npx', enabled: true });

            // partialize 是 Zustand persist 的配置，直接调用验证
            // 注：这里只测 persisted key 在 partialize 白名单中
            const { partialize } = useChatStore.persist?.getOptions?.() || {};
            if (partialize) {
                const persisted = partialize(useChatStore.getState());
                expect(persisted).toHaveProperty('mcpServers');
                expect(persisted.mcpServers).toHaveLength(1);
            }
        });
    });
});
