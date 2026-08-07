/**
 * Phase 6a G1 手动验证脚本 — OnlineEvaluator 在线评估
 *
 * 用法: node scripts/test-online-eval.js
 */

import { OnlineEvaluator } from "../src/eval/online.js";
import Database from "better-sqlite3";

const db = new Database("agent_data.db");

// 强制 sampleRate: 1.0，确保一定采样
const evaluator = new OnlineEvaluator({
    sampleRate: 1.0,
    enabled: true,
});

console.log("=== G1: OnlineEvaluator 手动验证 ===\n");
console.log("状态:", JSON.stringify(evaluator.getStats()));

// 触发评估
const triggered = evaluator.maybeEvaluate({
    userId: 10,
    sessionId: 149,
    messageId: 867,
    userInput: "你好，请简单介绍一下你自己",
    assistantText: "你好！我是AI助手，很高兴为你服务。我能帮你搜索信息、回答知识问题、分析代码等。",
    toolCallNames: [],
    toolCallsDetail: [],
    runId: "manual-test-20260806",
});

console.log("触发结果:", triggered);
console.log("采样立即返回 (setImmediate 异步)...");

// 等待 LLMJudge 评估完成
await new Promise(resolve => setTimeout(resolve, 15000));

console.log("\n评估后统计:", JSON.stringify(evaluator.getStats()));

// 检查数据库
const rows = db.prepare(
    "SELECT id, score_type, test_case_id, run_id, message_id, created_at FROM eval_scores WHERE score_type = ? ORDER BY id DESC LIMIT 5"
).all("online");

console.log(`\neval_scores online 记录: ${rows.length} 条`);
if (rows.length > 0) {
    console.log("✅ G1 通过！找到 online 评估记录：");
    for (const row of rows) {
        console.log(JSON.stringify(row, null, 2));
    }
} else {
    console.log("⚠️ 没有 online 记录 — 检查后端日志中是否有 [OnlineEvaluator] 错误");
}

db.close();
console.log("\n=== G1 验证完成 ===");
