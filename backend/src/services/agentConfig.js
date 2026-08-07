/**
 * AgentConfigService — Agent 配置运行时服务
 *
 * Phase 6a G4：对标 AgentArts 前端可配置智能体。
 *
 * 设计：
 *   - 配置存 agent_config 表（key-value）
 *   - Agent 运行时动态读取：get(key) → DB value → 代码默认值
 *   - 内存缓存 5min，减少 DB 查询
 *   - G4 阶段：只实现 get/set，G5 阶段追加版本管理
 *
 * 用法：
 *   const agentConfig = new AgentConfigService();
 *   const desc = agentConfig.get('tool.web_search.description');
 *   // → DB 中用户自定义的描述，或代码默认值
 *
 *   agentConfig.set('agent.search.instruction', '强调使用当前年份...');
 *   // → 更新 DB，清除缓存
 */

import {
    getAgentConfigValue,
    setAgentConfigValue,
    getAllAgentConfigValues,
    saveConfigSnapshot,
    listConfigVersions,
    getConfigVersion,
    updateConfigVersionLabel,
    deleteConfigVersion,
} from "../db/index.js";

/**
 * 配置键 → 代码默认值的映射
 * 新增可配置项时只需在这里加一行
 */
const DEFAULTS = {
    // ── 工具描述 ──
    "tool.web_search.description":
        "搜索互联网获取实时信息。返回搜索结果摘要。注意使用当前年份作为搜索参数。",
    "tool.search_knowledge_base.description":
        "搜索用户上传的知识库文档。输入为自然语言查询，返回相关文档片段。",
    "tool.get_system_time.description":
        "获取服务器当前的系统时间。无需参数。",
    "tool.get_db_message_count.description":
        "获取本地 SQLite 数据库中的历史对话总条数。无需参数。",
    "tool.memory.description":
        "管理用户记忆。支持的操作（通过 action 参数指定）：add-添加记忆, search-搜索记忆, consolidate-巩固记忆, forget-遗忘记忆。输入为 JSON 字符串。",

    // ── Agent 节点指令 ──
    "agent.router.instruction": "",
    "agent.search.instruction": "",
    "agent.knowledge.instruction": "",
    "agent.general.instruction": "",
    "agent.code.instruction": "",
    "agent.synthesizer.instruction": "",

    // ── 记忆策略参数 ──
    "memory.consolidateThreshold": "0.7",
    "memory.autoForgetThreshold": "0.3",
    "memory.autoForgetDays": "30",
};

// 缓存 TTL：5 分钟
const CACHE_TTL_MS = 5 * 60 * 1000;

class AgentConfigService {
    constructor() {
        /** @type {Map<string, {value: string, ts: number}>} */
        this._cache = new Map();
    }

    /**
     * 获取配置值（DB → 默认值 优先级）
     * @param {string} key
     * @returns {string}
     */
    get(key) {
        // 检查缓存
        const cached = this._cache.get(key);
        if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
            return cached.value;
        }

        // 查 DB
        try {
            const row = getAgentConfigValue(key);
            if (row && row.value !== null && row.value !== undefined) {
                this._cache.set(key, { value: row.value, ts: Date.now() });
                return row.value;
            }
        } catch (err) {
            console.warn(`[AgentConfig] get("${key}") DB error:`, err.message);
        }

        // 回退到代码默认值
        const defaultVal = DEFAULTS[key];
        if (defaultVal !== undefined) {
            this._cache.set(key, { value: defaultVal, ts: Date.now() });
            return defaultVal;
        }

