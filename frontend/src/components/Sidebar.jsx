import { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '../store/chatStore';

export default function Sidebar({ className = '', onAfterSelect }) {
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
            <aside className={`flex h-full w-[280px] max-w-[88vw] flex-col border-r border-slate-800 bg-[#17191c] text-slate-100 ${className}`}>
                <div className="border-b border-slate-800 p-4">
                    <button
                        type="button"
                        onClick={handleCreate}
                        disabled={isCreatingSession}
                        className="w-full rounded-xl border border-slate-700 bg-slate-800/80 px-3 py-2.5 text-sm font-semibold text-slate-100 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {isCreatingSession ? '创建中...' : '+ 新建聊天'}
                    </button>

                    <input
                        value={keyword}
                        onChange={(event) => setKeyword(event.target.value)}
                        placeholder="搜索会话"
                        className="mt-3 w-full rounded-xl border border-slate-700 bg-[#1f2329] px-3 py-2 text-xs text-slate-200 outline-none placeholder:text-slate-500 focus:border-slate-500"
                    />

                    <input
                        value={messageSearchKeyword}
                        onChange={(event) => setMessageSearchKeyword(event.target.value)}
                        placeholder="筛选当前会话消息"
                        className="mt-2 w-full rounded-xl border border-slate-700 bg-[#1f2329] px-3 py-2 text-xs text-slate-200 outline-none placeholder:text-slate-500 focus:border-slate-500"
                    />
                </div>

                {sessionError && (
                    <div className="mx-3 mt-3 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                        <p>{sessionError}</p>
                        <button
                            type="button"
                            onClick={initSessions}
                            className="mt-2 rounded bg-red-500/20 px-2 py-1 text-[11px] text-red-100 transition hover:bg-red-500/30"
                        >
                            重试初始化
                        </button>
                    </div>
                )}

                <div className="flex-1 overflow-y-auto p-3">
                    <ul className="space-y-2">
                        {filteredSessions.map((session) => {
                            const active = session.id === currentSessionId;

                            return (
                                <li key={session.id}>
                                    <button
                                        type="button"
                                        onClick={() => handleSwitch(session.id)}
                                        aria-label={`切换到会话 ${session.title || '未命名会话'}`}
                                        className={[
                                            'group w-full rounded-xl px-3 py-2.5 text-left text-sm transition',
                                            active
                                                ? 'bg-slate-700 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]'
                                                : 'bg-transparent text-slate-300 hover:bg-slate-800/70',
                                        ].join(' ')}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <p className="truncate font-medium">{session.title || '未命名会话'}</p>
                                            <div className="flex shrink-0 items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity">
                                                <button
                                                    type="button"
                                                    onClick={(event) => handlePin(event, session.id)}
                                                    aria-label={session.pinned ? '取消置顶会话' : '置顶会话'}
                                                    className="rounded px-1 text-[10px] text-amber-300 hover:bg-amber-500/20"
                                                >
                                                    {session.pinned ? '取消顶' : '置顶'}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={(event) => handleRename(event, session)}
                                                    aria-label="重命名会话"
                                                    className="rounded px-1 text-[10px] text-slate-300 hover:bg-slate-600/60"
                                                >
                                                    改
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={(event) => handleDelete(event, session.id)}
                                                    aria-label="删除会话"
                                                    className="rounded px-1 text-[10px] text-red-300 hover:bg-red-500/20"
                                                >
                                                    删
                                                </button>
                                            </div>
                                        </div>
                                        <p className="mt-1 truncate text-xs text-gray-400">
                                            {session.pinned ? '📌 置顶 · ' : ''}
                                            {new Date(session.updated_at || session.created_at).toLocaleString()}
                                        </p>
                                    </button>
                                </li>
                            );
                        })}

                        {filteredSessions.length === 0 && (
                            <li className="rounded-xl bg-slate-800/40 px-3 py-2 text-xs text-slate-400">
                                未找到匹配会话
                            </li>
                        )}
                    </ul>
                </div>

                <div className="border-t border-slate-800 p-3">
                    <div className="grid grid-cols-4 gap-2">
                        <button
                            type="button"
                            onClick={toggleSettings}
                            className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700"
                        >
                            设置
                        </button>
                        <button
                            type="button"
                            onClick={toggleEvalDashboard}
                            className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700"
                        >
                            评估
                        </button>
                        <button
                            type="button"
                            onClick={toggleObservability}
                            className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700"
                        >
                            观测
                        </button>
                        <button
                            type="button"
                            onClick={exportCurrentSessionMarkdown}
                            disabled={isExporting}
                            className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {isExporting ? '导出中...' : '导出 MD'}
                        </button>
                    </div>
                </div>
            </aside>

            {renameTarget && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) {
                            setRenameTarget(null);
                            setRenameValue('');
                        }
                    }}
                >
                    <div role="dialog" aria-modal="true" aria-label="重命名会话" className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#17191c] p-4 text-slate-100 shadow-2xl">
                        <h3 className="text-sm font-semibold">重命名会话</h3>
                        <input
                            autoFocus
                            value={renameValue}
                            onChange={(event) => setRenameValue(event.target.value)}
                            className="mt-3 w-full rounded-lg border border-slate-700 bg-[#1f2329] px-3 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
                        />
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => {
                                    setRenameTarget(null);
                                    setRenameValue('');
                                }}
                                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs"
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
                                className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-900"
                            >
                                保存
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {deleteTarget && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) {
                            setDeleteTarget(null);
                        }
                    }}
                >
                    <div role="dialog" aria-modal="true" aria-label="删除会话确认" className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#17191c] p-4 text-slate-100 shadow-2xl">
                        <h3 className="text-sm font-semibold">确认删除会话</h3>
                        <p className="mt-2 text-xs text-slate-300">将删除“{deleteTarget.title || '未命名会话'}”及其全部消息，此操作不可恢复。</p>
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => setDeleteTarget(null)}
                                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs"
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                onClick={async () => {
                                    await deleteSession(deleteTarget.id);
                                    setDeleteTarget(null);
                                }}
                                className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white"
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
