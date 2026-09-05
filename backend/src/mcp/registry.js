/**
 * ToolRegistry — 统一工具注册中心
 *
 * 合并本地 DynamicTool 与 MCP 远程发现的结构化工具，
 * 保持下游 LangChain API 对工具来源零感知。
 *
 * 对应 Hello-Agents: Ch10 MCP 工具发现 + 注册机制
 */

import { DynamicStructuredTool, DynamicTool } from "@langchain/core/tools";
import { connectToMCPServer } from "./client.js";
import { getRequestContext } from "../services/requestContext.js";
import { withRetry } from "../services/resilience.js";

/**
 * MCP Server 的 schema 以 JSON Schema 形式返回，直接交给
 * DynamicStructuredTool，让模型看到真实的字段名、类型和 required 约束。
 * 缺失 schema 时仍注册一个宽松 object schema，避免单个工具阻断整个 Server。
 */
function normalizeMCPInputSchema(inputSchema, serverName, toolName) {
    if (inputSchema && typeof inputSchema === "object" && inputSchema.type === "object") {
        return {
            ...inputSchema,
            properties: inputSchema.properties && typeof inputSchema.properties === "object"
                ? inputSchema.properties
                : {},
        };
    }

    if (inputSchema) {
        console.warn(`[registry] MCP tool "${serverName}/${toolName}" has unsupported inputSchema; using permissive object schema`);
    }

    return {
        type: "object",
        properties: {},
        additionalProperties: true,
    };
}

/**
 * 兼容旧的直接调用方：结构化 MCP 工具现在应接收对象，
 * 但旧的 Plan/tool_executor 路径可能仍传入字符串。
 * 这里只做确定性的格式转换，不根据语义猜测多个字段的含义。
 */
function normalizeLegacyStructuredInput(tool, input) {
    if (input !== null && typeof input === "object") return input;
    if (input === undefined || input === null) return {};
    if (typeof input !== "string") return input;

    const schema = tool?.schema || {};
    const properties = schema.properties && typeof schema.properties === "object"
        ? schema.properties
        : {};
    const propKeys = Object.keys(properties);

    // JSON 对象是最可靠的 legacy 格式，先解析再过滤 schema 合法字段。
    try {
        const parsed = JSON.parse(input);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            if (propKeys.length === 0) return parsed;
            return Object.fromEntries(Object.entries(parsed).filter(([key]) => propKeys.includes(key)));
        }
    } catch { /* 不是 JSON，继续处理旧字符串格式 */ }

    if (propKeys.length === 1) return { [propKeys[0]]: input };
    if (propKeys.includes("path")) return { path: input };

    if (input.includes("|")) {
        const parts = input.split("|");
        const assigned = {};
        propKeys.forEach((key, index) => {
            const value = parts[index]?.trim();
            if (value) assigned[key] = value;
        });
        return assigned;
    }

    const required = Array.isArray(schema.required) ? schema.required : [];
    return { [required[0] || propKeys[0] || "input"]: input };
}

class ToolRegistry {
    constructor() {
        /** @type {import("@langchain/core/tools").DynamicTool[]} */
        this._localTools = [];

        /** @type {Map<string, { client: import("@modelcontextprotocol/sdk/client/index.js").Client, tools: import("@langchain/core/tools").StructuredToolInterface[] }>} */
        this._mcpWrappers = new Map();

        /** @type {Map<string, Promise>} 连接进行中，防止并发重复连接 */
        this._pendingConnections = new Map();
    }

    /**
     * 注册本地 DynamicTool 实例（模块加载时自动调用）。
     * 直接存储原始实例，不做任何包装。
     * @param {import("@langchain/core/tools").DynamicTool[]} tools
     */
    registerLocalTools(tools) {
        if (!Array.isArray(tools)) return;
        for (const tool of tools) {
            if (!(tool instanceof DynamicTool)) {
                console.warn(`[registry] skipping non-DynamicTool: ${tool?.name || "unnamed"}`);
                continue;
            }
            // 避免重复注册
            if (this._localTools.some(t => t.name === tool.name)) {
                console.log(`[registry] tool "${tool.name}" already registered, skipping`);
                continue;
            }
            this._localTools.push(tool);
        }
        console.log(`[registry] registered ${this._localTools.length} local tool(s)`);
    }

