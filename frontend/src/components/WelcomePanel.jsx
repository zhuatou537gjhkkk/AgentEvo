import { useMemo } from 'react';

const SUGGESTIONS = [
    {
        icon: '✦',
        title: '了解今日热点',
        description: '快速整理过去 24 小时的重要动态',
        prompt: '请帮我整理过去 24 小时最值得关注的科技与商业新闻。',
    },
    {
        icon: '↗',
        title: '分析市场趋势',
        description: '从数据和背景中提炼关键变化',
        prompt: '请分析当前 AI 市场的主要趋势、机会和潜在风险。',
    },
    {
        icon: '▣',
        title: '总结一份文档',
        description: '提炼重点、结论与可执行行动项',
        prompt: '请帮我总结这份文档的核心内容，并列出行动项。',
    },
];

export default function WelcomePanel({ userName, onSuggestion }) {
    const displayName = useMemo(() => String(userName || '').trim() || '朋友', [userName]);

    return (
        <section className="welcome-panel" aria-labelledby="welcome-title">
            <div className="welcome-mark" aria-hidden="true">✦</div>
            <p className="welcome-eyebrow">AgentEvo workspace</p>
            <h1 id="welcome-title" className="welcome-title">Hello {displayName}</h1>
            <p className="welcome-subtitle">今天想一起完成什么？</p>
            <div className="suggestion-grid">
                {SUGGESTIONS.map((suggestion) => (
                    <button
                        key={suggestion.title}
                        type="button"
                        className="suggestion-card"
                        onClick={() => onSuggestion?.(suggestion.prompt)}
                    >
                        <span className="suggestion-icon" aria-hidden="true">{suggestion.icon}</span>
                        <span className="suggestion-copy">
                            <strong>{suggestion.title}</strong>
                            <small>{suggestion.description}</small>
                        </span>
                        <span className="suggestion-arrow" aria-hidden="true">↗</span>
                    </button>
                ))}
            </div>
        </section>
    );
}
