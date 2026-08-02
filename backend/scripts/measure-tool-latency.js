/**
 * 工具调用延迟基线测量脚本
 *
 * Phase 1 基线任务：记录当前工具调用延迟
 * 测量内容：
 *   1. get_system_time — 本地工具，预期 < 5ms
 *   2. get_db_message_count — 本地 DB 查询，预期 < 50ms
 *   3. update_todo — 纯 JSON 解析，预期 < 5ms
 *   4. web_search — 博查 API 调用，预期 500-3000ms（取决于网络）
 *   5. search_knowledge_base — FAISS 向量检索，预期 10-200ms（取决于库大小）
 *
 * 运行: node scripts/measure-tool-latency.js
 */

import "dotenv/config";
import { getMessageStats } from "../src/db/index.js";
import { queryKnowledgeBase } from "../src/rag/index.js";

// ── get_system_time ──────────────────────────────────────
const func_get_system_time = async () => {
    return new Date().toLocaleString();
};

// ── get_db_message_count ─────────────────────────────────
const func_get_db_message_count = async () => {
    const stats = getMessageStats();
    return JSON.stringify(stats);
};

// ── update_todo (JSON 解析) ──────────────────────────────
const func_update_todo = async (input) => {
    const parsed = typeof input === "string" ? JSON.parse(input) : input;
    const todos = Array.isArray(parsed.todos) ? parsed.todos : [];
    return JSON.stringify({ ok: true, count: todos.length });
};

// ── web_search (博查 API) ────────────────────────────────
const func_web_search = async (input) => {
    if (!process.env.BOCHA_API_KEY) {
        throw new Error("BOCHA_API_KEY not set — 跳过联网搜索延迟测试");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch("https://api.bochaai.com/v1/web-search", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.BOCHA_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ query: String(input).trim() || "测试", count: 3, freshness: "noLimit" }),
            signal: controller.signal,
        });
        const data = await response.json();
        const count = data?.data?.webPages?.value?.length ?? 0;
        return `web_search 返回 ${count} 条结果`;
    } finally {
        clearTimeout(timer);
    }
};

// ── search_knowledge_base ────────────────────────────────
const func_search_knowledge_base = async (input) => {
    return queryKnowledgeBase(String(input).trim() || "测试");
};

// ── 测量工具函数 ─────────────────────────────────────────
async function measure(name, fn, ...args) {
    const rounds = 3;
    const times = [];
    let result = null;
    let error = null;

    for (let i = 0; i < rounds; i++) {
        const start = performance.now();
        try {
            result = await fn(...args);
            const elapsed = performance.now() - start;
            times.push(elapsed);
        } catch (e) {
            error = e.message;
            times.push(null);
        }
    }

    const validTimes = times.filter((t) => t !== null);
    if (validTimes.length === 0) {
        return { name, error, rounds };
    }

    const avg = validTimes.reduce((a, b) => a + b, 0) / validTimes.length;
    const min = Math.min(...validTimes);
    const max = Math.max(...validTimes);

    return {
        name,
        avg: Math.round(avg),
        min: Math.round(min),
        max: Math.round(max),
        rounds: validTimes.length,
        result: typeof result === "string" ? result.slice(0, 80) : String(result).slice(0, 80),
        error,
    };
}

// ── 主流程 ───────────────────────────────────────────────
async function main() {
    console.log("=".repeat(64));
    console.log("工具调用延迟基线测量");
    console.log(`时间: ${new Date().toLocaleString()}`);
    console.log("=".repeat(64));
    console.log();

    const results = [];

    // 1. 本地工具
    console.log("▶ 测量本地工具...\n");
    results.push(await measure("get_system_time", func_get_system_time));
    results.push(await measure("get_db_message_count", func_get_db_message_count));
    results.push(await measure("update_todo", func_update_todo, JSON.stringify({
        todos: [{ id: "1", content: "测试", status: "pending" }],
    })));

    // 2. 知识库检索（需要已有索引）
    console.log("▶ 测量知识库检索...\n");
    results.push(await measure("search_knowledge_base", func_search_knowledge_base, "测试查询"));

    // 3. 联网搜索（需要 BOCHA_API_KEY）
    console.log("▶ 测量联网搜索...\n");
    if (process.env.BOCHA_API_KEY) {
        results.push(await measure("web_search", func_web_search, "测试搜索"));
    } else {
        console.log("  ⚠ BOCHA_API_KEY 未设置，跳过 web_search 延迟测试\n");
        results.push({ name: "web_search", error: "BOCHA_API_KEY not set", rounds: 0 });
    }

    // ── 输出表格 ─────────────────────────────────────────
    console.log("=".repeat(64));
    console.log("测量结果");
    console.log("=".repeat(64));
    console.log();

    console.log(
        "工具名称".padEnd(28) +
        "平均".padStart(8) +
        "最小".padStart(8) +
        "最大".padStart(8) +
        "轮次".padStart(6)
    );
    console.log("-".repeat(58));

    for (const r of results) {
        if (r.error && r.rounds === 0) {
            console.log(
                r.name.padEnd(28) +
                "(跳过)".padStart(8) +
                `  ${r.error}`
            );
        } else if (r.error) {
            console.log(
                r.name.padEnd(28) +
                `${r.avg}ms`.padStart(8) +
                `${r.min}ms`.padStart(8) +
                `${r.max}ms`.padStart(8) +
                `${r.rounds}`.padStart(6) +
                `  ⚠ 部分失败: ${r.error}`
            );
        } else {
            console.log(
                r.name.padEnd(28) +
                `${r.avg}ms`.padStart(8) +
                `${r.min}ms`.padStart(8) +
                `${r.max}ms`.padStart(8) +
                `${r.rounds}`.padStart(6)
            );
        }
    }

    console.log();
    console.log("注: 以上为工具函数本身的执行时间，不含 LLM 决策/Schema 解析开销。");
    console.log("端到端延迟 = LLM 决策时间 + 工具执行时间 + SSE 网络传输。");
}

main().catch((err) => {
    console.error("测量脚本异常:", err);
    process.exit(1);
});
