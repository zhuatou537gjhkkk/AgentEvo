/**
 * ToolRegistry — 统一工具注册中心
 *
 * Phase 3 核心：合并本地 DynamicTool + MCP 远程发现的工具，
 * 始终返回 DynamicTool 实例，下游 LangChain API 零感知。
 *
 * 对应 Hello-Agents: Ch10 MCP 工具发现 + 注册机制
 */

import { DynamicTool } from "@langchain/core/tools";
import { connectToMCPServer } from "./client.js";

class ToolRegistry {
    constructor() {
        /** @type {import("@langchain/core/tools").DynamicTool[]} */
        this._localTools = [];

        /** @type {Map<string, { client: import("@modelcontextprotocol/sdk/client/index.js").Client, tools: import("@langchain/core/tools").DynamicTool[] }>} */
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
     * 连接外部 MCP Server，发现其工具并包装为 DynamicTool 注册。
     * @param {{ name: string, command: string, args?: string[] }} config
     */
    async registerMCPServer(config) {
        if (this._mcpWrappers.has(config.name)) {
            console.log(`[registry] MCP server "${config.name}" already connected, skipping`);
            return;
        }

        // 防止并发重复连接：如果已有进行中的连接，复用同一个 Promise
        if (this._pendingConnections.has(config.name)) {
            console.log(`[registry] MCP server "${config.name}" connection in progress, awaiting...`);
            return this._pendingConnections.get(config.name);
        }

        const connectPromise = this._doConnect(config);
        this._pendingConnections.set(config.name, connectPromise);

        try {
            return await connectPromise;
        } finally {
            this._pendingConnections.delete(config.name);
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

        // 将每个远程工具包装为 DynamicTool — 保持 LangChain 接口一致性
        // Phase 4: 同时注册裸名和命名空间前缀名（serverName/toolName），
        // 命名空间前缀避免与本地工具重名遮蔽。
        const wrappers = [];
        for (const rt of remoteTools) {
            const toolName = rt.name;
            const toolDesc = rt.description || `MCP tool from ${config.name}: ${toolName}`;
            const prefixedName = `${config.name}/${toolName}`;
            const inputSchema = rt.inputSchema || null;

            const makeTool = (name) => new DynamicTool({
                name,
                description: `[${config.name}] ${toolDesc}`,
                func: async (input) => {
                    try {
                        // Phase 4: 根据 inputSchema 映射参数，避免 MCP -32602
                        let callArgs;
                        if (typeof input === "string") {
                            callArgs = { input };
                        } else {
                            callArgs = { ...input };
                        }
                        // Phase 4: inputSchema 驱动的参数映射，避免 MCP -32602
                        //
                        // 场景：
                        //   1. string input → { input } → 映射到 schema 期望的属性名
                        //   2. object input 但 key 名不匹配 schema → 自动纠正
                        //   3. object input 且 key 名匹配 schema → 直接透传
                        if (inputSchema?.properties) {
                            const propKeys = Object.keys(inputSchema.properties);
                            const inputVal = callArgs.input;

                            // 场景 1a: 单属性工具 + string input → 直接映射
                            if (propKeys.length === 1 && inputVal !== undefined) {
                                callArgs = { [propKeys[0]]: inputVal };
                            }
                            // 场景 1b: 多属性工具 + input 值 + path 属性 → 优先映射到 path
                            else if (propKeys.includes("path") && inputVal !== undefined) {
                                callArgs.path = inputVal;
                                delete callArgs.input;
                            }
                            // 场景 2: object input 的 key 不在 schema 中 → 自动纠正
                            // 例如 Planner 输出 { file_path: "..." } 但 schema 期望 { path: "..." }
                            else if (inputVal === undefined) {
                                const callKeys = Object.keys(callArgs);
                                const extraKeys = callKeys.filter(k => !propKeys.includes(k));
                                if (extraKeys.length === 1 && typeof callArgs[extraKeys[0]] === "string") {
                                    // 将多余的 key 映射到 schema 的第一个属性
                                    callArgs = { [propKeys[0]]: callArgs[extraKeys[0]] };
                                }
                            }
                        }
                        const result = await client.callTool({
                            name: toolName,
                            arguments: callArgs,
                        });
                        const content = result?.content || [];
                        const textParts = content
                            .filter(c => c.type === "text")
                            .map(c => c.text);
                        return textParts.length > 0 ? textParts.join("\n") : JSON.stringify(result);
                    } catch (err) {
                        return `MCP tool "${toolName}" error: ${err.message}`;
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

        this._mcpWrappers.set(config.name, { client, tools: wrappers });
        console.log(`[registry] MCP server "${config.name}" ready with ${wrappers.length} tool(s)`);
    }

    /**
     * 返回所有已注册工具的 DynamicTool[]。
     * 本地工具在前，MCP 工具在后。
     * @returns {import("@langchain/core/tools").DynamicTool[]}
     */
    getAllTools() {
        const mcpTools = [];
        for (const [, wrapper] of this._mcpWrappers) {
            mcpTools.push(...wrapper.tools);
        }
        return [...this._localTools, ...mcpTools];
    }

    /**
     * 按名称查找单个工具。
     *
     * Phase 4: 支持命名空间格式 "serverName/toolName"。
     * - 包含 "/" → 在指定 MCP server 的 tools 中查找
     * - 不含 "/" → 本地工具优先，MCP fallback（向后兼容）
     *
     * @param {string} name
     * @returns {import("@langchain/core/tools").DynamicTool | undefined}
     */
    getTool(name) {
        // Phase 4: 命名空间格式 "serverName/toolName"
        if (name.includes("/")) {
            const slashIdx = name.indexOf("/");
            const serverName = name.slice(0, slashIdx);
            const toolName = name.slice(slashIdx + 1);
            const wrapper = this._mcpWrappers.get(serverName);
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
            const found = wrapper.tools.find(t => t.name === name);
            if (found) return found;
        }

        return undefined;
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
    async removeMCPServer(name) {
        const wrapper = this._mcpWrappers.get(name);
        if (!wrapper) {
            console.log(`[registry] MCP server "${name}" not found`);
            return;
        }

        try {
            await wrapper.client.close();
        } catch (err) {
            console.error(`[registry] error closing MCP server "${name}": ${err.message}`);
        }

        this._mcpWrappers.delete(name);
        console.log(`[registry] MCP server "${name}" removed`);
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
    getToolCategories() {
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
            // 只取带命名空间前缀的版本（避免裸名重复）
            const prefixedTools = wrapper.tools.filter(t => t.name.includes("/"));
            if (prefixedTools.length > 0) {
                categories.push({
                    category: serverName,
                    type: "mcp",
                    tools: prefixedTools.map(t => ({ name: t.name, description: t.description || "" })),
                });
            }
        }

        return categories;
    }

    /**
     * 获取指定类别的所有工具（DynamicTool 数组）。
     * @param {string} categoryName
     * @returns {Array}
     */
    getToolsByCategory(categoryName) {
        const allLocal = this.getAllTools();
        if (categoryName === "system") {
            // system 类别：非 search/knowledge 的本地工具
            return allLocal.filter(t =>
                !["web_search", "search_knowledge_base"].includes(t.name)
            );
        }
        // MCP Server 类别
        if (this._mcpWrappers.has(categoryName)) {
            return this._mcpWrappers.get(categoryName).tools;
        }
        return [];
    }

    /**
     * 检查是否存在指定类别的工具。
     * @param {string} categoryName
     * @returns {boolean}
     */
    hasToolCategory(categoryName) {
        // 本地已知类别
        if (["search", "knowledge", "system", "general", "code"].includes(categoryName)) return true;
        // MCP Server 类别
        if (this._mcpWrappers.has(categoryName)) return true;
        return false;
    }

    /**
     * 获取所有已连接的 MCP Server 名称。
     * @returns {string[]}
     */
    getMCPServerNames() {
        return Array.from(this._mcpWrappers.keys());
    }

    /**
     * 获取指定 MCP Server 的工具列表。
     * @param {string} serverName
     * @returns {{ name: string, description: string }[]}
     */
    getMCPServerTools(serverName) {
        const wrapper = this._mcpWrappers.get(serverName);
        if (!wrapper) return [];
        return wrapper.tools.map(t => ({ name: t.name, description: t.description }));
    }
}

export { ToolRegistry };

/** @type {ToolRegistry} */
export const toolRegistry = new ToolRegistry();
