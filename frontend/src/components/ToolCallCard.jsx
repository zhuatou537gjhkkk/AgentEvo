import { memo, useState } from 'react';
import { ToolStatus, getToolDuration, getGroupAggregateStatus } from '../utils/toolExecutionStateMachine';
import { useChatStore } from '../store/chatStore';

// ── 工具类型图标映射 ───────────────────────────────────────
const TOOL_ICONS = {
  web_search: { icon: '🌐', label: '联网搜索' },
  search_knowledge_base: { icon: '📚', label: '知识库搜索' },
  get_system_time: { icon: '🕐', label: '系统时间' },
  get_db_message_count: { icon: '🗄', label: '数据库统计' },
  ask_user_question: { icon: '❓', label: '向用户提问' },
};

function resolveToolMeta(name) {
  return TOOL_ICONS[name] || { icon: '🔧', label: name };
}

// Phase 2: Agent 类型标签
const AGENT_LABELS = {
  searchAgent: '搜索Agent',
  knowledgeAgent: '知识库Agent',
  codeAgent: '代码Agent',
  generalAgent: '通用Agent',
  router: '路由',
  synthesizer: '综合',
};

// ── 状态配置 ───────────────────────────────────────────────
const STATUS_CONFIG = {
  [ToolStatus.PENDING]: {
    border: 'border-l-blue-400',
    bg: 'bg-blue-500/5',
    text: 'text-blue-300',
    label: '等待中',
  },
  [ToolStatus.EXECUTING]: {
    border: 'border-l-blue-400',
    bg: 'bg-blue-500/5',
    text: 'text-blue-300',
    label: '执行中',
    pulse: true,
  },
  [ToolStatus.SUCCESS]: {
    border: 'border-l-emerald-400',
    bg: 'bg-emerald-500/5',
    text: 'text-emerald-300',
    label: '成功',
  },
  [ToolStatus.ERROR]: {
    border: 'border-l-red-400',
    bg: 'bg-red-500/5',
    text: 'text-red-300',
    label: '失败',
  },
  [ToolStatus.TIMEOUT]: {
    border: 'border-l-amber-400',
    bg: 'bg-amber-500/5',
    text: 'text-amber-300',
    label: '超时',
  },
  [ToolStatus.CANCELLED]: {
    border: 'border-l-slate-500',
    bg: 'bg-slate-500/5',
    text: 'text-slate-400',
    label: '已取消',
  },
  [ToolStatus.WAITING_USER]: {
    border: 'border-l-amber-400',
    bg: 'bg-amber-500/5',
    text: 'text-amber-300',
    label: '等待回答',
    pulse: true,
  },
};

// ── 工具组聚合状态配置 ────────────────────────────────────
const GROUP_STATUS_CONFIG = {
  [ToolStatus.EXECUTING]: {
    border: 'border-l-blue-400',
    bg: 'bg-blue-500/5',
    text: 'text-blue-300',
    label: '正在执行',
    pulse: true,
  },
  [ToolStatus.SUCCESS]: {
    border: 'border-l-emerald-400',
    bg: 'bg-emerald-500/5',
    text: 'text-emerald-300',
    label: '执行完成',
    pulse: false,
  },
  [ToolStatus.ERROR]: {
    border: 'border-l-red-400',
    bg: 'bg-red-500/5',
    text: 'text-red-300',
    label: '部分失败',
    pulse: false,
  },
  [ToolStatus.PENDING]: {
    border: 'border-l-slate-500',
    bg: 'bg-slate-500/5',
    text: 'text-slate-400',
    label: '等待中',
    pulse: false,
  },
  [ToolStatus.WAITING_USER]: {
    border: 'border-l-amber-400',
    bg: 'bg-amber-500/5',
    text: 'text-amber-300',
    label: '等待用户回答',
    pulse: true,
  },
};

// ── 输出折叠区域 ───────────────────────────────────────────
const COLLAPSED_MAX_CHARS = 120;

