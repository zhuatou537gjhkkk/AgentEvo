import { useRef, useCallback, useEffect } from 'react';
import {
  createToolExecutionStateMachine,
  createToolCallEntry,
  ToolStatus,
} from '../utils/toolExecutionStateMachine';

/**
 * React Hook: 封装工具执行状态机，提供响应式的工具调用生命周期管理。
 *
 * 核心机制:
 *   - 用 Map + 数组存储工具调用，通过 toolCallId 配对 tool_start/tool_end 事件
 *   - 自动超时标记：tool_start 后启动 setTimeout，到期自动标记 TIMEOUT
 *   - 支持手动重试、批量取消
 *
 * @param {object} config
 * @param {number} [config.timeoutMs=30000]           — 全局默认超时
 * @param {number} [config.maxRetries=3]              — 最大重试次数
 * @param {Map<string, number>} [config.perToolTimeout] — 按工具名定制超时
 * @param {(entries: object[]) => void} [config.onStateChange] — 状态变更回调 (传入全部工具记录)
 */
export function useToolExecution(config = {}) {
  const {
    timeoutMs = 30000,
    maxRetries = 3,
    perToolTimeout = new Map(),
    onStateChange,
  } = config;

  // 保持回调引用稳定
  const onChangeRef = useRef(onStateChange);
  onChangeRef.current = onStateChange;

  // 状态机实例 — 只创建一次
  const fsmRef = useRef(null);

  if (!fsmRef.current) {
    fsmRef.current = createToolExecutionStateMachine({
      timeoutMs,
      maxRetries,
      perToolTimeout,
      onChange: () => {
        // 每次状态变化，调用外部回调传递全量数据
        if (typeof onChangeRef.current === 'function') {
          onChangeRef.current(fsmRef.current.getAll());
        }
      },
    });
  }

  const fsm = fsmRef.current;

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      fsm.destroy();
      fsmRef.current = null;
    };
  }, [fsm]);

  // ── SSE 事件入口 ────────────────────────────────────

  /** 收到 tool_start 事件时调用 */
  const onToolStart = useCallback(
    (toolCallId, toolName, input) => {
      fsm.create(toolCallId, toolName, input);
      fsm.start(toolCallId);
    },
    [fsm]
  );

  /** 收到 tool_end 事件时调用 */
  const onToolEnd = useCallback(
    (toolCallId, output) => {
      fsm.end(toolCallId, output);
    },
    [fsm]
  );

  /** 收到 tool_error 事件时调用 */
  const onToolError = useCallback(
    (toolCallId, errorMessage) => {
      fsm.error(toolCallId, errorMessage);
    },
    [fsm]
  );

  /** 用户取消某个工具调用 */
  const onToolCancel = useCallback(
    (toolCallId) => {
      fsm.cancel(toolCallId);
    },
    [fsm]
  );

  // ── 主动操作 ────────────────────────────────────────

  /** 重试失败/超时的工具调用 */
  const retry = useCallback(
    (toolCallId) => {
      fsm.retry(toolCallId);
    },
    [fsm]
  );

  /** 取消所有进行中的工具调用 */
  const cancelAll = useCallback(() => {
    fsm.cancelAll();
  }, [fsm]);

  /** 获取所有工具调用记录（按时间排序） */
  const getAll = useCallback(() => {
    return fsm.getAll();
  }, [fsm]);

  /** 获取单条记录 */
  const get = useCallback(
    (toolCallId) => {
      return fsm.get(toolCallId);
    },
    [fsm]
  );

  /** 获取统计信息 */
  const getStats = useCallback(() => {
    return fsm.getStats();
  }, [fsm]);

  /** 直接暴露 fsm 实例 (用于需要 createToolCallEntry 等工具函数的场景) */
  const getFsm = useCallback(() => fsm, [fsm]);

  return {
    // SSE 事件入口
    onToolStart,
    onToolEnd,
    onToolError,
    onToolCancel,

    // 主动操作
    retry,
    cancelAll,
    getAll,
    get,
    getStats,
    getFsm,

    // 导出状态枚举和工厂函数供外部使用
    ToolStatus,
    createToolCallEntry,
  };
}
