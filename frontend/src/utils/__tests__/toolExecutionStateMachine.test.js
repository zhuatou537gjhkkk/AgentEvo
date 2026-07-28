import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ToolStatus,
  createToolCallEntry,
  createToolExecutionStateMachine,
  canTransition,
  getNextStatus,
  isTerminalStatus,
  formatDuration,
  getToolDuration,
} from '../toolExecutionStateMachine';

// ── 辅助 ───────────────────────────────────────────────────

function createFreshFSM(config) {
  return createToolExecutionStateMachine({ timeoutMs: 30000, maxRetries: 3, ...config });
}

// ── 1. 合法转移 ────────────────────────────────────────────

describe('合法状态转移', () => {
  it('PENDING → EXECUTING', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'test', {});
    const result = fsm.start('t1');
    expect(result).not.toBeNull();
    expect(result.status).toBe(ToolStatus.EXECUTING);
  });

  it('EXECUTING → SUCCESS', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    const result = fsm.end('t1', 'done');
    expect(result).not.toBeNull();
    expect(result.status).toBe(ToolStatus.SUCCESS);
    expect(result.output).toBe('done');
  });

  it('EXECUTING → ERROR', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    const result = fsm.error('t1', 'something broke');
    expect(result).not.toBeNull();
    expect(result.status).toBe(ToolStatus.ERROR);
    expect(result.error).toBe('something broke');
  });

  it('EXECUTING → TIMEOUT', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    const result = fsm.timeout('t1', 'timed out');
    expect(result).not.toBeNull();
    expect(result.status).toBe(ToolStatus.TIMEOUT);
    expect(result.error).toBe('timed out');
  });

  it('EXECUTING → CANCELLED', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    const result = fsm.cancel('t1');
    expect(result).not.toBeNull();
    expect(result.status).toBe(ToolStatus.CANCELLED);
  });

  it('PENDING → CANCELLED', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'test', {});
    const result = fsm.cancel('t1');
    expect(result).not.toBeNull();
    expect(result.status).toBe(ToolStatus.CANCELLED);
  });

  it('ERROR → EXECUTING (retry)', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    fsm.error('t1', 'fail');
    const result = fsm.retry('t1');
    expect(result).not.toBeNull();
    expect(result.status).toBe(ToolStatus.EXECUTING);
    expect(result.retryCount).toBe(1);
  });

  it('TIMEOUT → EXECUTING (retry)', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    fsm.timeout('t1', 'too slow');
    const result = fsm.retry('t1');
    expect(result).not.toBeNull();
    expect(result.status).toBe(ToolStatus.EXECUTING);
    expect(result.retryCount).toBe(1);
  });
});

// ── 2. 守卫拒绝 ────────────────────────────────────────────

describe('守卫：非法转移应被拒绝', () => {
  it('PENDING → end 被拒', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'test', {});
    const result = fsm.end('t1', 'nope');
    expect(result).toBeNull();
  });

  it('PENDING → error 被拒', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'test', {});
    const result = fsm.error('t1', 'nope');
    expect(result).toBeNull();
  });

  it('SUCCESS → 任何事件被拒', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    fsm.end('t1', 'ok');
    expect(fsm.error('t1', 'no')).toBeNull();
    expect(fsm.timeout('t1', 'no')).toBeNull();
    expect(fsm.cancel('t1')).toBeNull();
    expect(fsm.retry('t1')).toBeNull();
  });

  it('CANCELLED → 任何事件被拒', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    fsm.cancel('t1');
    expect(fsm.end('t1', 'no')).toBeNull();
    expect(fsm.error('t1', 'no')).toBeNull();
    expect(fsm.retry('t1')).toBeNull();
  });

  it('不存在的 id 返回 null', () => {
    const fsm = createFreshFSM();
    expect(fsm.get('ghost')).toBeNull();
    expect(fsm.start('ghost')).toBeNull();
  });
});

// ── 3. 重试上限 ────────────────────────────────────────────

describe('重试上限', () => {
  it('retryCount 递增正确', () => {
    const fsm = createFreshFSM({ maxRetries: 3 });
    fsm.create('t1', 'test', {});
    fsm.start('t1');

    let entry = fsm.error('t1', 'fail');
    expect(entry.retryCount).toBe(0);

    entry = fsm.retry('t1');
    expect(entry.retryCount).toBe(1);

    entry = fsm.error('t1', 'fail again');
    entry = fsm.retry('t1');
    expect(entry.retryCount).toBe(2);

    entry = fsm.error('t1', 'fail again');
    entry = fsm.retry('t1');
    expect(entry.retryCount).toBe(3);

    // 超过上限
    entry = fsm.error('t1', 'final fail');
    const retryResult = fsm.retry('t1');
    expect(retryResult).toBeNull();
  });

  it('maxRetries=0 不允许重试', () => {
    const fsm = createFreshFSM({ maxRetries: 0 });
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    fsm.error('t1', 'fail');
    expect(fsm.retry('t1')).toBeNull();
  });
});

