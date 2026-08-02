import { memo } from 'react';

/**
 * MCPToolCard — 外部 MCP 工具连接状态卡片
 *
 * Phase 3: 显示 MCP Server 的工具列表及其连接状态。
 * 复用 ToolCallCard 的 border-l-4 + CollapsibleOutput 视觉模式。
 */

const STATUS_CONFIG = {
    connected: {
        border: 'border-l-emerald-400',
        bg: 'bg-emerald-500/5',
        text: 'text-emerald-300',
        label: '已连接',
        dot: 'bg-emerald-400',
    },
    connecting: {
        border: 'border-l-blue-400',
        bg: 'bg-blue-500/5',
        text: 'text-blue-300',
        label: '连接中',
        dot: 'bg-blue-400',
        pulse: true,
    },
    disconnected: {
        border: 'border-l-red-400',
        bg: 'bg-red-500/5',
        text: 'text-red-300',
        label: '已断开',
        dot: 'bg-red-400',
    },
    error: {
        border: 'border-l-amber-400',
        bg: 'bg-amber-500/5',
        text: 'text-amber-300',
        label: '错误',
        dot: 'bg-amber-400',
    },
};

function CollapsibleOutput({ text, maxLength = 120 }) {
    if (!text || text.length <= maxLength) {
        return <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-[var(--panel-bg)] px-2 py-1 text-[11px] leading-relaxed text-[var(--text-muted)] whitespace-pre-wrap break-all">{text}</pre>;
    }

    // Simple always-expanded display since this is used in settings context
    return (
        <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-blue-500 hover:text-blue-400">
                {text.slice(0, maxLength)}...
            </summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-[var(--panel-bg)] px-2 py-1 text-[11px] leading-relaxed text-[var(--text-muted)] whitespace-pre-wrap break-all">{text}</pre>
        </details>
    );
}

const MCPToolCard = memo(function MCPToolCard({ tool, status = 'disconnected' }) {
    const config = STATUS_CONFIG[status] || STATUS_CONFIG.disconnected;

    return (
        <div className={`border-l-4 ${config.border} ${config.bg} rounded-r-md px-3 py-2`}>
            <div className="flex items-center gap-2">
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${config.dot} ${config.pulse ? 'animate-pulse' : ''}`} />
                <span className="text-sm font-medium text-[var(--text-main)]">🔧 {tool.name}</span>
                <span className={`text-[11px] font-medium ${config.text}`}>{config.label}</span>
            </div>
            {tool.description && (
                <p className="mt-1 text-[11px] text-[var(--text-muted)] leading-relaxed">
                    {tool.description.length > 200 ? tool.description.slice(0, 200) + '...' : tool.description}
                </p>
            )}
            {tool.error && (
                <CollapsibleOutput text={`错误: ${tool.error}`} maxLength={80} />
            )}
        </div>
    );
}, (prevProps, nextProps) => {
    return (
        prevProps.tool?.name === nextProps.tool?.name &&
        prevProps.status === nextProps.status &&
        prevProps.tool?.error === nextProps.tool?.error
    );
});

export default MCPToolCard;
export { STATUS_CONFIG };
