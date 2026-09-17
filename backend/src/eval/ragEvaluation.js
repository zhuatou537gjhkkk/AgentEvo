/**
 * K7 deterministic knowledge-RAG evaluation.
 *
 * The evaluator consumes retrieval results, not generated prose. This keeps
 * recall/no-match/citation checks reproducible and prevents an LLM judge from
 * overriding a deterministic security or retrieval failure.
 */

export const RAG_GOLDEN_CASES = Object.freeze([
    { id: "rag_cn_semantic_001", category: "semantic", query: "怎么把服务重新启动", relevantChunkIds: ["doc-cn-restart"], expectedPages: [2] },
    { id: "rag_exact_model_002", category: "exact_term", query: "Qwen3.7 embedding 的 batch size", relevantChunkIds: ["doc-model-number"], expectedPages: [4] },
    { id: "rag_cross_page_003", category: "cross_page", query: "跨页部署步骤", relevantChunkIds: ["doc-cross-page-a", "doc-cross-page-b"], expectedPages: [8, 9] },
    { id: "rag_table_004", category: "table", query: "ready 状态代表什么", relevantChunkIds: ["doc-table-status"], expectedPages: [12] },
    { id: "rag_formula_005", category: "formula", query: "向量相似度公式", relevantChunkIds: ["doc-formula-cosine"], expectedPages: [15] },
    { id: "rag_scan_pdf_006", category: "ocr_pdf", query: "扫描 PDF 中的审批日期", relevantChunkIds: ["doc-scan-date"], expectedPages: [18] },
    { id: "rag_image_ocr_007", category: "ocr_image", query: "图片里的端口号", relevantChunkIds: ["doc-image-port"], expectedPages: [1] },
    { id: "rag_no_answer_008", category: "no_answer", query: "系统支持量子传输吗", relevantChunkIds: [], noAnswer: true },
    { id: "rag_revision_009", category: "revision", query: "新的 retention 配置", relevantChunkIds: ["doc-revision-new"], excludedChunkIds: ["doc-revision-old"], expectedPages: [22] },
    { id: "rag_owner_010", category: "owner_isolation", query: "另一个用户的私密文档", relevantChunkIds: [], noAnswer: true },
    { id: "rag_retry_011", category: "provider_retry", query: "MinerU 429 后的文档", relevantChunkIds: ["doc-mineru-retry"], expectedPages: [26] },
    { id: "rag_restart_012", category: "restart_recovery", query: "重启后仍可查询的手册", relevantChunkIds: ["doc-restart-ready"], expectedPages: [30] },
]);

// Small, deterministic fixtures keep evaluator development offline and make
// the intended evidence/citation contract reviewable without production data.
export const RAG_GOLDEN_FIXTURES = Object.freeze({
    rag_cn_semantic_001: [{ chunkId: "doc-cn-restart", pageStart: 2, pageEnd: 2, content: "服务重启步骤：先停止进程，再启动服务。" }],
    rag_exact_model_002: [{ chunkId: "doc-model-number", pageStart: 4, pageEnd: 4, content: "Qwen3.7 embedding 的 batch size 为 32。" }],
    rag_cross_page_003: [
        { chunkId: "doc-cross-page-a", pageStart: 8, pageEnd: 8, content: "跨页部署步骤的第一部分。" },
        { chunkId: "doc-cross-page-b", pageStart: 9, pageEnd: 9, content: "跨页部署步骤的第二部分。" },
    ],
    rag_table_004: [{ chunkId: "doc-table-status", pageStart: 12, pageEnd: 12, content: "表格：ready 表示服务已准备好接收请求。" }],
    rag_formula_005: [{ chunkId: "doc-formula-cosine", pageStart: 15, pageEnd: 15, content: "余弦相似度公式用于比较向量方向。" }],
    rag_scan_pdf_006: [{ chunkId: "doc-scan-date", pageStart: 18, pageEnd: 18, content: "扫描 PDF OCR：审批日期为 2026-08-20。" }],
    rag_image_ocr_007: [{ chunkId: "doc-image-port", pageStart: 1, pageEnd: 1, content: "图片 OCR：服务端口为 8080。" }],
    rag_no_answer_008: [{ chunkId: "doc-unrelated", pageStart: 3, pageEnd: 3, content: "系统支持普通网络传输。" }],
    rag_revision_009: [
        { chunkId: "doc-revision-new", pageStart: 22, pageEnd: 22, content: "新的 retention 配置为 30 天。" },
        { chunkId: "doc-revision-old", pageStart: 21, pageEnd: 21, content: "旧的 retention 配置为 7 天。" },
    ],
    rag_owner_010: [{ chunkId: "doc-other-owner", pageStart: 5, pageEnd: 5, content: "其他用户的私密文档。" }],
    rag_retry_011: [{ chunkId: "doc-mineru-retry", pageStart: 26, pageEnd: 26, content: "MinerU 429 后经过退避重试完成解析。" }],
    rag_restart_012: [{ chunkId: "doc-restart-ready", pageStart: 30, pageEnd: 30, content: "服务重启后仍可查询本手册。" }],
});

