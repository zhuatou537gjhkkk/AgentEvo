import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { addMcpServer as apiAddMcpServer, removeMcpServer as apiRemoveMcpServer, connectMcpServer as apiConnectMcpServer, disconnectMcpServer as apiDisconnectMcpServer, fetchMcpServers } from '../api/chat';
import MemoryPanel from './MemoryPanel';

export default function SettingsModal() {
    const isSettingsOpen = useChatStore((state) => state.isSettingsOpen);
    const systemPrompt = useChatStore((state) => state.systemPrompt);
    const temperature = useChatStore((state) => state.temperature);
    const setSystemPrompt = useChatStore((state) => state.setSystemPrompt);
    const setTemperature = useChatStore((state) => state.setTemperature);
    const isVoiceEnabled = useChatStore((state) => state.isVoiceEnabled);
    const toggleVoice = useChatStore((state) => state.toggleVoice);
    const voiceRate = useChatStore((state) => state.voiceRate);
    const setVoiceRate = useChatStore((state) => state.setVoiceRate);
    const voiceVolume = useChatStore((state) => state.voiceVolume);
    const setVoiceVolume = useChatStore((state) => state.setVoiceVolume);
    const voiceName = useChatStore((state) => state.voiceName);
    const setVoiceName = useChatStore((state) => state.setVoiceName);
    const themeMode = useChatStore((state) => state.themeMode);
    const setThemeMode = useChatStore((state) => state.setThemeMode);
    const resetCurrentSessionSettings = useChatStore((state) => state.resetCurrentSessionSettings);
    const toggleSettings = useChatStore((state) => state.toggleSettings);
    const mcpServers = useChatStore((state) => state.mcpServers);
    const storeAddMcpServer = useChatStore((state) => state.addMcpServer);
    const storeRemoveMcpServer = useChatStore((state) => state.removeMcpServer);
    const storeUpdateMcpServerStatus = useChatStore((state) => state.updateMcpServerStatus);
    const [voices, setVoices] = useState([]);
    const [showMcpForm, setShowMcpForm] = useState(false);
    const [mcpFormName, setMcpFormName] = useState('');
    const [mcpFormCommand, setMcpFormCommand] = useState('');
    const [mcpFormArgs, setMcpFormArgs] = useState('');
    const [mcpConnecting, setMcpConnecting] = useState(false);
    const [mcpLoading, setMcpLoading] = useState(false);
    const [mcpActionLoading, setMcpActionLoading] = useState(null); // name of server being connected/disconnected
    const dialogRef = useRef(null);

    // 打开设置时从后端拉取 MCP Server 列表
    useEffect(() => {
        if (!isSettingsOpen) return;
        let cancelled = false;

        setMcpLoading(true);
        fetchMcpServers()
            .then((data) => {
                if (cancelled) return;
                const list = Array.isArray(data?.servers) ? data.servers : [];
                // 用后端返回的列表替换 store（后端包含 config + 动态注册的 server）
                useChatStore.setState({ mcpServers: list });
            })
            .catch(() => { /* 网络错误忽略 */ })
            .finally(() => {
                if (!cancelled) setMcpLoading(false);
            });

        return () => { cancelled = true; };
    }, [isSettingsOpen]);

    useEffect(() => {
        if (typeof window === 'undefined' || !window.speechSynthesis) {
            return undefined;
        }

        const updateVoices = () => {
            const list = window.speechSynthesis.getVoices() || [];
            setVoices(list);
        };

        updateVoices();
        window.speechSynthesis.addEventListener('voiceschanged', updateVoices);

        return () => {
            window.speechSynthesis.removeEventListener('voiceschanged', updateVoices);
        };
    }, []);

    useEffect(() => {
        if (!isSettingsOpen) {
            return undefined;
        }

        dialogRef.current?.focus();

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                toggleSettings();
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [isSettingsOpen, toggleSettings]);

    if (!isSettingsOpen) {
        return null;
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3 sm:p-4"
            onClick={(event) => {
                if (event.target === event.currentTarget) {
                    toggleSettings();
                }
            }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label="Agent 设定"
                tabIndex={-1}
                className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-[var(--panel-border)] bg-[var(--panel-bg)] p-4 shadow-2xl outline-none sm:p-6"
            >
                <h2 className="text-xl font-semibold text-[var(--text-main)]">Agent 设定</h2>
                <p className="mt-1 text-xs text-[var(--text-muted)]">当前会话独立保存此处配置，切换会话不会互相影响。</p>

                <div className="mt-5 space-y-4">
                    <label className="block">
                        <span className="mb-2 block text-sm font-medium text-[var(--text-main)]">System Prompt</span>
                        <textarea
                            value={systemPrompt}
                            onChange={(event) => setSystemPrompt(event.target.value)}
                            rows={6}
                            className="w-full rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-2 text-sm text-[var(--text-main)] outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200 dark:focus:border-slate-500 dark:focus:ring-slate-700"
                            placeholder="请输入系统提示词"
                        />
                    </label>

                    <label className="block">
                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-sm font-medium text-[var(--text-main)]">Temperature</span>
                            <span className="text-sm font-semibold text-blue-600">{Number(temperature).toFixed(1)}</span>
                        </div>
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.1"
                            value={temperature}
                            onChange={(event) => setTemperature(Number(event.target.value))}
                            className="w-full accent-blue-600"
                        />
                    </label>

                    <label className="flex items-center justify-between rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-2">
                        <span className="text-sm font-medium text-[var(--text-main)]">自动语音播报</span>
                        <input
                            type="checkbox"
                            checked={isVoiceEnabled}
                            onChange={toggleVoice}
                            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                    </label>

                    <label className="block rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-2">
                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-sm font-medium text-[var(--text-main)]">语速</span>
                            <span className="text-sm font-semibold text-blue-600">{Number(voiceRate).toFixed(1)}</span>
                        </div>
                        <input
                            type="range"
                            min="0.5"
                            max="2"
                            step="0.1"
                            value={voiceRate}
                            onChange={(event) => setVoiceRate(Number(event.target.value))}
                            className="w-full accent-blue-600"
                        />
                    </label>

                    <label className="block rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-2">
                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-sm font-medium text-[var(--text-main)]">音量</span>
                            <span className="text-sm font-semibold text-blue-600">{Math.round(Number(voiceVolume) * 100)}%</span>
                        </div>
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.1"
                            value={voiceVolume}
                            onChange={(event) => setVoiceVolume(Number(event.target.value))}
                            className="w-full accent-blue-600"
                        />
                    </label>

                    <label className="block rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-2">
                        <span className="mb-2 block text-sm font-medium text-[var(--text-main)]">音色</span>
                        <select
                            value={voiceName}
                            onChange={(event) => setVoiceName(event.target.value)}
                            className="w-full rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1.5 text-sm text-[var(--text-main)] outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200 dark:focus:border-slate-500 dark:focus:ring-slate-700"
                        >
                            <option value="">系统默认（自动优先中文）</option>
                            {voices.map((voice) => (
                                <option key={`${voice.name}-${voice.lang}`} value={voice.name}>
                                    {`${voice.name} (${voice.lang || 'unknown'})`}
                                </option>
                            ))}
                        </select>
                    </label>

                    <label className="block rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-2">
                        <span className="mb-2 block text-sm font-medium text-[var(--text-main)]">主题模式</span>
                        <select
                            value={themeMode}
                            onChange={(event) => setThemeMode(event.target.value)}
                            className="w-full rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1.5 text-sm text-[var(--text-main)] outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200 dark:focus:border-slate-500 dark:focus:ring-slate-700"
                        >
                            <option value="system">跟随系统</option>
                            <option value="light">浅色</option>
                            <option value="dark">深色</option>
                        </select>
                    </label>
                </div>

                {/* ── Phase 3: MCP 服务器管理 ── */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-[var(--text-main)]">MCP 服务器</span>
                        <button
                            type="button"
                            onClick={() => setShowMcpForm((v) => !v)}
                            className="rounded-lg bg-[var(--panel-soft)] px-2.5 py-1 text-xs font-medium text-[var(--text-muted)] transition hover:text-[var(--text-main)]"
                        >
                            {showMcpForm ? '取消' : '+ 添加'}
                        </button>
                    </div>

                    {showMcpForm && (
                        <div className="space-y-2 rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-2">
                            <input
                                value={mcpFormName}
                                onChange={(e) => setMcpFormName(e.target.value)}
                                placeholder="服务器名称"
                                className="w-full rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1 text-xs text-[var(--text-main)] outline-none"
                            />
                            <input
                                value={mcpFormCommand}
                                onChange={(e) => setMcpFormCommand(e.target.value)}
                                placeholder="命令 (如 npx 或 python)"
                                className="w-full rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1 text-xs text-[var(--text-main)] outline-none"
                            />
                            <input
                                value={mcpFormArgs}
                                onChange={(e) => setMcpFormArgs(e.target.value)}
                                placeholder="参数 (空格分隔, 可选)"
                                className="w-full rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1 text-xs text-[var(--text-main)] outline-none"
                            />
                            <button
                                type="button"
                                disabled={!mcpFormName || !mcpFormCommand || mcpConnecting}
                                onClick={async () => {
                                    setMcpConnecting(true);
                                    try {
                                        const args = mcpFormArgs.trim() ? mcpFormArgs.trim().split(/\s+/) : [];
                                        await apiAddMcpServer(mcpFormName, mcpFormCommand, args);
                                        storeAddMcpServer({ name: mcpFormName, command: mcpFormCommand, args, enabled: true });
                                        storeUpdateMcpServerStatus(mcpFormName, true);
                                        setMcpFormName('');
                                        setMcpFormCommand('');
                                        setMcpFormArgs('');
                                        setShowMcpForm(false);
                                    } catch (err) {
                                        storeAddMcpServer({ name: mcpFormName, command: mcpFormCommand, args: mcpFormArgs.trim().split(/\s+/), enabled: true });
                                        storeUpdateMcpServerStatus(mcpFormName, false);
                                    } finally {
                                        setMcpConnecting(false);
                                    }
                                }}
                                className="w-full rounded-lg bg-[#111827] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#0b1220] disabled:opacity-40"
                            >
                                {mcpConnecting ? '连接中...' : '连接'}
                            </button>
                        </div>
                    )}

                    {mcpLoading && (
                        <p className="text-xs text-[var(--text-muted)]">⏳ 加载中...</p>
                    )}
                    {!mcpLoading && mcpServers.length === 0 && !showMcpForm && (
                        <p className="text-xs text-[var(--text-muted)]">暂无 MCP 服务器。点击"添加"连接新的 MCP 服务器。</p>
                    )}

                    {mcpServers.map((server) => (
                        <div
                            key={server.name}
                            className="flex items-center justify-between rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-2"
                        >
                            <div className="flex items-center gap-2 min-w-0">
                                <span
                                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                                        server.connected ? 'bg-emerald-400' : 'bg-red-400'
                                    }`}
                                />
                                <span className="text-sm font-medium text-[var(--text-main)] truncate">{server.name}</span>
                                <span className="text-[11px] text-[var(--text-muted)] truncate">
                                    {server.command} {Array.isArray(server.args) ? server.args.join(' ') : ''}
                                </span>
                            </div>
                            {server.type !== 'builtin' && (
                                <div className="ml-2 flex shrink-0 items-center gap-1">
                                    {server.connected ? (
                                        <button
                                            type="button"
                                            disabled={mcpActionLoading === server.name}
                                            onClick={async () => {
                                                setMcpActionLoading(server.name);
                                                try {
                                                    await apiDisconnectMcpServer(server.name);
                                                    storeUpdateMcpServerStatus(server.name, false);
                                                } catch { /* ignore */ }
                                                finally { setMcpActionLoading(null); }
                                            }}
                                            className="rounded-lg px-2 py-1 text-[11px] text-amber-400 transition hover:bg-amber-500/10 disabled:opacity-40"
                                        >
                                            {mcpActionLoading === server.name ? '...' : '断开'}
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            disabled={mcpActionLoading === server.name}
                                            onClick={async () => {
                                                setMcpActionLoading(server.name);
                                                try {
                                                    await apiConnectMcpServer(server.name);
                                                    storeUpdateMcpServerStatus(server.name, true);
                                                } catch { /* ignore */ }
                                                finally { setMcpActionLoading(null); }
                                            }}
                                            className="rounded-lg px-2 py-1 text-[11px] text-emerald-400 transition hover:bg-emerald-500/10 disabled:opacity-40"
                                        >
                                            {mcpActionLoading === server.name ? '...' : '连接'}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={async () => {
                                            try {
                                                await apiRemoveMcpServer(server.name);
                                            } catch { /* ignore network errors */ }
                                            storeRemoveMcpServer(server.name);
                                        }}
                                        className="rounded-lg px-2 py-1 text-[11px] text-red-400 transition hover:bg-red-500/10"
                                    >
                                        移除
                                    </button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {/* ── Phase 4: 记忆管理 ── */}
                <div className="mt-5 space-y-3 border-t border-[var(--panel-border)] pt-4">
                    <span className="text-sm font-semibold text-[var(--text-main)]">🧠 记忆管理</span>
                    <MemoryPanel />
                </div>

                <div className="mt-6 flex justify-between">
                    <button
                        type="button"
                        onClick={resetCurrentSessionSettings}
                        className="rounded-xl border border-[var(--panel-border)] bg-[var(--panel-bg)] px-4 py-2 text-sm font-medium text-[var(--text-main)] transition hover:opacity-95"
                    >
                        恢复默认
                    </button>
                    <button
                        type="button"
                        onClick={toggleSettings}
                        className="rounded-xl bg-[#111827] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0b1220]"
                    >
                        保存并关闭
                    </button>
                </div>
            </div>
        </div>
    );
}
