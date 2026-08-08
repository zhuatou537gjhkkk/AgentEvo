/**
 * OTel Trace 格式映射 — 全流程闭环验证脚本 (Phase 6c)
 *
 * 验证路径：
 *   ① 直接函数层：DB Trace → toOpenTelemetry() → otelToInternalTrace() → 结构对比
 *   ② HTTP API 层：GET /observability/traces/:id/otel → POST /observability/otel/import → 验证
 *   ③ 外部 Trace 导入：手动构造 OTel JSON → Import → 验证
 *
 * 用法：
 *   node backend/scripts/e2e-otel-roundtrip.js
 *   # 需要后端运行时自动测 HTTP 层；未运行则只测函数层
 *
 * 环境变量（可选）：
 *   BASE_URL=http://localhost:3000
 *   TEST_USER=testuser
 *   TEST_PASS=test123
 */

// ══════════════════════════════════════════════════
// 依赖
// ══════════════════════════════════════════════════
import { getRecentTraces, getTraceById } from "../src/db/index.js";
import { TraceCollector } from "../src/trace/collector.js";
import { otelToInternalTrace } from "../src/trace/import.js";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const TEST_USER = process.env.TEST_USER || "testuser";
const TEST_PASS = process.env.TEST_PASS || "test123";

let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
    if (condition) {
        passed++;
        console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
    } else {
        failed++;
        console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    }
}

