export function mcpServerPriority(server) {
    if (server?.scope === 'user') return 2;
    if (server?.connected) return 1;
    return 0;
}

export function dedupeMcpServers(list) {
    const byName = new Map();
    for (const server of Array.isArray(list) ? list : []) {
        const name = String(server?.name || '').trim();
        if (!name) continue;
        const existing = byName.get(name);
        const shouldReplace = !existing
            || mcpServerPriority(server) > mcpServerPriority(existing)
            || mcpServerPriority(server) === mcpServerPriority(existing);
        if (shouldReplace) {
            byName.set(name, {
                ...existing,
                ...server,
                name,
                command: server.command || existing?.command,
                args: server.args || existing?.args,
            });
        }
    }
    return [...byName.values()];
}

export function parseMcpArgs(value) {
    const text = String(value || '').trim();
    return text ? text.split(/\s+/) : [];
}

export function isBuiltinMcpServer(server) {
    return server?.type === 'builtin' || server?.scope === 'builtin';
}

export function isMcpMutationSuccessful(result) {
    return Boolean(result?.ok);
}
