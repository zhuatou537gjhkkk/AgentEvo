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
import { validateMCPServerConfig } from "./security.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// backend root = src/mcp → src → backend
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
// 有界握手：MCP Server 启动后若 initialize 无响应会挂起 connect。
// 这里用 race 保证超时后 close transport（杀掉子进程）再抛错，不让 admin/启动路径无限等待。
// 注：不用 withRetry 重跑整个 spawn —— 子进程 connect 重试可能泄漏上一次尝试的存活子进程；
// 工具调用侧（registry.callTool/invokeTool）本就 withRetry，连接本身只需有界超时。
const MCP_CONNECT_TIMEOUT_MS = 15000;

/**
 * 连接到 MCP Server（Stdio transport）。
 * 通过子进程启动 Server，通过 stdin/stdout 通信。
 *
 * @param {{ name: string, command: string, args?: string[], cwd?: string }} config
 * @returns {Promise<import("@modelcontextprotocol/sdk/client/index.js").Client>}
 */
export async function connectToMCPServer(config) {
    const safeConfig = validateMCPServerConfig(config, { resolvedEnv: Boolean(config?.env && Object.values(config.env).some((value) => !String(value).startsWith("env:"))) });
    const { command, args = [], cwd, env } = safeConfig;

    // Windows 下 npx 是 npx.cmd 批处理脚本，StdioClientTransport shell:false 直接 spawn "npx" 会 ENOENT
    const resolvedCommand =
        process.platform === "win32" && command === "npx" ? "npx.cmd" : command;

    const transport = new StdioClientTransport({
        command: resolvedCommand,
        args,
        cwd: cwd || BACKEND_ROOT,
        stderr: "pipe",
        // SDK 的 getDefaultEnvironment() 只继承白名单系统变量，自定义 env（如 API key）必须显式传入
        env,
    });

    const client = new Client(
        { name: "agent-evo", version: "1.0.0" },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    let handshakeTimer;
    try {
        await Promise.race([
            client.connect(transport),
            new Promise((_, reject) => {
                handshakeTimer = setTimeout(() => {
                    reject(Object.assign(new Error(`MCP connect timeout after ${MCP_CONNECT_TIMEOUT_MS}ms: "${config.name}"`), {
                        code: "MCP_CONNECT_TIMEOUT",
                        statusCode: 504,
                        retryable: true,
                    }));
                }, MCP_CONNECT_TIMEOUT_MS);
            }),
        ]);
    } catch (err) {
        clearTimeout(handshakeTimer);
        try { await transport.close(); } catch { /* 尽力清理子进程 */ }
        throw err;
    }
    clearTimeout(handshakeTimer);
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
