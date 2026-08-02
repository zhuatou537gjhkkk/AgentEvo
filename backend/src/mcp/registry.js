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
        const wrappers = remoteTools.map((rt) => {
            const toolName = rt.name;
            const toolDesc = rt.description || `MCP tool from ${config.name}: ${toolName}`;

            return new DynamicTool({
                name: toolName,
                description: toolDesc,
                func: async (input) => {
                    try {
                        const callArgs = typeof input === "string" ? { input } : input;
                        const result = await client.callTool({
                            name: toolName,
                            arguments: callArgs,
                        });
                        // MCP 返回 content 数组，提取文本
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
        });

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
     * @param {string} name
     * @returns {import("@langchain/core/tools").DynamicTool | undefined}
     */
    getTool(name) {
        // 先查本地（快速路径）
        const local = this._localTools.find(t => t.name === name);
        if (local) return local;

        // 再查 MCP
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

/** @type {ToolRegistry} */
export const toolRegistry = new ToolRegistry();
