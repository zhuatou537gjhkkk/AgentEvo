import { useEffect, useState } from 'react';
import { deleteAgentConfigVersion, fetchAgentConfigVersions, renameAgentConfigVersion, rollbackAgentConfig } from '../../api/chat';
import { formatConfigError } from './configSchema';
import { ErrorMessage, PermissionMessage, StatusMessage } from './AgentWorkflowPanel';
import { SectionHeading } from './SettingsWorkspace';

export default function ConfigVersionsPanel({ reloadKey = 0, onConfigChanged }) {
    const [versions, setVersions] = useState([]);
    const [status, setStatus] = useState('loading');
    const [error, setError] = useState('');
    const [loadingAction, setLoadingAction] = useState(null);

    const load = async () => {
        setStatus('loading');
        setError('');
        try {
            const data = await fetchAgentConfigVersions();
            if (!data?.ok) throw new Error('配置版本加载失败，请重试。');
            setVersions(Array.isArray(data.versions) ? data.versions : []);
            setStatus('ready');
        } catch (err) {
            setStatus(err?.status === 403 ? 'forbidden' : 'error');
            setError(formatConfigError(err, '配置版本加载失败，请重试。'));
        }
    };

    useEffect(() => { load(); }, [reloadKey]);

    const rename = async (version) => {
        const label = window.prompt('版本标签（留空清除）', version.label || '');
        if (label === null) return;
        setLoadingAction(`label-${version.id}`);
        setError('');
        try {
            const data = await renameAgentConfigVersion(version.id, label.trim() || null);
            if (!data?.ok) throw new Error('重命名失败，请重试。');
            setVersions((current) => current.map((item) => item.id === version.id ? { ...item, label: label.trim() || null } : item));
        } catch (err) {
            setError(formatConfigError(err));
        } finally {
            setLoadingAction(null);
        }
    };

    const remove = async (version) => {
        if (!window.confirm(`确认删除版本 v${version.id}？此操作不可撤销。`)) return;
        setLoadingAction(`delete-${version.id}`);
        setError('');
        try {
            const data = await deleteAgentConfigVersion(version.id);
            if (!data?.ok) throw new Error('删除失败，请重试。');
            setVersions((current) => current.filter((item) => item.id !== version.id));
        } catch (err) {
            setError(formatConfigError(err));
        } finally {
            setLoadingAction(null);
        }
    };

    const restore = async (version) => {
        if (!window.confirm(`恢复 v${version.id}？这会影响 Agent 指令、内置工具描述和记忆策略，不会回滚本会话 Prompt、语音偏好或 MCP 连接。`)) return;
        setLoadingAction(`restore-${version.id}`);
        setError('');
        try {
            const data = await rollbackAgentConfig(version.id);
            if (!data?.ok) throw new Error('恢复失败，请重试。');
            onConfigChanged?.();
            await load();
        } catch (err) {
            setError(formatConfigError(err));
        } finally {
            setLoadingAction(null);
        }
    };

    return (
        <section>
            <SectionHeading title="配置版本" scope="管理员设置" description="这里展示整个 Agent 配置集合的快照历史。恢复影响 Agent 指令、内置工具描述及记忆策略，不会回滚本会话 Prompt、语音偏好或 MCP 连接。" />
            {status === 'loading' && <StatusMessage>正在加载配置版本...</StatusMessage>}
            {status === 'forbidden' && <PermissionMessage onRetry={load} />}
            {status === 'error' && <ErrorMessage message={error} onRetry={load} />}
            {status === 'ready' && versions.length === 0 && <div className="surface-subtle rounded-xl px-3 py-4 text-xs text-[var(--text-muted)]">暂无配置版本快照。保存 Agent、工具或记忆策略后会生成快照。</div>}
            {status === 'ready' && versions.length > 0 && (
                <div className="space-y-2">
                    {versions.map((version) => (
                        <div key={version.id} className="surface-card flex flex-wrap items-center justify-between gap-3 p-3">
                            <div>
                                <p className="text-sm font-semibold text-[var(--text-main)]">v{version.id}{version.source ? ` · ${version.source}` : ''}</p>
                                <p className="mt-1 text-xs text-[var(--text-muted)]">{version.label || '未命名版本'} · {version.created_at || '未知时间'}</p>
                            </div>
                            <div className="flex gap-1">
                                <button type="button" disabled={Boolean(loadingAction)} onClick={() => rename(version)} className="ui-button-ghost px-2 py-1 text-xs">重命名</button>
                                <button type="button" disabled={Boolean(loadingAction)} onClick={() => restore(version)} className="ui-button-ghost px-2 py-1 text-xs">{loadingAction === `restore-${version.id}` ? '恢复中...' : '恢复'}</button>
                                <button type="button" disabled={Boolean(loadingAction)} onClick={() => remove(version)} className="ui-button-ghost px-2 py-1 text-xs text-[var(--status-danger)]">删除</button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            {error && status === 'ready' && <p className="mt-3 text-xs text-[var(--status-danger)]" role="alert">{error}</p>}
        </section>
    );
}
