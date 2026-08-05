import { memo, useEffect, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { playVoice, stopVoice } from '../store/chatStore';
import ToolCallCard, { ToolGroupCard } from './ToolCallCard';
import UserQuestionCard from './UserQuestionCard';
import EvalFeedback from './EvalFeedback';
import TaskProgressCard from './TaskProgressCard';
import { groupToolsByInterval } from '../utils/toolExecutionStateMachine';

function parseStructuredWebSearchContent(content) {
    const text = String(content || '').trim();
    if (!text.includes('标题:') || !text.includes('链接:')) {
        return null;
    }

    const lines = text.split('\n');
    const headerLine = lines[0].startsWith('已按时间窗口') || lines[0].startsWith('未找到')
        ? lines[0]
        : '';
    const dataText = headerLine ? lines.slice(1).join('\n').trim() : text;

    const blocks = dataText
        .split(/\n(?=时间: )/g)
        .map((block) => block.trim())
        .filter(Boolean);

    const items = blocks.map((block) => {
        const pick = (label) => {
            const line = block
                .split('\n')
                .find((itemLine) => itemLine.startsWith(`${label}: `));
            return line ? line.slice(label.length + 2).trim() : '';
        };

        return {
            time: pick('时间'),
            verification: pick('时间校验'),
            site: pick('来源'),
            title: pick('标题'),
            summary: pick('摘要'),
            link: pick('链接'),
            query: pick('检索词'),
        };
    }).filter((item) => item.title || item.link);

    if (items.length === 0) {
        return null;
    }

    return {
        header: headerLine,
        items,
    };
}

let syntaxHighlighterCache = null;
let syntaxThemeCache = null;
let syntaxLoaderPromise = null;
let markdownRendererCache = null;
let markdownPluginCache = null;
let markdownLoaderPromise = null;

async function loadSyntaxAssets() {
    if (syntaxHighlighterCache && syntaxThemeCache) {
        return {
            SyntaxHighlighter: syntaxHighlighterCache,
            theme: syntaxThemeCache,
        };
    }

    if (!syntaxLoaderPromise) {
        syntaxLoaderPromise = Promise.all([
            import('react-syntax-highlighter/dist/esm/prism-light').then((mod) => mod.default),
            import('react-syntax-highlighter/dist/esm/styles/prism').then((mod) => mod.oneDark),
            import('react-syntax-highlighter/dist/esm/languages/prism/javascript').then((mod) => ['javascript', mod.default]),
            import('react-syntax-highlighter/dist/esm/languages/prism/jsx').then((mod) => ['jsx', mod.default]),
            import('react-syntax-highlighter/dist/esm/languages/prism/typescript').then((mod) => ['typescript', mod.default]),
            import('react-syntax-highlighter/dist/esm/languages/prism/tsx').then((mod) => ['tsx', mod.default]),
            import('react-syntax-highlighter/dist/esm/languages/prism/json').then((mod) => ['json', mod.default]),
            import('react-syntax-highlighter/dist/esm/languages/prism/bash').then((mod) => ['bash', mod.default]),
            import('react-syntax-highlighter/dist/esm/languages/prism/python').then((mod) => ['python', mod.default]),
            import('react-syntax-highlighter/dist/esm/languages/prism/java').then((mod) => ['java', mod.default]),
            import('react-syntax-highlighter/dist/esm/languages/prism/css').then((mod) => ['css', mod.default]),
            import('react-syntax-highlighter/dist/esm/languages/prism/markdown').then((mod) => ['markdown', mod.default]),
            import('react-syntax-highlighter/dist/esm/languages/prism/sql').then((mod) => ['sql', mod.default]),
            import('react-syntax-highlighter/dist/esm/languages/prism/yaml').then((mod) => ['yaml', mod.default]),
        ]).then(([SyntaxHighlighter, theme, ...languages]) => {
            for (const [languageName, languageModule] of languages) {
                SyntaxHighlighter.registerLanguage(languageName, languageModule);
            }

            syntaxHighlighterCache = SyntaxHighlighter;
            syntaxThemeCache = theme;

            return {
                SyntaxHighlighter,
                theme,
            };
        });
    }

    return syntaxLoaderPromise;
}

async function loadMarkdownAssets() {
    if (markdownRendererCache && markdownPluginCache) {
        return {
            ReactMarkdown: markdownRendererCache,
            remarkGfm: markdownPluginCache,
        };
    }

    if (!markdownLoaderPromise) {
        markdownLoaderPromise = Promise.all([
            import('react-markdown').then((mod) => mod.default),
            import('remark-gfm').then((mod) => mod.default),
        ]).then(([ReactMarkdown, remarkGfm]) => {
            markdownRendererCache = ReactMarkdown;
            markdownPluginCache = remarkGfm;

            return {
                ReactMarkdown,
                remarkGfm,
            };
        });
    }

    return markdownLoaderPromise;
}

function CodeRenderer({ inline, className, children, ...props }) {
    const [copied, setCopied] = useState(false);
    const [assets, setAssets] = useState(() => {
        if (syntaxHighlighterCache && syntaxThemeCache) {
            return {
                SyntaxHighlighter: syntaxHighlighterCache,
                theme: syntaxThemeCache,
            };
        }

        return null;
    });
    const match = /language-([a-zA-Z0-9-]+)/.exec(className || '');
    const language = match ? match[1] : 'text';
    const codeText = String(children).replace(/\n$/, '');

    if (inline) {
        return (
            <code
                className="rounded-md bg-slate-200/80 px-1.5 py-0.5 font-mono text-[0.92em] text-slate-800 dark:bg-slate-700/70 dark:text-slate-100"
                {...props}
            >
                {children}
            </code>
        );
    }

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(codeText);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        } catch {
            setCopied(false);
        }
    };

    useEffect(() => {
        if (inline || assets) {
            return undefined;
        }

        let active = true;

        loadSyntaxAssets()
            .then((loaded) => {
                if (active) {
                    setAssets(loaded);
                }
            })
            .catch(() => {
                if (active) {
                    setAssets(null);
                }
            });

        return () => {
            active = false;
        };
    }, [inline, assets]);

    const SyntaxHighlighter = assets?.SyntaxHighlighter;
    const theme = assets?.theme;

    return (
        <div className="my-3 overflow-hidden rounded-xl border border-slate-700/80 bg-[#0f172a] shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-700/80 px-3 py-2 text-xs text-slate-300">
                <span className="rounded bg-slate-800 px-2 py-0.5 font-mono uppercase tracking-wide text-slate-200">
                    {language}
                </span>
                <button
                    type="button"
                    onClick={handleCopy}
                    className="rounded border border-slate-600 px-2 py-0.5 text-[11px] font-medium text-slate-200 transition hover:bg-slate-800"
                >
                    {copied ? '已复制' : '复制代码'}
                </button>
            </div>
            <div className="overflow-x-auto">
                {SyntaxHighlighter && theme ? (
                    <SyntaxHighlighter
                        language={language}
                        style={theme}
                        PreTag="div"
                        customStyle={{
                            margin: 0,
                            background: 'transparent',
                            borderRadius: 0,
                            fontSize: '0.85rem',
                            lineHeight: 1.6,
                        }}
                        {...props}
                    >
                        {codeText}
                    </SyntaxHighlighter>
                ) : (
                    <pre className="m-0 overflow-x-auto p-3 font-mono text-[13px] leading-6 text-slate-200">
                        <code>{codeText}</code>
                    </pre>
                )}
            </div>
        </div>
    );
}

