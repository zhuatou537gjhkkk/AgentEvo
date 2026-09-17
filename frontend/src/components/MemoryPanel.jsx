/**
 * MemoryPanel — 记忆管理面板 (Phase 4)
 *
 * 功能：
 * - 显示记忆统计（working/episodic/semantic 分布）
 * - 搜索/浏览记忆条目
 * - 删除/清空记忆
 * - 手动触发记忆巩固
 */

import { useState, useEffect, useCallback } from 'react';
import { useChatStore } from '../store/chatStore';
import { shallow } from 'zustand/shallow';

const TYPE_LABELS = {
    working: '⚡ 工作记忆',
    episodic: '📖 情景记忆',
    semantic: '🧠 语义记忆',
};

const TYPE_COLORS = {
    working: 'memory-type-working',
    episodic: 'memory-type-episodic',
    semantic: 'memory-type-semantic',
};

const STATUS_LABELS = {
    pending: '待确认',
    active: '正在使用',
    rejected: '已拒绝',
    superseded: '已被替代',
    invalidated: '已失效',
};

const CATEGORY_LABELS = {
    fact: '稳定事实',
    preference: '用户偏好',
    constraint: '长期约束',
    goal: '持续目标',
    event: '关键事件',
    uncategorized: '未分类',
};

const RELATION_LABELS = {
    independent: '独立记忆',
    duplicate: '重复内容',
    supplement: '补充信息',
    conflict: '偏好变更',
    expiration: '旧信息过期',
};

