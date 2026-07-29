/**
 * 工具执行状态机 (Tool Execution FSM)
 *
 * 状态定义:
 *   PENDING       — 已入队，等待执行
 *   EXECUTING     — 正在执行
 *   WAITING_USER  — 等待用户回答 (ask_user_question 专用)
 *   SUCCESS       — 执行成功 (终态)
 *   ERROR         — 执行失败
 *   TIMEOUT       — 执行超时
 *   CANCELLED     — 被用户取消 (终态)
 *
 * 状态转移:
 *   PENDING       ──(start)──────→ EXECUTING
 *   EXECUTING     ──(end)────────→ SUCCESS
 *   EXECUTING     ──(wait_user)──→ WAITING_USER
 *   WAITING_USER  ──(end)────────→ SUCCESS
 *   WAITING_USER  ──(cancel)─────→ CANCELLED
 *   EXECUTING     ──(error)──────→ ERROR
 *   EXECUTING     ──(timeout)────→ TIMEOUT
 *   EXECUTING     ──(cancel)─────→ CANCELLED
 *   ERROR         ──(retry)──────→ EXECUTING   (retryCount++)
 *   TIMEOUT       ──(retry)──────→ EXECUTING   (retryCount++)
 *
 * 禁止的转移 (守卫):
 *   - 只有 EXECUTING 才能进入终态
 *   - SUCCESS / CANCELLED 是最终态，不可再转移
 *   - 重试次数超过上限时禁止 retry
 */

// ── 状态常量 ────────────────────────────────────────────────
export const ToolStatus = {
  PENDING: 'pending',
  EXECUTING: 'executing',
  WAITING_USER: 'waiting_user',
  SUCCESS: 'success',
  ERROR: 'error',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
};

// ── 终态集合 ───────────────────────────────────────────────
const TERMINAL_STATES = new Set([
  ToolStatus.SUCCESS,
  ToolStatus.CANCELLED,
]);

// ── 事件常量 ────────────────────────────────────────────────
const Event = {
  START: 'start',
  END: 'end',
  WAIT_USER: 'wait_user',
  ERROR: 'error',
  TIMEOUT: 'timeout',
  CANCEL: 'cancel',
  RETRY: 'retry',
};

/**
 * 转移表: { [currentStatus]: { [event]: nextStatus | null } }
 * null 表示该转移被禁止。
 */
const TRANSITION_TABLE = {
  [ToolStatus.PENDING]: {
    [Event.START]: ToolStatus.EXECUTING,
    [Event.CANCEL]: ToolStatus.CANCELLED,
  },
  [ToolStatus.EXECUTING]: {
    [Event.END]: ToolStatus.SUCCESS,
    [Event.WAIT_USER]: ToolStatus.WAITING_USER,
    [Event.ERROR]: ToolStatus.ERROR,
    [Event.TIMEOUT]: ToolStatus.TIMEOUT,
    [Event.CANCEL]: ToolStatus.CANCELLED,
  },
  [ToolStatus.WAITING_USER]: {
    [Event.END]: ToolStatus.SUCCESS,
    [Event.CANCEL]: ToolStatus.CANCELLED,
  },
  [ToolStatus.ERROR]: {
    [Event.RETRY]: ToolStatus.EXECUTING,
  },
  [ToolStatus.TIMEOUT]: {
    [Event.RETRY]: ToolStatus.EXECUTING,
  },
  // SUCCESS, CANCELLED 无有效转移，终态
};

// ── 默认配置 ────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;

// ── 工厂函数：创建一条空的工具调用记录 ──────────────────────
export function createToolCallEntry(id, name, input, startedAt) {
  return {
    id,
    name,
    input,
    output: null,
    status: ToolStatus.PENDING,
    startedAt: startedAt || Date.now(),
    endedAt: null,
    error: null,
    retryCount: 0,
    timeoutId: null,
  };
}