    /**
     * 连接外部 MCP Server，发现其工具并包装为结构化工具注册。
     * @param {{ name: string, command: string, args?: string[] }} config
     */
    async registerMCPServer(config) {
        const scopeKey = config.scope?.tenantId
            ? `${config.scope.tenantId}:${config.scope.userId}:${config.name}`
            : `system:${config.name}`;
        const existingLegacyKey = !config.scope && this._mcpWrappers.has(config.name) ? config.name : null;
        if (existingLegacyKey) this._mcpWrappers.delete(existingLegacyKey);
        if (this._mcpWrappers.has(scopeKey)) {
            console.log(`[registry] MCP server "${config.name}" already connected, skipping`);
            return;
        }

        // 防止并发重复连接：如果已有进行中的连接，复用同一个 Promise
        if (this._pendingConnections.has(scopeKey)) {
            console.log(`[registry] MCP server "${config.name}" connection in progress, awaiting...`);
            return this._pendingConnections.get(scopeKey);
        }

        const connectPromise = this._doConnect({ ...config, _scopeKey: existingLegacyKey || scopeKey });
        this._pendingConnections.set(scopeKey, connectPromise);

        try {
            return await connectPromise;
        } finally {
            this._pendingConnections.delete(scopeKey);
        }
    }

    async _doConnect(config) {
        console.log(`[registry] connecting to MCP server "${config.name}"...`);
        const client = await connectToMCPServer(config);

        let remoteTools;
        try {
            const result = await client.listTools();
            remoteTools = result?.tools || [];
        } catch (err) {
            console.error(`[registry] failed to list tools from "${config.name}": ${err.message}`);
            await client.close();
            return;
        }

        console.log(`[registry] discovered ${remoteTools.length} tool(s) from "${config.name}"`);

        // 将每个远程工具包装为结构化工具，让模型直接看到 MCP inputSchema。
        // 同时注册裸名和命名空间前缀名（serverName/toolName），
        // 命名空间前缀避免与本地工具重名遮蔽。
        const wrappers = [];
        for (const rt of remoteTools) {
            const toolName = rt.name;
            const toolDesc = rt.description || `MCP tool from ${config.name}: ${toolName}`;
            const prefixedName = `${config.name}/${toolName}`;
            const schema = normalizeMCPInputSchema(rt.inputSchema, config.name, toolName);

            const makeTool = (name) => new DynamicStructuredTool({
                name,
                description: `[${config.name}] ${toolDesc}`,
                schema,
                func: async (input) => {
                    try {
                        const result = await withRetry(
                            (_, signal) => client.callTool({
                                name: toolName,
                                arguments: input && typeof input === "object" ? input : {},
                                signal,
                            }),
                            { retries: 1 }
                        );
                        const content = result?.content || [];
                        const textParts = content
                            .filter(c => c.type === "text")
                            .map(c => c.text);
                        return textParts.length > 0 ? textParts.join("\n") : JSON.stringify(result);
                    } catch (err) {
                        return JSON.stringify({
                            ok: false,
                            errorCode: "MCP_TOOL_FAILED",
                            message: `MCP tool "${toolName}" failed`,
                            retryable: Boolean(err?.code === "ECONNRESET" || err?.code === "ETIMEDOUT"),
                        });
                    }
                },
            });

            // 注册带命名空间前缀的版本（Planner/ToolExecutor 优先使用）
            wrappers.push(makeTool(prefixedName));
            // 也注册裸名版本（向后兼容旧代码直接 getTool("read_file")）
            // 但本地工具同名时跳过裸名注册，避免遮蔽
            if (!this._localTools.some(t => t.name === toolName)) {
                wrappers.push(makeTool(toolName));
            } else {
                console.log(`[registry] MCP tool "${toolName}" shadowed by local tool, only available as "${prefixedName}"`);
            }
        }

        this._mcpWrappers.set(config._scopeKey || `system:${config.name}`, {
            client,
            tools: wrappers,
            name: config.name,
            scope: config.scope || null,
            scopeKey: config._scopeKey || `system:${config.name}`,
        });
        console.log(`[registry] MCP server "${config.name}" ready with ${wrappers.length} tool(s)`);
    }

    /**
     * 返回所有已注册工具（本地 DynamicTool + MCP 结构化工具）。
     * 本地工具在前，MCP 工具在后。
     * @returns {import("@langchain/core/tools").StructuredToolInterface[]}
     */
    getAllTools(scope = null) {
        const effectiveScope = scope || getRequestContext();
        const mcpTools = [];
        for (const [, wrapper] of this._mcpWrappers) {
            if (!this._isVisible(wrapper, effectiveScope)) continue;
            mcpTools.push(...wrapper.tools);
        }
        return [...this._localTools, ...mcpTools];
    }

