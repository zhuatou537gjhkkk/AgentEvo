import { describe, expect, it } from 'vitest';
import { dedupeMcpServers, isBuiltinMcpServer, isMcpMutationSuccessful, parseMcpArgs } from './mcpServers';

describe('MCP settings helpers', () => {
    it('prefers user scope over connected builtin/tenant duplicates', () => {
        const result = dedupeMcpServers([
            { name: 'filesystem', scope: 'tenant', connected: true, command: 'tenant' },
            { name: 'filesystem', scope: 'user', connected: false, command: 'user' },
        ]);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ name: 'filesystem', scope: 'user', command: 'user', connected: false });
    });

    it('prefers connected server when no user-scoped duplicate exists', () => {
        const result = dedupeMcpServers([
            { name: 'search', connected: false, command: 'old' },
            { name: 'search', connected: true, command: 'new' },
        ]);
        expect(result[0]).toMatchObject({ command: 'new', connected: true });
    });

    it('recognizes builtin servers and parses the existing argument format', () => {
        expect(isBuiltinMcpServer({ type: 'builtin' })).toBe(true);
        expect(isBuiltinMcpServer({ scope: 'user' })).toBe(false);
        expect(parseMcpArgs('npx -y server')).toEqual(['npx', '-y', 'server']);
        expect(parseMcpArgs('')).toEqual([]);
        expect(isMcpMutationSuccessful({ ok: true })).toBe(true);
        expect(isMcpMutationSuccessful({ ok: false, message: 'failed' })).toBe(false);
    });
});
