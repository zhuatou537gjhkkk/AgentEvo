import { useEffect, useState } from 'react';
import ChatInput from './components/ChatInput';
import ChatList from './components/ChatList';
import SettingsModal from './components/SettingsModal';
import Sidebar from './components/Sidebar';
import EvalDashboard from './components/EvalDashboard';
import ObservabilityPanel from './components/ObservabilityPanel';
import { useChatStore } from './store/chatStore';

export default function App() {
    const initSessions = useChatStore((state) => state.initSessions);
    const initAuth = useChatStore((state) => state.initAuth);
    const login = useChatStore((state) => state.login);
    const register = useChatStore((state) => state.register);
    const logout = useChatStore((state) => state.logout);
    const isAuthenticated = useChatStore((state) => state.isAuthenticated);
    const isAuthLoading = useChatStore((state) => state.isAuthLoading);
    const authError = useChatStore((state) => state.authError);
    const user = useChatStore((state) => state.user);
    const themeMode = useChatStore((state) => state.themeMode);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [showShortcuts, setShowShortcuts] = useState(false);
    const [authMode, setAuthMode] = useState('login');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');

    useEffect(() => {
        initAuth();
    }, [initAuth]);

    useEffect(() => {
        if (isAuthenticated) {
            initSessions();
        }
    }, [initSessions, isAuthenticated]);

    useEffect(() => {
        const onKeyDown = (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                const input = document.getElementById('chat-input-textarea');
                input?.focus();
                return;
            }

            if ((event.ctrlKey || event.metaKey) && event.key === '/') {
                event.preventDefault();
                setShowShortcuts((prev) => !prev);
                return;
            }

            if (event.key === 'Escape') {
                setShowShortcuts(false);
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
        };
    }, []);

    useEffect(() => {
        const root = document.documentElement;
        const media = window.matchMedia('(prefers-color-scheme: dark)');

        const applyTheme = () => {
            const resolved = themeMode === 'system'
                ? (media.matches ? 'dark' : 'light')
                : themeMode;

            root.classList.toggle('dark', resolved === 'dark');
        };

        applyTheme();
        media.addEventListener('change', applyTheme);

        return () => {
            media.removeEventListener('change', applyTheme);
        };
    }, [themeMode]);

    if (!isAuthenticated) {
        return (
            <div className="flex h-screen items-center justify-center bg-[var(--app-bg)] px-4">
                <form
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (isAuthLoading) {
                            return;
                        }

                        if (authMode === 'login') {
                            await login(username, password);
                        } else {
                            await register(username, password);
                        }
                    }}
                    className="w-full max-w-sm rounded-3xl border border-[var(--panel-border)] bg-[var(--panel-bg)] p-5 shadow-lg"
                >
                    <h1 className="text-lg font-semibold text-[var(--text-main)]">AgentEvo 登录</h1>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">登录后可同步你的会话和设置。</p>

                    <input
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        placeholder="用户名"
                        className="mt-4 w-full rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-2 text-sm outline-none"
                    />
                    <input
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="密码"
                        className="mt-2 w-full rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] px-3 py-2 text-sm outline-none"
                    />

                    {authError && <p className="mt-2 text-xs text-red-500">{authError}</p>}

                    <button
                        type="submit"
                        disabled={isAuthLoading}
                        className="mt-4 w-full rounded-xl bg-[#111827] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                        {isAuthLoading ? '处理中...' : authMode === 'login' ? '登录' : '注册并登录'}
                    </button>

                    <button
                        type="button"
                        onClick={() => setAuthMode((prev) => (prev === 'login' ? 'register' : 'login'))}
                        className="mt-2 w-full text-xs text-[var(--text-muted)]"
                    >
                        {authMode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}
                    </button>
                </form>
            </div>
        );
    }

    return (
        <div className="flex h-screen overflow-hidden bg-[var(--app-bg)] text-[var(--text-main)] transition-colors">
            <SettingsModal />
            <EvalDashboard />
            <ObservabilityPanel />
            <Sidebar className="hidden md:flex" />

            {sidebarOpen && (
                <div className="fixed inset-0 z-40 md:hidden">
                    <div
                        className="absolute inset-0 bg-black/45"
                        onClick={() => setSidebarOpen(false)}
                    />
                    <Sidebar
                        className="relative z-50 h-full"
                        onAfterSelect={() => setSidebarOpen(false)}
                    />
                </div>
            )}

            <section className="relative flex min-w-0 flex-1 flex-col">
                <header className="border-b border-[var(--panel-border)] bg-[var(--app-bg)]/90 px-3 py-3 backdrop-blur sm:px-6">
                    <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 text-sm">
                        <button
                            type="button"
                            onClick={() => setSidebarOpen(true)}
                            className="rounded-xl border border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--text-main)] shadow-sm md:hidden"
                        >
                            会话
                        </button>
                        <span className="font-semibold tracking-wide text-[var(--brand)]">AgentEvo</span>
                        <div className="hidden items-center gap-3 sm:flex">
                            <button
                                type="button"
                                onClick={() => setShowShortcuts(true)}
                                className="text-xs text-[var(--text-muted)]"
                                aria-keyshortcuts="Control+Slash Meta+Slash"
                            >
                                快捷键
                            </button>
                            <span className="text-xs text-[var(--text-muted)]">{user?.username}</span>
                            <button
                                type="button"
                                onClick={logout}
                                className="rounded-lg border border-[var(--panel-border)] px-2 py-1 text-xs text-[var(--text-muted)]"
                            >
                                退出
                            </button>
                        </div>
                    </div>
                </header>

                <main className="flex-1 overflow-hidden px-2 pb-3 pt-4 sm:px-6">
                    <ChatList />
                </main>

                <ChatInput />
            </section>

            {showShortcuts && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3" onClick={(event) => {
                    if (event.target === event.currentTarget) {
                        setShowShortcuts(false);
                    }
                }}>
                    <div className="w-full max-w-md rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-bg)] p-4">
                        <h3 className="text-sm font-semibold">快捷键</h3>
                        <ul className="mt-3 space-y-2 text-xs text-[var(--text-muted)]">
                            <li>Ctrl/⌘ + K: 聚焦输入框</li>
                            <li>Ctrl/⌘ + /: 打开快捷键面板</li>
                            <li>Enter: 发送消息</li>
                            <li>Shift + Enter: 换行</li>
                            <li>Esc: 关闭弹窗</li>
                        </ul>
                        <button
                            type="button"
                            onClick={() => setShowShortcuts(false)}
                            className="mt-4 rounded-lg bg-[#111827] px-3 py-1.5 text-xs font-semibold text-white"
                        >
                            我知道了
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
