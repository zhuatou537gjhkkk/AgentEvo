import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
    fetchChatStream,
    fetchSessions,
    createSession,
    fetchMessagesBySession,
    updateSessionTitle,
    deleteSession as deleteSessionApi,
    updateSessionPin,
    registerAuth,
    loginAuth,
    fetchMe,
    setAuthToken,
    createSessionBranch,
    deleteMessagePair,
    sendUserAnswer,
} from '../api/chat';
import { createToolExecutionStateMachine, ToolStatus } from '../utils/toolExecutionStateMachine';

// 模块级 Map：存储活跃 FSM 及其 syncToolLogs，用于 stop 时立即取消工具
// 不能放 Zustand state（非序列化对象会被 persist 中间件丢弃）
const activeToolCleanupMap = new Map();

const initialMessage = {
    id: 'init',
    role: 'assistant',
    content: '你好，我是你的 AI 助手，有什么可以帮你的吗？',
};

const DEFAULT_SESSION_TITLE = '新对话';
const DEFAULT_SYSTEM_PROMPT = '你是一个有用的 AI 助手。';
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_VOICE_RATE = 1;
const DEFAULT_VOICE_VOLUME = 1;
const DEFAULT_THEME_MODE = 'system';
const AUTH_STORAGE_KEY = 'chat-agent-auth-token';

function readStoredAuthToken() {
    if (typeof window === 'undefined') {
        return '';
    }

    return String(window.localStorage.getItem(AUTH_STORAGE_KEY) || '');
}

function sanitizeSpeechText(text) {
    const source = String(text || '');

    return source
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^[\s>*#-]+/gm, '')
        .replace(/[>*#`*_~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function playVoice(text, options = {}) {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
        return;
    }

    const cleanText = sanitizeSpeechText(text);
    if (!cleanText) {
        return;
    }

    const state = useChatStore.getState?.();
    const messageId = options?.messageId || null;
    const nextRate = normalizeVoiceRate(state?.voiceRate);
    const nextVolume = normalizeVoiceVolume(state?.voiceVolume);
    const nextVoiceName = state?.voiceName || '';

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = 'zh-CN';
    utterance.rate = nextRate;
    utterance.volume = nextVolume;

    const resolvedVoice = resolveVoiceByName(nextVoiceName);
    if (resolvedVoice) {
        utterance.voice = resolvedVoice;
        utterance.lang = resolvedVoice.lang || 'zh-CN';
    }

    if (useChatStore.setState) {
        useChatStore.setState({ speakingMessageId: messageId });
    }

    utterance.onend = () => {
        const latest = useChatStore.getState?.();
        if (!useChatStore.setState) {
            return;
        }

        if ((latest?.speakingMessageId || null) === messageId) {
            useChatStore.setState({ speakingMessageId: null });
        }
    };

    utterance.onerror = () => {
        const latest = useChatStore.getState?.();
        if (!useChatStore.setState) {
            return;
        }

        if ((latest?.speakingMessageId || null) === messageId) {
            useChatStore.setState({ speakingMessageId: null });
        }
    };

    window.speechSynthesis.speak(utterance);
}

export function stopVoice() {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
        return;
    }

    window.speechSynthesis.cancel();

    if (useChatStore.setState) {
        useChatStore.setState({ speakingMessageId: null });
    }
}

function normalizeVoiceRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value)) {
        return DEFAULT_VOICE_RATE;
    }

    return Math.max(0.5, Math.min(2, value));
}

function normalizeVoiceVolume(volume) {
    const value = Number(volume);
    if (!Number.isFinite(value)) {
        return DEFAULT_VOICE_VOLUME;
    }

    return Math.max(0, Math.min(1, value));
}

function resolveVoiceByName(voiceName) {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
        return null;
    }

    const voices = window.speechSynthesis.getVoices() || [];
    if (voices.length === 0) {
        return null;
    }

    if (voiceName) {
        const matched = voices.find((voice) => voice.name === voiceName);
        if (matched) {
            return matched;
        }
    }

    const zhVoice = voices.find((voice) => String(voice.lang || '').toLowerCase().startsWith('zh'));
    if (zhVoice) {
        return zhVoice;
    }

    return null;
}

function normalizeTemperatureValue(temp) {
    const value = Number(temp);
    if (!Number.isFinite(value)) {
        return DEFAULT_TEMPERATURE;
    }

    return Math.max(0, Math.min(1, value));
}

function createDefaultAgentSettings() {
    return {
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        temperature: DEFAULT_TEMPERATURE,
    };
}

function toSessionPreviewTitle(content) {
    const normalized = String(content || '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return DEFAULT_SESSION_TITLE;
    }

    return normalized.slice(0, 18);
}

function resolveThemeValue(mode) {
    if (mode === 'dark' || mode === 'light') {
        return mode;
    }

    if (typeof window === 'undefined' || !window.matchMedia) {
        return 'light';
    }

    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function createMarkdownExportContent(sessionTitle, messages) {
    const safeTitle = String(sessionTitle || DEFAULT_SESSION_TITLE).trim() || DEFAULT_SESSION_TITLE;
    const lines = [
        `# ${safeTitle}`,
        '',
        `导出时间: ${new Date().toLocaleString()}`,
        '',
        '---',
        '',
    ];

    const list = Array.isArray(messages) ? messages : [];
    for (const message of list) {
        if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
            continue;
        }

        const roleLabel = message.role === 'user' ? '用户' : '助手';
        lines.push(`## ${roleLabel}`);
        lines.push('');
        lines.push(String(message.content || '').trim() || '(空消息)');
        lines.push('');
    }

    return `${lines.join('\n').trim()}\n`;
}

function toExportFileName(title) {
    const safeTitle = String(title || DEFAULT_SESSION_TITLE)
        .trim()
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, ' ')
        .slice(0, 48) || DEFAULT_SESSION_TITLE;
    const now = new Date();
    const stamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        '-',
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
    ].join('');

    return `${safeTitle}-${stamp}.md`;
}

function downloadMarkdownFile(fileName, content) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
}

function isDefaultSessionTitle(title) {
    return !title || title === DEFAULT_SESSION_TITLE;
}

function sortSessions(sessions) {
    return [...sessions].sort((a, b) => {
        const aPinned = Number(a.pinned || 0);
        const bPinned = Number(b.pinned || 0);
        if (aPinned !== bPinned) {
            return bPinned - aPinned;
        }

        const aPinnedAt = new Date(a.pinned_at || 0).getTime();
        const bPinnedAt = new Date(b.pinned_at || 0).getTime();
        if (aPinnedAt !== bPinnedAt) {
            return bPinnedAt - aPinnedAt;
        }

        const aTime = new Date(a.updated_at || a.created_at || 0).getTime();
        const bTime = new Date(b.updated_at || b.created_at || 0).getTime();
        return bTime - aTime;
    });
}

