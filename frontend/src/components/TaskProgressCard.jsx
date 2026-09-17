import { memo, useState } from 'react';

// ── 状态元数据 ──────────────────────────────────────────────
const STATUS_META = {
  pending: { icon: '⏳', text: '等待中', border: 'border-l-[var(--status-neutral)]', bg: 'bg-[var(--status-neutral-soft)]', textColor: 'text-[var(--status-neutral)]' },
  in_progress: { icon: '🔄', text: '执行中', border: 'border-l-[var(--status-info)]', bg: 'bg-[var(--status-info-soft)]', textColor: 'text-[var(--status-info)]', pulse: true },
  completed: { icon: '✅', text: '完成', border: 'border-l-[var(--status-success)]', bg: 'bg-[var(--status-success-soft)]', textColor: 'text-[var(--status-success)]' },
  error: { icon: '❌', text: '失败', border: 'border-l-[var(--status-danger)]', bg: 'bg-[var(--status-danger-soft)]', textColor: 'text-[var(--status-danger)]' },
  failed: { icon: '❌', text: '失败', border: 'border-l-[var(--status-danger)]', bg: 'bg-[var(--status-danger-soft)]', textColor: 'text-[var(--status-danger)]' },
  blocked: { icon: '⛔', text: '已阻塞', border: 'border-l-[var(--status-warning)]', bg: 'bg-[var(--status-warning-soft)]', textColor: 'text-[var(--status-warning)]' },
  skipped: { icon: '⏭️', text: '已跳过', border: 'border-l-[var(--status-neutral)]', bg: 'bg-[var(--status-neutral-soft)]', textColor: 'text-[var(--status-neutral)]' },
  waiting_approval: { icon: '🛑', text: '等待批准', border: 'border-l-[var(--status-warning)]', bg: 'bg-[var(--status-warning-soft)]', textColor: 'text-[var(--status-warning)]' },
};

function TaskProgressCard({ progress }) {
  const [collapsed, setCollapsed] = useState(false);

  if (!Array.isArray(progress) || progress.length === 0) {
    return null;
  }

  const terminalStatuses = ['completed', 'failed', 'error', 'blocked', 'skipped', 'cancelled', 'interrupted'];
  const successfulCount = progress.filter((t) => t.status === 'completed').length;
  const terminalCount = progress.filter((t) => terminalStatuses.includes(t.status)).length;
  const allTerminal = terminalCount === progress.length;
  const allSucceeded = successfulCount === progress.length;

  return (
    <div className="surface-subtle mb-2 overflow-hidden">
      {/* ── Header ──────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:brightness-95 transition"
      >
        <span className="text-[var(--text-main)]">📋 任务进度</span>
        <span className="text-[var(--text-muted)]">
          {terminalCount}/{progress.length}
        </span>
        {allSucceeded && <span className="text-[var(--status-success)] text-[10px]">全部完成</span>}
        {allTerminal && !allSucceeded && <span className="text-[var(--status-warning)] text-[10px]">已结束（部分未完成）</span>}
        <span className="ml-auto text-[10px] text-[var(--text-muted)]">
          {collapsed ? '展开 ▼' : '收起 ▲'}
        </span>
      </button>

      {/* ── Item list ────────────────────────────────────── */}
      {!collapsed && (
        <div className="divide-y divide-[var(--panel-border)] border-t border-[var(--panel-border)]">
          {progress.map((task) => {
            const meta = STATUS_META[task.status] || STATUS_META.pending;
            const displayText = (task.status === 'in_progress' && task.activeForm)
              ? task.activeForm
              : task.content;

            return (
              <div
                key={String(task.id)}
                className={`border-l-4 ${meta.border} ${meta.bg} px-3 py-1.5 flex items-center gap-2 ${
                  meta.pulse ? 'animate-tool-border-pulse' : ''
                }`}
              >
                <span className={task.status === 'in_progress' ? 'animate-tool-spin inline-block' : ''}>
                  {meta.icon}
                </span>
                <span className={`text-xs ${meta.textColor}`}>
                  <span>{displayText}</span>
                  {task.statusReason && (
                    <span className="ml-2 text-[10px] text-[var(--text-muted)]">{task.statusReason}</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(
  TaskProgressCard,
  (prevProps, nextProps) => {
    const prevProgress = prevProps.progress || [];
    const nextProgress = nextProps.progress || [];
    if (prevProgress.length !== nextProgress.length) return false;

    for (let i = 0; i < prevProgress.length; i += 1) {
      if (
        String(prevProgress[i].id) !== String(nextProgress[i].id) ||
        prevProgress[i].status !== nextProgress[i].status ||
        prevProgress[i].activeForm !== nextProgress[i].activeForm ||
        prevProgress[i].content !== nextProgress[i].content ||
        prevProgress[i].statusReason !== nextProgress[i].statusReason ||
        JSON.stringify(prevProgress[i].dependsOn || []) !== JSON.stringify(nextProgress[i].dependsOn || []) ||
        prevProgress[i].outcome !== nextProgress[i].outcome
      ) {
        return false;
      }
    }

    return true;
  }
);