// ── 转移合法性校验 ─────────────────────────────────────────
export function canTransition(currentStatus, event) {
  const transitions = TRANSITION_TABLE[currentStatus];
  if (!transitions) {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(transitions, event);
}

export function getNextStatus(currentStatus, event) {
  const transitions = TRANSITION_TABLE[currentStatus];
  if (!transitions) {
    throw new Error(`未知状态: ${currentStatus}`);
  }

  const nextStatus = transitions[event];
  if (nextStatus == null) {
    throw new Error(
      `禁止的状态转移: ${currentStatus} ->(${event})-> ?`
    );
  }

  return nextStatus;
}

// ── 判断是否为终态 ─────────────────────────────────────────
export function isTerminalStatus(status) {
  return TERMINAL_STATES.has(status);
}

// ── 状态机引擎 ──────────────────────────────────────────────

/**
 * 创建一个工具执行状态机实例。
 *
 * 纯数据驱动，不依赖任何框架。返回一个操作句柄。
 *
 * @param {object} config
 * @param {number} [config.timeoutMs=30000]          — 全局默认超时 (ms)
 * @param {number} [config.maxRetries=3]             — 最大重试次数
 * @param {Map<string, number>} [config.perToolTimeout] — 按工具名定制的超时 (ms)
 * @param {(entry: object) => void} [config.onChange] — 状态变更回调
 */
export function createToolExecutionStateMachine(config = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    perToolTimeout = new Map(),
    onChange = null,
  } = config;

  /** @type {Map<string, object>} */
  const entries = new Map();
  /** @type {string[]} — 保持插入顺序 */
  const orderedIds = [];

  // ── 内部方法 ──────────────────────────────────────────

  function getTimeoutMs(toolName) {
    if (perToolTimeout && perToolTimeout.has(toolName)) {
      return perToolTimeout.get(toolName);
    }

    return timeoutMs;
  }

  function clearEntryTimeout(entry) {
    if (entry.timeoutId != null) {
      clearTimeout(entry.timeoutId);
      // 不直接 mutating 调用方传来的 entry，而是会走 transition 更新
    }

    return entry.timeoutId != null;
  }

  function scheduleTimeout(id) {
    const entry = entries.get(id);
    if (!entry) {
      return;
    }

    // 清除已有的 timer
    if (entry.timeoutId != null) {
      clearTimeout(entry.timeoutId);
    }

    const ms = getTimeoutMs(entry.name);
    const timerId = setTimeout(() => {
      transition(id, Event.TIMEOUT, { error: `执行超时 (${ms / 1000}s)` });
    }, ms);

    // 直接在 entry 上更新 timeoutId（transition 前进行的内部状态）
    entry.timeoutId = timerId;
  }

  function stampEnd(entry, status, endedAt) {
    const updated = { ...entry, status, endedAt: endedAt || Date.now() };

    if (entry.timeoutId != null) {
      clearTimeout(entry.timeoutId);
      updated.timeoutId = null;
    }

    return updated;
  }

  // ── 状态转移函数 ──────────────────────────────────────

  function transition(id, event, payload = {}) {
    const entry = entries.get(id);
    if (!entry) {
      return null;
    }

    if (!canTransition(entry.status, event)) {
      // 静默跳过非法转移
      return null;
    }

    let nextStatus;

    if (event === Event.RETRY) {
      if (entry.retryCount >= maxRetries) {
        // 超过重试上限，不允许重试
        return null;
      }
    }

    nextStatus = getNextStatus(entry.status, event);

    // 终态时清理 timer
    let updatedEntry;

    if (isTerminalStatus(nextStatus)) {
      updatedEntry = stampEnd(entry, nextStatus, payload.endedAt);
    } else {
      updatedEntry = { ...entry, status: nextStatus };
    }

    // 附加 payload 字段
    if (payload.error != null) {
      updatedEntry = { ...updatedEntry, error: payload.error };
    }

    if (payload.output != null) {
      updatedEntry = { ...updatedEntry, output: payload.output || '' };
    }

    if (event === Event.RETRY) {
      updatedEntry = {
        ...updatedEntry,
        retryCount: updatedEntry.retryCount + 1,
        error: null,
        output: null,
        endedAt: null,
      };
    }

    // 更新到 Map 中
    entries.set(id, updatedEntry);

    // 如果 retry 后进入 EXECUTING，重新启动超时
    if (event === Event.RETRY && nextStatus === ToolStatus.EXECUTING) {
      scheduleTimeout(id);
    }

    // 通知外部
    if (typeof onChange === 'function') {
      onChange(updatedEntry);
    }

    return updatedEntry;
  }

  // ── 公开 API ──────────────────────────────────────────

  return {
    /** 创建一条工具调用记录并进入 PENDING 状态 */
    create(id, name, input, startedAt) {
      if (entries.has(id)) {
        return entries.get(id);
      }

      const entry = createToolCallEntry(id, name, input, startedAt);
      entries.set(id, entry);
      orderedIds.push(id);

      return entry;
    },

    /** PENDING -> EXECUTING */
    start(id) {
      const result = transition(id, Event.START);

      if (result && result.status === ToolStatus.EXECUTING) {
        scheduleTimeout(id);
      }

      return result;
    },

    /** EXECUTING -> SUCCESS */
    end(id, output, endedAt) {
      return transition(id, Event.END, { output, endedAt });
    },

    /** EXECUTING -> ERROR */
    error(id, err, endedAt) {
      return transition(id, Event.ERROR, {
        error: String(err || '未知错误'),
        endedAt,
      });
    },

    /** EXECUTING -> TIMEOUT (通常由内部定时器触发，也可手动调用) */
    timeout(id, message) {
      return transition(id, Event.TIMEOUT, {
        error: String(message || '执行超时'),
      });
    },

    /** EXECUTING -> CANCELLED */
    cancel(id) {
      return transition(id, Event.CANCEL);
    },

    /** EXECUTING -> WAITING_USER (ask_user_question 等待用户回答) */
    waitUser(id) {
      return transition(id, Event.WAIT_USER);
    },

    /** ERROR/TIMEOUT -> EXECUTING */
    retry(id) {
      return transition(id, Event.RETRY);
    },

    /** 批量取消所有 PENDING/EXECUTING 的工具 */
    cancelAll() {
      const cancelled = [];

      for (const [id, entry] of entries) {
        if (
          entry.status === ToolStatus.PENDING ||
          entry.status === ToolStatus.EXECUTING ||
          entry.status === ToolStatus.WAITING_USER
        ) {
          const result = this.cancel(id);

          if (result) {
            cancelled.push(result);
          }
        }
      }

      return cancelled;
    },

    /** 获取单条记录 */
    get(id) {
      return entries.get(id) || null;
    },

    /** 按插入顺序返回所有记录 */
    getAll() {
      return orderedIds
        .map((id) => entries.get(id))
        .filter(Boolean);
    },

    /** 统计信息 */
    getStats() {
      let total = 0;
      let success = 0;
      let error = 0;
      let timeout = 0;
      let cancelled = 0;
      let executing = 0;
      let pending = 0;

      let waitingUser = 0;

      for (const entry of entries.values()) {
        total += 1;

        switch (entry.status) {
          case ToolStatus.PENDING:
            pending += 1;
            break;
          case ToolStatus.EXECUTING:
            executing += 1;
            break;
          case ToolStatus.WAITING_USER:
            waitingUser += 1;
            break;
          case ToolStatus.SUCCESS:
            success += 1;
            break;
          case ToolStatus.ERROR:
            error += 1;
            break;
          case ToolStatus.TIMEOUT:
            timeout += 1;
            break;
          case ToolStatus.CANCELLED:
            cancelled += 1;
            break;
        }
      }

      return { total, success, error, timeout, cancelled, executing, pending, waitingUser };
    },

    /** 销毁实例，清理所有定时器 */
    destroy() {
      for (const entry of entries.values()) {
        if (entry.timeoutId != null) {
          clearTimeout(entry.timeoutId);
        }
      }

      entries.clear();
      orderedIds.length = 0;
    },

    /** 清理单条记录（用于组件卸载等场景） */
    remove(id) {
      const entry = entries.get(id);

      if (entry?.timeoutId != null) {
        clearTimeout(entry.timeoutId);
      }

      entries.delete(id);

      const index = orderedIds.indexOf(id);
      if (index !== -1) {
        orderedIds.splice(index, 1);
      }
    },
  };
}