export default function MemoryPanel({ onOpenSourceSession } = {}) {
    // Do not subscribe to the whole chat store here. Opening Settings mounts
    // this panel while chat streaming/message updates may still be active; a
    // whole-store subscription causes every unrelated chat update to rerender
    // the memory list and can make the modal appear frozen.
    const {
        memories,
        memoryStats,
        isMemoryLoading,
        memoryError,
        fetchMemories,
        fetchMemoryStats,
        fetchMemoryRetention,
        runMemoryRetention,
        exportMemories,
        fetchMemoryLineage,
        batchUpdateMemories,
        switchSession,
        deleteMemory,
        updateMemory,
        clearMemories,
        consolidateMemories,
    } = useChatStore((state) => ({
        memories: Array.isArray(state.memories) ? state.memories : [],
        memoryStats: state.memoryStats,
        isMemoryLoading: state.isMemoryLoading,
        memoryError: state.memoryError,
        fetchMemories: state.fetchMemories,
        fetchMemoryStats: state.fetchMemoryStats,
        fetchMemoryRetention: state.fetchMemoryRetention,
        runMemoryRetention: state.runMemoryRetention,
        exportMemories: state.exportMemories,
        fetchMemoryLineage: state.fetchMemoryLineage,
        batchUpdateMemories: state.batchUpdateMemories,
        switchSession: state.switchSession,
        deleteMemory: state.deleteMemory,
        updateMemory: state.updateMemory,
        clearMemories: state.clearMemories,
        consolidateMemories: state.consolidateMemories,
    }), shallow);

    const [searchQuery, setSearchQuery] = useState('');
    const [filterType, setFilterType] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [consolidateResult, setConsolidateResult] = useState(null);
    const [confirmClear, setConfirmClear] = useState(false);
    const [expandedLineageId, setExpandedLineageId] = useState(null);
    const [lineageById, setLineageById] = useState({});
    const [selectedIds, setSelectedIds] = useState(() => new Set());
    const [batchLoading, setBatchLoading] = useState(false);
    const [retentionInfo, setRetentionInfo] = useState(null);
    const [retentionResult, setRetentionResult] = useState(null);

    const load = useCallback(() => {
        fetchMemories(searchQuery, filterType, 50, statusFilter);
        fetchMemoryStats();
    }, [fetchMemories, fetchMemoryStats, searchQuery, filterType, statusFilter]);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        setSelectedIds(new Set());
    }, [searchQuery, filterType, statusFilter]);

    useEffect(() => {
        fetchMemoryRetention().then(setRetentionInfo);
    }, []);

    const handleDelete = async (id) => {
        await deleteMemory(id);
        fetchMemoryStats();
    };

    const handleClear = async () => {
        if (!confirmClear) {
            setConfirmClear(true);
            setTimeout(() => setConfirmClear(false), 5000);
            return;
        }
        await clearMemories();
        setConfirmClear(false);
    };

    const handleConsolidate = async () => {
        setConsolidateResult(null);
        const result = await consolidateMemories('working', 'episodic', 0.7);
        if (result) {
            setConsolidateResult(result);
            load();
        }
    };

    const handleSearch = (e) => {
        e.preventDefault();
        load();
    };

    const handleRetention = async () => {
        const result = await runMemoryRetention(false);
        if (result) {
            setRetentionResult(result);
            load();
        }
    };

    const handleExport = async () => {
        const data = await exportMemories();
        if (!data) return;
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `agentevo-memory-export-${new Date().toISOString().slice(0, 10)}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
    };

    const handleLifecycle = async (id, action) => {
        await updateMemory(id, { action });
        load();
    };

    const handleEdit = async (memory) => {
        const content = window.prompt('编辑记忆内容', memory.content);
        if (content && content.trim() && content.trim() !== memory.content) {
            await updateMemory(memory.id, { action: 'update', content: content.trim() });
            load();
        }
    };

    const handleToggleLineage = async (memoryId) => {
        if (expandedLineageId === memoryId) {
            setExpandedLineageId(null);
            return;
        }
        setExpandedLineageId(memoryId);
        if (!lineageById[memoryId]) {
            const result = await fetchMemoryLineage(memoryId);
            if (result) setLineageById((current) => ({ ...current, [memoryId]: result }));
        }
    };

    const toggleSelected = (memoryId) => {
        setSelectedIds((current) => {
            const next = new Set(current);
            if (next.has(memoryId)) next.delete(memoryId);
            else next.add(memoryId);
            return next;
        });
    };

    const handleBatch = async (action) => {
        const ids = [...selectedIds];
        if (ids.length === 0) return;
        setBatchLoading(true);
        try {
            await batchUpdateMemories(ids, action);
            setSelectedIds(new Set());
            load();
        } finally {
            setBatchLoading(false);
        }
    };

    const pendingVisibleIds = memories.filter((memory) => memory.status === 'pending').map((memory) => memory.id);
    const allPendingSelected = pendingVisibleIds.length > 0 && pendingVisibleIds.every((id) => selectedIds.has(id));
    const toggleAllPending = () => {
        setSelectedIds((current) => {
            const next = new Set(current);
            if (allPendingSelected) pendingVisibleIds.forEach((id) => next.delete(id));
            else pendingVisibleIds.forEach((id) => next.add(id));
            return next;
        });
    };

    return (
            <div className="memory-panel space-y-4">
            {memoryError && (
                <div className="rounded-lg border border-[var(--status-danger)]/30 bg-[var(--status-danger-soft)] px-3 py-2 text-xs text-[var(--text-main)]" role="alert">
                    <span>{memoryError}</span>
                    <button type="button" onClick={load} className="ml-2 underline">重试</button>
                </div>
            )}
            {/* 统计概览 */}
            {memoryStats && (
                <div className="flex gap-2 flex-wrap">
                    {['working', 'episodic', 'semantic'].map((type) => (
                        <div
                            key={type}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium border cursor-pointer transition-opacity hover:opacity-80 ${
                                filterType === type ? 'ring-2 ring-blue-400' : ''
                            } ${TYPE_COLORS[type]}`}
                            onClick={() => setFilterType(filterType === type ? '' : type)}
                        >
                            {TYPE_LABELS[type]}: {memoryStats?.byType?.[type] || 0}
                        </div>
                    ))}
                    <div className="surface-subtle px-3 py-1.5 rounded-lg text-xs font-medium text-[var(--text-main)]">
                        总计: {memoryStats?.total || 0}
                    </div>
                </div>
            )}

            {/* 搜索栏 */}
            <form onSubmit={handleSearch} className="flex gap-2">
                <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜索记忆..."
                    className="ui-input flex-1 px-3 py-1.5 text-sm"
                />
                <button
                    type="submit"
                    className="ui-button-primary px-3 py-1.5 text-sm"
                >
                    搜索
                </button>
                {filterType && (
                    <button
                        type="button"
                        onClick={() => { setFilterType(''); setSearchQuery(''); }}
                        className="ui-button-ghost px-2 py-1.5 text-xs"
                    >
                        清除筛选
                    </button>
                )}
            </form>

            {/* 操作按钮 */}
            <div className="flex gap-2">
                <button
                    onClick={handleConsolidate}
                    className="ui-button-primary px-3 py-1.5 text-xs"
                >
                    🔄 记忆巩固
                </button>
                <button
                    onClick={handleRetention}
                    className="ui-button-ghost px-3 py-1.5 text-xs"
                >
                    🧹 运行保留清理
                </button>
                <button
                    onClick={handleExport}
                    className="ui-button-ghost px-3 py-1.5 text-xs"
                >
                    ⇩ 导出记忆
                </button>
                <button
                    onClick={handleClear}
                    className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                        confirmClear
                            ? 'ui-button-primary bg-[var(--status-danger)] animate-pulse'
                            : 'ui-button-secondary text-[var(--text-muted)]'
                    }`}
                >
                    {confirmClear ? '⚠️ 确认清空？' : '🗑 清空记忆'}
                </button>
            </div>

            <div className="surface-subtle rounded-lg px-3 py-2 text-xs text-[var(--text-muted)]">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-[var(--text-main)]">保留策略</span>
                    {retentionInfo?.enabled ? (
                        <span>已启用 · 待确认 {retentionInfo.policy.pendingTtlDays} 天 · 工作记忆 {retentionInfo.policy.workingTtlDays} 天</span>
                    ) : (
                        <span>自动保留策略未启用</span>
                    )}
                </div>
                {retentionResult && (
                    <div className="mt-1">
                        {retentionResult.dryRun ? '预览' : '清理'}完成：扫描 {retentionResult.scanned} 条，软失效 {retentionResult.invalidated} 条
                    </div>
                )}
            </div>

            {/* 生命周期筛选 */}
            <div className="flex gap-1 flex-wrap">
                {[
                    ['all', '全部'],
                    ['pending', '待确认'],
                    ['active', '正在使用'],
                    ['superseded,invalidated,rejected', '历史状态'],
                ].map(([value, label]) => (
                    <button
                        key={value}
                        type="button"
                        onClick={() => setStatusFilter(value)}
                        className={`px-2 py-1 rounded text-xs ${statusFilter === value ? 'ui-button-primary' : 'ui-button-ghost'}`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {pendingVisibleIds.length > 0 && (
                <div className="surface-subtle flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs">
                    <label className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
                        <input type="checkbox" checked={allPendingSelected} onChange={toggleAllPending} />
                        全选待确认
                    </label>
                    <span className="text-[var(--text-muted)]">已选 {selectedIds.size} 条</span>
                    <button type="button" disabled={selectedIds.size === 0 || batchLoading} onClick={() => handleBatch('approve')} className="ui-button-primary px-2 py-1 text-xs disabled:opacity-50">
                        批量批准
                    </button>
                    <button type="button" disabled={selectedIds.size === 0 || batchLoading} onClick={() => handleBatch('reject')} className="ui-button-ghost px-2 py-1 text-xs disabled:opacity-50">
                        批量拒绝
                    </button>
                </div>
            )}

            {/* 巩固结果 */}
            {consolidateResult && (
                <div className="status-badge-success rounded-lg px-3 py-2 text-xs">
                    巩固完成: {consolidateResult.consolidated} 条从 {consolidateResult.from_type || 'working'} → {consolidateResult.to_type || 'episodic'}
                </div>
            )}

            {/* 记忆列表 */}
            <div className="space-y-2 max-h-80 overflow-y-auto">
                {isMemoryLoading ? (
                    <div className="py-6 text-center text-sm text-[var(--text-muted)]">加载中...</div>
                ) : memories.length === 0 ? (
                    <div className="py-6 text-center text-sm text-[var(--text-muted)]">
                        {searchQuery || filterType ? '没有匹配的记忆' : '暂无记忆，开始对话后会自动记录'}
                    </div>
                ) : (
                    memories.map((mem) => (
                        <div
                            key={mem.id || mem._id}
                            className={`surface-subtle flex items-start gap-2 p-3 rounded-lg ${
                                TYPE_COLORS[mem.memory_type] || 'memory-type-neutral'
                            }`}
                        >
                            {mem.status === 'pending' && (
                                <input
                                    type="checkbox"
                                    checked={selectedIds.has(mem.id)}
                                    onChange={() => toggleSelected(mem.id)}
                                    className="mt-1 shrink-0"
                                    aria-label={`选择记忆 ${mem.id}`}
                                />
                            )}
                            <div className="flex-1 min-w-0">
                                <p className="text-sm leading-relaxed break-words text-[var(--text-main)]">
                                    {mem.content}
                                </p>
                                <div className="flex gap-2 mt-1 text-xs text-[var(--text-muted)]">
                                    <span>{TYPE_LABELS[mem.memory_type] || mem.memory_type}</span>
                                    <span>{STATUS_LABELS[mem.status] || mem.status || '正在使用'}</span>
                                    {mem.source && <span>来源: {mem.source}</span>}
                                    <span>重要性: {typeof mem.importance === 'number' ? mem.importance.toFixed(1) : '-'}</span>
                                    {mem.confidence != null && <span>置信度: {Number(mem.confidence).toFixed(1)}</span>}
                                    {mem.relevanceScore != null && (
                                        <span>相关性: {mem.relevanceScore.toFixed(2)}</span>
                                    )}
                                </div>
                                <div className="flex gap-2 mt-1 text-xs text-[var(--text-muted)] flex-wrap">
                                    <span>分类: {CATEGORY_LABELS[mem.category] || mem.category || '未分类'}</span>
                                    {mem.memory_key && <span>主题键: {mem.memory_key}</span>}
                                    {mem.session_id && (
                                        <button type="button" onClick={() => onOpenSourceSession ? onOpenSourceSession(mem.session_id) : switchSession(mem.session_id)} className="text-blue-600 hover:underline">
                                            打开来源会话 #{mem.session_id}
                                        </button>
                                    )}
                                </div>
                                {mem.relation_type && mem.relation_type !== 'independent' && (
                                    <div className="mt-2 rounded-lg border border-[var(--border-color)] px-2 py-1.5 text-xs text-[var(--text-muted)]">
                                        <span className="font-medium text-[var(--text-main)]">{RELATION_LABELS[mem.relation_type] || mem.relation_type}</span>
                                        {mem.related_memory?.content && <span>：{mem.related_memory.content}</span>}
                                        {mem.status === 'pending' && ['conflict', 'expiration'].includes(mem.relation_type) && (
                                            <div className="mt-1 text-[var(--status-warning)]">批准后，关联旧记忆将变为“已被替代”。</div>
                                        )}
                                        {mem.status === 'pending' && mem.relation_type === 'supplement' && (
                                            <div className="mt-1">批准后两条记忆会同时保留。</div>
                                        )}
                                    </div>
                                )}
                                <div className="flex gap-1 mt-2 flex-wrap">
                                    {mem.status === 'pending' && (
                                        <>
                                            <button type="button" onClick={() => handleLifecycle(mem.id, 'approve')} className="ui-button-primary px-2 py-1 text-xs">批准</button>
                                            <button type="button" onClick={() => handleLifecycle(mem.id, 'reject')} className="ui-button-ghost px-2 py-1 text-xs">拒绝</button>
                                        </>
                                    )}
                                    {mem.status === 'active' && (
                                        <button type="button" onClick={() => handleLifecycle(mem.id, 'invalidate')} className="ui-button-ghost px-2 py-1 text-xs">标记失效</button>
                                    )}
                                    {mem.status === 'invalidated' && (
                                        <button type="button" onClick={() => handleLifecycle(mem.id, 'restore')} className="ui-button-primary px-2 py-1 text-xs">恢复使用</button>
                                    )}
                                    <button type="button" onClick={() => handleEdit(mem)} className="ui-button-ghost px-2 py-1 text-xs">编辑</button>
                                    <button type="button" onClick={() => updateMemory(mem.id, { action: 'update', pinned: !mem.pinned }).then(load)} className="ui-button-ghost px-2 py-1 text-xs">{mem.pinned ? '取消置顶' : '置顶'}</button>
                                    {(mem.memory_key || mem.related_memory_id || mem.supersedes_id || mem.superseded_by) && (
                                        <button type="button" onClick={() => handleToggleLineage(mem.id)} className="ui-button-ghost px-2 py-1 text-xs">
                                            {expandedLineageId === mem.id ? '收起版本链' : '查看版本链'}
                                        </button>
                                    )}
                                </div>
                                {expandedLineageId === mem.id && (
                                    <div className="mt-2 border-l-2 border-[var(--border-color)] pl-2 space-y-1 text-xs text-[var(--text-muted)]">
                                        {!lineageById[mem.id] ? (
                                            <div>正在加载版本链...</div>
                                        ) : lineageById[mem.id].chain?.map((item) => (
                                            <div key={item.id} className={item.id === mem.id ? 'text-[var(--text-main)] font-medium' : ''}>
                                                #{item.id} · {STATUS_LABELS[item.status] || item.status} · {RELATION_LABELS[item.relation_type] || item.relation_type}：{item.content}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <button
                                onClick={() => handleDelete(mem.id)}
                                className="shrink-0 p-1 text-[var(--text-muted)] hover:text-[var(--status-danger)] transition-colors text-xs"
                                title="删除此记忆"
                            >
                                ✕
                            </button>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
