/**
 * Phase 6a G2 手动验证脚本 — CodeJudge 6 种判定器功能测试
 *
 * 用法: node scripts/test-codejudge.js
 */

import { CodeJudge } from "../src/eval/codeJudge.js";

const judge = new CodeJudge();

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err) {
        console.log(`  ❌ ${name}: ${err.message}`);
        failed++;
    }
}

console.log("=== G2: CodeJudge 手动验证 ===\n");

// ── 1. regexMatch ──
console.log("1. regex-match 判定器");
test("匹配成功", () => {
    const results = judge.evaluate("今天天气很好，适合出门", [], [
        { type: "regex-match", pattern: "天气.*好", description: "输出包含天气好的描述" }
    ]);
    if (!results[0].pass) throw new Error("应匹配 /天气.*好/");
    if (results[0].score !== 1) throw new Error(`score 应为 1，实际 ${results[0].score}`);
});
test("匹配失败", () => {
    const results = judge.evaluate("这是普通回答", [], [
        { type: "regex-match", pattern: "天气" }
    ]);
    if (results[0].pass) throw new Error("不应匹配 /天气/");
});

// ── 2. jsonSchema ──
console.log("\n2. json-schema 判定器");
test("JSON type 校验通过", () => {
    const results = judge.evaluate('输出: {"name":"张三","age":25}', [], [
        { type: "json-schema", schema: { type: "object", required: ["name"], properties: { age: { type: "number" } } } }
    ]);
    if (!results[0].pass) throw new Error("JSON schema 应通过");
});
test("缺少 required 字段", () => {
    const results = judge.evaluate('输出: {"age":25}', [], [
        { type: "json-schema", schema: { type: "object", required: ["name"] } }
    ]);
    if (results[0].pass) throw new Error("缺少 name 字段，应不通过");
});
test("无 JSON 输出", () => {
    const results = judge.evaluate("这是纯文本没有JSON", [], [
        { type: "json-schema", schema: { type: "object" } }
    ]);
    if (results[0].pass) throw new Error("无 JSON 应不通过");
});

// ── 3. keywordInclude ──
console.log("\n3. keyword-include 判定器");
test("包含所有关键词", () => {
    const results = judge.evaluate("Python是一种编程语言，适用于AI开发", [], [
        { type: "keyword-include", keywords: ["Python", "AI", "编程"] }
    ]);
    if (!results[0].pass) throw new Error("应包含所有关键词");
});
test("缺少关键词 (matchMode=all)", () => {
    const results = judge.evaluate("Python很好用", [], [
        { type: "keyword-include", keywords: ["Python", "JavaScript"] }
    ]);
    if (results[0].pass) throw new Error("缺少 JavaScript 关键词，应不通过");
});
test("matchMode=any 命中部分", () => {
    const results = judge.evaluate("你好，很高兴认识你", [], [
        { type: "keyword-include", keywords: ["你好", "帮助", "什么"], matchMode: "any" }
    ]);
    if (!results[0].pass) throw new Error("命中'你好'，matchMode=any 应通过");
    if (results[0].score !== 1) throw new Error(`score 应为 1，实际 ${results[0].score}`);
});
test("matchMode=any 全未命中", () => {
    const results = judge.evaluate("哈喽，开心见到你", [], [
        { type: "keyword-include", keywords: ["你好", "帮助", "什么"], matchMode: "any" }
    ]);
    if (results[0].pass) throw new Error("未命中任何关键词，应不通过");
});

// ── 4. keywordExclude ──
console.log("\n4. keyword-exclude 判定器");
test("不含禁止词", () => {
    const results = judge.evaluate("这是一个正常的回答", [], [
        { type: "keyword-exclude", keywords: ["不知道", "无法回答"] }
    ]);
    if (!results[0].pass) throw new Error("应不含禁止词");
});
test("含禁止词", () => {
    const results = judge.evaluate("对不起，我不知道答案", [], [
        { type: "keyword-exclude", keywords: ["不知道"] }
    ]);
    if (results[0].pass) throw new Error("包含了'不知道'，应不通过");
});

// ── 5. toolCalled ──
console.log("\n5. tool-called 判定器");
test("调用了指定工具", () => {
    const results = judge.evaluate("输出文本", ["web_search", "get_system_time"], [
        { type: "tool-called", toolName: "web_search" }
    ]);
    if (!results[0].pass) throw new Error("web_search 已调用，应通过");
});
test("未调用指定工具", () => {
    const results = judge.evaluate("输出文本", ["get_system_time"], [
        { type: "tool-called", toolName: "web_search" }
    ]);
    if (results[0].pass) throw new Error("web_search 未调用，应不通过");
});

