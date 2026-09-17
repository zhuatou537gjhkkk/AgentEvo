import { useEffect, useMemo, useState } from 'react';
import { fetchAgentConfig, updateAgentConfig } from '../../api/chat';
import { configValueMap, formatConfigError, getConfigValue, MEMORY_CONFIGS, validateConfigValue } from './configSchema';
import { ErrorMessage, PermissionMessage, StatusMessage } from './AgentWorkflowPanel';
import { SectionHeading } from './SettingsWorkspace';

export default function MemoryPolicyPanel({ draft = null, onDraftChange, onConfigChanged }) {
    const [configs, setConfigs] = useState([]);
    const [status, setStatus] = useState('loading');
    const [error, setError] = useState('');
    const [editing, setEditing] = useState(draft);
    const [saving, setSaving] = useState(false);
    const values = useMemo(() => configValueMap(configs), [configs]);

    const load = async () => {
        setStatus('loading');
        setError('');
        try {
            const data = await fetchAgentConfig();
            if (!data?.ok) throw new Error('记忆策略加载失败，请重试。');
            setConfigs(Array.isArray(data.configs) ? data.configs : []);
            setStatus('ready');
        } catch (err) {
            setStatus(err?.status === 403 ? 'forbidden' : 'error');
            setError(formatConfigError(err, '记忆策略加载失败，请重试。'));
        }
    };

    useEffect(() => { load(); }, []);
    useEffect(() => { onDraftChange?.(editing); }, [editing, onDraftChange]);

    const save = async () => {
        if (!editing || saving) return;
        const validation = validateConfigValue(editing.key, editing.value);
        if (!validation.ok) {
            setError(validation.error);
            return;
        }
        setSaving(true);
        setError('');
        try {
            const data = await updateAgentConfig(editing.key, validation.value);
            if (!data?.ok) throw new Error('保存失败，请重试。');
            setConfigs((current) => current.some((item) => item.key === editing.key)
                ? current.map((item) => item.key === editing.key ? { ...item, value: validation.value } : item)
                : [...current, { key: editing.key, value: validation.value }]);
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
            <SectionHeading title="记忆策略" scope="管理员设置" description="记忆列表本身不隐藏；此处七项策略通过 Agent 配置接口管理，普通用户遇到 403 时会明确显示权限状态。跨源实验参数可能被功能开关或环境变量覆盖。" />
            {status === 'loading' && <StatusMessage>正在加载记忆策略...</StatusMessage>}
            {status === 'forbidden' && <PermissionMessage onRetry={load} />}
            {status === 'error' && <ErrorMessage message={error} onRetry={load} />}
            {status === 'ready' && (
                <div className="space-y-2">
                    {MEMORY_CONFIGS.map((meta) => {
                        const value = values.has(meta.key) ? values.get(meta.key) : getConfigValue(configs, meta);
                        const isEditing = editing?.key === meta.key;
                        return (
                            <div key={meta.key} className="surface-card p-3">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                    <div>
                                        <h3 className="text-sm font-semibold text-[var(--text-main)]">{meta.label}</h3>
                                        <p className="mt-1 text-xs text-[var(--text-muted)]">{meta.description}</p>
                                    </div>
                                    {!isEditing && <button type="button" onClick={() => setEditing({ key: meta.key, value })} className="ui-button-ghost shrink-0 px-2 py-1 text-xs">编辑</button>}
                                </div>
                                {isEditing ? (
                                    <div className="mt-3 space-y-2">
                                        {meta.inputType === 'json' ? (
                                            <textarea value={editing.value} onChange={(event) => setEditing({ ...editing, value: event.target.value })} rows={5} className="ui-textarea w-full px-3 py-2 font-mono text-xs" autoFocus />
                                        ) : (
                                            <input type={meta.inputType === 'ratio' || meta.inputType === 'days' ? 'number' : 'text'} min={meta.inputType === 'ratio' ? '0' : meta.inputType === 'days' ? '0' : undefined} max={meta.inputType === 'ratio' ? '1' : undefined} step={meta.inputType === 'ratio' ? '0.05' : meta.inputType === 'days' ? '1' : undefined} value={editing.value} onChange={(event) => setEditing({ ...editing, value: event.target.value })} className="ui-input w-full px-3 py-2 text-xs" autoFocus />
                                        )}
                                        <div className="flex gap-2">
                                            <button type="button" onClick={save} disabled={saving} className="ui-button-primary px-3 py-1.5 text-xs disabled:opacity-50">{saving ? '保存中...' : '保存'}</button>
                                            <button type="button" onClick={() => setEditing(null)} className="ui-button-ghost px-3 py-1.5 text-xs">取消</button>
                                        </div>
                                    </div>
                                ) : <p className="mt-3 whitespace-pre-wrap break-all text-xs text-[var(--text-main)]">{value || '（空）'}</p>}
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
