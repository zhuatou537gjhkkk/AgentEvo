import { memo, useState } from 'react';

// ── 状态元数据 ──────────────────────────────────────────────
const STATUS_META = {
  pending: { icon: '⏳', text: '等待中', border: 'border-l-slate-400', bg: 'bg-[var(--status-neutral-soft)]', textColor: 'text-[var(--status-neutral)]' },
  in_progress: { icon: '🔄', text: '执行中', border: 'border-l-indigo-400', bg: 'bg-[var(--status-info-soft)]', textColor: 'text-[var(--status-info)]', pulse: true },
  completed: { icon: '✅', text: '完成', border: 'border-l-emerald-500', bg: 'bg-[var(--status-success-soft)]', textColor: 'text-[var(--status-success)]' },
  error: { icon: '❌', text: '失败', border: 'border-l-red-500', bg: 'bg-[var(--status-danger-soft)]', textColor: 'text-[var(--status-danger)]' },
};

function TaskProgressCard({ progress }) {
  const [collapsed, setCollapsed] = useState(false);

  if (!Array.isArray(progress) || progress.length === 0) {
    return null;
  }

  const hasActive = progress.some((t) => t.status === 'in_progress' || t.status === 'pending');
  const allDone = progress.every((t) => t.status === 'completed');

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
          {progress.filter((t) => t.status === 'completed').length}/{progress.length}
        </span>
        {allDone && <span className="text-emerald-400 text-[10px]">全部完成</span>}
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
                key={task.id}
                className={`border-l-4 ${meta.border} ${meta.bg} px-3 py-1.5 flex items-center gap-2 ${
                  meta.pulse ? 'animate-tool-border-pulse' : ''
                }`}
              >
                <span className={task.status === 'in_progress' ? 'animate-tool-spin inline-block' : ''}>
                  {meta.icon}
                </span>
                <span className={`text-xs ${meta.textColor}`}>{displayText}</span>
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
        prevProgress[i].id !== nextProgress[i].id ||
        prevProgress[i].status !== nextProgress[i].status ||
        prevProgress[i].activeForm !== nextProgress[i].activeForm ||
        prevProgress[i].content !== nextProgress[i].content
      ) {
        return false;
      }
    }

    return true;
  }
);