function finite(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function normalizeIds(items) {
    return (Array.isArray(items) ? items : [])
        .map((item) => String(item?.chunkId ?? item?.id ?? ""))
        .filter(Boolean);
}

function pageMatches(item, expectedPages) {
    const start = Number(item?.pageStart ?? item?.page_start);
    const end = Number(item?.pageEnd ?? item?.page_end ?? start);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return expectedPages.some((page) => Number(page) >= start && Number(page) <= end);
}

function reciprocalRank(ids, relevant) {
    const index = ids.findIndex((id) => relevant.has(id));
    return index === -1 ? 0 : 1 / (index + 1);
}

function ndcg(ids, relevant) {
    if (relevant.size === 0) return 0;
    const dcg = ids.reduce((sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
    const idealCount = Math.min(relevant.size, ids.length || relevant.size);
    const ideal = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2))
        .reduce((sum, value) => sum + value, 0);
    return ideal > 0 ? dcg / ideal : 0;
}

export function validateRagGoldenCases(cases = RAG_GOLDEN_CASES) {
    const seen = new Set();
    for (const testCase of cases) {
        if (!testCase?.id || seen.has(testCase.id)) return { ok: false, reason: "duplicate-or-missing-id" };
        if (!Array.isArray(testCase.relevantChunkIds)) return { ok: false, reason: "relevantChunkIds-required" };
        if (!testCase.noAnswer && testCase.relevantChunkIds.length === 0) return { ok: false, reason: "empty-positive-case" };
        seen.add(testCase.id);
    }
    return { ok: true, count: seen.size };
}

/** Score one retrieval response using deterministic retrieval/citation metrics. */
export function evaluateRagCase(testCase, response = {}, { latencyMs = null } = {}) {
    const items = Array.isArray(response.items) ? response.items : [];
    const ids = normalizeIds(items);
    const relevant = new Set((testCase.relevantChunkIds || []).map(String));
    const retrievedRelevant = ids.filter((id) => relevant.has(id));
    const recall = relevant.size > 0 ? new Set(retrievedRelevant).size / relevant.size : 0;
    const noAnswerCorrect = testCase.noAnswer === true
        ? (response.status === "no_match" || items.length === 0)
        : null;
    const pageAccuracy = Array.isArray(testCase.expectedPages) && testCase.expectedPages.length > 0
        ? (items.some((item) => pageMatches(item, testCase.expectedPages)) ? 1 : 0)
        : null;
    const excludedPresent = (testCase.excludedChunkIds || []).some((id) => ids.includes(String(id)));
    const metrics = response.metrics || {};
    const compression = metrics.compression || {};
    return {
        id: testCase.id,
        category: testCase.category,
        status: response.status || (items.length > 0 ? "ok" : "no_match"),
        retrievedIds: ids,
        recallAtK: recall,
        reciprocalRank: reciprocalRank(ids, relevant),
        ndcgAtK: ndcg(ids, relevant),
        noAnswerCorrect,
        pageAccuracy,
        excludedPresent,
        latencyMs: Math.max(0, finite(latencyMs ?? metrics.latencyMs)),
        rerankLatencyMs: Math.max(0, finite(metrics.rerankLatencyMs)),
        compressionRatio: compression.ratio == null ? null : Math.max(0, Math.min(1, finite(compression.ratio))),
        embeddingCalls: Math.max(0, finite(metrics.embeddingCalls)),
        passed: testCase.noAnswer
            ? noAnswerCorrect === true && !excludedPresent
            : recall > 0 && !excludedPresent && (pageAccuracy == null || pageAccuracy === 1),
    };
}

function average(rows, key) {
    const values = rows.map((row) => Number(row[key])).filter(Number.isFinite);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/** Aggregate a run without reading a model, database, or external service. */
export function aggregateRagEvaluation(rows = []) {
    const list = Array.isArray(rows) ? rows : [];
    const noAnswerRows = list.filter((row) => row.noAnswerCorrect != null);
    const noAnswerCorrect = noAnswerRows.filter((row) => row.noAnswerCorrect === true).length;
    const compressionRows = list.filter((row) => row.compressionRatio != null);
    return {
        total: list.length,
        passed: list.filter((row) => row.passed === true).length,
        failed: list.filter((row) => row.passed !== true).length,
        recallAtK: average(list, "recallAtK"),
        mrr: average(list, "reciprocalRank"),
        ndcgAtK: average(list, "ndcgAtK"),
        noAnswerPrecision: noAnswerRows.length > 0 ? noAnswerCorrect / noAnswerRows.length : null,
        citationPageAccuracy: average(list.filter((row) => row.pageAccuracy != null), "pageAccuracy"),
        avgLatencyMs: average(list, "latencyMs"),
        avgRerankLatencyMs: average(list, "rerankLatencyMs"),
        avgCompressionRatio: compressionRows.length > 0 ? average(compressionRows, "compressionRatio") : null,
        embeddingCalls: list.reduce((sum, row) => sum + finite(row.embeddingCalls), 0),
    };
}

/** Run cases through an injected retriever; no network is used by this module. */
export async function runRagEvaluation({ cases = RAG_GOLDEN_CASES, retrieve, now = () => Date.now() } = {}) {
    const validation = validateRagGoldenCases(cases);
    if (!validation.ok) throw new Error(`invalid RAG golden set: ${validation.reason}`);
    if (typeof retrieve !== "function") throw new Error("RAG evaluation requires an injected retriever");
    const results = [];
    for (const testCase of cases) {
        const started = now();
        try {
            const response = await retrieve(testCase);
            results.push(evaluateRagCase(testCase, response, { latencyMs: now() - started }));
        } catch (error) {
            results.push({
                id: testCase.id,
                category: testCase.category,
                status: "error",
                retrievedIds: [],
                recallAtK: 0,
                reciprocalRank: 0,
                ndcgAtK: 0,
                noAnswerCorrect: testCase.noAnswer ? false : null,
                pageAccuracy: testCase.expectedPages ? 0 : null,
                excludedPresent: false,
                latencyMs: Math.max(0, now() - started),
                rerankLatencyMs: 0,
                compressionRatio: null,
                embeddingCalls: 0,
                passed: false,
                errorCode: String(error?.code || "RAG_EVAL_RETRIEVER_ERROR").slice(0, 64),
            });
        }
    }
    return { cases: results, summary: aggregateRagEvaluation(results) };
}

export default { RAG_GOLDEN_CASES, RAG_GOLDEN_FIXTURES, evaluateRagCase, aggregateRagEvaluation, runRagEvaluation };