function CollapsibleOutput({ output }) {
  const [expanded, setExpanded] = useState(false);
  const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);

  if (!text) {
    return null;
  }

  const shouldCollapse = text.length > COLLAPSED_MAX_CHARS + 20;

  return (
    <div className="mt-1.5">
      <pre className="whitespace-pre-wrap break-all rounded bg-black/20 px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-300">
        {shouldCollapse && !expanded ? `${text.slice(0, COLLAPSED_MAX_CHARS)}...` : text}
      </pre>
      {shouldCollapse && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="mt-1 text-[11px] text-blue-400 hover:text-blue-300 transition"
        >
          {expanded ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  );
}

// ── ToolGroupCard ──────────────────────────────────────────

/**
 * 工具组卡片：时间间隔 ≤ 5s 的多个工具合并显示。
 * 折叠时显示聚合状态（"正在执行 3 个工具"），展开后逐个渲染 ToolCallCard。
 */
function ToolGroupCard({ group, isTyping }) {
  const [expanded, setExpanded] = useState(false);
  const aggregate = getGroupAggregateStatus(group);
  const config = GROUP_STATUS_CONFIG[aggregate.status] || GROUP_STATUS_CONFIG[ToolStatus.PENDING];
  const count = group.length;

  return (
    <div
      className={`border-l-4 ${config.border} ${config.bg} rounded-r-md ${
        config.pulse ? 'animate-tool-border-pulse' : ''
      }`}
    >
      {/* ── 聚合 header ────────────────────────────── */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:brightness-95 transition"
      >
        {/* Spinner */}
        {aggregate.hasExecuting && (
          <span className="inline-block h-3 w-3 shrink-0 rounded-full border-2 border-blue-400 border-t-transparent animate-tool-spin" />
        )}

        <span className={config.text}>
          {config.label === '正在执行' ? '⚙️' : config.label === '执行完成' ? '✅' : config.label === '部分失败' ? '⚠️' : '⏳'}{' '}
          {config.label} {count} 个工具
        </span>

        {/* 成功/失败计数 */}
        {aggregate.hasError && !aggregate.hasExecuting && (
          <span className="text-red-400/70">
            (
            {group.filter((e) => e.status === ToolStatus.SUCCESS).length} 成功 /{' '}
            {group.filter((e) => e.status === ToolStatus.ERROR || e.status === ToolStatus.TIMEOUT).length} 失败
            )
          </span>
        )}

        <span className="ml-auto text-[10px] text-[var(--text-muted)]">
          {expanded ? '收起 ▲' : '展开 ▼'}
        </span>
      </button>

      {/* ── 展开后逐个渲染 ─────────────────────────── */}
      {expanded && (
        <div className="divide-y divide-[var(--panel-border)] border-t border-[var(--panel-border)]">
          {group.map((log) => (
            <ToolCallCard key={log.id} log={log} isTyping={isTyping} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── ToolCallCard ───────────────────────────────────────────
function ToolCallCard({ log, isTyping }) {
  const retryToolCall = useChatStore((state) => state.retryToolCall);
  const status = log.status || ToolStatus.PENDING;
  const config = STATUS_CONFIG[status] || STATUS_CONFIG[ToolStatus.EXECUTING];
  const meta = resolveToolMeta(log.name);
  const duration = getToolDuration(log);
  const isError = status === ToolStatus.ERROR || status === ToolStatus.TIMEOUT;
  const hasOutput = Boolean(log.output) && status === ToolStatus.SUCCESS;

  return (
    <div
      className={`animate-tool-fade-in border-l-4 ${config.border} ${config.bg} rounded-r-md px-3 py-2 ${
        config.pulse ? 'animate-tool-border-pulse' : ''
      }`}
    >
      {/* ── 标题行 ──────────────────────────────────── */}
      <div className="flex items-center gap-2 text-xs">
        {/* Spinner */}
        {status === ToolStatus.EXECUTING && (
          <span className="inline-block h-3 w-3 shrink-0 rounded-full border-2 border-blue-400 border-t-transparent animate-tool-spin" />
        )}

        {/* 图标 + 名称 */}
        <span className={config.text}>
          {meta.icon} {meta.label}
        </span>

        {/* Phase 2: Agent 身份徽章 — 仅非默认 react 类型时显示 */}
        {log.agentType && log.agentType !== 'react' && (
          <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-400 border border-purple-500/20">
            {AGENT_LABELS[log.agentType] || log.agentName || log.agentType}
          </span>
        )}

        {/* 耗时 */}
        {duration && (
          <span className="text-[var(--text-muted)]">
            耗时 {duration}
          </span>
        )}

        {/* 重试次数 */}
        {log.retryCount > 0 && (
          <span className="text-amber-400">
            (重试 {log.retryCount} 次)
          </span>
        )}

        {/* 状态标签 */}
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${config.bg} ${config.text}`}>
          {config.label}
        </span>

        {/* 重试按钮 */}
        {isError && !isTyping && retryToolCall && (
          <button
            type="button"
            onClick={() => retryToolCall(log.id)}
            className="ml-auto rounded border border-red-500/40 px-2 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10 transition"
          >
            重试
          </button>
        )}
      </div>

      {/* ── 输入摘要 ────────────────────────────────── */}
      {log.input && (
        <p className="mt-1 text-[11px] text-[var(--text-muted)] truncate">
          输入: {(() => {
            let display = log.input;
            // 若 input 被序列化为 JSON 字符串（如 persist 回灌或旧数据），先 parse
            if (typeof display === 'string') {
              try { display = JSON.parse(display); } catch { /* 保持原字符串 */ }
            }
            // 循环解包 LangChain 的 {input: ...} 包装层（处理深层嵌套）
            while (display && typeof display === 'object' && !Array.isArray(display) && Object.keys(display).length === 1 && 'input' in display) {
              display = display.input;
            }
            return typeof display === 'string' ? display : JSON.stringify(display);
          })()}
        </p>
      )}

      {/* ── 错误信息 ────────────────────────────────── */}
      {isError && log.error && (
        <p className="mt-1 text-[11px] text-red-400/80 break-words">
          错误: {log.error}
        </p>
      )}

      {/* ── 折叠输出 ────────────────────────────────── */}
      {hasOutput && <CollapsibleOutput output={log.output} />}
    </div>
  );
}

export default memo(
  ToolCallCard,
  (prevProps, nextProps) =>
    prevProps.log.id === nextProps.log.id &&
    prevProps.log.status === nextProps.log.status &&
    prevProps.log.output === nextProps.log.output &&
    prevProps.log.error === nextProps.log.error &&
    prevProps.log.retryCount === nextProps.log.retryCount &&
    prevProps.log.endedAt === nextProps.log.endedAt &&
    prevProps.isTyping === nextProps.isTyping
);

export { ToolGroupCard };