// ── 6. toolNotCalled ──
console.log("\n6. tool-not-called 判定器");
test("未滥用工具", () => {
    const results = judge.evaluate("输出文本", ["web_search"], [
        { type: "tool-not-called", toolName: "get_system_time" }
    ]);
    if (!results[0].pass) throw new Error("get_system_time 未被调用，应通过");
});
test("滥用了工具", () => {
    const results = judge.evaluate("输出文本", ["web_search", "get_system_time"], [
        { type: "tool-not-called", toolName: "get_system_time" }
    ]);
    if (results[0].pass) throw new Error("get_system_time 被调用了，应不通过");
});

// ── 7. 综合测试：多判定器 + summarize ──
console.log("\n7. 综合测试：多判定器 + summarize");
test("多判定器并行", () => {
    const results = judge.evaluate(
        "Python是2024年最流行的编程语言，主要用于AI和数据分析",
        ["web_search"],
        [
            { type: "keyword-include", keywords: ["Python", "AI"] },
            { type: "keyword-exclude", keywords: ["不知道"] },
            { type: "tool-called", toolName: "web_search" },
            { type: "tool-not-called", toolName: "get_system_time" },
        ]
    );
    if (results.length !== 4) throw new Error(`应有 4 个结果，实际 ${results.length}`);
    const summary = CodeJudge.summarize(results);
    if (summary.passed !== 4) throw new Error(`应 4/4 通过，实际 ${summary.passed}/${summary.total}`);
});
test("summarize 空结果", () => {
    const summary = CodeJudge.summarize([]);
    if (summary.passed !== 0 || summary.total !== 0) throw new Error("空结果 summary 应为 0/0");
});
test("toToolUsageHint 全通过 → 5", () => {
    const results = judge.evaluate("text", ["web_search"], [
        { type: "tool-called", toolName: "web_search" }
    ]);
    const hint = CodeJudge.toToolUsageHint(results);
    if (hint !== 5) throw new Error(`全通过 hint 应为 5，实际 ${hint}`);
});
test("toToolUsageHint 全失败 → 1", () => {
    const results = judge.evaluate("text", [], [
        { type: "tool-called", toolName: "web_search" }
    ]);
    const hint = CodeJudge.toToolUsageHint(results);
    if (hint !== 1) throw new Error(`全失败 hint 应为 1，实际 ${hint}`);
});
test("toToolUsageHint 无工具检查 → -1", () => {
    const results = judge.evaluate("Python", [], [
        { type: "keyword-include", keywords: ["Python"] }
    ]);
    const hint = CodeJudge.toToolUsageHint(results);
    if (hint !== -1) throw new Error(`无工具检查 hint 应为 -1，实际 ${hint}`);
});

// ── 8. 边界情况 ──
console.log("\n8. 边界情况");
test("空 checks 数组", () => {
    const results = judge.evaluate("任意文本", [], []);
    if (results.length !== 0) throw new Error("空 checks 应返回空数组");
});
test("未知判定器类型", () => {
    const results = judge.evaluate("text", [], [{ type: "unknown-type" }]);
    if (results[0].pass) throw new Error("未知类型应失败");
});
test("regex-match 缺少 pattern", () => {
    const results = judge.evaluate("text", [], [{ type: "regex-match" }]);
    if (results[0].pass) throw new Error("缺少 pattern 应失败");
});
test("无效正则表达式", () => {
    const results = judge.evaluate("text", [], [{ type: "regex-match", pattern: "[invalid" }]);
    if (results[0].pass) throw new Error("无效正则应失败");
});
test("score 自定义值", () => {
    const results = judge.evaluate("Python", [], [
        { type: "keyword-include", keywords: ["Python"], score: 0.5 }
    ]);
    if (results[0].score !== 0.5) throw new Error(`score 应为 0.5，实际 ${results[0].score}`);
});

// ── 总结 ──
console.log(`\n=== 结果: ${passed}/${passed + failed} 通过 ===`);
if (failed > 0) {
    console.log(`❌ ${failed} 项失败！`);
    process.exit(1);
} else {
    console.log(`✅ G2 CodeJudge 全部 ${passed} 项测试通过`);
}