// ── 格式化工具函数 ──────────────────────────────────────────

/**
 * 将毫秒数格式化为人类可读的耗时字符串。
 *   < 1000ms → "320ms"
 *   < 60000ms → "1.2s"
 *   >= 60000ms → "2m 15s"
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return '';
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);

  return `${minutes}m ${seconds}s`;
}

/**
 * 从工具调用记录中提取格式化耗时。
 * @param {{ startedAt?: number, endedAt?: number }} entry
 * @returns {string}
 */
export function getToolDuration(entry) {
  if (!entry?.startedAt || !entry?.endedAt) {
    return '';
  }

  return formatDuration(entry.endedAt - entry.startedAt);
}

// ── 工具时间间隔分组 ──────────────────────────────────────

/**
 * 默认分组间隔：5 秒
 */
export const DEFAULT_TOOL_GROUP_GAP_MS = 5000;

/**
 * 按执行时间将工具日志分组。
 *
 * 规则：
 *   1. 按 startedAt 升序排列（防御性拷贝）
 *   2. 相邻两个工具的 startedAt 差值 ≤ maxGapMs 时归入同一组
 *   3. 组内保持时间顺序
 *
 * @param {Array<{ id: string, startedAt: number }>} logs  — 工具日志条目
 * @param {number} [maxGapMs=5000]                          — 最大分组间隔 (毫秒)
 * @returns {Array<Array>}  — 分组结果，每组是一个条目数组
 */
