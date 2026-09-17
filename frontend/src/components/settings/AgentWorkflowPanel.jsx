import { useEffect, useMemo, useState } from 'react';
import { fetchAgentConfig, updateAgentConfig } from '../../api/chat';
import { AGENT_CONFIGS, formatConfigError, getConfigValue, configValueMap } from './configSchema';
import { SectionHeading } from './SettingsWorkspace';

export default function AgentWorkflowPanel({ draft = null, onDraftChange, onConfigChanged }) {
    const [configs, setConfigs] = useState([]);
    const [status, setStatus] = useState('loading');
    const [error, setError] = useState('');
    const [editing, setEditing] = useState(draft);
    const [saving, setSaving] = useState(false);

    const load = async () => {
        setStatus('loading');
        setError('');
        try {
            const data = await fetchAgentConfig();
            if (!data?.ok) throw new Error('配置加载失败，请重试。');
            setConfigs(Array.isArray(data.configs) ? data.configs : []);
            setStatus('ready');
        } catch (err) {
            setStatus(err?.status === 403 ? 'forbidden' : 'error');
            setError(formatConfigError(err, 'Agent 配置加载失败，请重试。'));
        }
    };

    useEffect(() => {
        load();
    }, []);

    useEffect(() => {
        onDraftChange?.(editing);
    }, [editing, onDraftChange]);

    const values = useMemo(() => configValueMap(configs), [configs]);

    const save = async () => {
        if (!editing || saving) return;
        setSaving(true);
        setError('');
        try {
            const data = await updateAgentConfig(editing.key, editing.value);
            if (!data?.ok) throw new Error('保存失败，请重试。');
            setConfigs((current) => current.some((item) => item.key === editing.key)
                ? current.map((item) => item.key === editing.key ? { ...item, value: editing.value } : item)
                : [...current, { key: editing.key, value: editing.value }]);
            setEditing(null);
            onConfigChanged?.();
        } catch (err) {
            setError(formatConfigError(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div>
            <SectionHeading title="Agent 工作流" scope="当前用户" description="常见流程示意：Router → 专业 Agent（general / search / knowledge / code，可多路）→ Synthesizer。Planner 与工具执行器是运行节点，目前没有单独的可编辑指令配置。" />
            {status === 'loading' && <StatusMessage>正在加载 Agent 配置...</StatusMessage>}
            {status === 'forbidden' && <PermissionMessage onRetry={load} />}
            {status === 'error' && <ErrorMessage message={error} onRetry={load} />}
            {status === 'ready' && configs.length === 0 && <EmptyMessage>接口返回了空配置集合，将显示六个可编辑配置入口。</EmptyMessage>}

            {status === 'ready' && (
                <div className="grid gap-3 lg:grid-cols-2">
                    {AGENT_CONFIGS.map((meta) => {
                        const value = values.has(meta.key) ? values.get(meta.key) : getConfigValue(configs, meta);
                        const isEditing = editing?.key === meta.key;
                        return (
                            <article key={meta.key} className="surface-card p-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <h3 className="text-sm font-semibold text-[var(--text-main)]">{meta.label}</h3>
                                        <p className="mt-1 text-xs text-[var(--text-muted)]">{meta.responsibility}</p>
                                    </div>
                                    {!isEditing && <button type="button" onClick={() => setEditing({ key: meta.key, value })} className="ui-button-ghost shrink-0 px-2 py-1 text-xs">编辑</button>}
                                </div>
                                <p className="mt-3 text-[11px] text-[var(--text-muted)]">何时生效：{meta.when}</p>
                                {isEditing ? (
                                    <div className="mt-3 space-y-2">
                                        <textarea value={editing.value} onChange={(event) => setEditing({ ...editing, value: event.target.value })} rows={5} className="ui-textarea w-full px-3 py-2 text-xs" autoFocus />
                                        <div className="flex gap-2">
                                            <button type="button" onClick={save} disabled={saving} className="ui-button-primary px-3 py-1.5 text-xs disabled:opacity-50">{saving ? '保存中...' : '保存'}</button>
                                            <button type="button" onClick={() => setEditing(null)} className="ui-button-ghost px-3 py-1.5 text-xs">取消</button>
                                        </div>
                                    </div>
                                ) : (
                                    <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-xs text-[var(--text-main)]">{value.trim() || `${meta.summary}（当前未添加额外指令）`}</p>
                                )}
                                <p className="mt-3 break-all font-mono text-[10px] text-[var(--text-muted)]">{meta.key}</p>
                            </article>
                        );
                    })}
                </div>
            )}
            {error && status === 'ready' && <p className="mt-3 text-xs text-[var(--status-danger)]" role="alert">{error}</p>}
        </div>
    );
}

export function StatusMessage({ children }) {
    return <div className="surface-subtle rounded-xl px-3 py-4 text-xs text-[var(--text-muted)]">{children}</div>;
}

export function EmptyMessage({ children }) {
    return <div className="surface-subtle rounded-xl border border-dashed px-3 py-4 text-xs text-[var(--text-muted)]">{children}</div>;
}

export function PermissionMessage({ onRetry }) {
    return (
        <div className="surface-subtle rounded-xl px-3 py-4 text-xs text-[var(--text-muted)]">
            <p>需要管理员权限才能查看或编辑此区域。记忆列表仍可正常使用。</p>
            <button type="button" onClick={onRetry} className="ui-button-ghost mt-2 px-2 py-1 text-xs">重试</button>
        </div>
    );
}

export function ErrorMessage({ message, onRetry }) {
    return (
        <div className="rounded-xl border border-[var(--status-danger)]/30 bg-[var(--status-danger-soft)] px-3 py-4 text-xs text-[var(--text-main)]" role="alert">
            <p>{message}</p>
            <button type="button" onClick={onRetry} className="ui-button-ghost mt-2 px-2 py-1 text-xs">重试</button>
        </div>
    );
}