// ── 4. 超时调度 ────────────────────────────────────────────

describe('超时调度', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start 后启动超时定时器，到期后自动 TIMEOUT', () => {
    const onChange = vi.fn();
    const fsm = createFreshFSM({ timeoutMs: 5000, onChange });
    fsm.create('t1', 'test', {});
    fsm.start('t1');

    expect(fsm.get('t1').status).toBe(ToolStatus.EXECUTING);

    vi.advanceTimersByTime(5000);

    const entry = fsm.get('t1');
    expect(entry.status).toBe(ToolStatus.TIMEOUT);
    expect(entry.error).toBeTruthy();
    expect(onChange).toHaveBeenCalled();
  });

  it('end 之后清除超时定时器', () => {
    const fsm = createFreshFSM({ timeoutMs: 5000 });
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    fsm.end('t1', 'quick');
    const entry = fsm.get('t1');

    vi.advanceTimersByTime(5000);

    // 终态不应被 timeout 再次改变
    expect(fsm.get('t1').status).toBe(ToolStatus.SUCCESS);
  });

  it('destroy 清除所有定时器', () => {
    const fsm = createFreshFSM({ timeoutMs: 5000 });
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    fsm.create('t2', 'test2', {});
    fsm.start('t2');
    fsm.destroy();

    vi.advanceTimersByTime(5000);

    // destroy 后 getAll 返回空
    expect(fsm.getAll()).toHaveLength(0);
  });

  it('perToolTimeout 按工具名定制超时', () => {
    const customMap = new Map([['slow_tool', 60000]]);
    const fsm = createFreshFSM({ timeoutMs: 5000, perToolTimeout: customMap });
    fsm.create('t1', 'slow_tool', {});
    fsm.start('t1');

    vi.advanceTimersByTime(5000);
    expect(fsm.get('t1').status).toBe(ToolStatus.EXECUTING); // 还没到 60s

    vi.advanceTimersByTime(55000);
    expect(fsm.get('t1').status).toBe(ToolStatus.TIMEOUT);
  });
});

// ── 5. 批量操作 ────────────────────────────────────────────

describe('批量操作', () => {
  it('cancelAll 只取消非终态工具', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'a', {}); // PENDING
    fsm.create('t2', 'b', {});
    fsm.start('t2'); // EXECUTING
    fsm.create('t3', 'c', {});
    fsm.start('t3');
    fsm.end('t3', 'done'); // SUCCESS — 终态

    const cancelled = fsm.cancelAll();
    expect(cancelled).toHaveLength(2);
    expect(fsm.get('t1').status).toBe(ToolStatus.CANCELLED);
    expect(fsm.get('t2').status).toBe(ToolStatus.CANCELLED);
    expect(fsm.get('t3').status).toBe(ToolStatus.SUCCESS); // 不受影响
  });

  it('create 重复 id 去重（返回已存在记录）', () => {
    const fsm = createFreshFSM();
    const first = fsm.create('t1', 'a', { x: 1 });
    const second = fsm.create('t1', 'b', { x: 2 });
    expect(first.input).toEqual({ x: 1 });
    expect(second.input).toEqual({ x: 1 });
  });

  it('remove 清理 id 和定时器', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    fsm.remove('t1');
    expect(fsm.get('t1')).toBeNull();
    expect(fsm.getAll()).toHaveLength(0);
  });

  it('remove 不存在 id 不抛异常', () => {
    const fsm = createFreshFSM();
    expect(() => fsm.remove('ghost')).not.toThrow();
  });
});

// ── 6. 有序迭代 ────────────────────────────────────────────

describe('有序迭代', () => {
  it('getAll 保持插入顺序', () => {
    const fsm = createFreshFSM();
    fsm.create('c', 'third', {});
    fsm.create('a', 'first', {});
    fsm.create('b', 'second', {});
    const all = fsm.getAll();
    expect(all[0].id).toBe('c');
    expect(all[1].id).toBe('a');
    expect(all[2].id).toBe('b');
  });
});

// ── 7. 统计 ────────────────────────────────────────────────

