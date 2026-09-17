import { useCallback, useState } from 'react';
import AgentWorkflowPanel from './AgentWorkflowPanel';
import AppearanceVoicePanel from './AppearanceVoicePanel';
import ConfigVersionsPanel from './ConfigVersionsPanel';
import McpServersPanel from './McpServersPanel';
import MemoryPolicyPanel from './MemoryPolicyPanel';
import ToolDescriptionsPanel from './ToolDescriptionsPanel';
import MemoryPanel from '../MemoryPanel';
import { useChatStore } from '../../store/chatStore';
import { SETTINGS_TABS } from './navigation';

export default function SettingsWorkspace({ onBack }) {
    const [activeTab, setActiveTab] = useState('agent');
    const [configRevision, setConfigRevision] = useState(0);
    const [drafts, setDrafts] = useState({});
    const switchSession = useChatStore((state) => state.switchSession);

    const notifyConfigChanged = useCallback(() => setConfigRevision((value) => value + 1), []);
    const updateDraft = useCallback((name, draft) => setDrafts((current) => ({ ...current, [name]: draft || null })), []);
    const leaveSettings = useCallback(() => {
        const hasDraft = Object.values(drafts).some(Boolean);
        if (hasDraft && !window.confirm('当前设置还有未保存草稿，离开后会丢失。确定离开吗？')) return;
        onBack?.();
    }, [drafts, onBack]);
    const openSourceSession = useCallback((sessionId) => {
        Promise.resolve(switchSession(sessionId)).finally(() => leaveSettings());
    }, [leaveSettings, switchSession]);
    const handleAgentDraftChange = useCallback((draft) => updateDraft('agent', draft), [updateDraft]);
    const handleToolDraftChange = useCallback((draft) => updateDraft('tools', draft), [updateDraft]);
    const handleMemoryDraftChange = useCallback((draft) => updateDraft('memory', draft), [updateDraft]);

    return (
        <main className="tool-workspace">
            <div className="tool-page-surface flex min-h-full flex-col">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex flex-wrap items-center gap-2">
                            <h1 className="text-xl font-bold text-[var(--text-main)]">设置工作台</h1>
                            <span className="rounded-full border border-[var(--panel-border)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">当前用户</span>
                        </div>
                        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--text-muted)]">
                            工作台配置影响当前用户的后续会话；本会话 Prompt/Temperature 请在聊天页单独调整。
                        </p>
                    </div>
                    <button type="button" onClick={leaveSettings} className="ui-button-ghost px-3 py-1.5 text-xs">
                        返回聊天
                    </button>
                </div>

                <nav className="mt-5 flex gap-2 overflow-x-auto border-b border-[var(--panel-border)] pb-2" aria-label="设置分区">
                    {SETTINGS_TABS.map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => setActiveTab(tab.id)}
                            aria-current={activeTab === tab.id ? 'page' : undefined}
                            className={`min-w-max rounded-lg px-3 py-2 text-xs font-semibold transition ${activeTab === tab.id ? 'bg-[var(--accent-soft)] text-[var(--text-main)]' : 'text-[var(--text-muted)] hover:bg-[var(--panel-soft)] hover:text-[var(--text-main)]'}`}
                        >
                            {tab.label}
                        </button>
                    ))}
                </nav>

                <div className="min-h-0 flex-1 pt-5">
                    {activeTab === 'agent' && <AgentWorkflowPanel draft={drafts.agent} onDraftChange={handleAgentDraftChange} onConfigChanged={notifyConfigChanged} />}
                    {activeTab === 'tools' && (
                        <div className="space-y-6">
                            <McpServersPanel />
                            <ToolDescriptionsPanel draft={drafts.tools} onDraftChange={handleToolDraftChange} onConfigChanged={notifyConfigChanged} />
                        </div>
                    )}
                    {activeTab === 'memory' && (
                        <div className="space-y-6">
                            <section>
                                <SectionHeading title="记忆列表" scope="当前用户" description="普通用户可以查看、审核、编辑、导出和清理自己的记忆。" />
                                <MemoryPanel onOpenSourceSession={openSourceSession} />
                            </section>
                            <MemoryPolicyPanel draft={drafts.memory} onDraftChange={handleMemoryDraftChange} onConfigChanged={notifyConfigChanged} />
                        </div>
                    )}
                    {activeTab === 'appearance' && <AppearanceVoicePanel />}
                    {activeTab === 'versions' && <ConfigVersionsPanel reloadKey={configRevision} onConfigChanged={notifyConfigChanged} />}
                </div>
            </div>
        </main>
    );
}

export function SectionHeading({ title, scope, description }) {
    return (
        <div className="mb-3">
            <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-[var(--text-main)]">{title}</h2>
                <span className="rounded-full border border-[var(--panel-border)] px-2 py-0.5 text-[10px] text-[var(--text-muted)]">{scope}</span>
            </div>
            {description && <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{description}</p>}
        </div>
    );
}
