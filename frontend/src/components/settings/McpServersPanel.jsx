import { useEffect, useMemo, useState } from 'react';
import { addMcpServer, connectMcpServer, disconnectMcpServer, fetchMcpServers, removeMcpServer } from '../../api/chat';
import { useChatStore } from '../../store/chatStore';
import { dedupeMcpServers, isBuiltinMcpServer, isMcpMutationSuccessful, parseMcpArgs } from './mcpServers';
import { ErrorMessage, PermissionMessage, StatusMessage } from './AgentWorkflowPanel';
import { SectionHeading } from './SettingsWorkspace';

function errorText(error, fallback) {
    if (error?.status === 403 || error?.statusCode === 403) return '需要管理员权限。';
    return error?.message || fallback;
}

export default function McpServersPanel() {
    const storeServers = useChatStore((state) => state.mcpServers);
    const storeAddMcpServer = useChatStore((state) => state.addMcpServer);
    const storeRemoveMcpServer = useChatStore((state) => state.removeMcpServer);
    const storeUpdateMcpServerStatus = useChatStore((state) => state.updateMcpServerStatus);
    const [servers, setServers] = useState([]);
    const [status, setStatus] = useState('loading');
    const [error, setError] = useState('');
    const [actionError, setActionError] = useState('');
    const [showForm, setShowForm] = useState(false);
    const [name, setName] = useState('');
    const [command, setCommand] = useState('');
    const [args, setArgs] = useState('');
    const [actionLoading, setActionLoading] = useState(null);

    const visibleServers = useMemo(() => dedupeMcpServers(servers.length ? servers : storeServers), [servers, storeServers]);

    const load = async () => {
        setStatus('loading');
        setError('');
        try {
            const data = await fetchMcpServers();
            const next = dedupeMcpServers(data?.servers);
            setServers(next);
            useChatStore.setState({ mcpServers: next });
            setStatus('ready');
        } catch (err) {
            setStatus(err?.status === 403 ? 'forbidden' : 'error');
            setError(errorText(err, 'MCP 服务器加载失败，请重试。'));
        }
    };

    useEffect(() => { load(); }, []);

    const refreshLocal = (next) => {
        const normalized = dedupeMcpServers(next);
        setServers(normalized);
        useChatStore.setState({ mcpServers: normalized });
    };

    const handleAdd = async () => {
        const trimmedName = name.trim();
        const trimmedCommand = command.trim();
        if (!trimmedName || !trimmedCommand || actionLoading) return;
        setActionLoading('add');
        setActionError('');
        try {
            const result = await addMcpServer(trimmedName, trimmedCommand, parseMcpArgs(args));
            if (!isMcpMutationSuccessful(result)) throw new Error(result?.message || '添加 MCP 服务器失败。');
            storeAddMcpServer({ name: trimmedName, command: trimmedCommand, args: parseMcpArgs(args), enabled: true });
            await load();
            setName('');
            setCommand('');
            setArgs('');
            setShowForm(false);
        } catch (err) {
            setActionError(errorText(err, '添加 MCP 服务器失败，未更新本地状态。'));
        } finally {
            setActionLoading(null);
        }
    };

    const handleConnection = async (server) => {
        setActionLoading(server.name);
        setActionError('');
        try {
            if (server.connected) {
                const result = await disconnectMcpServer(server.name);
                if (!isMcpMutationSuccessful(result)) throw new Error(result?.message || '断开 MCP 服务器失败。');
                storeUpdateMcpServerStatus(server.name, false);
            } else {
                const result = await connectMcpServer(server.name);
                if (!isMcpMutationSuccessful(result)) throw new Error(result?.message || '连接 MCP 服务器失败。');
                storeUpdateMcpServerStatus(server.name, true);
            }
            refreshLocal(visibleServers.map((item) => item.name === server.name ? { ...item, connected: !server.connected } : item));
        } catch (err) {
            setActionError(`${server.name}：${errorText(err, '连接状态更新失败，未改变本地状态。')}`);
        } finally {
            setActionLoading(null);
        }
    };

    const handleRemove = async (server) => {
        if (isBuiltinMcpServer(server) || !window.confirm(`确认移除 MCP 服务器“${server.name}”？`)) return;
        setActionLoading(server.name);
        setActionError('');
        try {
            const result = await removeMcpServer(server.name);
            if (!isMcpMutationSuccessful(result)) throw new Error(result?.message || '移除 MCP 服务器失败。');
            storeRemoveMcpServer(server.name);
            refreshLocal(visibleServers.filter((item) => item.name !== server.name));
        } catch (err) {
            setActionError(`${server.name}：${errorText(err, '移除失败，未改变本地状态。')}`);
        } finally {
            setActionLoading(null);
        }
    };

    return (
        <section>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <SectionHeading title="MCP 服务器" scope="当前用户" description="连接、断开和移除动态 MCP 服务器。内置服务器只能查看，连接状态以服务端确认结果为准。" />
                <button type="button" onClick={() => setShowForm((value) => !value)} className="ui-button-ghost px-3 py-1.5 text-xs">{showForm ? '取消' : '+ 添加'}</button>
            </div>
            {status === 'loading' && <StatusMessage>正在加载 MCP 服务器...</StatusMessage>}
            {status === 'forbidden' && <PermissionMessage onRetry={load} />}
            {status === 'error' && <ErrorMessage message={error} onRetry={load} />}
            {status === 'ready' && (
                <>
                    {showForm && (
                        <div className="surface-subtle mb-3 grid gap-2 rounded-xl p-3 sm:grid-cols-3">
                            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="服务器名称" aria-label="MCP 服务器名称" className="ui-input px-2 py-1.5 text-xs" />
                            <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="命令，如 npx 或 python" aria-label="MCP 服务器命令" className="ui-input px-2 py-1.5 text-xs" />
                            <input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="参数（空格分隔）" aria-label="MCP 服务器参数" className="ui-input px-2 py-1.5 text-xs" />
                            <button type="button" onClick={handleAdd} disabled={!name.trim() || !command.trim() || Boolean(actionLoading)} className="ui-button-primary px-3 py-1.5 text-xs disabled:opacity-50 sm:col-span-3">{actionLoading === 'add' ? '连接中...' : '添加并连接'}</button>
                        </div>
                    )}
                    {visibleServers.length === 0 ? <div className="surface-subtle rounded-xl px-3 py-4 text-xs text-[var(--text-muted)]">暂无 MCP 服务器。</div> : (
                        <div className="space-y-2">
                            {visibleServers.map((server) => (
                                <div key={server.name} className="surface-card flex flex-wrap items-center justify-between gap-3 p-3">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className={`h-2 w-2 rounded-full ${server.connected ? 'bg-emerald-400' : 'bg-red-400'}`} aria-label={server.connected ? '已连接' : '未连接'} />
                                            <span className="truncate text-sm font-semibold text-[var(--text-main)]">{server.name}</span>
                                            {isBuiltinMcpServer(server) && <span className="rounded-full border border-[var(--panel-border)] px-2 py-0.5 text-[10px] text-[var(--text-muted)]">内置</span>}
                                        </div>
                                        <p className="mt-1 break-all text-[11px] text-[var(--text-muted)]">{server.command || '服务端内置'} {Array.isArray(server.args) ? server.args.join(' ') : ''}</p>
                                    </div>
                                    {!isBuiltinMcpServer(server) && <div className="flex shrink-0 gap-1">
                                        <button type="button" disabled={actionLoading === server.name} onClick={() => handleConnection(server)} className="ui-button-ghost px-2 py-1 text-xs disabled:opacity-50">{actionLoading === server.name ? '处理中...' : server.connected ? '断开' : '连接'}</button>
                                        <button type="button" disabled={actionLoading === server.name} onClick={() => handleRemove(server)} className="ui-button-ghost px-2 py-1 text-xs text-[var(--status-danger)] disabled:opacity-50">移除</button>
                                    </div>}
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}
            {actionError && <p className="mt-3 text-xs text-[var(--status-danger)]" role="alert">{actionError}</p>}
        </section>
    );
}
