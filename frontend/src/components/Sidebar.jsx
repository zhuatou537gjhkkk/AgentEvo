import { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '../store/chatStore';

export default function Sidebar({ className = '', onAfterSelect, activeView = 'chat', onViewChange }) {
    const [keyword, setKeyword] = useState('');
    const [renameTarget, setRenameTarget] = useState(null);
    const [renameValue, setRenameValue] = useState('');
    const [deleteTarget, setDeleteTarget] = useState(null);
    const sessions = useChatStore((state) => state.sessions);
    const currentSessionId = useChatStore((state) => state.currentSessionId);
    const isSessionLoading = useChatStore((state) => state.isSessionLoading);
    const isCreatingSession = useChatStore((state) => state.isCreatingSession);
    const sessionError = useChatStore((state) => state.sessionError);
    const initSessions = useChatStore((state) => state.initSessions);
    const switchSession = useChatStore((state) => state.switchSession);
    const addNewSession = useChatStore((state) => state.addNewSession);
    const renameSession = useChatStore((state) => state.renameSession);
    const deleteSession = useChatStore((state) => state.deleteSession);
    const toggleSessionPin = useChatStore((state) => state.toggleSessionPin);
    const toggleSettings = useChatStore((state) => state.toggleSettings);
    const toggleEvalDashboard = useChatStore((state) => state.toggleEvalDashboard);
    const toggleObservability = useChatStore((state) => state.toggleObservability);
    const exportCurrentSessionMarkdown = useChatStore((state) => state.exportCurrentSessionMarkdown);
    const isExporting = useChatStore((state) => state.isExporting);
    const messageSearchKeyword = useChatStore((state) => state.messageSearchKeyword);
    const setMessageSearchKeyword = useChatStore((state) => state.setMessageSearchKeyword);

    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.key !== 'Escape') {
                return;
            }

            if (renameTarget) {
                setRenameTarget(null);
                setRenameValue('');
                return;
            }

            if (deleteTarget) {
                setDeleteTarget(null);
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [renameTarget, deleteTarget]);

    const filteredSessions = useMemo(() => {
        const q = keyword.trim().toLowerCase();
        if (!q) {
            return sessions;
        }

        return sessions.filter((session) => {
            const title = String(session.title || '').toLowerCase();
            const timestamp = new Date(session.updated_at || session.created_at).toLocaleString().toLowerCase();
            return title.includes(q) || timestamp.includes(q);
        });
    }, [sessions, keyword]);

    const handleSwitch = async (id) => {
        await switchSession(id);
        onAfterSelect?.();
    };

    const handleCreate = async () => {
        await addNewSession();
        onAfterSelect?.();
    };

    const handleRename = async (event, session) => {
        event.stopPropagation();
        setRenameTarget(session);
        setRenameValue(session.title || '');
    };

    const handleDelete = async (event, sessionId) => {
        event.stopPropagation();
        const session = sessions.find((item) => item.id === sessionId) || null;
        setDeleteTarget(session);
    };

    const handlePin = async (event, sessionId) => {
        event.stopPropagation();
        await toggleSessionPin(sessionId);
    };

    return (
        <>
            <aside className={`app-sidebar ${className}`}>
                <div className="sidebar-brand">
                    <div className="brand-lockup">
                        <span className="brand-dot" aria-hidden="true">✦</span>
                        <span>AgentEvo</span>
                    </div>
                    <span className="sidebar-version">workspace</span>
                </div>

                <div className="sidebar-actions">
                    <button type="button" onClick={handleCreate} disabled={isCreatingSession} className="new-chat-button">
                        <span aria-hidden="true">＋</span>
                        {isCreatingSession ? '创建中...' : '新建聊天'}
                    </button>
                    <label className="sidebar-search">
                        <span aria-hidden="true">⌕</span>
                        <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索会话" />
                    </label>
                </div>

                <nav className="sidebar-nav" aria-label="工作区导航">
                    <p className="sidebar-section-label">工作台</p>
                    <button type="button" onClick={() => onViewChange?.('chat')} className={`sidebar-nav-item ${activeView === 'chat' ? 'is-active' : ''}`}>
                        <span aria-hidden="true">◎</span><span>聊天工作区</span>
                    </button>
                    <button type="button" onClick={() => onViewChange?.('eval')} className={`sidebar-nav-item ${activeView === 'eval' ? 'is-active' : ''}`}>
                        <span aria-hidden="true">◈</span><span>评估与优化</span>
                    </button>
                    <button type="button" onClick={() => onViewChange?.('observability')} className={`sidebar-nav-item ${activeView === 'observability' ? 'is-active' : ''}`}>
                        <span aria-hidden="true">⌁</span><span>运行观测</span>
                    </button>
                </nav>

                {sessionError && (
                    <div className="sidebar-error">
                        <p>{sessionError}</p>
                        <button type="button" onClick={initSessions}>重试初始化</button>
                    </div>
                )}

                <div className="sidebar-recent">
                    <div className="sidebar-section-heading">
                        <p className="sidebar-section-label">最近对话</p>
                        <span>{filteredSessions.length}</span>
                    </div>
                    <input
                        value={messageSearchKeyword}
                        onChange={(event) => setMessageSearchKeyword(event.target.value)}
                        placeholder="筛选当前会话消息"
                        className="sidebar-message-filter"
                    />
                    <ul className="session-list">
                        {filteredSessions.map((session) => {
                            const active = session.id === currentSessionId;
                            return (
                                <li key={session.id} className={`session-row ${active ? 'is-active' : ''}`}>
                                    <button type="button" onClick={() => handleSwitch(session.id)} aria-label={`切换到会话 ${session.title || '未命名会话'}`} className="session-select">
                                        <span className="session-icon" aria-hidden="true">{session.pinned ? '●' : '○'}</span>
                                        <span className="min-w-0 flex-1">
                                            <span className="session-title">{session.title || '未命名会话'}</span>
                                            <span className="session-time">{new Date(session.updated_at || session.created_at).toLocaleDateString()}</span>
                                        </span>
                                    </button>
                                    <div className="session-actions">
                                        <button type="button" onClick={(event) => handlePin(event, session.id)} aria-label={session.pinned ? '取消置顶会话' : '置顶会话'} title={session.pinned ? '取消置顶' : '置顶'}>⌃</button>
                                        <button type="button" onClick={(event) => handleRename(event, session)} aria-label="重命名会话" title="重命名">⋯</button>
                                        <button type="button" onClick={(event) => handleDelete(event, session.id)} aria-label="删除会话" title="删除">×</button>
                                    </div>
                                </li>
                            );
                        })}
                        {filteredSessions.length === 0 && <li className="session-empty">未找到匹配会话</li>}
                    </ul>
                </div>

                <div className="sidebar-footer">
                    <div className="upgrade-card">
                        <span className="upgrade-kicker">AgentEvo Pro</span>
                        <strong>解锁更强的工作流</strong>
                        <small>更多文件、记忆与模型能力</small>
                        <span className="upgrade-link">了解更多 ↗</span>
                    </div>
                    <div className="sidebar-footer-actions">
                        <button type="button" onClick={toggleSettings}><span aria-hidden="true">⚙</span>设置</button>
                        <button type="button" onClick={exportCurrentSessionMarkdown} disabled={isExporting}><span aria-hidden="true">⇩</span>{isExporting ? '导出中' : '导出'}</button>
                    </div>
                </div>
            </aside>

            {renameTarget && (
                <div
                    className="ui-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-3"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) {
                            setRenameTarget(null);
                            setRenameValue('');
                        }
                    }}
                >
                    <div role="dialog" aria-modal="true" aria-label="重命名会话" className="w-full max-w-md rounded-2xl ui-modal w-full max-w-md p-4 text-[var(--text-main)]">
                        <h3 className="text-sm font-semibold">重命名会话</h3>
                        <input
                            autoFocus
                            value={renameValue}
                            onChange={(event) => setRenameValue(event.target.value)}
                            className="mt-3 w-full rounded-lg ui-input w-full px-3 py-2 text-sm"
                        />
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => {
                                    setRenameTarget(null);
                                    setRenameValue('');
                                }}
                                className="ui-button-secondary px-3 py-1.5 text-xs"
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                onClick={async () => {
                                    const title = renameValue.trim();
                                    if (!title) {
                                        return;
                                    }

                                    await renameSession(renameTarget.id, title);
                                    setRenameTarget(null);
                                    setRenameValue('');
                                }}
                                className="ui-button-primary px-3 py-1.5 text-xs"
                            >
                                保存
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {deleteTarget && (
                <div
                    className="ui-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-3"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) {
                            setDeleteTarget(null);
                        }
                    }}
                >
                    <div role="dialog" aria-modal="true" aria-label="删除会话确认" className="w-full max-w-md rounded-2xl ui-modal w-full max-w-md p-4 text-[var(--text-main)]">
                        <h3 className="text-sm font-semibold">确认删除会话</h3>
                        <p className="mt-2 text-xs text-slate-300">将删除“{deleteTarget.title || '未命名会话'}”及其全部消息，此操作不可恢复。</p>
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => setDeleteTarget(null)}
                                className="ui-button-secondary px-3 py-1.5 text-xs"
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                onClick={async () => {
                                    await deleteSession(deleteTarget.id);
                                    setDeleteTarget(null);
                                }}
                                className="ui-button-primary bg-[var(--status-danger)] px-3 py-1.5 text-xs"
                            >
                                删除
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
