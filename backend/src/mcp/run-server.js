#!/usr/bin/env node
/**
 * MCP Server 启动入口
 *
 * 用法: node src/mcp/run-server.js
 *
 * 此脚本通过 stdin/stdout 与 MCP Client 通信，
 * 将 AI-Chat 的 6 个 DynamicTool 对外暴露为 MCP 协议服务。
 *
 * 对应 Hello-Agents: Ch10 04_MCPTransport.py
 */

import { startMCPServer } from "./server.js";

startMCPServer().catch((err) => {
    console.error("[mcp:server] failed to start:", err.message);
    process.exit(1);
});
