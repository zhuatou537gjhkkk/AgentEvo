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
    working: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    episodic: 'bg-blue-100 text-blue-800 border-blue-200',
    semantic: 'bg-purple-100 text-purple-800 border-purple-200',
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
                    <div className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200">
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
                    className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
                />
                <button
                    type="submit"
                    className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
                >
                    搜索
                </button>
                {filterType && (
                    <button
                        type="button"
                        onClick={() => { setFilterType(''); setSearchQuery(''); }}
                        className="px-2 py-1.5 text-xs text-gray-500 hover:text-gray-700"
                    >
                        清除筛选
                    </button>
                )}
            </form>

            {/* 操作按钮 */}
            <div className="flex gap-2">
                <button
                    onClick={handleConsolidate}
                    className="px-3 py-1.5 text-xs bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors"
                >
                    🔄 记忆巩固
                </button>
                <button
                    onClick={handleClear}
                    className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                        confirmClear
                            ? 'bg-red-600 text-white animate-pulse'
                            : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                    }`}
                >
                    {confirmClear ? '⚠️ 确认清空？' : '🗑 清空记忆'}
                </button>
            </div>

            {/* 巩固结果 */}
            {consolidateResult && (
                <div className="px-3 py-2 rounded-lg text-xs bg-green-50 text-green-700 border border-green-200">
                    巩固完成: {consolidateResult.consolidated} 条从 {consolidateResult.from_type || 'working'} → {consolidateResult.to_type || 'episodic'}
                </div>
            )}

            {/* 记忆列表 */}
            <div className="space-y-2 max-h-80 overflow-y-auto">
                {isMemoryLoading ? (
                    <div className="text-center text-sm text-gray-400 py-6">加载中...</div>
                ) : memories.length === 0 ? (
                    <div className="text-center text-sm text-gray-400 py-6">
                        {searchQuery || filterType ? '没有匹配的记忆' : '暂无记忆，开始对话后会自动记录'}
                    </div>
                ) : (
                    memories.map((mem) => (
                        <div
                            key={mem.id || mem._id}
                            className={`flex items-start gap-2 p-3 rounded-lg border ${
                                TYPE_COLORS[mem.memory_type] || 'bg-gray-50 border-gray-200'
                            }`}
                        >
                            <div className="flex-1 min-w-0">
                                <p className="text-sm text-gray-800 leading-relaxed break-words">
                                    {mem.content}
                                </p>
                                <div className="flex gap-2 mt-1 text-xs text-gray-500">
                                    <span>{TYPE_LABELS[mem.memory_type] || mem.memory_type}</span>
                                    <span>重要性: {typeof mem.importance === 'number' ? mem.importance.toFixed(1) : '-'}</span>
                                    {mem.relevanceScore != null && (
                                        <span>相关性: {mem.relevanceScore.toFixed(2)}</span>
                                    )}
                                </div>
                            </div>
                            <button
                                onClick={() => handleDelete(mem.id)}
                                className="shrink-0 p-1 text-gray-400 hover:text-red-500 transition-colors text-xs"
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