        return "";
    }

    /**
     * 获取数值型配置
     * @param {string} key
     * @param {number} fallback
     * @returns {number}
     */
    getNumber(key, fallback = 0) {
        const val = this.get(key);
        const num = Number(val);
        return Number.isNaN(num) ? fallback : num;
    }

    /**
     * 获取所有配置项（含默认值）
     * @returns {Array<{key: string, value: string, default_value: string|null, description: string|null}>}
     */
    getAll() {
        try {
            const rows = getAllAgentConfigValues();
            const result = [];
            const seenKeys = new Set();

            for (const row of rows) {
                result.push(row);
                seenKeys.add(row.key);
            }

            // 补充未在 DB 中但定义了默认值的 key
            for (const [key, defaultVal] of Object.entries(DEFAULTS)) {
                if (!seenKeys.has(key)) {
                    result.push({
                        key,
                        value: defaultVal,
                        default_value: defaultVal,
                        description: null,
                        updated_at: null,
                    });
                }
            }

            return result;
        } catch (err) {
            console.warn("[AgentConfig] getAll() DB error:", err.message);
            return Object.entries(DEFAULTS).map(([key, value]) => ({
                key,
                value,
                default_value: value,
                description: null,
                updated_at: null,
            }));
        }
    }

    /**
     * 设置配置值（写入 DB + 清除缓存 + 自动版本快照）
     * @param {string} key
     * @param {string} value
     * @param {string} [description]
     * @returns {boolean} 是否成功
     */
    set(key, value, description = null, skipSnapshot = false) {
        try {
            const defaultVal = DEFAULTS[key] || null;
            const ok = setAgentConfigValue(key, value, defaultVal, description);
            if (ok) {
                // 更新缓存
                this._cache.set(key, { value: String(value), ts: Date.now() });
                // G5: 自动保存版本快照（每次变更都留痕）
                if (!skipSnapshot) {
                    try {
                        const snap = this.snapshot();
                        saveConfigSnapshot(snap, "manual");
                    } catch (vErr) {
                        console.warn("[AgentConfig] auto-version save failed:", vErr.message);
                    }
                }
            }
            return ok;
        } catch (err) {
            console.error(`[AgentConfig] set("${key}") error:`, err.message);
            return false;
        }
    }

    /**
     * 批量设置（在同一操作中修改多个配置）
     * @param {Array<{key: string, value: string}>} entries
     * @returns {{ok: number, fail: number}}
     */
    setBatch(entries, skipSnapshot = false) {
        let ok = 0;
        let fail = 0;
        for (const { key, value } of entries) {
            if (this.set(key, value, null, skipSnapshot)) ok++;
            else fail++;
        }
        return { ok, fail };
    }

    /**
     * 重置某个 key 为默认值
     * @param {string} key
     * @returns {boolean}
     */
    reset(key) {
        const defaultVal = DEFAULTS[key];
        if (defaultVal === undefined) return false;
        return this.set(key, defaultVal, "重置为默认值");
    }

    /**
     * 获取当前配置快照（所有 key → value）
     * 供 G5 版本管理使用
     * @returns {object}
     */
    snapshot() {
        const all = this.getAll();
        const snap = {};
        for (const row of all) {
            snap[row.key] = row.value;
        }
        return snap;
    }

    /**
     * 从快照恢复（供 G5 回滚使用）
     * @param {object} snap — snapshot() 的输出
     * @returns {{ok: number, fail: number}}
     */
    restore(snap) {
        if (!snap || typeof snap !== "object") return { ok: 0, fail: 0 };
        const entries = Object.entries(snap).map(([key, value]) => ({ key, value }));
        // skipSnapshot=true: restoreVersion() handles the final rollback snapshot;
        // we must NOT save one snapshot per key (would flood version history)
        return this.setBatch(entries, true);
    }

    /**
     * 列出配置版本历史
     * @param {number} [limit=20]
     * @returns {Array<{id: number, source: string, created_at: string}>}
     */
    listVersions(limit = 20) {
        try {
            return listConfigVersions(limit);
        } catch (err) {
            console.error("[AgentConfig] listVersions error:", err.message);
            return [];
        }
    }

    /**
     * 获取某个版本的完整快照
     * @param {number} id
     * @returns {{id: number, snapshot: object, source: string, created_at: string}|null}
     */
    getVersion(id) {
        try {
            return getConfigVersion(id);
        } catch (err) {
            console.error("[AgentConfig] getVersion error:", err.message);
            return null;
        }
    }

    /**
     * 回滚到指定版本
     * 回滚本身也会创建一个新版本（source=rollback），形成完整审计链
     * @param {number} versionId
     * @returns {boolean} 是否成功
     */
    restoreVersion(versionId) {
        try {
            const version = this.getVersion(versionId);
            if (!version || !version.snapshot) return false;

            // 恢复所有配置项
            const result = this.restore(version.snapshot);

            // 回滚操作本身也保存为快照
            try {
                const newSnap = this.snapshot();
                saveConfigSnapshot(newSnap, "rollback");
            } catch (vErr) {
                console.warn("[AgentConfig] rollback version save failed:", vErr.message);
            }

            return result.ok > 0;
        } catch (err) {
            console.error("[AgentConfig] restoreVersion error:", err.message);
            return false;
        }
    }

    /**
     * 重命名版本标签
     * @param {number} id
     * @param {string} label
     * @returns {boolean}
     */
    renameVersion(id, label) {
        try {
            return updateConfigVersionLabel(id, label);
        } catch (err) {
            console.error("[AgentConfig] renameVersion error:", err.message);
            return false;
        }
    }

    /**
     * 删除某个版本记录
     * @param {number} id
     * @returns {boolean}
     */
    removeVersion(id) {
        try {
            return deleteConfigVersion(id);
        } catch (err) {
            console.error("[AgentConfig] removeVersion error:", err.message);
            return false;
        }
    }

    /**
     * 清除内存缓存（强制下次 get 从 DB 重读）
     */
    clearCache() {
        this._cache.clear();
    }
}

/** 单例实例 */
const agentConfig = new AgentConfigService();

export { AgentConfigService, agentConfig, DEFAULTS };
