import { useEffect, useMemo, useState } from 'react';
import { fetchAgentConfig, updateAgentConfig } from '../../api/chat';
import { TOOL_CONFIGS, configValueMap, getConfigValue, formatConfigError } from './configSchema';
import { EmptyMessage, ErrorMessage, PermissionMessage, StatusMessage } from './AgentWorkflowPanel';
import { SectionHeading } from './SettingsWorkspace';

export default function ToolDescriptionsPanel({ draft = null, onDraftChange, onConfigChanged }) {
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
            if (!data?.ok) throw new Error('内置工具描述加载失败，请重试。');
            setConfigs(Array.isArray(data.configs) ? data.configs : []);
            setStatus('ready');
        } catch (err) {
            setStatus(err?.status === 403 ? 'forbidden' : 'error');
            setError(formatConfigError(err, '内置工具描述加载失败，请重试。'));
        }
    };

    useEffect(() => { load(); }, []);
    useEffect(() => { onDraftChange?.(editing); }, [editing, onDraftChange]);
    const values = useMemo(() => configValueMap(configs), [configs]);

    const save = async () => {
        if (!editing || saving) return;
        setSaving(true);
        setError('');
        try {
            const data = await updateAgentConfig(editing.key, editing.value);
            if (!data?.ok) throw new Error('保存失败，请重试。');
            setConfigs((current) => current.map((item) => item.key === editing.key ? { ...item, value: editing.value } : item));
            setEditing(null);
            onConfigChanged?.();
        } catch (err) {
            setError(formatConfigError(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <section>
            <SectionHeading title="内置工具描述" scope="当前用户" description="这里只编辑五个内置 tool.*.description。动态 MCP 工具列表是另一套连接管理，不会被这些描述键伪装或替代；技能库仍由侧栏单独管理。" />
            {status === 'loading' && <StatusMessage>正在加载内置工具描述...</StatusMessage>}
            {status === 'forbidden' && <PermissionMessage onRetry={load} />}
            {status === 'error' && <ErrorMessage message={error} onRetry={load} />}
            {status === 'ready' && configs.length === 0 && <EmptyMessage>接口返回了空配置集合，将显示五个默认描述入口。</EmptyMessage>}
            {status === 'ready' && (
                <div className="space-y-2">
                    {TOOL_CONFIGS.map((meta) => {
                        const value = values.has(meta.key) ? values.get(meta.key) : getConfigValue(configs, meta);
                        const isEditing = editing?.key === meta.key;
                        return (
                            <div key={meta.key} className="surface-card p-3">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <h3 className="text-sm font-semibold text-[var(--text-main)]">{meta.label}</h3>
                                        <p className="mt-1 text-xs text-[var(--text-muted)]">{meta.responsibility}</p>
                                    </div>
                                    {!isEditing && <button type="button" onClick={() => setEditing({ key: meta.key, value })} className="ui-button-ghost shrink-0 px-2 py-1 text-xs">编辑</button>}
                                </div>
                                {isEditing ? (
                                    <div className="mt-3 space-y-2">
                                        <textarea value={editing.value} onChange={(event) => setEditing({ ...editing, value: event.target.value })} rows={3} className="ui-textarea w-full px-3 py-2 text-xs" autoFocus />
                                        <div className="flex gap-2">
                                            <button type="button" onClick={save} disabled={saving} className="ui-button-primary px-3 py-1.5 text-xs disabled:opacity-50">{saving ? '保存中...' : '保存'}</button>
                                            <button type="button" onClick={() => setEditing(null)} className="ui-button-ghost px-3 py-1.5 text-xs">取消</button>
                                        </div>
                                    </div>
                                ) : <p className="mt-3 whitespace-pre-wrap text-xs text-[var(--text-main)]">{value || '（空，使用运行时默认行为）'}</p>}
                                <p className="mt-2 break-all font-mono text-[10px] text-[var(--text-muted)]">{meta.key}</p>
                            </div>
                        );
                    })}
                </div>
            )}
            {error && status === 'ready' && <p className="mt-3 text-xs text-[var(--status-danger)]" role="alert">{error}</p>}
        </section>
    );
}
