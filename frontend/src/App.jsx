import { useEffect, useState } from 'react';
import ChatInput from './components/ChatInput';
import ChatList from './components/ChatList';
import SettingsModal from './components/SettingsModal';
import Sidebar from './components/Sidebar';
import EvalDashboard from './components/EvalDashboard';
import ObservabilityPanel from './components/ObservabilityPanel';
import WelcomePanel from './components/WelcomePanel';
import { useChatStore } from './store/chatStore';

function AmbientBackground() {
    return (
        <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
            <div
                className="ambient-blob -left-[12%] -top-[16%] h-[46vmax] w-[46vmax] animate-blob-drift"
                style={{ background: 'var(--blob-1)' }}
            />
            <div
                className="ambient-blob -right-[14%] top-[16%] h-[38vmax] w-[38vmax] animate-blob-drift [animation-delay:-7s]"
                style={{ background: 'var(--blob-2)' }}
            />
            <div
                className="ambient-blob -bottom-[20%] left-[18%] h-[42vmax] w-[42vmax] animate-blob-drift [animation-delay:-13s]"
                style={{ background: 'var(--blob-3)' }}
            />
        </div>
    );
}

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
    const sessions = useChatStore((state) => state.sessions);
    const currentSessionId = useChatStore((state) => state.currentSessionId);
    const messages = useChatStore((state) => state.messages);
    const isSessionLoading = useChatStore((state) => state.isSessionLoading);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [showShortcuts, setShowShortcuts] = useState(false);
    const [activeView, setActiveView] = useState('chat');
    const [suggestedPrompt, setSuggestedPrompt] = useState('');
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
        const media = typeof window.matchMedia === 'function'
            ? window.matchMedia('(prefers-color-scheme: dark)')
            : { matches: false };

        const applyTheme = () => {
            const resolved = themeMode === 'system'
                ? (media.matches ? 'dark' : 'light')
                : themeMode;

            root.classList.toggle('dark', resolved === 'dark');
        };

        applyTheme();
        if (typeof media.addEventListener === 'function') {
            media.addEventListener('change', applyTheme);
        } else if (typeof media.addListener === 'function') {
            media.addListener(applyTheme);
        }

        return () => {
            if (typeof media.removeEventListener === 'function') {
                media.removeEventListener('change', applyTheme);
            } else if (typeof media.removeListener === 'function') {
                media.removeListener(applyTheme);
            }
        };
    }, [themeMode]);

    const currentSession = sessions.find((session) => session.id === currentSessionId);
    const messageSearchKeyword = useChatStore((state) => state.messageSearchKeyword);
    const hasConversation = messages.some((message) => message.id !== 'init');
    const showWelcome = activeView === 'chat'
        && !hasConversation
        && !isSessionLoading
        && !String(messageSearchKeyword || '').trim();
    const viewTitle = activeView === 'eval'
        ? '评估与优化'
        : activeView === 'observability'
            ? '运行观测'
            : currentSession?.title || '新对话';

    if (isAuthLoading) {
        return (
            <div className="flex h-screen items-center justify-center px-4">
                <AmbientBackground />
                <div className="glass glass-fade-in relative z-10 rounded-3xl px-6 py-5 text-sm text-[var(--text-muted)]">
                    正在检查登录状态...
                </div>
            </div>
        );
    }

    if (!isAuthenticated) {
        return (
            <div className="flex h-screen items-center justify-center px-4">
                <AmbientBackground />
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
                    className="glass glass-fade-in relative z-10 w-full max-w-sm rounded-3xl p-6"
                >
                    <h1 className="gradient-text text-xl font-extrabold">AgentEvo</h1>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                        {authMode === 'login' ? '登录后可同步你的会话和设置。' : '创建账号并开始使用 AgentEvo。'}
                    </p>

                    <input
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        placeholder="用户名"
                        className="mt-4 w-full rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-3 py-2 text-sm text-[var(--text-main)] outline-none transition focus:border-[var(--glass-border-active)]"
                    />
                    <input
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="密码"
                        className="mt-2 w-full rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-3 py-2 text-sm text-[var(--text-main)] outline-none transition focus:border-[var(--glass-border-active)]"
                    />

                    {authError && <p className="mt-2 text-xs text-red-500">{authError}</p>}

                    <button
                        type="submit"
                        disabled={isAuthLoading}
                        className="btn-gradient mt-4 w-full rounded-xl px-3 py-2 text-sm font-semibold disabled:opacity-60"
                    >
                        {isAuthLoading ? '处理中...' : authMode === 'login' ? '登录' : '注册并登录'}
                    </button>

                    <button
                        type="button"
                        onClick={() => setAuthMode((prev) => (prev === 'login' ? 'register' : 'login'))}
                        className="mt-2 w-full text-xs text-[var(--text-muted)] transition hover:text-[var(--text-main)]"
                    >
                        {authMode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}
                    </button>
                </form>
            </div>
        );
    }

    const changeView = (nextView) => {
        setActiveView(nextView);
        setSuggestedPrompt('');
        setSidebarOpen(false);
    };

    return (
        <div className="app-shell text-[var(--text-main)] transition-colors">
            <AmbientBackground />
            <SettingsModal />
            <Sidebar
                activeView={activeView}
                onViewChange={changeView}
                className="relative z-10 hidden md:flex"
            />

            {sidebarOpen && (
                <div className="fixed inset-0 z-40 md:hidden">
                    <div
                        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
                        onClick={() => setSidebarOpen(false)}
                    />
                    <Sidebar
                        activeView={activeView}
                        onViewChange={changeView}
                        className="relative z-50 h-full"
                        onAfterSelect={() => setSidebarOpen(false)}
                    />
                </div>
            )}

            <section className="workspace relative z-10">
                <header className="workspace-header">
                    <div className="workspace-header-inner">
                        <div className="flex min-w-0 items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setSidebarOpen(true)}
                                className="icon-button md:hidden"
                                aria-label="打开导航"
                            >
                                <span aria-hidden="true">☰</span>
                            </button>
                            <div className="hidden items-center gap-2 md:flex">
                                <span className="brand-dot" aria-hidden="true">✦</span>
                                <span className="text-sm font-extrabold tracking-tight">AgentEvo</span>
                            </div>
                            <span className="header-divider hidden md:block" aria-hidden="true" />
                            <span className="truncate text-sm font-semibold text-[var(--text-main)]">{viewTitle}</span>
                        </div>
                        <div className="flex items-center gap-2 sm:gap-3">
                            <button
                                type="button"
                                onClick={() => setShowShortcuts(true)}
                                className="header-link hidden sm:inline-flex"
                                aria-keyshortcuts="Control+Slash Meta+Slash"
                            >
                                快捷键
                            </button>
                            <span className="user-chip">
                                <span className="status-dot" aria-hidden="true" />
                                <span className="hidden sm:inline">{user?.username}</span>
                            </span>
                            <button type="button" onClick={logout} className="header-link">退出</button>
                        </div>
                    </div>
                </header>

                {activeView === 'chat' ? (
                    <>
                        <main className="chat-main">
                            {!hasConversation && !isSessionLoading && (
                                <WelcomePanel
                                    userName={user?.username}
                                    onSuggestion={setSuggestedPrompt}
                                />
                            )}
                            <ChatList hideInitialPlaceholder={showWelcome} />
                        </main>
                        <ChatInput
                            suggestedPrompt={suggestedPrompt}
                            onSuggestedPromptConsumed={() => setSuggestedPrompt('')}
                        />
                    </>
                ) : activeView === 'eval' ? (
                    <main className="tool-workspace"><EvalDashboard embedded onBack={() => changeView('chat')} /></main>
                ) : (
                    <main className="tool-workspace"><ObservabilityPanel embedded onBack={() => changeView('chat')} /></main>
                )}
            </section>

            {showShortcuts && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-3 backdrop-blur-sm" onClick={(event) => {
                    if (event.target === event.currentTarget) {
                        setShowShortcuts(false);
                    }
                }}>
                    <div className="glass glass-fade-in w-full max-w-md rounded-2xl p-4">
                        <h3 className="text-sm font-semibold text-[var(--text-main)]">快捷键</h3>
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
                            className="btn-gradient mt-4 rounded-lg px-3 py-1.5 text-xs font-semibold"
                        >
                            我知道了
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
