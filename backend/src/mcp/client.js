/**
 * MCPClient 封装 — 基于 @modelcontextprotocol/sdk 的 Stdio transport 客户端
 *
 * Phase 3: 连接外部 MCP Server，发现工具并调用。
 * 对应 Hello-Agents: Ch10 02_Connect2MCP.py + 04_MCPTransport.py
 */

import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// backend root = src/mcp → src → backend
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

/**
 * 连接到 MCP Server（Stdio transport）。
 * 通过子进程启动 Server，通过 stdin/stdout 通信。
 *
 * @param {{ name: string, command: string, args?: string[], cwd?: string }} config
 * @returns {Promise<import("@modelcontextprotocol/sdk/client/index.js").Client>}
 */
export async function connectToMCPServer(config) {
    const { command, args = [], cwd } = config;

    const transport = new StdioClientTransport({
        command,
        args,
        cwd: cwd || BACKEND_ROOT,
        stderr: "pipe",
    });

    const client = new Client(
        { name: "agent-evo", version: "1.0.0" },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    await client.connect(transport);
    console.log(`[mcp:client] connected to "${config.name}" (${command} ${args.join(" ")})`);
    return client;
}

/**
 * 快速测试：发现 MCP Server 的工具列表。
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @returns {Promise<{ name: string, description?: string, inputSchema?: object }[]>}
 */
export async function discoverTools(client) {
    const result = await client.listTools();
    return result?.tools || [];
}
