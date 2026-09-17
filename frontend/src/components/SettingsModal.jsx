import { useEffect, useRef } from 'react';
import { useChatStore } from '../store/chatStore';
export { dedupeMcpServers } from './settings/mcpServers';

/**
 * Chat-scoped settings only. Workspace configuration and browser preferences
 * live in SettingsWorkspace so this dialog cannot imply that every setting is
 * isolated per conversation.
 */
export default function SettingsModal() {
    const isSettingsOpen = useChatStore((state) => state.isSettingsOpen);
    const systemPrompt = useChatStore((state) => state.systemPrompt);
    const temperature = useChatStore((state) => state.temperature);
    const setSystemPrompt = useChatStore((state) => state.setSystemPrompt);
    const setTemperature = useChatStore((state) => state.setTemperature);
    const resetCurrentSessionSettings = useChatStore((state) => state.resetCurrentSessionSettings);
    const toggleSettings = useChatStore((state) => state.toggleSettings);
    const dialogRef = useRef(null);

    useEffect(() => {
        if (!isSettingsOpen) return undefined;
        dialogRef.current?.focus();
        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                toggleSettings();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isSettingsOpen, toggleSettings]);

    if (!isSettingsOpen) return null;

    return (
        <div
            className="ui-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
            onClick={(event) => {
                if (event.target === event.currentTarget) toggleSettings();
            }}
        >
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="本会话设置" tabIndex={-1} className="w-full max-w-2xl rounded-3xl surface-card p-4 shadow-2xl outline-none sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                        <h2 className="text-xl font-semibold text-[var(--text-main)]">本会话设置</h2>
                        <p className="mt-1 text-xs text-[var(--text-muted)]">仅影响当前会话的后续消息；设置保存在当前浏览器。</p>
                    </div>
                    <span className="rounded-full border border-[var(--panel-border)] px-2 py-0.5 text-[10px] text-[var(--text-muted)]">当前会话</span>
                </div>

                <div className="mt-5 space-y-4">
                    <label className="block">
                        <span className="mb-2 block text-sm font-medium text-[var(--text-main)]">System Prompt</span>
                        <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={7} className="ui-textarea w-full px-3 py-2 text-sm" placeholder="请输入系统提示词" />
                    </label>
                    <label className="block">
                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-sm font-medium text-[var(--text-main)]">Temperature</span>
                            <span className="text-sm font-semibold text-[var(--brand-start)]">{Number(temperature).toFixed(1)}</span>
                        </div>
                        <input type="range" min="0" max="1" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} className="w-full accent-[var(--brand-start)]" />
                    </label>
                </div>

                <div className="mt-6 flex flex-wrap justify-between gap-2">
                    <button type="button" onClick={resetCurrentSessionSettings} className="ui-button-secondary px-4 py-2 text-sm">恢复本会话默认设置</button>
                    <button type="button" onClick={toggleSettings} className="ui-button-primary px-4 py-2 text-sm">关闭</button>
                </div>
            </div>
        </div>
    );
}