export const useChatStore = create(persist((set, get) => ({
    sessions: [],
    currentSessionId: null,
    hasInitializedSessions: false,
    activeSessionRequestId: null,
    isSessionLoading: false,
    isCreatingSession: false,
    sessionError: '',
    activeAbortController: null,
    activeStreamToken: null,
    lastFailedUserMessage: '',
    lastFailedRequest: null,
    messages: [initialMessage],
    isTyping: false,
    selectedImage: null,
    enableWebSearch: false,
    planMode: false,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    temperature: DEFAULT_TEMPERATURE,
    sessionAgentSettings: {},
    isSettingsOpen: false,
    isVoiceEnabled: false,
    voiceRate: DEFAULT_VOICE_RATE,
    voiceVolume: DEFAULT_VOICE_VOLUME,
    voiceName: '',
    speakingMessageId: null,
    themeMode: DEFAULT_THEME_MODE,
    mcpServers: [],
    isExporting: false,
    sessionDrafts: {},
    messageSearchKeyword: '',
    authToken: readStoredAuthToken(),
    user: null,
    isAuthenticated: false,
    isAuthLoading: false,
    authError: '',
    setEnableWebSearch: (enabled) => {
        set((state) => {
            const nextValue = typeof enabled === 'function'
                ? enabled(state.enableWebSearch)
                : enabled;

            return { enableWebSearch: Boolean(nextValue) };
        });
    },
    setPlanMode: (enabled) => {
        set((state) => {
            const nextValue = typeof enabled === 'function'
                ? enabled(state.planMode)
                : enabled;

            return { planMode: Boolean(nextValue) };
        });
    },
    setSelectedImage: (payload) => {
        set({ selectedImage: payload || null });
    },
    clearSelectedImage: () => {
        set({ selectedImage: null });
    },
    setSystemPrompt: (prompt) => {
        const nextPrompt = String(prompt ?? '');

        set((state) => {
            const sessionId = state.currentSessionId;
            if (!sessionId) {
                return { systemPrompt: nextPrompt };
            }

            const sessionSettings = state.sessionAgentSettings[sessionId] || createDefaultAgentSettings();

            return {
                systemPrompt: nextPrompt,
                sessionAgentSettings: {
                    ...state.sessionAgentSettings,
                    [sessionId]: {
                        ...sessionSettings,
                        systemPrompt: nextPrompt,
                    },
                },
            };
        });
    },
    setTemperature: (temp) => {
        const normalized = normalizeTemperatureValue(temp);

        set((state) => {
            const sessionId = state.currentSessionId;
            if (!sessionId) {
                return { temperature: normalized };
            }

            const sessionSettings = state.sessionAgentSettings[sessionId] || createDefaultAgentSettings();

            return {
                temperature: normalized,
                sessionAgentSettings: {
                    ...state.sessionAgentSettings,
                    [sessionId]: {
                        ...sessionSettings,
                        temperature: normalized,
                    },
                },
            };
        });
    },
    resetCurrentSessionSettings: () => {
        set((state) => {
            const nextDefault = createDefaultAgentSettings();
            const sessionId = state.currentSessionId;

            if (!sessionId) {
                return {
                    systemPrompt: nextDefault.systemPrompt,
                    temperature: nextDefault.temperature,
                };
            }

            return {
                systemPrompt: nextDefault.systemPrompt,
                temperature: nextDefault.temperature,
                sessionAgentSettings: {
                    ...state.sessionAgentSettings,
                    [sessionId]: nextDefault,
                },
            };
        });
    },
    toggleSettings: () => {
        set((state) => ({ isSettingsOpen: !state.isSettingsOpen }));
    },
    toggleVoice: () => {
        set((state) => ({ isVoiceEnabled: !state.isVoiceEnabled }));
    },
    setVoiceRate: (rate) => {
        set({ voiceRate: normalizeVoiceRate(rate) });
    },
    setVoiceVolume: (volume) => {
        set({ voiceVolume: normalizeVoiceVolume(volume) });
    },
    setVoiceName: (voiceName) => {
        set({ voiceName: String(voiceName || '') });
    },
    setThemeMode: (mode) => {
        const nextMode = ['light', 'dark', 'system'].includes(mode) ? mode : DEFAULT_THEME_MODE;
        set({ themeMode: nextMode });
    },
    // ── Phase 3: MCP Server 管理 ──
    addMcpServer: (server) => {
        set((state) => ({
            mcpServers: [...state.mcpServers, { ...server, connected: false }],
        }));
    },
    removeMcpServer: (name) => {
        set((state) => ({
            mcpServers: state.mcpServers.filter((s) => s.name !== name),
        }));
    },
    toggleMcpServer: (name) => {
        set((state) => ({
            mcpServers: state.mcpServers.map((s) =>
                s.name === name ? { ...s, enabled: !s.enabled } : s
            ),
        }));
    },
    updateMcpServerStatus: (name, connected) => {
        set((state) => ({
            mcpServers: state.mcpServers.map((s) =>
                s.name === name ? { ...s, connected } : s
            ),
        }));
    },
    setMessageSearchKeyword: (keyword) => {
        set({ messageSearchKeyword: String(keyword || '') });
    },
    initAuth: async () => {
        const token = String(get().authToken || '');

        if (!token) {
            setAuthToken('');
            set({
                user: null,
                isAuthenticated: false,
                isAuthLoading: false,
            });
            return;
        }

        set({ isAuthLoading: true, authError: '' });
        setAuthToken(token);

        try {
            const data = await fetchMe();
            set({
                user: data?.user || null,
                isAuthenticated: Boolean(data?.user),
                isAuthLoading: false,
                authError: '',
            });
        } catch (error) {
            setAuthToken('');
            set({
                authToken: '',
                user: null,
                isAuthenticated: false,
                isAuthLoading: false,
                authError: '登录状态已过期，请重新登录。',
                sessions: [],
                currentSessionId: null,
                hasInitializedSessions: false,
                messages: [initialMessage],
            });
        }
    },
    register: async (username, password) => {
        const safeUsername = String(username || '').trim();
        const safePassword = String(password || '');

        if (safeUsername.length < 3 || safePassword.length < 6) {
            set({ authError: '用户名至少 3 位，密码至少 6 位。' });
            return false;
        }

        set({ isAuthLoading: true, authError: '' });

        try {
            const data = await registerAuth(safeUsername, safePassword);
            const token = String(data?.token || '');
            setAuthToken(token);

            set({
                authToken: token,
                user: data?.user || null,
                isAuthenticated: Boolean(data?.user),
                isAuthLoading: false,
                authError: '',
                hasInitializedSessions: false,
                sessions: [],
                currentSessionId: null,
                messages: [initialMessage],
            });
            return true;
        } catch (error) {
            set({
                isAuthLoading: false,
                authError: error?.message || '注册失败，请稍后重试。',
            });
            return false;
        }
    },
    login: async (username, password) => {
        const safeUsername = String(username || '').trim();
        const safePassword = String(password || '');

        if (!safeUsername || !safePassword) {
            set({ authError: '请输入用户名和密码。' });
            return false;
        }

        set({ isAuthLoading: true, authError: '' });

        try {
            const data = await loginAuth(safeUsername, safePassword);
            const token = String(data?.token || '');
            setAuthToken(token);

            set({
                authToken: token,
                user: data?.user || null,
                isAuthenticated: Boolean(data?.user),
                isAuthLoading: false,
                authError: '',
                hasInitializedSessions: false,
                sessions: [],
                currentSessionId: null,
                messages: [initialMessage],
            });
            return true;
        } catch (error) {
            set({
                isAuthLoading: false,
                authError: error?.message || '登录失败，请稍后重试。',
            });
            return false;
        }
    },
    logout: () => {
        setAuthToken('');

        set({
            authToken: '',
            user: null,
            isAuthenticated: false,
            hasInitializedSessions: false,
            sessions: [],
            currentSessionId: null,
            messages: [initialMessage],
            sessionError: '',
            authError: '',
        });
    },
    getCurrentDraft: () => {
        const state = get();
        const sessionId = state.currentSessionId;

        if (!sessionId) {
            return '';
        }

        return String(state.sessionDrafts?.[sessionId] || '');
    },
    setCurrentDraft: (draft) => {
        const content = String(draft || '');

        set((state) => {
            const sessionId = state.currentSessionId;
            if (!sessionId) {
                return {};
            }

            return {
                sessionDrafts: {
                    ...state.sessionDrafts,
                    [sessionId]: content,
                },
            };
        });
    },
    clearCurrentDraft: () => {
        set((state) => {
            const sessionId = state.currentSessionId;
            if (!sessionId || !state.sessionDrafts?.[sessionId]) {
                return {};
            }

            return {
                sessionDrafts: {
                    ...state.sessionDrafts,
                    [sessionId]: '',
                },
            };
        });
    },
    getResolvedTheme: () => resolveThemeValue(get().themeMode),
    exportCurrentSessionMarkdown: async () => {
        if (get().isExporting) {
            return;
        }

        const state = get();
        const sessionId = state.currentSessionId;
        if (!sessionId) {
            return;
        }

        set({ isExporting: true });

        try {
            const history = await fetchMessagesBySession(sessionId);
            const sourceMessages = history.length > 0 ? history : state.messages;
            const session = state.sessions.find((item) => item.id === sessionId);
            const title = session?.title || DEFAULT_SESSION_TITLE;
            const markdown = createMarkdownExportContent(title, sourceMessages);
            downloadMarkdownFile(toExportFileName(title), markdown);
            set({ sessionError: '' });
        } catch (error) {
            set({ sessionError: '导出失败，请稍后重试。' });
        } finally {
            set({ isExporting: false });
        }
    },
    initSessions: async () => {
        const state = get();

        if (!state.isAuthenticated || !state.authToken) {
            return;
        }

        setAuthToken(state.authToken);

        if (state.isSessionLoading) {
            return;
        }

        if (state.hasInitializedSessions && state.sessions.length > 0) {
            return;
        }

        set({
            isSessionLoading: true,
            sessionError: '',
        });

        try {
            const list = await fetchSessions();

            if (list.length === 0) {
                const id = await createSession('新对话');
                const session = {
                    id,
                    title: DEFAULT_SESSION_TITLE,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                };

                const initialSettings = createDefaultAgentSettings();

                set({
                    hasInitializedSessions: true,
                    sessions: [session],
                    currentSessionId: id,
                    messages: [initialMessage],
                    systemPrompt: initialSettings.systemPrompt,
                    temperature: initialSettings.temperature,
                    sessionAgentSettings: {
                        ...get().sessionAgentSettings,
                        [id]: initialSettings,
                    },
                    sessionError: '',
                });
                return;
            }

            const currentId = list[0].id;
            const history = await fetchMessagesBySession(currentId);
            const nextAgentSettings = { ...get().sessionAgentSettings };

            for (const session of list) {
                if (!nextAgentSettings[session.id]) {
                    nextAgentSettings[session.id] = createDefaultAgentSettings();
                }
            }

            const currentAgentSettings = nextAgentSettings[currentId] || createDefaultAgentSettings();

            set({
                hasInitializedSessions: true,
                sessions: list,
                currentSessionId: currentId,
                messages: history.length > 0 ? history : [initialMessage],
                systemPrompt: currentAgentSettings.systemPrompt,
                temperature: currentAgentSettings.temperature,
                sessionAgentSettings: nextAgentSettings,
                sessionError: '',
            });
        } catch (error) {
            set({
                hasInitializedSessions: false,
                sessions: [],
                currentSessionId: null,
                messages: [initialMessage],
                sessionError: '初始化会话失败，请点击重试。',
            });
        } finally {
            set({ isSessionLoading: false });
        }
    },
    switchSession: async (id) => {
        const requestId = `${id}-${Date.now()}`;

        set({
            currentSessionId: id,
            activeSessionRequestId: requestId,
            isSessionLoading: true,
            isTyping: false,
            messageSearchKeyword: '',
            sessionError: '',
        });

        try {
            const history = await fetchMessagesBySession(id);

            const state = get();
            if (state.activeSessionRequestId !== requestId || state.currentSessionId !== id) {
                return;
            }

            set({
                messages: history.length > 0 ? history : [initialMessage],
                systemPrompt: (() => {
                    const saved = state.sessionAgentSettings[id];
                    return saved ? saved.systemPrompt : DEFAULT_SYSTEM_PROMPT;
                })(),
                temperature: (() => {
                    const saved = state.sessionAgentSettings[id];
                    return saved ? normalizeTemperatureValue(saved.temperature) : DEFAULT_TEMPERATURE;
                })(),
                sessionAgentSettings: (() => {
                    if (state.sessionAgentSettings[id]) {
                        return state.sessionAgentSettings;
                    }

                    return {
                        ...state.sessionAgentSettings,
                        [id]: createDefaultAgentSettings(),
                    };
                })(),
            });
        } catch (error) {
            const state = get();
            if (state.activeSessionRequestId !== requestId || state.currentSessionId !== id) {
                return;
            }

            set({
                messages: [
                    {
                        id: `error-${Date.now()}`,
                        role: 'assistant',
                        content: '加载会话失败，请稍后重试。',
                    },
                ],
                sessionError: '加载会话失败，请重试。',
            });
        } finally {
            const state = get();
            if (state.activeSessionRequestId === requestId) {
                set({
                    isSessionLoading: false,
                    activeSessionRequestId: null,
                });
            }
        }
    },
    addNewSession: async () => {
        if (get().isCreatingSession) {
            return;
        }

        set({
            isCreatingSession: true,
            sessionError: '',
        });

        try {
            const id = await createSession('新对话');
            const newSession = {
                id,
                title: DEFAULT_SESSION_TITLE,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            };
            const defaultSettings = createDefaultAgentSettings();

            set((state) => ({
                systemPrompt: defaultSettings.systemPrompt,
                temperature: defaultSettings.temperature,
                hasInitializedSessions: true,
                sessions: [newSession, ...state.sessions],
                currentSessionId: id,
                messages: [initialMessage],
                isTyping: false,
                sessionAgentSettings: {
                    ...state.sessionAgentSettings,
                    [id]: defaultSettings,
                },
                sessionError: '',
            }));
        } catch (error) {
            set({
                sessionError: '新建会话失败，请稍后重试。',
            });
        } finally {
            set({ isCreatingSession: false });
        }
    },
    renameSession: async (id, title) => {
        const safeTitle = String(title || '').trim();
        if (!safeTitle) {
            return;
        }

        try {
            await updateSessionTitle(id, safeTitle);
            set((state) => ({
                sessions: sortSessions(state.sessions.map((session) => {
                    if (session.id !== id) {
                        return session;
                    }

                    return {
                        ...session,
                        title: safeTitle,
                        updated_at: new Date().toISOString(),
                    };
                })),
                sessionError: '',
            }));
        } catch (error) {
            set({ sessionError: '重命名失败，请稍后重试。' });
        }
    },
    toggleSessionPin: async (id) => {
        const state = get();
        const target = state.sessions.find((session) => session.id === id);
        if (!target) {
            return;
        }

        const nextPinned = !Boolean(target.pinned);

        try {
            await updateSessionPin(id, nextPinned);
            set((current) => ({
                sessions: sortSessions(current.sessions.map((session) => {
                    if (session.id !== id) {
                        return session;
                    }

                    return {
                        ...session,
                        pinned: nextPinned ? 1 : 0,
                        pinned_at: nextPinned ? new Date().toISOString() : null,
                        updated_at: new Date().toISOString(),
                    };
                })),
                sessionError: '',
            }));
        } catch (error) {
            set({ sessionError: '置顶操作失败，请稍后重试。' });
        }
    },
    deleteSession: async (id) => {
        try {
            const stateBeforeDelete = get();

            if (stateBeforeDelete.currentSessionId === id && stateBeforeDelete.isTyping) {
                get().stopMessageStream();
            }

            await deleteSessionApi(id);

            const state = get();
            const remainingSessions = state.sessions.filter((session) => session.id !== id);

            if (remainingSessions.length === 0) {
                const newId = await createSession(DEFAULT_SESSION_TITLE);
                const fallbackSession = {
                    id: newId,
                    title: DEFAULT_SESSION_TITLE,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                };

                const defaultSettings = createDefaultAgentSettings();
                const nextSettingsMap = { ...state.sessionAgentSettings };
                const nextDrafts = { ...state.sessionDrafts };
                delete nextSettingsMap[id];
                delete nextDrafts[id];
                nextDrafts[newId] = '';
                nextSettingsMap[newId] = defaultSettings;

                set({
                    sessions: [fallbackSession],
                    currentSessionId: newId,
                    messages: [initialMessage],
                    systemPrompt: defaultSettings.systemPrompt,
                    temperature: defaultSettings.temperature,
                    sessionAgentSettings: nextSettingsMap,
                    sessionDrafts: nextDrafts,
                    sessionError: '',
                });
                return;
            }

            const nextSessionId =
                state.currentSessionId === id ? remainingSessions[0].id : state.currentSessionId;

            set((state) => {
                const nextSettingsMap = { ...state.sessionAgentSettings };
                const nextDrafts = { ...state.sessionDrafts };
                delete nextSettingsMap[id];
                delete nextDrafts[id];

                if (state.currentSessionId !== id) {
                    return {
                        sessions: sortSessions(remainingSessions),
                        currentSessionId: nextSessionId,
                        sessionAgentSettings: nextSettingsMap,
                        sessionDrafts: nextDrafts,
                        sessionError: '',
                    };
                }

                const activeSettings =
                    nextSettingsMap[nextSessionId] ||
                    createDefaultAgentSettings();

                if (!nextSettingsMap[nextSessionId]) {
                    nextSettingsMap[nextSessionId] = activeSettings;
                }

                return {
                    sessions: sortSessions(remainingSessions),
                    currentSessionId: nextSessionId,
                    systemPrompt: activeSettings.systemPrompt,
                    temperature: normalizeTemperatureValue(activeSettings.temperature),
                    sessionAgentSettings: nextSettingsMap,
                    sessionDrafts: nextDrafts,
                    sessionError: '',
                };
            });

            if (state.currentSessionId === id && nextSessionId) {
                await get().switchSession(nextSessionId);
            }
        } catch (error) {
            set({ sessionError: '删除会话失败，请稍后重试。' });
        }
    },
    stopMessageStream: () => {
        const state = get();
        const controller = state.activeAbortController;
        const streamToken = state.activeStreamToken;

        // 立即取消所有工具调用，不等 SSE error 回调异步触发
        if (streamToken) {
            const cleanup = activeToolCleanupMap.get(streamToken);
            if (cleanup) {
                cleanup.fsm.cancelAll();
                cleanup.syncToolLogs();
                activeToolCleanupMap.delete(streamToken);
            }
        }

        if (controller) {
            controller.abort();
            set({
                isTyping: false,
                activeAbortController: null,
                activeStreamToken: null,
            });
        }
    },
    retryLastFailedMessage: async () => {
        const failedRequest = get().lastFailedRequest;
        if (!failedRequest?.content || get().isTyping) {
            return;
        }

        await get().sendMessage(failedRequest.content, {
            enableWebSearch: get().enableWebSearch,
            imageId: failedRequest.imageId || null,
        });
    },
    retryMessageById: async (messageId) => {
        if (get().isTyping) {
            return;
        }

        const messages = get().messages;
        const targetIndex = messages.findIndex((item) => String(item.id) === String(messageId));
        if (targetIndex < 0) {
            return;
        }

        const target = messages[targetIndex];
        if (target.role === 'user') {
            await get().sendMessage(target.content, {
                enableWebSearch: get().enableWebSearch,
            });
            return;
        }

        for (let i = targetIndex - 1; i >= 0; i -= 1) {
            if (messages[i].role === 'user') {
                await get().sendMessage(messages[i].content, {
                    enableWebSearch: get().enableWebSearch,
                });
                return;
            }
        }
    },
    retryToolCall: async (toolCallId) => {
        if (get().isTyping) {
            return;
        }

        const messages = get().messages;
        let userMessage = null;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].role === 'user') {
                userMessage = messages[i];
                break;
            }
        }

        if (!userMessage?.content) {
            return;
        }

        await get().sendMessage(userMessage.content, {
            enableWebSearch: true,
        });
    },
    submitUserAnswer: async (questionId, answer) => {
        // 更新本地 questionLogs，标记为已提交
        const activeStreamToken = get().activeStreamToken;

        set((state) => ({
            messages: (() => {
                const nextMessages = [...state.messages];
                const tailIndex = nextMessages.length - 1;
                const tail = nextMessages[tailIndex];

                if (!tail || tail.role !== 'assistant') {
                    return state.messages;
                }

                const currentQuestionLogs = Array.isArray(tail.questionLogs)
                    ? [...tail.questionLogs]
                    : [];

                const updatedLogs = currentQuestionLogs.map((q) => {
                    if (q.questionId === questionId) {
                        return { ...q, isSubmitted: true, submittedAnswer: answer };
                    }
                    return q;
                });

                nextMessages[tailIndex] = {
                    ...tail,
                    questionLogs: updatedLogs,
                };

                return nextMessages;
            })(),
        }));

        // 调用后端 REST 端点 resolve deferred Promise → Agent 恢复执行
        try {
            const result = await sendUserAnswer(questionId, answer);
            if (!result?.ok) {
                console.warn(`[submitUserAnswer] question ${questionId} already resolved: ${result?.status}`);
            }
        } catch (err) {
            console.error(`[submitUserAnswer] failed for ${questionId}:`, err);
            // 回滚提交状态
            set((state) => ({
                messages: (() => {
                    const nextMessages = [...state.messages];
                    const tailIndex = nextMessages.length - 1;
                    const tail = nextMessages[tailIndex];

                    if (!tail || tail.role !== 'assistant') {
                        return state.messages;
                    }

                    const currentQuestionLogs = Array.isArray(tail.questionLogs)
                        ? [...tail.questionLogs]
                        : [];

                    const revertedLogs = currentQuestionLogs.map((q) => {
                        if (q.questionId === questionId) {
                            return { ...q, isSubmitted: false, submittedAnswer: null };
                        }
                        return q;
                    });

                    nextMessages[tailIndex] = {
                        ...tail,
                        questionLogs: revertedLogs,
                    };

                    return nextMessages;
                })(),
            }));
        }
    },
    createBranchFromMessage: async (messageId) => {
        if (get().isTyping) {
            return;
        }

        const state = get();
        const sessionId = state.currentSessionId;
        if (!sessionId) {
            return;
        }

        const messages = state.messages;
        const target = messages.find((item) => String(item.id) === String(messageId));
        if (!target) {
            return;
        }

        const sourceSession = state.sessions.find((item) => item.id === sessionId);
        const title = `${sourceSession?.title || DEFAULT_SESSION_TITLE} · 分支`;
        const numericMessageId = Number(messageId);
        if (!Number.isInteger(numericMessageId) || numericMessageId <= 0) {
            set({ sessionError: '该消息尚未入库，请稍后再分支。' });
            return;
        }

        try {
            const payload = await createSessionBranch(sessionId, {
                fromMessageId: numericMessageId,
                title,
            });

            const newSessionId = Number(payload?.id);
            if (!newSessionId) {
                return;
            }

            set((current) => ({
                sessions: sortSessions([
                    payload?.session || {
                        id: newSessionId,
                        title,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    },
                    ...current.sessions,
                ]),
                sessionError: '',
            }));

            await get().switchSession(newSessionId);
        } catch (error) {
            set({ sessionError: error?.message || '创建分支失败，请稍后重试。' });
        }
    },
    editUserMessageAndResend: async (messageId, editedContent) => {
        if (get().isTyping) {
            return;
        }

        const nextContent = String(editedContent || '').trim();
        if (!nextContent) {
            return;
        }

        const state = get();
        const sessionId = state.currentSessionId;
        if (!sessionId) {
            return;
        }

        const targetIndex = state.messages.findIndex((item) => String(item.id) === String(messageId));
        if (targetIndex < 0 || state.messages[targetIndex]?.role !== 'user') {
            return;
        }

        const numericMessageId = Number(messageId);
        if (!Number.isInteger(numericMessageId) || numericMessageId <= 0) {
            set({ sessionError: '该消息尚未入库，请稍后再编辑重发。' });
            return;
        }

        try {
            await deleteMessagePair(sessionId, numericMessageId);

            set((current) => ({
                messages: current.messages.filter((item, index) => {
                    if (String(item.id) === String(messageId) && item.role === 'user') {
                        return false;
                    }

                    const prev = current.messages[index - 1];
                    const isPairedAssistant =
                        item.role === 'assistant' &&
                        prev?.role === 'user' &&
                        String(prev.id) === String(messageId);

                    return !isPairedAssistant;
                }),
                sessionError: '',
            }));

            await get().sendMessage(nextContent, {
                enableWebSearch: get().enableWebSearch,
            });
        } catch (error) {
            set({ sessionError: error?.message || '编辑重发失败，请稍后重试。' });
        }
    },
    sendMessage: async (content, options = {}) => {
        const effectiveEnableWebSearch = options.enableWebSearch ?? get().enableWebSearch;
        const enableWebSearch = Boolean(effectiveEnableWebSearch);
        const planMode = Boolean(options.planMode ?? get().planMode);
        const state = useChatStore.getState();
        const sessionId = state.currentSessionId;
        const selectedImage = state.selectedImage;
        const selectedImageId = options.imageId ?? selectedImage?.imageId ?? null;

        const sessionSpecificSettings = sessionId
            ? state.sessionAgentSettings[sessionId]
            : null;
        const systemPrompt = sessionSpecificSettings?.systemPrompt ?? state.systemPrompt;
        const temperature = normalizeTemperatureValue(
            sessionSpecificSettings?.temperature ?? state.temperature
        );

        if (!sessionId) {
            return;
        }

        const userMessage = {
            id: `user-${Date.now()}`,
            role: 'user',
            content,
            enableWebSearch: Boolean(enableWebSearch),
        };

        const assistantMessageId = `assistant-${Date.now()}`;
        const assistantMessage = {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            toolLogs: [],
            thoughtLogs: [],
            taskProgress: [],
            enableWebSearch: Boolean(enableWebSearch),
        };

        const streamToken = `${sessionId}-${Date.now()}`;

        set((state) => ({
            messages: [...state.messages, userMessage, assistantMessage],
            isTyping: true,
            lastFailedUserMessage: '',
            sessions: sortSessions(
                state.sessions.map((session) => {
                    if (session.id !== sessionId) {
                        return session;
                    }

                    return {
                        ...session,
                        updated_at: new Date().toISOString(),
                    };
                })
            ),
        }));

        const currentSession = state.sessions.find((session) => session.id === sessionId);
        const hasUserMessage = state.messages.some((message) => message.role === 'user');

        if (!hasUserMessage && isDefaultSessionTitle(currentSession?.title)) {
            const generatedTitle = toSessionPreviewTitle(content);

            set((state) => ({
                sessions: state.sessions.map((session) => {
                    if (session.id !== sessionId) {
                        return session;
                    }

                    return {
                        ...session,
                        title: generatedTitle,
                    };
                }),
            }));

            updateSessionTitle(sessionId, generatedTitle).catch(() => {
                // Ignore title sync failures and keep chat flow responsive.
            });
        }

        const controller = new AbortController();
        let pendingAssistantChunk = '';
        let chunkFrameId = null;

        const flushPendingAssistantChunk = () => {
            if (!pendingAssistantChunk) {
                return;
            }

            const latest = get();
            if (latest.currentSessionId !== sessionId || latest.activeStreamToken !== streamToken) {
                pendingAssistantChunk = '';
                return;
            }

            const chunk = pendingAssistantChunk;
            pendingAssistantChunk = '';

            set((state) => ({
                messages: (() => {
                    const nextMessages = [...state.messages];
                    const tailIndex = nextMessages.length - 1;
                    const tail = nextMessages[tailIndex];

                    if (!tail || tail.role !== 'assistant') {
                        return state.messages;
                    }

                    nextMessages[tailIndex] = {
                        ...tail,
                        content: tail.content + chunk,
                    };

                    return nextMessages;
                })(),
            }));
        };

        const cancelChunkFrame = () => {
            if (chunkFrameId === null) {
                return;
            }

            cancelAnimationFrame(chunkFrameId);
            chunkFrameId = null;
        };

        const scheduleChunkFlush = () => {
            if (chunkFrameId !== null) {
                return;
            }

            chunkFrameId = requestAnimationFrame(() => {
                chunkFrameId = null;
                flushPendingAssistantChunk();
            });
        };

        // ── 创建本轮工具执行状态机 ─────────────────────
        const toolStateMachine = createToolExecutionStateMachine({
            timeoutMs: 60000,
            perToolTimeout: new Map([['web_search', 90000]]),
        });

        // ── 乱序结果缓存：tool_end/tool_error 先于 tool_start 到达时暂存 ──
        // 生命周期跟随本次 sendMessage 闭包，流结束后自动 GC，无需手动清理
        const toolResultCache = new Map();

        // ── 任务进度可视化：工具名→中文关键词模糊匹配 ─────────────────
        const TOOL_TASK_KEYWORDS = {
            web_search: ['搜索', '网络', '联网', '查找', '获取信息'],
            search_knowledge_base: ['知识库', '文档', '检索', 'RAG'],
            get_system_time: ['时间', '日期'],
            ask_user_question: ['询问', '提问', '确认', '选择'],
            update_todo: ['计划', '规划', '任务'],
        };

        /** 在 taskProgress 中找到匹配 toolName 的第一个活跃项（pending 或 in_progress）
         *
         *  BUG-P2-01 修复：原先只匹配 status==='pending'，但 tool_start 已将步骤
         *  改为 in_progress，导致 tool_end 回来时关键词匹配失败，误将其他 pending
         *  步骤标记为 completed。现在同时匹配 pending 和 in_progress 两个活跃态。
         */
        const matchToolToTask = (toolName, progress) => {
            if (!Array.isArray(progress) || progress.length === 0) return -1;
            const keywords = TOOL_TASK_KEYWORDS[toolName];
            if (keywords) {
                const keywordIdx = progress.findIndex(
                    (t) => (t.status === 'pending' || t.status === 'in_progress') && keywords.some((kw) => t.content.includes(kw))
                );
                if (keywordIdx >= 0) return keywordIdx;
            }
            // 兜底：返回第一个活跃项
            return progress.findIndex((t) => t.status === 'pending' || t.status === 'in_progress');
        };

        /** 更新 tail message 上单条 task 的状态 */
        const updateTaskStatus = (toolName, newStatus, activeForm) => {
            set((state) => ({
                messages: (() => {
                    const nextMessages = [...state.messages];
                    const tailIndex = nextMessages.length - 1;
                    const tail = nextMessages[tailIndex];
                    if (!tail || tail.role !== 'assistant') return state.messages;
                    const progress = [...(tail.taskProgress || [])];
                    if (progress.length === 0) return state.messages;
                    const idx = matchToolToTask(toolName, progress);
                    if (idx < 0) return state.messages;
                    progress[idx] = { ...progress[idx], status: newStatus };
                    if (activeForm) progress[idx] = { ...progress[idx], activeForm };
                    nextMessages[tailIndex] = { ...tail, taskProgress: progress };
                    return nextMessages;
                })(),
            }));
        };

        /** 合并写入 taskProgress 到 tail message
         *
         *  BUG-P2-01 修复：原先直接用 incoming 覆盖整个数组，但 Agent 调用
         *  update_todo 时可能只传部分步骤，导致其他步骤被删除。改为按 id 合并：
         *  已有步骤只更新 status，新步骤追加，未提及的步骤保留。
         */
        const syncTaskProgress = (incoming) => {
            set((state) => ({
                messages: (() => {
                    const nextMessages = [...state.messages];
                    const tailIndex = nextMessages.length - 1;
                    const tail = nextMessages[tailIndex];
                    if (!tail || tail.role !== 'assistant') return state.messages;

                    const existing = tail.taskProgress || [];
                    let merged;
                    if (!Array.isArray(incoming) || incoming.length === 0) {
                        merged = existing;
                    } else {
                        // 更新已有步骤的状态（按 id 匹配），保留 incoming 中不存在的步骤
                        merged = existing.map((existingStep) => {
                            const match = incoming.find((s) => s.id === existingStep.id);
                            return match
                                ? { ...existingStep, status: match.status || existingStep.status }
                                : existingStep;
                        });
                        // 追加 incoming 中有但 existing 中没有的新步骤
                        for (const step of incoming) {
                            if (!existing.some((e) => e.id === step.id)) {
                                merged.push(step);
                            }
                        }
                    }

                    nextMessages[tailIndex] = { ...tail, taskProgress: merged };
                    return nextMessages;
                })(),
            }));
        };

        const syncToolLogs = () => {
            const entries = toolStateMachine.getAll();
            const logs = entries.map((entry) => ({
                id: entry.id,
                name: entry.name,
                input: entry.input,
                output: entry.output,
                status: entry.status,
                error: entry.error,
                retryCount: entry.retryCount,
                startedAt: entry.startedAt,
                endedAt: entry.endedAt,
                agentName: entry.agentName || 'core',       // Phase 2: Agent 身份标识
                agentType: entry.agentType || 'react',       // Phase 2: Agent 类型标识
            }));

            set((state) => ({
                messages: (() => {
                    const nextMessages = [...state.messages];
                    const tailIndex = nextMessages.length - 1;
                    const tail = nextMessages[tailIndex];

                    if (!tail || tail.role !== 'assistant') {
                        return state.messages;
                    }

                    nextMessages[tailIndex] = {
                        ...tail,
                        toolLogs: logs,
                    };

                    return nextMessages;
                })(),
            }));
        };

        // 注册到模块级 Map，供 stopMessageStream 即时取消
        activeToolCleanupMap.set(streamToken, { fsm: toolStateMachine, syncToolLogs });

        set({
            activeAbortController: controller,
            activeStreamToken: streamToken,
            selectedImage: null,
        });

        await fetchChatStream(
            sessionId,
            content,
            (chunk) => {
                if (!chunk) {
                    return;
                }

                const latest = get();
                if (latest.currentSessionId !== sessionId || latest.activeStreamToken !== streamToken) {
                    return;
                }

                pendingAssistantChunk += chunk;
                scheduleChunkFlush();
            },
            (toolData) => {
                const latest = get();
                if (latest.currentSessionId !== sessionId || latest.activeStreamToken !== streamToken) {
                    return;
                }

                cancelChunkFrame();
                flushPendingAssistantChunk();

                // ── 通过状态机处理工具事件 (含乱序缓存配对) ──
                const toolCallId = toolData?.toolCallId || '';

                if (toolData?.type === 'tool_start') {
                    if (toolCallId) {
                        const toolStartedAt = toolData.at ? new Date(toolData.at).getTime() : undefined;
                        toolStateMachine.create(toolCallId, toolData.toolName || 'unknown', toolData.input, toolStartedAt);
                        toolStateMachine.start(toolCallId);

                        // Phase 2: 存储 Agent 身份到 FSM entry
                        if (toolData.agentName || toolData.agentType) {
                            const stored = toolStateMachine.get(toolCallId);
                            if (stored) {
                                stored.agentName = toolData.agentName;
                                stored.agentType = toolData.agentType || 'react';
                            }
                        }

                        // ask_user_question: 进入等待用户输入状态
                        if (toolData.toolName === 'ask_user_question') {
                            toolStateMachine.waitUser(toolCallId);
                        }

                        // 检查是否有先到达的缓存结果，自动配对
                        const cached = toolResultCache.get(toolCallId);
                        if (cached) {
                            toolResultCache.delete(toolCallId);
                            if (cached.type === 'tool_end') {
                                toolStateMachine.end(toolCallId, cached.output, cached.endedAt);
                            } else if (cached.type === 'tool_error') {
                                toolStateMachine.error(toolCallId, cached.error, cached.endedAt);
                            }
                        }
                    }
                    syncToolLogs();
                    // update_todo 是元工具（修改计划自身），不参与事件兜底匹配
                    // 它的进度通过 todo_updated SSE → syncTaskProgress 处理
                    if (toolData.toolName !== 'update_todo') {
                        updateTaskStatus(toolData.toolName || '', 'in_progress', toolData.activeForm || '');
                    }
                } else if (toolData?.type === 'tool_end') {
                    if (toolCallId) {
                        const toolEndedAt = toolData.at ? new Date(toolData.at).getTime() : undefined;
                        const entry = toolStateMachine.get(toolCallId);
                        if (entry) {
                            // 正常顺序：tool_start 已到达，直接更新
                            toolStateMachine.end(toolCallId, toolData.output, toolEndedAt);
                        } else {
                            // 乱序：tool_end 先于 tool_start 到达，缓存等待配对
                            toolResultCache.set(toolCallId, {
                                type: 'tool_end',
                                output: toolData.output,
                                endedAt: toolEndedAt,
                            });
                        }
                    }
                    syncToolLogs();
                    if (toolData.toolName !== 'update_todo') {
                        updateTaskStatus(toolData.toolName || '', 'completed');
                    }
                } else if (toolData?.type === 'tool_error') {
                    if (toolCallId) {
                        const toolEndedAt = toolData.at ? new Date(toolData.at).getTime() : undefined;
                        const entry = toolStateMachine.get(toolCallId);
                        if (entry) {
                            // 正常顺序：tool_start 已到达，直接更新
                            toolStateMachine.error(toolCallId, toolData.error || '工具执行异常', toolEndedAt);
                        } else {
                            // 乱序：tool_error 先于 tool_start 到达，缓存等待配对
                            toolResultCache.set(toolCallId, {
                                type: 'tool_error',
                                error: toolData.error || '工具执行异常',
                                endedAt: toolEndedAt,
                            });
                        }
                    }
                    syncToolLogs();
                    if (toolData.toolName !== 'update_todo') {
                        updateTaskStatus(toolData.toolName || '', 'error');
                    }
                } else if (toolData?.type === 'ask_user_question') {
                    // Agent 向用户提问
                    const questionId = toolData?.questionId;
                    const questionType = toolData?.questionType || 'text_input';
                    const question = toolData?.question || '';
                    const options = Array.isArray(toolData?.options) ? toolData.options : [];

                    if (questionId) {
                        // 添加 questionLogs 到 assistant 消息
                        set((state) => ({
                            messages: (() => {
                                const nextMessages = [...state.messages];
                                const tailIndex = nextMessages.length - 1;
                                const tail = nextMessages[tailIndex];

                                if (!tail || tail.role !== 'assistant') {
                                    return state.messages;
                                }

                                const currentQuestionLogs = Array.isArray(tail.questionLogs)
                                    ? [...tail.questionLogs]
                                    : [];

                                // 防重复：同一 questionId 不重复添加
                                if (!currentQuestionLogs.some((q) => q.questionId === questionId)) {
                                    currentQuestionLogs.push({
                                        questionId,
                                        question,
                                        questionType,
                                        options,
                                        status: 'pending',
                                        isSubmitted: false,
                                        submittedAnswer: null,
                                    });
                                }

                                nextMessages[tailIndex] = {
                                    ...tail,
                                    questionLogs: currentQuestionLogs,
                                };

                                return nextMessages;
                            })(),
                        }));

                    }
                } else if (toolData?.type === 'todo_updated') {
                    // Agent 更新任务计划
                    const todos = Array.isArray(toolData?.todos) ? toolData.todos : [];
                    if (todos.length > 0) {
                        const progress = todos.map((t) => ({
                            id: t.id || `task-${Math.random().toString(36).slice(2, 8)}`,
                            content: t.content || '',
                            activeForm: '',
                            status: t.status || 'pending',
                        }));
                        syncTaskProgress(progress);
                    }
                } else if (toolData?.type === 'thought' && toolData?.text) {
                    // 思考日志保持原有处理方式
                    set((state) => ({
                        messages: (() => {
                            const nextMessages = [...state.messages];
                            const tailIndex = nextMessages.length - 1;
                            const tail = nextMessages[tailIndex];

                            if (!tail || tail.role !== 'assistant') {
                                return state.messages;
                            }

                            const currentThoughtLogs = Array.isArray(tail.thoughtLogs) ? [...tail.thoughtLogs] : [];
                            currentThoughtLogs.push({
                                text: toolData.text,
                                status: toolData.status || 'running',
                                at: toolData.at || new Date().toISOString(),
                            });

                            nextMessages[tailIndex] = {
                                ...tail,
                                thoughtLogs: currentThoughtLogs,
                            };

                            return nextMessages;
                        })(),
                    }));
                } else if (toolData?.type === 'metrics') {
                    set((state) => ({
                        messages: (() => {
                            const nextMessages = [...state.messages];
                            const tailIndex = nextMessages.length - 1;
                            const tail = nextMessages[tailIndex];

                            if (!tail || tail.role !== 'assistant') {
                                return state.messages;
                            }

                            nextMessages[tailIndex] = {
                                ...tail,
                                metrics: {
                                    latency_ms: Number(toolData?.metrics?.latency_ms) || 0,
                                    prompt_tokens: Number(toolData?.metrics?.prompt_tokens) || 0,
                                    completion_tokens: Number(toolData?.metrics?.completion_tokens) || 0,
                                    total_tokens: Number(toolData?.metrics?.total_tokens) || 0,
                                    model: String(toolData?.metrics?.model || ''),
                                },
                            };

                            return nextMessages;
                        })(),
                    }));
                } else if (toolData?.type === 'agent_start' || toolData?.type === 'agent_end' || toolData?.type === 'agent_handoff') {
                    // Phase 2: 多 Agent 生命周期事件 → 写入 thoughtLogs
                    const agentText = toolData?.type === 'agent_start'
                        ? `Agent ${toolData.agentName || toolData.agentType || ''} 开始工作`
                        : toolData?.type === 'agent_end'
                            ? `Agent ${toolData.agentName || toolData.agentType || ''} 完成`
                            : `${toolData.from || '?'} → ${toolData.to || '?'}`;

                    set((state) => ({
                        messages: (() => {
                            const nextMessages = [...state.messages];
                            const tailIndex = nextMessages.length - 1;
                            const tail = nextMessages[tailIndex];

                            if (!tail || tail.role !== 'assistant') {
                                return state.messages;
                            }

                            const currentThoughtLogs = Array.isArray(tail.thoughtLogs) ? [...tail.thoughtLogs] : [];
                            currentThoughtLogs.push({
                                text: agentText,
                                status: toolData?.type === 'agent_end' ? 'done' : 'running',
                                at: toolData.at || new Date().toISOString(),
                            });

                            nextMessages[tailIndex] = {
                                ...tail,
                                thoughtLogs: currentThoughtLogs,
                            };

                            return nextMessages;
                        })(),
                    }));
                }
            },
            () => {
                const latest = get();
                if (latest.currentSessionId !== sessionId || latest.activeStreamToken !== streamToken) {
                    cancelChunkFrame();
                    pendingAssistantChunk = '';
                    // 清理状态机
                    activeToolCleanupMap.delete(streamToken);
                    toolStateMachine.destroy();
                    return;
                }

                // 流正常结束，取消所有未完成的工具
                toolStateMachine.cancelAll();
                syncToolLogs();
                activeToolCleanupMap.delete(streamToken);
                toolStateMachine.destroy();

                cancelChunkFrame();
                flushPendingAssistantChunk();

                // 流结束时将剩余 pending 的任务全部标记为 completed
                const doneMsgs = get().messages;
                for (let i = doneMsgs.length - 1; i >= 0; i -= 1) {
                    if (doneMsgs[i].role === 'assistant') {
                        const tp = doneMsgs[i].taskProgress || [];
                        if (tp.length > 0 && tp.some((t) => t.status === 'pending')) {
                            syncTaskProgress(tp.map((t) =>
                                t.status === 'pending' ? { ...t, status: 'completed' } : t
                            ));
                        }
                        break;
                    }
                }

                const finalAssistantContent = (() => {
                    for (let i = latest.messages.length - 1; i >= 0; i -= 1) {
                        if (latest.messages[i].role === 'assistant') {
                            return latest.messages[i].content || '';
                        }
                    }

                    return '';
                })();

                if (latest.isVoiceEnabled && finalAssistantContent) {
                    playVoice(finalAssistantContent, { messageId: assistantMessageId });
                }

                // 在 fetchMessagesBySession 覆盖之前，捕获本地 toolLogs/thoughtLogs/taskProgress
                // 后端不存储这些字段，刷新历史会丢失工具卡片和任务进度
                const localMsgs = get().messages;
                let localToolLogs = [];
                let localThoughtLogs = [];
                let localTaskProgress = [];
                for (let i = localMsgs.length - 1; i >= 0; i -= 1) {
                    if (localMsgs[i].role === 'assistant') {
                        localToolLogs = localMsgs[i].toolLogs || [];
                        localThoughtLogs = localMsgs[i].thoughtLogs || [];
                        localTaskProgress = localMsgs[i].taskProgress || [];
                        break;
                    }
                }

                set({
                    isTyping: false,
                    activeAbortController: null,
                    activeStreamToken: null,
                    lastFailedUserMessage: '',
                    lastFailedRequest: null,
                });

                fetchMessagesBySession(sessionId)
                    .then((history) => {
                        const current = get();
                        if (current.currentSessionId !== sessionId || current.isTyping) {
                            return;
                        }

                        if (Array.isArray(history) && history.length > 0) {
                            // 合并本地 toolLogs/thoughtLogs/taskProgress 到刷新后的最后一条 assistant 消息
                            if (localToolLogs.length > 0 || localThoughtLogs.length > 0 || localTaskProgress.length > 0) {
                                for (let i = history.length - 1; i >= 0; i -= 1) {
                                    if (history[i].role === 'assistant') {
                                        history[i] = {
                                            ...history[i],
                                            toolLogs: localToolLogs,
                                            thoughtLogs: localThoughtLogs,
                                            taskProgress: localTaskProgress,
                                        };
                                        break;
                                    }
                                }
                            }
                            set({ messages: history });
                        }
                    })
                    .catch(() => {
                        // Ignore refresh failures and keep optimistic messages.
                    });
            },
            (error) => {
                const isAbort = error?.name === 'AbortError';

                const latest = get();
                if (latest.currentSessionId !== sessionId || latest.activeStreamToken !== streamToken) {
                    cancelChunkFrame();
                    pendingAssistantChunk = '';
                    // 清理状态机
                    activeToolCleanupMap.delete(streamToken);
                    toolStateMachine.destroy();
                    return;
                }

                // 流出错，取消所有进行中的工具
                toolStateMachine.cancelAll();
                syncToolLogs();
                activeToolCleanupMap.delete(streamToken);
                toolStateMachine.destroy();

                cancelChunkFrame();
                flushPendingAssistantChunk();

                set((state) => ({
                    messages: (() => {
                        const nextMessages = [...state.messages];
                        const tailIndex = nextMessages.length - 1;
                        const tail = nextMessages[tailIndex];

                        if (!tail || tail.role !== 'assistant') {
                            return state.messages;
                        }

                        nextMessages[tailIndex] = {
                            ...tail,
                            content: isAbort
                                ? tail.content || '已停止生成。'
                                : '抱歉，当前服务暂时不可用，请稍后重试。',
                        };

                        return nextMessages;
                    })(),
                    isTyping: false,
                    activeAbortController: null,
                    activeStreamToken: null,
                    lastFailedUserMessage: isAbort ? '' : content,
                    lastFailedRequest: isAbort
                        ? null
                        : {
                            content,
                            enableWebSearch,
                            imageId: selectedImageId,
                        },
                }));
            },
            {
                signal: controller.signal,
                enableWebSearch,
                planMode,
                systemPrompt,
                temperature,
                imageId: selectedImageId,
            }
        );
    },
}), {
    name: 'chat-agent-settings',
    partialize: (state) => ({
        authToken: state.authToken,
        user: state.user,
        sessionAgentSettings: state.sessionAgentSettings,
        sessionDrafts: state.sessionDrafts,
        enableWebSearch: state.enableWebSearch,
        isVoiceEnabled: state.isVoiceEnabled,
        voiceRate: state.voiceRate,
        voiceVolume: state.voiceVolume,
        voiceName: state.voiceName,
        themeMode: state.themeMode,
        mcpServers: state.mcpServers,
    }),
}));