describe('统计信息', () => {
  it('getStats 各状态计数正确', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'a', {}); // PENDING
    fsm.create('t2', 'b', {});
    fsm.start('t2'); // EXECUTING
    fsm.create('t3', 'c', {});
    fsm.start('t3');
    fsm.end('t3', 'ok'); // SUCCESS
    fsm.create('t4', 'd', {});
    fsm.start('t4');
    fsm.error('t4', 'oops'); // ERROR

    const stats = fsm.getStats();
    expect(stats.total).toBe(4);
    expect(stats.pending).toBe(1);
    expect(stats.executing).toBe(1);
    expect(stats.success).toBe(1);
    expect(stats.error).toBe(1);
  });
});

// ── 8. onChange 回调 ───────────────────────────────────────

describe('onChange 回调', () => {
  it('合法转移后调用回调', () => {
    const onChange = vi.fn();
    const fsm = createFreshFSM({ onChange });
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    expect(onChange).toHaveBeenCalledTimes(1);
    fsm.end('t1', 'ok');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('守卫拒绝时不调用回调', () => {
    const onChange = vi.fn();
    const fsm = createFreshFSM({ onChange });
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    onChange.mockClear();
    fsm.end('t1', 'ok');
    onChange.mockClear();

    fsm.error('t1', 'no'); // SUCCESS → ERROR 非法
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ── 9. 边界 ────────────────────────────────────────────────

describe('边界情况', () => {
  it('end 空 output', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    const result = fsm.end('t1', '');
    expect(result.status).toBe(ToolStatus.SUCCESS);
    expect(result.output).toBe('');
  });

  it('快速连续转移不抛异常', () => {
    const fsm = createFreshFSM();
    fsm.create('t1', 'test', {});
    expect(() => {
      fsm.start('t1');
      fsm.end('t1', 'ok');
      fsm.end('t1', 'double'); // 第二次被拒
    }).not.toThrow();
  });

  it('retry 后重新执行流程 (retry → error → retry)', () => {
    const fsm = createFreshFSM({ maxRetries: 3 });
    fsm.create('t1', 'test', {});
    fsm.start('t1');
    fsm.error('t1', 'fail');
    fsm.retry('t1');
    // 重试后应可再次 error
    const result = fsm.error('t1', 'fail again');
    expect(result).not.toBeNull();
    expect(result.status).toBe(ToolStatus.ERROR);
  });
});

// ── 10. 纯函数 ─────────────────────────────────────────────

describe('纯函数', () => {
  it('canTransition 判断正确', () => {
    expect(canTransition(ToolStatus.EXECUTING, 'end')).toBe(true);
    expect(canTransition(ToolStatus.SUCCESS, 'end')).toBe(false);
    expect(canTransition('bogus', 'start')).toBe(false);
  });

  it('getNextStatus 返回正确状态', () => {
    expect(getNextStatus(ToolStatus.PENDING, 'start')).toBe(ToolStatus.EXECUTING);
    expect(() => getNextStatus(ToolStatus.SUCCESS, 'start')).toThrow();
  });

  it('isTerminalStatus 正确识别终态', () => {
    expect(isTerminalStatus(ToolStatus.SUCCESS)).toBe(true);
    expect(isTerminalStatus(ToolStatus.CANCELLED)).toBe(true);
    expect(isTerminalStatus(ToolStatus.EXECUTING)).toBe(false);
    expect(isTerminalStatus(ToolStatus.ERROR)).toBe(false);
  });

  it('createToolCallEntry 创建默认记录', () => {
    const entry = createToolCallEntry('id1', 'web_search', { q: 'hello' }, 1000);
    expect(entry.id).toBe('id1');
    expect(entry.name).toBe('web_search');
    expect(entry.status).toBe(ToolStatus.PENDING);
    expect(entry.startedAt).toBe(1000);
    expect(entry.retryCount).toBe(0);
    expect(entry.error).toBeNull();
  });
});

// ── 11. formatDuration / getToolDuration ───────────────────

describe('格式化耗时', () => {
  it('formatDuration 毫秒级', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(320)).toBe('320ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('formatDuration 秒级', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(59999)).toBe('60.0s');
  });

  it('formatDuration 分钟级', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
    expect(formatDuration(125000)).toBe('2m 5s');
    expect(formatDuration(135000)).toBe('2m 15s');
  });

  it('formatDuration 非法输入', () => {
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(NaN)).toBe('');
    expect(formatDuration(Infinity)).toBe('');
  });

  it('getToolDuration 从记录提取耗时', () => {
    const entry = { startedAt: 1000, endedAt: 2320 };
    expect(getToolDuration(entry)).toBe('1.3s');
  });

  it('getToolDuration 缺少字段返回空', () => {
    expect(getToolDuration(null)).toBe('');
    expect(getToolDuration({})).toBe('');
    expect(getToolDuration({ startedAt: 1000 })).toBe('');
  });
});