export function groupToolsByInterval(logs, maxGapMs = DEFAULT_TOOL_GROUP_GAP_MS) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return [];
  }

  const sorted = [...logs].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));

  const groups = [];
  let currentGroup = [sorted[0]];

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const current = sorted[i];
    const gap = (current.startedAt || 0) - (prev.startedAt || 0);

    if (gap <= maxGapMs) {
      currentGroup.push(current);
    } else {
      groups.push(currentGroup);
      currentGroup = [current];
    }
  }

  groups.push(currentGroup);
  return groups;
}

/**
 * 获取工具组的聚合状态。
 * 优先级: EXECUTING > ERROR > SUCCESS > 其他
 *
 * @param {Array<{ status: string }>} group — 同一组内的工具条目
 * @returns {{ status: string, hasExecuting: boolean, hasError: boolean }}
 */
export function getGroupAggregateStatus(group) {
  if (!Array.isArray(group) || group.length === 0) {
    return { status: ToolStatus.PENDING, hasExecuting: false, hasError: false };
  }

  let hasExecuting = false;
  let hasWaitingUser = false;
  let hasError = false;
  let allSuccess = true;

  for (const entry of group) {
    const s = entry.status || ToolStatus.PENDING;
    if (s === ToolStatus.EXECUTING) hasExecuting = true;
    if (s === ToolStatus.WAITING_USER) hasWaitingUser = true;
    if (s === ToolStatus.ERROR || s === ToolStatus.TIMEOUT) hasError = true;
    if (s !== ToolStatus.SUCCESS) allSuccess = false;
  }

  if (hasExecuting) return { status: ToolStatus.EXECUTING, hasExecuting: true, hasError };
  if (hasWaitingUser) return { status: ToolStatus.WAITING_USER, hasExecuting: false, hasError };
  if (hasError) return { status: ToolStatus.ERROR, hasExecuting: false, hasError: true };
  if (allSuccess) return { status: ToolStatus.SUCCESS, hasExecuting: false, hasError: false };
  return { status: ToolStatus.PENDING, hasExecuting: false, hasError: false };
}