    _isVisible(wrapper, scope = null) {
        if (!wrapper?.scope) return true;
        if (!scope) return false;
        return Number(wrapper.scope.userId) === Number(scope.userId)
            && String(wrapper.scope.tenantId) === String(scope.tenantId);
    }

    _findWrapper(serverName, scope = null) {
        for (const [key, wrapper] of this._mcpWrappers) {
            const legacyName = String(key).includes(":") ? String(key).split(":").pop() : String(key);
            if ((wrapper.name === serverName || legacyName === serverName) && this._isVisible(wrapper, scope)) return wrapper;
        }
        return null;
    }

    /**
     * 按名称查找单个工具。
     *
     * Phase 4: 支持命名空间格式 "serverName/toolName"。
     * - 包含 "/" → 在指定 MCP server 的 tools 中查找
     * - 不含 "/" → 本地工具优先，MCP fallback（向后兼容）
     *
     * @param {string} name
     * @returns {import("@langchain/core/tools").StructuredToolInterface | undefined}
     */
    getTool(name, scope = null) {
        const effectiveScope = scope || getRequestContext();
        // Phase 4: 命名空间格式 "serverName/toolName"
        if (name.includes("/")) {
            const slashIdx = name.indexOf("/");
            const serverName = name.slice(0, slashIdx);
            const toolName = name.slice(slashIdx + 1);
            const wrapper = this._findWrapper(serverName, effectiveScope);
            if (wrapper) {
                return wrapper.tools.find(t => t.name === name || t.name === toolName);
            }
            return undefined;
        }

        // 本地工具优先（向后兼容）
        const local = this._localTools.find(t => t.name === name);
        if (local) return local;

        // MCP 工具 fallback
        for (const [, wrapper] of this._mcpWrappers) {
            if (!this._isVisible(wrapper, effectiveScope)) continue;
            const found = wrapper.tools.find(t => t.name === name);
            if (found) return found;
        }

        return undefined;
    }

    /**
     * 以兼容方式调用工具：结构化 MCP 工具接收对象，
     * 本地 DynamicTool 保持原有字符串调用语义。
     * @param {string} name
     * @param {unknown} input
     * @param {object} [config]
     * @returns {Promise<unknown>}
     */
    async invokeTool(name, input, config) {
        const tool = this.getTool(name, config?.scope);
        if (!tool) throw new Error(`工具 "${name}" 不可用`);
        const normalizedInput = tool instanceof DynamicStructuredTool
            ? normalizeLegacyStructuredInput(tool, input)
            : input;
        return withRetry(
            (_, signal) => tool.invoke(normalizedInput, { ...config, signal }),
            { retries: 1, signal: config?.signal }
        );
    }

    /**
     * 检查指定名称的工具是否存在。
     * @param {string} name
     * @returns {boolean}
     */
    hasTool(name) {
        return this.getTool(name) !== undefined;
    }

    /**
     * 断开并移除 MCP Server。
     * @param {string} name
     */
    async removeMCPServer(name, scope = null) {
        const effectiveScope = scope || getRequestContext();
        const key = effectiveScope?.tenantId ? `${effectiveScope.tenantId}:${effectiveScope.userId}:${name}` : `system:${name}`;
        const wrapper = this._mcpWrappers.get(key) || this._findWrapper(name, effectiveScope);
        if (!wrapper) {
            console.log(`[registry] MCP server "${name}" not found`);
            return;
        }

        try {
            await wrapper.client.close();
        } catch (err) {
            console.error(`[registry] error closing MCP server "${name}": ${err.message}`);
        }

        this._mcpWrappers.delete(wrapper.scopeKey || key);
        console.log(`[registry] MCP server "${name}" removed`);
    }

    async closeAllMCPServers() {
        const wrappers = [...this._mcpWrappers.values()];
        const results = await Promise.allSettled(wrappers.map(async (wrapper) => {
            await wrapper.client.close();
            this._mcpWrappers.delete(wrapper.scopeKey);
        }));
        return {
            closed: results.filter((result) => result.status === "fulfilled").length,
            failed: results.filter((result) => result.status === "rejected").length,
        };
    }

    // ═══════════════════════════════════════════════════════
    // Phase 4: 工具类别感知（供 Router/Planner 动态感知可用工具）
    // ═══════════════════════════════════════════════════════

