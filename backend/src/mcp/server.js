/**
 * MCP Server 实现 — 将 AI-Chat 现有工具对外暴露为 MCP 协议服务
 *
 * Phase 3: 外部 AI 客户端可通过 Stdio transport 发现并调用我们的工具。
 * 对应 Hello-Agents: Ch10 04_MCPTransport.py (MCPTool server_command 模式)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { agentTools } from "./tools.js";

/**
 * 创建 MCP Server 实例。
 * 注册 tools/list 和 tools/call 两个核心处理器。
 * @returns {Server}
 */
export function createMCPServer() {
    const server = new Server(
        { name: "ai-chat-tools", version: "1.0.0" },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    // ── tools/list: 返回所有可用工具的元数据 ──
    server.setRequestHandler(
        ListToolsRequestSchema,
        async () => {
            const tools = agentTools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: {
                    type: "object",
                    properties: {
                        input: {
                            type: "string",
                            description: "工具输入参数（字符串或 JSON 字符串）",
                        },
                    },
                    required: [],
                },
            }));

            return { tools };
        }
    );

    // ── tools/call: 执行指定工具 ──
    server.setRequestHandler(
        CallToolRequestSchema,
        async (request) => {
            const { name, arguments: args } = request.params;
            console.log(`[mcp:server] tool call: ${name}`);

            const tool = agentTools.find((t) => t.name === name);
            if (!tool) {
                return {
                    content: [{ type: "text", text: `Unknown tool: ${name}` }],
                    isError: true,
                };
            }

            try {
                // 提取输入：优先用 arguments.input，否则整个 arguments 作为输入
                const input =
                    args && typeof args.input === "string"
                        ? args.input
                        : JSON.stringify(args || {});

                const result = await tool.invoke(input);
                return {
                    content: [{ type: "text", text: String(result) }],
                };
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Tool execution error: ${err.message}` }],
                    isError: true,
                };
            }
        }
    );

    return server;
}

/**
 * 启动 Stdio MCP Server。
 * 通过 stdin/stdout 与 MCP Client 通信。
 */
export async function startMCPServer() {
    const server = createMCPServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log("[mcp:server] AI-Chat MCP Server running (stdio)");
    return server;
}