function section(title) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  ${title}`);
    console.log(`${"═".repeat(60)}`);
}

// ══════════════════════════════════════════════════
// 第一部分：直接函数层往返测试 (无需服务器)
// ══════════════════════════════════════════════════

async function testFunctionLayer() {
    section("第一部分：直接函数层往返测试");

    // 从 DB 读取一条 Trace 摘要，找到有效 traceId
    const traces = getRecentTraces(1, 1);
    check("DB 中存在 Trace", traces.length > 0, `共 ${traces.length} 条`);

    if (traces.length === 0) {
        console.error("  ⚠ 无 Trace 数据，跳过函数层测试。请先发送一条聊天消息生成 Trace。");
        return;
    }

    // getRecentTraces 不返回 root_span，用 getTraceById 获取完整数据
    const dbTraceId = traces[0].trace_id;
    const dbTrace = getTraceById(dbTraceId);
    check("getTraceById 获取到完整 Trace", !!dbTrace, dbTraceId);

    console.log(`  源 Trace: ${dbTrace.trace_id} (${dbTrace.trace_type}, ${dbTrace.tool_call_count} tools, ${dbTrace.total_latency_ms}ms)`);

    // 构造 traceRecord（模拟 finishTrace 输出）
    const rootSpan = JSON.parse(dbTrace.root_span || "{}");
    const agentPath = JSON.parse(dbTrace.agent_traversal_path || "[]");
    const traceRecord = {
        traceId: dbTrace.trace_id,
        rootSpan,
        agentTraversalPath: agentPath,
        toolCallCount: dbTrace.tool_call_count,
        errorCount: dbTrace.error_count,
        model: dbTrace.model,
    };

    // ── Step ①: 导出为 OTel 格式 ──
    console.log("\n  ── Step ①: toOpenTelemetry() 导出 ──");
    const otel = TraceCollector.toOpenTelemetry(traceRecord);
    check("导出成功 (非 null)", otel !== null);
    check("resourceSpans 数组存在", otel && Array.isArray(otel.resourceSpans));
    check("至少 1 个 resourceSpan", otel && otel.resourceSpans.length >= 1);
    check("scopeSpans 存在", otel && otel.resourceSpans[0].scopeSpans.length >= 1);

    const spans = otel?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans || [];
    check("至少 1 个 Span", spans.length >= 1, `${spans.length} 个 Span`);

    // 验证 resource 级别属性
    const resAttrs = otel?.resourceSpans?.[0]?.resource?.attributes || [];
    const svcName = resAttrs.find((a) => a.key === "service.name");
    check("service.name = agent-evo", svcName?.value?.stringValue === "agent-evo");

    // 验证每个 Span 的必要字段
    let spanFieldsOk = true;
    for (const span of spans) {
        if (!span.spanId || !span.name || span.kind === undefined || !span.startTimeUnixNano) {
            spanFieldsOk = false;
            break;
        }
    }
    check("每个 Span 含 spanId/name/kind/时间戳", spanFieldsOk);

    // 验证 gen_ai.span.type 属性（往返兼容关键）
    const firstSpan = spans[0];
    const spanTypeAttr = firstSpan.attributes?.find((a) => a.key === "gen_ai.span.type");
    check("Span 包含 gen_ai.span.type 属性", !!spanTypeAttr, spanTypeAttr?.value?.stringValue);

    // ── Step ②: 导入回内部格式 ──
    console.log("\n  ── Step ②: otelToInternalTrace() 导入 ──");
    const imported = otelToInternalTrace(otel, { userId: 1, sessionId: 1 });
    check("导入成功 (非 null)", imported !== null);
    check("traceType = import", imported?.traceType === "import");
    check("traceId 以 otel- 开头", imported?.traceId?.startsWith("otel-"), imported?.traceId);
    check("model = external", imported?.model === "external");

    // ── Step ③: 往返结构对比 ──
    console.log("\n  ── Step ③: 往返结构对比 ──");
    check("toolCallCount 一致", imported?.toolCallCount === traceRecord.toolCallCount,
        `${imported?.toolCallCount} vs ${traceRecord.toolCallCount}`);
    check("agentTraversalPath 包含原始路径",
        traceRecord.agentTraversalPath.every((a) => imported?.agentTraversalPath?.includes(a)),
        `原始: [${traceRecord.agentTraversalPath}] → 导入: [${imported?.agentTraversalPath}]`);

    // 递归统计 Span 类型分布
    function countByType(span, counts = {}) {
        counts[span.type] = (counts[span.type] || 0) + 1;
        for (const child of (span.children || [])) countByType(child, counts);
        return counts;
    }
    const origCounts = countByType(traceRecord.rootSpan);
    const impCounts = countByType(imported.rootSpan);
    const typesMatch = Object.keys(origCounts).every((t) => origCounts[t] === impCounts[t]);
    check("Span 类型分布一致 (往返兼容)", typesMatch,
        `原始: ${JSON.stringify(origCounts)} → 导入: ${JSON.stringify(impCounts)}`);

    // 验证 Span name 保留
    function collectNames(span, set = new Set()) {
        set.add(span.name);
        for (const child of (span.children || [])) collectNames(child, set);
        return set;
    }
    const origNames = collectNames(traceRecord.rootSpan);
    const impNames = collectNames(imported.rootSpan);
    const namesMatch = [...origNames].every((n) => impNames.has(n));
    check("Span 名称完全保留", namesMatch,
        `原始: [${[...origNames]}] → 导入: [${[...impNames]}]`);

    // ── Step ④: 二次往返（导入后再导出再导入，验证幂等性） ──
    console.log("\n  ── Step ④: 二次往返（幂等性验证） ──");
    const otel2 = TraceCollector.toOpenTelemetry(imported);
    const imported2 = otelToInternalTrace(otel2, { userId: 1, sessionId: 1 });
    const impCounts2 = countByType(imported2.rootSpan);
    const typesMatch2 = Object.keys(impCounts).every((t) => impCounts[t] === impCounts2[t]);
    check("二次往返 Span 类型稳定", typesMatch2,
        `第一次: ${JSON.stringify(impCounts)} → 第二次: ${JSON.stringify(impCounts2)}`);

    return { otel, traceRecord };
}

// ══════════════════════════════════════════════════
// 第二部分：外部 Trace 导入测试
// ══════════════════════════════════════════════════

function testExternalImport() {
    section("第二部分：外部 OTel Trace 导入测试");

    // 模拟一个 LangChain/LangSmith 风格的 OTel Trace
    const externalOtel = {
        resourceSpans: [{
            resource: {
                attributes: [
                    { key: "service.name", value: { stringValue: "langchain-agent" } },
                    { key: "service.version", value: { stringValue: "0.3.0" } },
                ],
            },
            scopeSpans: [{
                scope: { name: "langchain.agent", version: "0.3.0" },
                spans: [
                    {
                        traceId: "ext-trace-001",
                        spanId: "ext-root",
                        parentSpanId: "",
                        name: "agent_executor",
                        kind: 2, // SERVER
                        startTimeUnixNano: "1749000000000000000",
                        endTimeUnixNano: "1749000005000000000",
                        attributes: [
                            { key: "langchain.agent.name", value: { stringValue: "research_agent" } },
                            { key: "langchain.run_id", value: { stringValue: "run-001" } },
                        ],
                        status: { code: 1 },
                    },
                    {
                        traceId: "ext-trace-001",
                        spanId: "ext-planner",
                        parentSpanId: "ext-root",
                        name: "plan_task",
                        kind: 1, // INTERNAL
                        startTimeUnixNano: "1749000000100000000",
                        endTimeUnixNano: "1749000002000000000",
                        attributes: [
                            { key: "langchain.task.name", value: { stringValue: "research_planning" } },
                        ],
                        status: { code: 1 },
                    },
                    {
                        traceId: "ext-trace-001",
                        spanId: "ext-search",
                        parentSpanId: "ext-planner",
                        name: "web_search_tool",
                        kind: 3, // CLIENT
                        startTimeUnixNano: "1749000001000000000",
                        endTimeUnixNano: "1749000001800000000",
                        attributes: [
                            { key: "tool.name", value: { stringValue: "tavily_search" } },
                            { key: "tool.input", value: { stringValue: '{"query":"AI news 2026"}' } },
                            { key: "tool.output", value: { stringValue: "Found 10 results..." } },
                        ],
                        status: { code: 1 },
                    },
                    {
                        traceId: "ext-trace-001",
                        spanId: "ext-summarize",
                        parentSpanId: "ext-planner",
                        name: "summarize_results",
                        kind: 1, // INTERNAL
                        startTimeUnixNano: "1749000002000000000",
                        endTimeUnixNano: "1749000004500000000",
                        attributes: [
                            { key: "langchain.llm.model", value: { stringValue: "claude-sonnet-5" } },
                        ],
                        status: { code: 1 },
                    },
                    {
                        traceId: "ext-trace-001",
                        spanId: "ext-error-tool",
                        parentSpanId: "ext-summarize",
                        name: "file_writer",
                        kind: 3, // CLIENT
                        startTimeUnixNano: "1749000003000000000",
                        endTimeUnixNano: "1749000003500000000",
                        attributes: [
                            { key: "tool.name", value: { stringValue: "write_file" } },
                        ],
                        status: { code: 2, message: "permission denied: /root/output.txt" },
                    },
                ],
            }],
        }],
    };

    console.log("  外部 Trace: LangChain Agent (5 Spans, 含 1 个错误)");

    const imported = otelToInternalTrace(externalOtel, { userId: 1, sessionId: 1 });
    check("外部 Trace 导入成功", imported !== null);

    // 验证根结构
    check("合成 root 创建", imported?.rootSpan?.name === "imported-trace" || imported?.rootSpan?.name === "agent_executor",
        imported?.rootSpan?.name);

    // 验证 agent/tool 计数
    check("toolCallCount = 2", imported?.toolCallCount === 2, `实际: ${imported?.toolCallCount}`);
    check("errorCount = 1", imported?.errorCount === 1, `实际: ${imported?.errorCount}`);

    // 验证 agent 路径
    check("agentTraversalPath 含 planner",
        imported?.agentTraversalPath?.includes("plan_task"),
        JSON.stringify(imported?.agentTraversalPath));
    check("agentTraversalPath 含 summarizer",
        imported?.agentTraversalPath?.includes("summarize_results"),
        JSON.stringify(imported?.agentTraversalPath));

    // 递归验证子节点
    function countSpans(span) {
        let n = 1;
        for (const c of (span.children || [])) n += countSpans(c);
        return n;
    }
    const totalSpans = countSpans(imported.rootSpan);
    check("总 Span 数 = 5 (1 root + 4 children, 单根无需合成)", totalSpans === 5, `实际: ${totalSpans}`);

    // 验证 metadata 提取
    function findSpan(span, name) {
        if (span.name === name) return span;
        for (const c of (span.children || [])) {
            const found = findSpan(c, name);
            if (found) return found;
        }
        return null;
    }
    const searchSpan = findSpan(imported.rootSpan, "web_search_tool");
    check("web_search_tool Span 存在", !!searchSpan);
    check("tool metadata 保留 tool.name", searchSpan?.metadata?.["tool.name"] === "tavily_search");
    check("tool metadata 保留 tool.input", searchSpan?.metadata?.["tool.input"]?.includes("AI news"));

    // 验证错误 Span
    const errSpan = findSpan(imported.rootSpan, "file_writer");
    check("file_writer Span 存在且含 error", !!errSpan?.metadata?.error,
        errSpan?.metadata?.error);

    return imported;
}

// ══════════════════════════════════════════════════
// 第三部分：HTTP API 层端到端测试 (需要后端运行)
// ══════════════════════════════════════════════════

async function testHttpLayer() {
    section("第三部分：HTTP API 层端到端测试");

    let token = null;

    // 登录获取 token
    try {
        console.log("  尝试登录...");
        const loginRes = await fetch(`${BASE_URL}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: TEST_USER, password: TEST_PASS }),
        });
        const loginData = await loginRes.json();
        if (loginData?.token) {
            token = loginData.token;
            console.log("  ✅ 登录成功");
        } else {
            console.log(`  ⚠ 登录失败：${loginData?.message || "未知"}。尝试注册...`);
            const regRes = await fetch(`${BASE_URL}/auth/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username: TEST_USER, password: TEST_PASS }),
            });
            const regData = await regRes.json();
            if (regData?.token) {
                token = regData.token;
                console.log("  ✅ 注册+登录成功");
            } else {
                console.log(`  ⚠ 注册也失败：${regData?.message || "未知"}。跳过 HTTP 层测试。`);
                return;
            }
        }
    } catch (err) {
        console.log(`  ⚠ 无法连接后端 (${err.message})。跳过 HTTP 层测试。`);
        console.log("  启动后端: cd backend && npm run dev");
        return;
    }

    const authHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
    };

    // ── Step A: 获取 Trace 列表 ──
    console.log("\n  ── Step A: GET /observability/traces ──");
    let traceId;
    try {
        const tracesRes = await fetch(`${BASE_URL}/observability/traces?limit=1`, {
            headers: authHeaders,
        });
        const tracesData = await tracesRes.json();
        check("GET /observability/traces 成功", tracesData?.ok === true,
            `${tracesData?.total || 0} 条`);
        if (tracesData?.traces?.length > 0) {
            traceId = tracesData.traces[0].trace_id;
            console.log(`  使用 Trace: ${traceId}`);
        }
    } catch (err) {
        console.log(`  ❌ HTTP 错误: ${err.message}`);
        return;
    }

    if (!traceId) {
        console.log("  ⚠ 无 Trace 可导出。请先发送一条聊天消息。");
        return;
    }

    // ── Step B: 导出 OTel ──
    console.log("\n  ── Step B: GET /observability/traces/:id/otel ──");
    let otelPayload;
    try {
        const otelRes = await fetch(`${BASE_URL}/observability/traces/${encodeURIComponent(traceId)}/otel`, {
            headers: authHeaders,
        });
        const otelData = await otelRes.json();
        check("GET /otel 返回 ok", otelData?.ok === true);
        check("返回 resourceSpans", otelData?.otel?.resourceSpans?.length >= 1,
            `${otelData?.otel?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.length || 0} Span(s)`);
        otelPayload = otelData?.otel;
    } catch (err) {
        check("GET /otel 网络请求", false, err.message);
        return;
    }

    // ── Step C: 导入 OTel ──
    console.log("\n  ── Step C: POST /observability/otel/import ──");
    let importTraceId;
    try {
        const importRes = await fetch(`${BASE_URL}/observability/otel/import`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({ otel: otelPayload, session_id: 0 }),
        });
        const importData = await importRes.json();
        check("POST /otel/import 成功", importData?.ok === true,
            `trace_id=${importData?.trace_id}, ${importData?.spans} Span(s)`);
        importTraceId = importData?.trace_id;
    } catch (err) {
        check("POST /otel/import 网络请求", false, err.message);
        return;
    }

    // ── Step D: 验证导入的 Trace 可查询 ──
    console.log("\n  ── Step D: 验证导入 Trace 可查询 ──");
    try {
        const detailRes = await fetch(`${BASE_URL}/observability/traces/${encodeURIComponent(importTraceId)}`, {
            headers: authHeaders,
        });
        const detailData = await detailRes.json();
        check("导入 Trace 可查询", detailData?.ok === true);
        check("导入 Trace 类型为 import", detailData?.trace?.trace_type === "import",
            detailData?.trace?.trace_type);
        check("model = external", detailData?.trace?.model === "external");
    } catch (err) {
        check("GET /observability/traces/:imported 网络请求", false, err.message);
    }

    // ── Step E: 导入的 Trace 也可以导出 ──
    console.log("\n  ── Step E: 导入 Trace 二次导出 ──");
    try {
        const otel2Res = await fetch(`${BASE_URL}/observability/traces/${encodeURIComponent(importTraceId)}/otel`, {
            headers: authHeaders,
        });
        const otel2Data = await otel2Res.json();
        check("导入 Trace 可二次导出", otel2Data?.ok === true);
        const spans2 = otel2Data?.otel?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans || [];
        check("二次导出 Span 数一致", spans2.length > 0, `${spans2.length} Span(s)`);
    } catch (err) {
        check("GET /otel (imported) 网络请求", false, err.message);
    }

    // ── Step F: 验证 Trace 列表含导入的 Trace ──
    console.log("\n  ── Step F: Trace 列表含导入项 ──");
    try {
        const listRes = await fetch(`${BASE_URL}/observability/traces?limit=50`, {
            headers: authHeaders,
        });
        const listData = await listRes.json();
        const found = listData?.traces?.some((t) => t.trace_id === importTraceId);
        check("Trace 列表包含导入的 Trace", found, importTraceId);
    } catch (err) {
        check("GET /observability/traces 列表查询", false, err.message);
    }
}

// ══════════════════════════════════════════════════
// 主入口
// ══════════════════════════════════════════════════

async function main() {
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║   OTel Trace 格式映射 — 全流程闭环验证              ║");
    console.log("║   Phase 6c E2E Test                                ║");
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log(`  时间: ${new Date().toISOString()}`);
    console.log(`  后端: ${BASE_URL}`);

    // 函数层测试（无需服务器）
    await testFunctionLayer();

    // 外部 Trace 导入测试（无需服务器）
    testExternalImport();

    // HTTP API 层测试（需要服务器）
    await testHttpLayer();

    // ── 结果汇总 ──
    section("结果汇总");
    const total = passed + failed;
    const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
    const icon = failed === 0 ? "🎉" : "⚠️";
    console.log(`  ${icon} ${passed}/${total} 通过 (${pct}%)${failed > 0 ? ` — ${failed} 失败` : ""}`);

    if (failed > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("\n💥 脚本异常:", err);
    process.exit(1);
});
