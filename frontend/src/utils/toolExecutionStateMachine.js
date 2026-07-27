/**
 * 工具执行状态机 (Tool Execution FSM)
 *
 * 状态定义:
 *   PENDING    — 已入队，等待执行
 *   EXECUTING  — 正在执行
 *   SUCCESS    — 执行成功 (终态)
 *   ERROR      — 执行失败
 *   TIMEOUT    — 执行超时
 *   CANCELLED  — 被用户取消 (终态)
 *
 * 状态转移:
 *   PENDING    ──(start)──→ EXECUTING
 *   EXECUTING  ──(end)────→ SUCCESS
 *   EXECUTING  ──(error)──→ ERROR
 *   EXECUTING  ──(timeout)─→ TIMEOUT
 *   EXECUTING  ──(cancel)──→ CANCELLED
 *   ERROR      ──(retry)──→ EXECUTING   (retryCount++)
 *   TIMEOUT    ──(retry)──→ EXECUTING   (retryCount++)
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
    [Event.ERROR]: ToolStatus.ERROR,
    [Event.TIMEOUT]: ToolStatus.TIMEOUT,
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

  function stampEnd(entry, status) {
    const updated = { ...entry, status, endedAt: Date.now() };

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
      updatedEntry = stampEnd(entry, nextStatus);
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
    create(id, name, input) {
      if (entries.has(id)) {
        return entries.get(id);
      }

      const entry = createToolCallEntry(id, name, input);
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
    end(id, output) {
      return transition(id, Event.END, { output });
    },

    /** EXECUTING -> ERROR */
    error(id, err) {
      return transition(id, Event.ERROR, {
        error: String(err || '未知错误'),
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
          entry.status === ToolStatus.EXECUTING
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

      for (const entry of entries.values()) {
        total += 1;

        switch (entry.status) {
          case ToolStatus.PENDING:
            pending += 1;
            break;
          case ToolStatus.EXECUTING:
            executing += 1;
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

      return { total, success, error, timeout, cancelled, executing, pending };
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