    /**
     * 返回所有可用工具类别，供 Router/Planner 动态构建 prompt。
     *
     * 类别来源：
     * - 本地工具按类型归类：search, knowledge, system
     * - 每个 MCP Server 为一个独立类别
     *
     * @returns {{ category: string, tools: { name: string, description: string }[] }[]}
     */
    getToolCategories(scope = null) {
        const effectiveScope = scope || getRequestContext();
        const categories = [];

        // 本地工具归类
        const localByCategory = new Map();

        // search 类别
        const searchTools = this._localTools.filter(t =>
            t.name === "web_search"
        );
        if (searchTools.length > 0) {
            localByCategory.set("search", searchTools);
        }

        // knowledge 类别
        const kbTools = this._localTools.filter(t =>
            t.name === "search_knowledge_base"
        );
        if (kbTools.length > 0) {
            localByCategory.set("knowledge", kbTools);
        }

        // system 类别（时间、统计、问答等）
        const systemTools = this._localTools.filter(t =>
            !["web_search", "search_knowledge_base"].includes(t.name)
        );
        if (systemTools.length > 0) {
            localByCategory.set("system", systemTools);
        }

        for (const [category, tools] of localByCategory) {
            categories.push({
                category,
                type: "local",
                tools: tools.map(t => ({ name: t.name, description: t.description || "" })),
            });
        }

        // 每个 MCP Server 为一个独立类别
        for (const [serverName, wrapper] of this._mcpWrappers) {
            if (!this._isVisible(wrapper, effectiveScope)) continue;
            // 只取带命名空间前缀的版本（避免裸名重复）
            const prefixedTools = wrapper.tools.filter(t => t.name.includes("/"));
            if (prefixedTools.length > 0) {
                categories.push({
                    category: wrapper.name || (String(serverName).includes(":") ? String(serverName).split(":").pop() : String(serverName)),
                    type: "mcp",
                    tools: prefixedTools.map(t => ({ name: t.name, description: t.description || "" })),
                });
            }
        }

        return categories;
    }

    /**
     * 获取指定类别的所有工具（本地 DynamicTool 或远程结构化工具）。
     * @param {string} categoryName
     * @returns {Array}
     */
    getToolsByCategory(categoryName, scope = null) {
        const effectiveScope = scope || getRequestContext();
        const allLocal = this.getAllTools(effectiveScope);
        if (categoryName === "system") {
            // system 类别：非 search/knowledge 的本地工具
            return allLocal.filter(t =>
                !["web_search", "search_knowledge_base"].includes(t.name)
            );
        }
        // MCP Server 类别
        const wrapper = this._findWrapper(categoryName, effectiveScope);
        if (wrapper) {
            return wrapper.tools;
        }
        return [];
    }

    /**
     * 检查是否存在指定类别的工具。
     * @param {string} categoryName
     * @returns {boolean}
     */
    hasToolCategory(categoryName, scope = null) {
        const effectiveScope = scope || getRequestContext();
        // 本地已知类别
        if (["search", "knowledge", "system", "general", "code"].includes(categoryName)) return true;
        // MCP Server 类别
        if (this._findWrapper(categoryName, effectiveScope)) return true;
        return false;
    }

    /**
     * 获取所有已连接的 MCP Server 名称。
     * @returns {string[]}
     */
    getMCPServerNames(scope = null) {
        const effectiveScope = scope || getRequestContext();
        return Array.from(this._mcpWrappers.entries())
            .filter(([, wrapper]) => this._isVisible(wrapper, effectiveScope))
            .map(([key, wrapper]) => wrapper.name || (String(key).includes(":") ? String(key).split(":").pop() : String(key)));
    }

    /**
     * 获取指定 MCP Server 的工具列表。
     * @param {string} serverName
     * @returns {{ name: string, description: string }[]}
     */
    getMCPServerTools(serverName, scope = null) {
        const effectiveScope = scope || getRequestContext();
        const wrapper = this._findWrapper(serverName, effectiveScope) || this._mcpWrappers.get(`system:${serverName}`);
        if (!wrapper || !this._isVisible(wrapper, effectiveScope)) {
            const legacy = this._mcpWrappers.get(serverName);
            if (legacy && this._isVisible(legacy, effectiveScope)) return legacy.tools.map(t => ({ name: t.name, description: t.description }));
            return [];
        }
        return wrapper.tools.map(t => ({ name: t.name, description: t.description }));
    }
}

export { ToolRegistry };

/** @type {ToolRegistry} */
export const toolRegistry = new ToolRegistry();
