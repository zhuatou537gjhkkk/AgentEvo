import { useChatStore } from "../store/chatStore";

export default function ContextIndicator() {
    const contextUsage = useChatStore((s) => s.contextUsage);
    const isCompacting = useChatStore((s) => s.isCompacting);
    const currentSessionId = useChatStore((s) => s.currentSessionId);
    const compactContext = useChatStore((s) => s.compactContext);
    const isTyping = useChatStore((s) => s.isTyping);

    if (!currentSessionId || !contextUsage) return null;

    const { usedTokens, maxTokens, ratio } = contextUsage;
    const usagePercent = Math.min(100, Math.max(0, ratio ?? 0));

    // SVG ring params
    const size = 22;
    const radius = 8;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (usagePercent / 100) * circumference;

    // Color thresholds: green < 50%, amber 50-85%, red >= 85%
    const strokeColor =
        usagePercent >= 85 ? "#ef4444" :
        usagePercent >= 50 ? "#f59e0b" :
        "#22c55e";

    const formatTokens = (n) => {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
        return String(n);
    };

    return (
        <div className="flex items-center gap-1.5" title={`${formatTokens(usedTokens)} / ${formatTokens(maxTokens)} tokens`}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
                <circle
                    cx={size / 2} cy={size / 2} r={radius}
                    fill="none"
                    stroke="var(--panel-border, #e5e7eb)"
                    strokeWidth="2.5"
                />
                <circle
                    cx={size / 2} cy={size / 2} r={radius}
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={strokeDashoffset}
                    transform={`rotate(-90 ${size / 2} ${size / 2})`}
                    style={{ transition: "stroke-dashoffset 0.5s ease, stroke 0.3s ease" }}
                />
            </svg>
            <span
                className="text-[11px] tabular-nums"
                style={{ color: strokeColor, minWidth: "2.2em" }}
            >
                {usagePercent}%
            </span>
            {usagePercent >= 50 && (
                <button
                    type="button"
                    disabled={isCompacting || isTyping}
                    onClick={() => compactContext(currentSessionId)}
                    className="rounded-md border px-1.5 py-0.5 text-[10px] leading-tight transition-colors"
                    style={{
                        borderColor: "var(--panel-border, #e5e7eb)",
                        color: strokeColor,
                        opacity: isCompacting ? 0.5 : 1,
                    }}
                >
                    {isCompacting ? "压缩中..." : "压缩"}
                </button>
            )}
        </div>
    );
}
