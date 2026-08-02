/**
 * bench-tool-latency.js — DynamicTool vs MCP 工具调用延迟对比
 *
 * Phase 3: 对比本地 DynamicTool.invoke() 和 MCP Client.callTool() 的延迟差异。
 * 目标：差异 < 200ms（本地 Stdio 传输）。
 *
 * 用法: node scripts/bench-tool-latency.js
 */

import { toolRegistry } from "../src/mcp/registry.js";
import { startMCPServer } from "../src/mcp/server.js";
import { connectToMCPServer } from "../src/mcp/client.js";

const ITERATIONS = 5;

function formatMs(ms) {
    return `${ms.toFixed(1)}ms`;
}

function stats(values) {
    values.sort((a, b) => a - b);
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const min = values[0];
    const max = values[values.length - 1];
    const median = values.length % 2 === 0
        ? (values[values.length / 2 - 1] + values[values.length / 2]) / 2
        : values[Math.floor(values.length / 2)];
    return { avg, min, max, median };
}

async function benchmarkDynamicTool(name) {
    const tool = toolRegistry.getTool(name);
    if (!tool) {
        console.error(`  Tool "${name}" not found in registry`);
        return null;
    }

    const times = [];
    for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now();
        try {
            await tool.invoke("test input");
        } catch { /* ignore */ }
        times.push(performance.now() - start);
    }
    return times;
}

async function benchmarkMCPTool(client, name) {
    // List tools to find the one we want
    const result = await client.listTools();
    const remoteTool = (result?.tools || []).find(t => t.name === name);
    if (!remoteTool) {
        console.error(`  Tool "${name}" not found on MCP server`);
        return null;
    }

    const times = [];
    for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now();
        try {
            await client.callTool({ name, arguments: { input: "test input" } });
        } catch { /* ignore */ }
        times.push(performance.now() - start);
    }
    return times;
}

async function main() {
    console.log("╔════════════════════════════════════════════════╗");
    console.log("║  Tool Latency: DynamicTool vs MCP (Stdio)     ║");
    console.log("╚════════════════════════════════════════════════╝\n");

    // 确保本地工具已注册
    console.log(`Local tools: ${toolRegistry.getAllTools().map(t => t.name).join(", ")}\n`);

    // 启动本地 MCP Server (后台子进程)
    console.log("Starting local MCP Server via Stdio...");
    let mcpClient = null;
    try {
        mcpClient = await connectToMCPServer({
            name: "bench-test",
            command: "node",
            args: ["src/mcp/run-server.js"],
        });
        console.log("MCP Server connected.\n");
    } catch (err) {
        console.error(`Failed to connect to MCP Server: ${err.message}`);
        console.log("Skipping MCP comparison. Make sure the server can be started with: node src/mcp/run-server.js");
        process.exit(1);
    }

    const testTools = [
        { name: "get_system_time", input: "now" },
        { name: "get_db_message_count", input: "count" },
        { name: "search_knowledge_base", input: "test query" },
    ];

    console.log(`${"Tool".padEnd(25)} ${"DynamicTool".padStart(14)} ${"MCP".padStart(14)} ${"Diff".padStart(12)}`);
    console.log("-".repeat(65));

    for (const { name } of testTools) {
        const dtTimes = await benchmarkDynamicTool(name);
        const mcpTimes = await benchmarkMCPTool(mcpClient, name);

        if (!dtTimes || !mcpTimes) {
            console.log(`${name.padEnd(25)} ${"SKIPPED".padStart(14)}`);
            continue;
        }

        const dtStats = stats(dtTimes);
        const mcpStats = stats(mcpTimes);
        const diff = mcpStats.avg - dtStats.avg;

        console.log(
            `${name.padEnd(25)} ${formatMs(dtStats.avg).padStart(14)} ${formatMs(mcpStats.avg).padStart(14)} ${(diff >= 0 ? '+' : '') + formatMs(diff).padStart(11)}`
        );
    }

    console.log("-".repeat(65));
    console.log(`\nTarget: MCP overhead < 200ms`);

    // Cleanup
    if (mcpClient) {
        await mcpClient.close();
    }

    process.exit(0);
}

main().catch((err) => {
    console.error("Benchmark failed:", err.message);
    process.exit(1);
});