function MessageItem({ message }) {
    const isUser = message.role === 'user';
    const toolLogs = Array.isArray(message.toolLogs) ? message.toolLogs : [];
    const thoughtLogs = Array.isArray(message.thoughtLogs) ? message.thoughtLogs : [];
    const retryMessageById = useChatStore((state) => state.retryMessageById);
    const createBranchFromMessage = useChatStore((state) => state.createBranchFromMessage);
    const editUserMessageAndResend = useChatStore((state) => state.editUserMessageAndResend);
    const isCurrentMessageSpeaking = useChatStore((state) => !isUser && state.speakingMessageId === message.id);
    const isTyping = useChatStore((state) => state.isTyping);
    const [copied, setCopied] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editedValue, setEditedValue] = useState(String(message.content || ''));
    const [markdownAssets, setMarkdownAssets] = useState(() => {
        if (markdownRendererCache && markdownPluginCache) {
            return {
                ReactMarkdown: markdownRendererCache,
                remarkGfm: markdownPluginCache,
            };
        }

        return null;
    });
    const structuredSearchResult =
        message.role === 'assistant' ? parseStructuredWebSearchContent(message.content) : null;

    useEffect(() => {
        setEditedValue(String(message.content || ''));
        setIsEditing(false);
    }, [message.id, message.content]);

    useEffect(() => {
        if (isUser || structuredSearchResult || markdownAssets) {
            return undefined;
        }

        let active = true;

        loadMarkdownAssets()
            .then((loaded) => {
                if (active) {
                    setMarkdownAssets(loaded);
                }
            })
            .catch(() => {
                if (active) {
                    setMarkdownAssets(null);
                }
            });

        return () => {
            active = false;
        };
    }, [isUser, structuredSearchResult, markdownAssets]);

    const handleCopyMessage = async () => {
        try {
            await navigator.clipboard.writeText(String(message.content || ''));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        } catch {
            setCopied(false);
        }
    };

    const handleReadMessage = () => {
        if (isCurrentMessageSpeaking) {
            stopVoice();
            return;
        }

        playVoice(message.content, { messageId: message.id });
    };

    const taskProgress = Array.isArray(message.taskProgress) ? message.taskProgress : [];

    const renderTaskProgress = () => {
        if (taskProgress.length === 0) return null;

        return <TaskProgressCard progress={taskProgress} />;
    };

    const renderToolLogs = () => {
        // ask_user_question / update_todo 由专用 UI 渲染，不在工具卡片区重复显示
        const visibleToolLogs = toolLogs.filter((log) => log.name !== 'ask_user_question' && log.name !== 'update_todo');
        if (visibleToolLogs.length === 0) {
            return null;
        }

        const groups = groupToolsByInterval(visibleToolLogs);

        return (
            <div className="mb-2 rounded-lg border border-[var(--panel-border)] bg-[var(--panel-soft)] divide-y divide-[var(--panel-border)] overflow-hidden">
                {groups.map((group, idx) => {
                    if (group.length === 1) {
                        return (
                            <ToolCallCard
                                key={group[0].id || `single-${idx}`}
                                log={group[0]}
                                isTyping={isTyping}
                            />
                        );
                    }
                    return (
                        <ToolGroupCard
                            key={`group-${idx}`}
                            group={group}
                            isTyping={isTyping}
                        />
                    );
                })}
            </div>
        );
    };

    const questionLogs = Array.isArray(message.questionLogs) ? message.questionLogs : [];

    const renderQuestionLogs = () => {
        if (questionLogs.length === 0) {
            return null;
        }

        return (
            <div className="mb-2 space-y-1.5">
                {questionLogs.map((qLog) => (
                    <UserQuestionCard
                        key={qLog.questionId}
                        questionLog={qLog}
                    />
                ))}
            </div>
        );
    };

    const renderThoughtLogs = () => {
        if (thoughtLogs.length === 0) {
            return null;
        }

        return (
            <details className="mb-2 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-200">
                <summary className="cursor-pointer select-none font-medium">思考过程</summary>
                <div className="mt-2 space-y-1">
                    {thoughtLogs.map((log, index) => (
                        <div key={`${log.at || 'thought'}-${index}`} className="whitespace-pre-wrap break-words">
                            {`- ${log.text}${log.status === 'done' ? ' ✅' : log.status === 'error' ? ' ❌' : ''}`}
                        </div>
                    ))}
                </div>
            </details>
        );
    };

    const renderStructuredSearchCards = () => {
        if (!structuredSearchResult) {
            return null;
        }

        return (
            <div className="space-y-3">
                {structuredSearchResult.header && (
                    <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
                        {structuredSearchResult.header}
                    </div>
                )}

                {structuredSearchResult.items.map((item, index) => {
                    const isVerified = item.verification === '已核验';
                    return (
                        <article
                            key={`${item.link || item.title}-${index}`}
                            className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900"
                        >
                            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                                <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-700 dark:bg-slate-800 dark:text-slate-200">{item.time || '未知时间'}</span>
                                <span
                                    className={[
                                        'rounded px-2 py-0.5',
                                        isVerified
                                            ? 'bg-emerald-100 text-emerald-700'
                                            : 'bg-amber-100 text-amber-700',
                                    ].join(' ')}
                                >
                                    {item.verification || '待核验'}
                                </span>
                                <span className="rounded bg-violet-100 px-2 py-0.5 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200">{item.site || '未知来源'}</span>
                            </div>

                            <h4 className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{item.title || '无标题'}</h4>
                            <p className="mb-2 whitespace-pre-wrap text-xs text-slate-700 dark:text-slate-300">{item.summary || '无摘要'}</p>

                            {item.link && item.link !== '无链接' ? (
                                <a
                                    href={item.link}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
                                >
                                    打开来源链接
                                </a>
                            ) : (
                                <span className="text-xs text-slate-500 dark:text-slate-400">无可用链接</span>
                            )}

                            {item.query && (
                                <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">检索词: {item.query}</p>
                            )}
                        </article>
                    );
                })}
            </div>
        );
    };

    const renderAssistantContent = () => {
        if (structuredSearchResult) {
            return renderStructuredSearchCards();
        }

        if (!markdownAssets?.ReactMarkdown || !markdownAssets?.remarkGfm) {
            return <p className="whitespace-pre-wrap break-words">{message.content}</p>;
        }

        const ReactMarkdown = markdownAssets.ReactMarkdown;
        const remarkGfm = markdownAssets.remarkGfm;

        return (
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    code: CodeRenderer,
                    table({ children }) {
                        return (
                            <div className="my-3 overflow-x-auto rounded-lg border border-slate-300 bg-white/80 dark:border-slate-700 dark:bg-slate-900/70">
                                <table className="min-w-full border-collapse text-left text-xs sm:text-sm">
                                    {children}
                                </table>
                            </div>
                        );
                    },
                    thead({ children }) {
                        return <thead className="bg-slate-100/90 dark:bg-slate-800">{children}</thead>;
                    },
                    tr({ children }) {
                        return <tr className="border-t border-slate-300 dark:border-slate-700">{children}</tr>;
                    },
                    th({ children }) {
                        return (
                            <th className="whitespace-nowrap border border-slate-300 px-3 py-2 font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-200">
                                {children}
                            </th>
                        );
                    },
                    td({ children }) {
                        return (
                            <td className="border border-slate-300 px-3 py-2 align-top text-slate-700 dark:border-slate-700 dark:text-slate-300">
                                {children}
                            </td>
                        );
                    },
                }}
            >
                {message.content}
            </ReactMarkdown>
        );
    };

    return (
        <div className={`flex w-full px-1 py-3 sm:px-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div className={`flex w-full gap-3 ${isUser ? 'max-w-[82%] flex-row-reverse sm:max-w-[76%] lg:max-w-[70%]' : 'max-w-full'}`}>
                <div
                    className={[
                        'mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                        isUser
                            ? 'bg-slate-800 text-slate-100 dark:bg-slate-200 dark:text-slate-900'
                            : 'bg-emerald-600 text-white',
                    ].join(' ')}
                    aria-hidden="true"
                >
                    {isUser ? '你' : 'AI'}
                </div>

                <div
                    className={[
                        'group relative min-w-0 text-[15px] leading-7',
                        isUser
                            ? 'rounded-[1.45rem] bg-[#2f2f2f] px-4 py-3.5 text-white shadow-[0_8px_20px_rgba(2,6,23,0.2)] dark:bg-[#2f2f2f]'
                            : 'bg-transparent px-0 py-0 text-[var(--text-main)] shadow-none',
                    ].join(' ')}
                >
                    <p className={`mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] ${isUser ? 'text-slate-200' : 'text-[var(--text-muted)]'}`}>
                        {isUser ? 'You' : 'Assistant'}
                    </p>
                    {!isUser && (
                        <button
                            type="button"
                            onClick={handleReadMessage}
                            className={[
                                'absolute right-0 top-0 rounded-md border px-1.5 py-0.5 text-[11px] transition md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100',
                                isCurrentMessageSpeaking
                                    ? 'border-red-300 bg-red-50 text-red-600 hover:bg-red-100'
                                    : 'border-[var(--panel-border)] bg-[var(--panel-bg)] text-[var(--text-muted)] hover:opacity-95',
                            ].join(' ')}
                            title={isCurrentMessageSpeaking ? '停止朗读' : '朗读此消息'}
                            aria-label={isCurrentMessageSpeaking ? '停止朗读' : '朗读此消息'}
                        >
                            {isCurrentMessageSpeaking ? '■ 停止' : '🔊 朗读'}
                        </button>
                    )}
                    {isUser ? (
                        isEditing ? (
                            <div className="space-y-2">
                                <textarea
                                    value={editedValue}
                                    onChange={(event) => setEditedValue(event.target.value)}
                                    className="w-full min-h-24 rounded-lg border border-slate-500/40 bg-black/10 px-2 py-1.5 text-sm text-white outline-none"
                                />
                                <div className="flex gap-2 text-xs">
                                    <button
                                        type="button"
                                        onClick={() => setIsEditing(false)}
                                        className="rounded-md border border-slate-300/50 px-2 py-1"
                                    >
                                        取消
                                    </button>
                                    <button
                                        type="button"
                                        disabled={isTyping}
                                        onClick={async () => {
                                            await editUserMessageAndResend(message.id, editedValue);
                                            setIsEditing(false);
                                        }}
                                        className="rounded-md bg-white px-2 py-1 font-semibold text-slate-900 disabled:opacity-60"
                                    >
                                        保存并重发
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <p className="whitespace-pre-wrap break-words">{message.content}</p>
                        )
                    ) : (
                        <div className="break-words pr-7 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:whitespace-pre-wrap [&_ul]:list-disc [&_ul]:pl-6">
                            {renderThoughtLogs()}
                            {renderTaskProgress()}
                            {renderToolLogs()}
                            {renderQuestionLogs()}
                            {renderAssistantContent()}
                            {message?.metrics && (
                                <div className="mt-2 inline-flex flex-wrap items-center gap-2 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1 text-[11px] text-[var(--text-muted)]">
                                    <span>响应 {message.metrics.latency_ms}ms</span>
                                    <span>Token {message.metrics.total_tokens}</span>
                                    {message.metrics.model && <span>{message.metrics.model}</span>}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Phase 5: 用户反馈按钮 */}
                    {!isUser && message.id && (
                        <EvalFeedback messageId={message.id} />
                    )}

                    <div className={`mt-2 flex items-center gap-2 text-xs ${isUser ? 'justify-end' : 'justify-start'}`}>
                        <button
                            type="button"
                            onClick={handleCopyMessage}
                            className={[
                                'rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-0.5 text-[var(--text-muted)] transition hover:opacity-95',
                                isUser ? '' : 'md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100',
                            ].join(' ')}
                        >
                            {copied ? '已复制' : '复制'}
                        </button>
                        {!isUser && (
                            <>
                                <button
                                    type="button"
                                    onClick={() => retryMessageById(message.id)}
                                    className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-0.5 text-[var(--text-muted)] transition hover:opacity-95 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                                >
                                    重试
                                </button>
                                <button
                                    type="button"
                                    disabled={isTyping}
                                    onClick={() => createBranchFromMessage(message.id)}
                                    className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-0.5 text-[var(--text-muted)] transition hover:opacity-95 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 disabled:opacity-60"
                                >
                                    分支
                                </button>
                            </>
                        )}
                        {isUser && (
                            <>
                                <button
                                    type="button"
                                    onClick={() => setIsEditing((prev) => !prev)}
                                    className="rounded-lg border border-white/25 bg-white/10 px-2 py-0.5 text-slate-100 transition hover:bg-white/15"
                                >
                                    {isEditing ? '收起编辑' : '编辑重发'}
                                </button>
                                <button
                                    type="button"
                                    disabled={isTyping}
                                    onClick={() => createBranchFromMessage(message.id)}
                                    className="rounded-lg border border-white/25 bg-white/10 px-2 py-0.5 text-slate-100 transition hover:bg-white/15 disabled:opacity-60"
                                >
                                    分支
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default memo(
    MessageItem,
    (prevProps, nextProps) => {
        const prevLogs = prevProps.message?.toolLogs || [];
        const nextLogs = nextProps.message?.toolLogs || [];
        const prevThoughtLogs = prevProps.message?.thoughtLogs || [];
        const nextThoughtLogs = nextProps.message?.thoughtLogs || [];
        const prevQuestionLogs = prevProps.message?.questionLogs || [];
        const nextQuestionLogs = nextProps.message?.questionLogs || [];

        const prevLastLog = prevLogs[prevLogs.length - 1];
        const nextLastLog = nextLogs[nextLogs.length - 1];
        const prevLastThought = prevThoughtLogs[prevThoughtLogs.length - 1];
        const nextLastThought = nextThoughtLogs[nextThoughtLogs.length - 1];
        const prevLastQuestion = prevQuestionLogs[prevQuestionLogs.length - 1];
        const nextLastQuestion = nextQuestionLogs[nextQuestionLogs.length - 1];

        return (
            prevProps.message?.id === nextProps.message?.id &&
            prevProps.message?.role === nextProps.message?.role &&
            prevProps.message?.content === nextProps.message?.content &&
            prevProps.message?.metrics?.latency_ms === nextProps.message?.metrics?.latency_ms &&
            prevProps.message?.metrics?.total_tokens === nextProps.message?.metrics?.total_tokens &&
            prevProps.message?.metrics?.model === nextProps.message?.metrics?.model &&
            prevLogs.length === nextLogs.length &&
            prevThoughtLogs.length === nextThoughtLogs.length &&
            prevQuestionLogs.length === nextQuestionLogs.length &&
            prevLastLog?.id === nextLastLog?.id &&
            prevLastLog?.name === nextLastLog?.name &&
            prevLastLog?.status === nextLastLog?.status &&
            prevLastLog?.error === nextLastLog?.error &&
            prevLastLog?.retryCount === nextLastLog?.retryCount &&
            prevLastLog?.endedAt === nextLastLog?.endedAt &&
            prevLastThought?.text === nextLastThought?.text &&
            prevLastThought?.status === nextLastThought?.status &&
            prevLastQuestion?.questionId === nextLastQuestion?.questionId &&
            prevLastQuestion?.isSubmitted === nextLastQuestion?.isSubmitted &&
            prevLastQuestion?.submittedAnswer === nextLastQuestion?.submittedAnswer &&
            prevLastQuestion?.status === nextLastQuestion?.status
        );
    }
);
