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

export default function MemoryPanel() {
    const {
        memories,
        memoryStats,
        isMemoryLoading,
        fetchMemories,
        fetchMemoryStats,
        deleteMemory,
        clearMemories,
        consolidateMemories,
    } = useChatStore();

    const [searchQuery, setSearchQuery] = useState('');
    const [filterType, setFilterType] = useState('');
    const [consolidateResult, setConsolidateResult] = useState(null);
    const [confirmClear, setConfirmClear] = useState(false);

    const load = useCallback(() => {
        fetchMemories(searchQuery, filterType, 50);
        fetchMemoryStats();
    }, [searchQuery, filterType]);

    useEffect(() => {
        load();
    }, [load]);

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

    return (
        <div className="memory-panel space-y-4">
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
                            {TYPE_LABELS[type]}: {memoryStats.byType[type] || 0}
                        </div>
                    ))}
                    <div className="surface-subtle px-3 py-1.5 rounded-lg text-xs font-medium text-[var(--text-main)]">
                        总计: {memoryStats.total}
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
                            <div className="flex-1 min-w-0">
                                <p className="text-sm leading-relaxed break-words text-[var(--text-main)]">
                                    {mem.content}
                                </p>
                                <div className="flex gap-2 mt-1 text-xs text-[var(--text-muted)]">
                                    <span>{TYPE_LABELS[mem.memory_type] || mem.memory_type}</span>
                                    <span>重要性: {typeof mem.importance === 'number' ? mem.importance.toFixed(1) : '-'}</span>
                                    {mem.relevanceScore != null && (
                                        <span>相关性: {mem.relevanceScore.toFixed(2)}</span>
                                    )}
                                </div>
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
