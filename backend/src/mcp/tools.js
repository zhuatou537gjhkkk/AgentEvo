import crypto from "crypto";
import { DynamicTool } from "@langchain/core/tools";
import { getMessageStats } from "../db/index.js";
import { queryKnowledgeBase } from "../rag/index.js";
import { toolRegistry } from "./registry.js";
import { MemoryService } from "../services/memory.js";
import { agentConfig } from "../services/agentConfig.js";
import { getRequestContext, getRequestUserId } from "../services/requestContext.js";

// ── User Question Broker ──────────────────────────────────────
// 管理 Agent 向用户提问的 Promise/deferred 注册表。
// 工具 func 创建 deferred → chat.js 发射 SSE 事件 → REST 端点 resolve deferred → Agent 继续执行。

const pendingQuestions = new Map(); // questionId → { resolve, reject, timer, question, questionType, options }

/**
 * 注册一个待回答的问题。
 * 由 ask_user_question 工具的 func 调用。
 * @returns {{ questionId: string, promise: Promise<string> }}
 */
export function registerPendingQuestion(question, questionType, options = [], context = null) {
    const questionId = crypto.randomUUID();
    let timer = null;

    const promise = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            pendingQuestions.delete(String(questionId));
            resolve(JSON.stringify({ status: "timeout", answer: null }));
        }, 120_000); // 2 分钟超时

        pendingQuestions.set(questionId, { resolve, reject, timer, question, questionType, options, context });
    });

    return { questionId, promise };
}

/**
 * 获取并消费最近一个未发射的问题（供 chat.js SSE 事件循环使用）。
 * 返回 null 表示没有待发射的问题。
 * 工具调用是串行的，所以最近未发射的一定对应当前工具调用。
 */
export function consumePendingQuestion(context = null) {
    // Only consume a question belonging to the current authenticated
    // user/session; old callers without context retain legacy behavior.
    for (const [questionId, entry] of pendingQuestions) {
        if (context?.userId && entry.context?.userId !== context.userId) continue;
        if (context?.sessionId && entry.context?.sessionId && entry.context.sessionId !== context.sessionId) continue;
        if (!entry.emitted) {
            entry.emitted = true;
            return {
                questionId,
                question: entry.question,
                questionType: entry.questionType,
                options: entry.options,
            };
        }
    }
    return null;
}

/**
 * 用户回答了问题。由 REST 端点 POST /chat/answer 调用。
 * @returns {boolean} 是否成功 resolve
 */
export function resolveUserQuestion(questionId, answer, context = null) {
    const deferred = pendingQuestions.get(String(questionId));
    if (!deferred) {
        return false;
    }
    if (context?.userId && deferred.context?.userId !== context.userId) {
        return false;
    }
    if (context?.sessionId && deferred.context?.sessionId && deferred.context.sessionId !== context.sessionId) {
        return false;
    }
    clearTimeout(deferred.timer);
    pendingQuestions.delete(String(questionId));
    deferred.resolve(JSON.stringify({ status: "answered", answer }));
    return true;
}

/**
 * 清理指定 questionId（流异常结束时调用）。
 */
export function cancelUserQuestion(questionId) {
    const deferred = pendingQuestions.get(String(questionId));
    if (!deferred) {
        return false;
    }
    clearTimeout(deferred.timer);
    pendingQuestions.delete(String(questionId));
    deferred.resolve(JSON.stringify({ status: "cancelled", answer: null }));
    return true;
}

/**
 * 清理所有未完成的提问（流结束时批量调用）。
 */
export function cancelAllPendingQuestions(context = null) {
    for (const [questionId, deferred] of pendingQuestions) {
        if (context?.userId && deferred.context?.userId !== context.userId) continue;
        if (context?.sessionId && deferred.context?.sessionId && deferred.context.sessionId !== context.sessionId) continue;
        clearTimeout(deferred.timer);
        deferred.resolve(JSON.stringify({ status: "cancelled", answer: null }));
        pendingQuestions.delete(questionId);
    }
}

const BOCHA_CACHE_TTL_MS = 5 * 60 * 1000;
const bochaResponseCache = new Map();

const getSystemTimeTool = new DynamicTool({
    name: "get_system_time",
    description: "获取服务器当前的系统时间",
    func: async () => {
        return new Date().toLocaleString();
    }
});

const getDbMessageCountTool = new DynamicTool({
    name: "get_db_message_count",
    description: "获取本地 SQLite 数据库中的历史对话总条数",
    func: async () => {
        const stats = getMessageStats(getRequestUserId());
        return JSON.stringify(stats);
    }
});

const searchKnowledgeBaseTool = new DynamicTool({
    name: "search_knowledge_base",
    description: "仅用于上传文档的事实问答（参数、负责人、定义、规则、引用证据）。若用户是创意写作任务（如标语、文案、命名、润色、头脑风暴），禁止调用此工具。若返回“当前知识库为空”或“未检索到相关知识片段”，必须停止继续调用。",
    func: async (input) => {
        return queryKnowledgeBase(input, getRequestUserId());
    }
});

const bochaSearchTool = new DynamicTool({
    name: "web_search",
    description: "当用户询问实时新闻、当前发生的事件、或你不知道的客观事实时，必须调用此工具。输入应为具体的搜索关键词字符串。",
    func: async (input) => {
        try {
            let queryStr = input;

            while (typeof queryStr === "string") {
                try {
                    const parsed = JSON.parse(queryStr);
                    if (parsed && typeof parsed === "object") {
                        queryStr =
                            parsed.input ||
                            parsed.query ||
                            parsed.search_query ||
                            parsed.keyword ||
                            Object.values(parsed)[0] ||
                            queryStr;
                        continue;
                    }
                    break;
                } catch {
                    break;
                }
            }

            if (typeof queryStr !== "string") {
                queryStr = String(queryStr ?? "");
            }
            queryStr = queryStr.trim();
            if (!queryStr) {
                return "web_search 输入为空，无法执行搜索。";
            }

            const now = Date.now();
            const oneDayMs = 24 * 60 * 60 * 1000;
            const numeralMap = {
                "一": 1,
                "二": 2,
                "两": 2,
                "三": 3,
                "四": 4,
                "五": 5,
                "六": 6,
                "七": 7,
                "八": 8,
                "九": 9,
                "十": 10
            };

            const formatDate = (timestamp) => {
                const date = new Date(timestamp);
                const y = date.getFullYear();
                const m = String(date.getMonth() + 1).padStart(2, "0");
                const d = String(date.getDate()).padStart(2, "0");
                return `${y}-${m}-${d}`;
            };

            const parseSimpleDate = (text) => {
                const source = String(text || "").trim();
                let match = source.match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})日?/);
                if (match) {
                    const ts = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
                    return Number.isNaN(ts) ? null : ts;
                }

                match = source.match(/(\d{1,2})[-\/月](\d{1,2})日?/);
                if (match) {
                    const ts = new Date(new Date().getFullYear(), Number(match[1]) - 1, Number(match[2])).getTime();
                    return Number.isNaN(ts) ? null : ts;
                }

                return null;
            };

            const parseDateRange = (text) => {
                const rangeMatch = String(text || "").match(
                    /(\d{4}[-\/年]\d{1,2}[-\/月]\d{1,2}日?)\s*(?:到|至|~|-)\s*(\d{4}[-\/年]\d{1,2}[-\/月]\d{1,2}日?)/
                );
                if (!rangeMatch) {
                    return null;
                }

                const start = parseSimpleDate(rangeMatch[1]);
                const end = parseSimpleDate(rangeMatch[2]);
                if (start == null || end == null) {
                    return null;
                }

                return {
                    startMs: Math.min(start, end),
                    endMs: Math.max(start, end) + oneDayMs - 1,
                    label: `${formatDate(Math.min(start, end))} 到 ${formatDate(Math.max(start, end))}`
                };
            };

            const toNumber = (raw) => {
                const direct = Number(raw);
                if (Number.isFinite(direct)) {
                    return direct;
                }
                return numeralMap[raw] || null;
            };

            const parseRelativeWindow = (text) => {
                const q = String(text || "");

                if (/今天|今日|\btoday\b/i.test(q)) {
                    return { startMs: now - oneDayMs, endMs: now, label: "最近1天" };
                }
                if (/昨天|\byesterday\b/i.test(q)) {
                    return { startMs: now - 2 * oneDayMs, endMs: now - oneDayMs, label: "昨天" };
                }
                if (/近\s*半年|最近\s*半年|半年内|6\s*个月内/.test(q)) {
                    return { startMs: now - 183 * oneDayMs, endMs: now, label: "最近半年" };
                }
                if (/近\s*一年|最近\s*一年|一年内|12\s*个月内/.test(q)) {
                    return { startMs: now - 365 * oneDayMs, endMs: now, label: "最近一年" };
                }

                const unitMatch = q.match(/(?:最近|近|过去)\s*(\d+|[一二两三四五六七八九十]+)\s*(分钟|小时|天|周|个月|月|年)内?/);
                if (unitMatch) {
                    const value = toNumber(unitMatch[1]);
                    const unit = unitMatch[2];
                    if (value && value > 0) {
                        const unitMsMap = {
                            "分钟": 60 * 1000,
                            "小时": 60 * 60 * 1000,
                            "天": oneDayMs,
                            "周": 7 * oneDayMs,
                            "个月": 30 * oneDayMs,
                            "月": 30 * oneDayMs,
                            "年": 365 * oneDayMs
                        };
                        const ms = unitMsMap[unit];
                        return {
                            startMs: now - value * ms,
                            endMs: now,
                            label: `最近${value}${unit}`
                        };
                    }
                }

                const englishUnitMatch = q.match(
                    /(?:past|last|in\s+the\s+last)\s*(\d+)\s*(minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)/i
                );
                if (englishUnitMatch) {
                    const value = Number(englishUnitMatch[1]);
                    const unit = englishUnitMatch[2].toLowerCase();
                    if (Number.isFinite(value) && value > 0) {
                        const englishUnitMsMap = {
                            minute: 60 * 1000,
                            minutes: 60 * 1000,
                            hour: 60 * 60 * 1000,
                            hours: 60 * 60 * 1000,
                            day: oneDayMs,
                            days: oneDayMs,
                            week: 7 * oneDayMs,
                            weeks: 7 * oneDayMs,
                            month: 30 * oneDayMs,
                            months: 30 * oneDayMs,
                            year: 365 * oneDayMs,
                            years: 365 * oneDayMs
                        };
                        const ms = englishUnitMsMap[unit];
                        return {
                            startMs: now - value * ms,
                            endMs: now,
                            label: `past ${value} ${unit}`
                        };
                    }
                }

                return null;
            };

            const explicitRange = parseDateRange(queryStr);
            const relativeRange = parseRelativeWindow(queryStr);
            const timeWindow = explicitRange || relativeRange;
            const hasTimeWindow = Boolean(timeWindow);
            let freshness = "noLimit";
            if (explicitRange) {
                // Handle absolute date ranges (e.g. 2024-03-01 to 2024-03-10)
                const startStr = formatDate(explicitRange.startMs);
                const endStr = formatDate(explicitRange.endMs);
                freshness = startStr === endStr ? startStr : `${startStr}..${endStr}`;
            } else if (relativeRange) {
                // Handle relative windows (e.g. last week, today)
                const duration = relativeRange.endMs - relativeRange.startMs;

                // For pure past windows (e.g. yesterday), use explicit date range format.
                if (relativeRange.endMs < now - 1000) {
                    const startStr = formatDate(relativeRange.startMs);
                    const endStr = formatDate(relativeRange.endMs);
                    freshness = startStr === endStr ? startStr : `${startStr}..${endStr}`;
                } else if (duration <= oneDayMs) {
                    freshness = "oneDay";
                } else if (duration <= 7 * oneDayMs) {
                    freshness = "oneWeek";
                } else if (duration <= 31 * oneDayMs) {
                    freshness = "oneMonth";
                } else if (duration <= 366 * oneDayMs) {
                    freshness = "oneYear";
                }
            }

            const stripTemporalWords = (text) =>
                String(text || "")
                    .replace(/最近\s*\d+\s*(分钟|小时|天|周|个月|月|年)内?/g, " ")
                    .replace(/最近\s*[一二两三四五六七八九十]+\s*(分钟|小时|天|周|个月|月|年)内?/g, " ")
                    .replace(/近\s*半年|最近\s*半年|半年内|近\s*一年|最近\s*一年|一年内|今天|今日|昨天/g, " ")
                    .replace(/(?:past|last|in\s+the\s+last)\s*\d+\s*(minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)/gi, " ")
                    .replace(/\btoday\b|\byesterday\b/gi, " ")
                    .replace(/\d{4}[-\/年]\d{1,2}[-\/月]\d{1,2}日?\s*(到|至|~|-)\s*\d{4}[-\/年]\d{1,2}[-\/月]\d{1,2}日?/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();

            const coreQuery = stripTemporalWords(queryStr) || queryStr;
            const splitTerms = coreQuery
                .split(/(?:\s+或\s+|\s+或者\s+|\s+and\s+|\s+or\s+|\s*\/\s*|\s*、\s*|\s*\|\s*)/i)
                .map((item) => item.trim())
                .filter((item) => item.length >= 2);

            const queryCandidates = [];
            const pushCandidate = (text) => {
                const value = String(text || "").trim();
                if (!value) {
                    return;
                }
                if (!queryCandidates.includes(value)) {
                    queryCandidates.push(value);
                }
            };

            pushCandidate(queryStr);
            pushCandidate(coreQuery);
            if (hasTimeWindow) {
                pushCandidate(`${coreQuery} ${timeWindow.label} 最新动态`);
                pushCandidate(`${coreQuery} ${formatDate(timeWindow.startMs)} 到 ${formatDate(timeWindow.endMs)}`);
            }
            for (const term of splitTerms.slice(0, 3)) {
                pushCandidate(`${term} 最新动态`);
                if (hasTimeWindow) {
                    pushCandidate(`${term} ${timeWindow.label}`);
                }
            }

            const selectedQueries = queryCandidates.slice(0, 2);

            const fetchBocha = async (query, preferredFreshness) => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 10000);
                const cacheKey = `${preferredFreshness}::${query}`;

                try {
                    const cached = bochaResponseCache.get(cacheKey);
                    if (cached && Date.now() - cached.cachedAt <= BOCHA_CACHE_TTL_MS) {
                        console.log(`[Tool][cache] HIT — "${query}" (freshness=${preferredFreshness}, age=${Date.now() - cached.cachedAt}ms)`);
                        return cached.rows;
                    }
                    if (cached) {
                        console.log(`[Tool][cache] EXPIRED — "${query}" (age=${Date.now() - cached.cachedAt}ms), re-fetching`);
                    } else {
                        console.log(`[Tool][cache] MISS — "${query}", fetching from API`);
                    }

                    let response = await fetch("https://api.bochaai.com/v1/web-search", {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${process.env.BOCHA_API_KEY}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            query,
                            count: 10,
                            freshness: preferredFreshness
                        }),
                        signal: controller.signal
                    });

                    if (!response.ok && preferredFreshness === "oneDay") {
                        response = await fetch("https://api.bochaai.com/v1/web-search", {
                            method: "POST",
                            headers: {
                                Authorization: `Bearer ${process.env.BOCHA_API_KEY}`,
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                query,
                                count: 10,
                                freshness: "noLimit"
                            }),
                            signal: controller.signal
                        });
                    }

                    if (!response.ok) {
                        return [];
                    }

                    const data = await response.json();
                    const list = data?.data?.webPages?.value;
                    if (!Array.isArray(list)) {
                        return [];
                    }

                    const rows = list.map((item) => ({ ...item, _searchQuery: query }));
                    bochaResponseCache.set(cacheKey, {
                        cachedAt: Date.now(),
                        rows
                    });
                    return rows;
                } catch {
                    return [];
                } finally {
                    clearTimeout(timer);
                }
            };

            console.log("[Tool] 真正发送给博查的词是: " + queryStr);
            console.log("[Tool] 解析时间范围: " + (hasTimeWindow ? `${timeWindow.label}` : "none"));
            console.log("[Tool] 实际查询候选: " + JSON.stringify(selectedQueries));

            const fetchedGroups = [];
            for (const query of selectedQueries) {
                const rows = await fetchBocha(query, freshness);
                fetchedGroups.push(rows);
            }

            const rawItems = fetchedGroups.flat();
            if (rawItems.length === 0) {
                return "已执行联网搜索，但未检索到可用网页结果。";
            }

            const parseTimeFromText = (text) => {
                const source = String(text || "");

                let match = source.match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})日?/);
                if (match) {
                    const ts = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
                    return Number.isNaN(ts) ? null : ts;
                }

                match = source.match(/(\d{1,2})月(\d{1,2})日/);
                if (match) {
                    const ts = new Date(new Date().getFullYear(), Number(match[1]) - 1, Number(match[2])).getTime();
                    return Number.isNaN(ts) ? null : ts;
                }

                match = source.match(/(\d+)\s*小时前/);
                if (match) {
                    return now - Number(match[1]) * 60 * 60 * 1000;
                }

                match = source.match(/(\d+)\s*分钟前/);
                if (match) {
                    return now - Number(match[1]) * 60 * 1000;
                }

                match = source.match(/(\d+)\s*天前/);
                if (match) {
                    return now - Number(match[1]) * oneDayMs;
                }

                if (/昨天/.test(source)) {
                    return now - oneDayMs;
                }

                if (/刚刚|刚才/.test(source)) {
                    return now;
                }

                return null;
            };

            const pickTimeValue = (item) =>
                item?.datePublished ||
                item?.dateLastCrawled ||
                item?.date ||
                item?.pubDate ||
                item?.publishedAt ||
                item?.updatedAt ||
                item?.time ||
                "";

            const normalizedItems = rawItems.map((item) => {
                const timeValue = pickTimeValue(item);
                let ts = Date.parse(timeValue);
                if (Number.isNaN(ts)) {
                    ts = parseTimeFromText(`${item?.name || ""} ${item?.snippet || ""}`);
                }
                return {
                    name: item?.name || "无标题",
                    snippet: item?.snippet || "无摘要",
                    url: item?.url || item?.link || "",
                    site: item?.siteName || item?.site || "未知来源",
                    time: timeValue || "未知时间",
                    timestamp: Number.isNaN(ts) ? null : ts,
                    searchQuery: item?._searchQuery || ""
                };
            });

            const dedupMap = new Map();
            for (const item of normalizedItems) {
                const key = item.url || `${item.name}|${item.site}|${item.time}`;
                if (!dedupMap.has(key)) {
                    dedupMap.set(key, item);
                }
            }
            const uniqueItems = Array.from(dedupMap.values());

            const highAuthorityHosts = [
                "openai.com",
                "x.ai",
                "x.com",
                "reuters.com",
                "bloomberg.com",
                "ft.com",
                "theverge.com",
                "techcrunch.com",
                "wsj.com",
                "nytimes.com",
                "bbc.com"
            ];
            const lowQualityHosts = [
                "csdn.net",
                "toutiao.com",
                "m.weibo.cn",
                "weibo.com",
                "feishu.cn",
                "waytoagi.com",
                "caprompt.com"
            ];

            const getHostname = (url) => {
                try {
                    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
                } catch {
                    return "";
                }
            };

            const hasHost = (host, list) => list.some((item) => host === item || host.endsWith(`.${item}`));

            const getSourceScore = (item) => {
                const host = getHostname(item.url);
                let score = 0;
                if (hasHost(host, highAuthorityHosts)) {
                    score += 4;
                }
                if (hasHost(host, lowQualityHosts)) {
                    score -= 2;
                }
                if (item.timestamp != null) {
                    score += 1;
                }
                if (/openai|musk|马斯克|xai/i.test(`${item.name} ${item.snippet}`)) {
                    score += 2;
                }
                return score;
            };

            const rankedItems = uniqueItems
                .map((item) => ({ ...item, sourceScore: getSourceScore(item) }))
                .sort((a, b) => {
                    if (b.sourceScore !== a.sourceScore) {
                        return b.sourceScore - a.sourceScore;
                    }
                    return (b.timestamp || 0) - (a.timestamp || 0);
                });

            const withTimestampCount = rankedItems.filter((item) => item.timestamp != null).length;
            const withoutTimestampCount = rankedItems.length - withTimestampCount;
            console.log(
                `[Tool] 结果统计 total=${rankedItems.length} withTimestamp=${withTimestampCount} withoutTimestamp=${withoutTimestampCount}`
            );

            let resultItems = rankedItems;
            let header = "";

            if (hasTimeWindow) {
                const strictItems = rankedItems.filter(
                    (item) =>
                        item.timestamp != null &&
                        item.timestamp >= timeWindow.startMs &&
                        item.timestamp <= timeWindow.endMs
                );

                const unknownTimeItems = rankedItems.filter((item) => item.timestamp == null);
                const outOfWindowItems = rankedItems
                    .filter((item) => item.timestamp != null)
                    .sort((a, b) => {
                        const da =
                            a.timestamp < timeWindow.startMs
                                ? timeWindow.startMs - a.timestamp
                                : a.timestamp - timeWindow.endMs;
                        const db =
                            b.timestamp < timeWindow.startMs
                                ? timeWindow.startMs - b.timestamp
                                : b.timestamp - timeWindow.endMs;
                        return da - db;
                    });

                console.log(
                    `[Tool] 时间过滤 strict=${strictItems.length} unknown=${unknownTimeItems.length} outWindow=${outOfWindowItems.length}`
                );

                if (strictItems.length > 0) {
                    resultItems = strictItems.sort((a, b) => {
                        if ((b.timestamp || 0) !== (a.timestamp || 0)) {
                            return (b.timestamp || 0) - (a.timestamp || 0);
                        }
                        return (b.sourceScore || 0) - (a.sourceScore || 0);
                    });
                    header = `已按时间窗口 ${timeWindow.label} 过滤，以下为命中结果:\n`;
                } else if (unknownTimeItems.length > 0) {
                    resultItems = unknownTimeItems;
                    header = `未找到可确认落在 ${timeWindow.label} 的结果，以下结果时间待核验，仅供参考:\n`;
                } else {
                    resultItems = outOfWindowItems;
                    header = `未找到 ${timeWindow.label} 内结果，以下为最接近该时间窗口的候选（已超窗）:\n`;
                }
            } else {
                resultItems = rankedItems;
            }

            if (resultItems.length === 0) {
                return "已执行联网搜索，但未检索到可用结果。";
            }

            return (
                header +
                resultItems
                    .slice(0, 8)
                    .map(
                        (item) =>
                            `时间: ${item.time}\n时间校验: ${item.timestamp != null ? "已核验" : "待核验"}\n来源: ${item.site}\n标题: ${item.name}\n摘要: ${item.snippet}\n链接: ${item.url || "无链接"}\n检索词: ${item.searchQuery}`
                    )
                    .join("\n")
            );
        } catch (error) {
            return `web_search 调用异常: ${error?.message || "unknown error"}`;
        }
    }
});

const updateTodoTool = new DynamicTool({
    name: "update_todo",
    description: `更新当前任务的执行计划。在开始多步骤任务前，先调用此工具列出完整计划。
输入为严格的 JSON 字符串，包含以下字段：
- todos (array): 任务列表，每项包含 id (string: 唯一标识)、content (string: 任务描述)

示例输入:
{"todos":[{"id":"1","content":"搜索网络获取最新信息","status":"pending"},{"id":"2","content":"检索知识库文档","status":"pending"},{"id":"3","content":"整合信息生成最终回答","status":"pending"}]}`,
    func: async (input) => {
        let parsed;
        try {
            parsed = typeof input === "string" ? JSON.parse(input) : input;
        } catch {
            return JSON.stringify({ ok: false, error: "Invalid JSON" });
        }
        const todos = Array.isArray(parsed.todos) ? parsed.todos : [];
        return JSON.stringify({ ok: true, count: todos.length });
    }
});

const askUserQuestionTool = new DynamicTool({
    name: "ask_user_question",
    description: `当需要用户做出选择、补充信息或确认操作时调用此工具。
输入为严格的 JSON 字符串，包含以下字段：
- question (string): 向用户展示的问题文本
- questionType (string): 问题类型。single_choice=单选(自动提交)、multi_choice=多选(批量提交)、text_input=文本输入
- options (string[]): 选项列表(仅 single_choice/multi_choice 需要)

示例输入:
{"question":"请选择你需要的文件","questionType":"single_choice","options":["报告A.pdf","报表B.xlsx","数据C.csv"]}
{"question":"请补充你的需求细节","questionType":"text_input","options":[]}`,
    func: async (input) => {
        let parsed;
        try {
            parsed = typeof input === "string" ? JSON.parse(input) : input;
        } catch {
            // 如果 LLM 没有传 JSON，退化为 text_input
            parsed = { question: String(input), questionType: "text_input", options: [] };
        }

        const question = String(parsed.question || "请补充信息");
        const questionType = ["single_choice", "multi_choice", "text_input"].includes(parsed.questionType)
            ? parsed.questionType
            : "text_input";
        const options = Array.isArray(parsed.options) ? parsed.options : [];

        const { questionId, promise } = registerPendingQuestion(question, questionType, options, getRequestContext());

        console.log(`[agent][ask_user] id=${questionId} type=${questionType} question="${question.slice(0, 80)}"`);

        const result = await promise;
        return result;
    }
});

// ── Phase 4: 记忆工具 ──

/** 当前请求的 userId，由 chatGraph 在每次请求前设置 */
let _memoryToolUserId = null;

/**
 * 设置 memory_tool 的当前用户上下文（每次请求前由 chatGraph 调用）
 */
export function setMemoryToolContext(userId) {
    // Legacy setter retained for tests/old callers; authenticated request context is authoritative.
    _memoryToolUserId = userId;
}

const memoryTool = new DynamicTool({
    name: "memory",
    description: `管理用户记忆。支持的操作（通过 action 参数指定）：
- add: 添加记忆。参数: action="add", content="内容", memory_type="working|episodic|semantic", importance=0.5
- search: 搜索记忆。参数: action="search", query="查询", memory_types=["working","episodic"], limit=10
- consolidate: 记忆巩固（短期→长期）。参数: action="consolidate", from_type="working", to_type="episodic", importance_threshold=0.7
- forget: 遗忘记忆。参数: action="forget", strategy="importance|time", memory_type="working", threshold=0.3
- stats: 获取记忆统计。参数: action="stats"
- summary: 获取记忆摘要。参数: action="summary", limit=20
输入为 JSON 字符串。`,
    func: async (input) => {
        try {
            let parsed;
            try {
                parsed = typeof input === "string" ? JSON.parse(input) : input;
            } catch {
                return JSON.stringify({ error: "无法解析输入，请提供有效的 JSON 格式" });
            }

            const action = String(parsed.action || "search");
            const requestContext = getRequestContext();
            const testUserFallback = process.env.NODE_ENV === "test" || process.env.VITEST ? 1 : null;
            const userId = getRequestUserId(_memoryToolUserId || testUserFallback);
            const sessionId = requestContext?.sessionId || null;
            if (!userId) {
                return JSON.stringify({ ok: false, error: "REQUEST_CONTEXT_REQUIRED" });
            }
            // Identity fields from model input are intentionally ignored.
            console.log(`[memory_tool] action=${action} userId=${userId} sessionId=${sessionId}`);
            const memory = new MemoryService(userId);

            switch (action) {
                case "add": {
                    const content = String(parsed.content || "");
                    if (!content.trim()) {
                        return JSON.stringify({ error: "content 不能为空" });
                    }
                    const memoryType = String(parsed.memory_type || "working");
                    const importance = Math.max(0, Math.min(1, Number(parsed.importance) || 0.5));
                    const metadata = parsed.metadata || {};
                    const id = memory.add(content, memoryType, importance, metadata, sessionId);
                    console.log(`[memory_tool] add result: id=${id} userId=${userId} content="${content}" type=${memoryType}`);
                    return JSON.stringify({ success: true, memory_id: id, action: "add" });
                }
                case "search": {
                    const query = String(parsed.query || parsed.q || "");
                    const memoryTypes = Array.isArray(parsed.memory_types)
                        ? parsed.memory_types
                        : (parsed.memory_type ? [parsed.memory_type] : null);
                    const limit = Math.min(50, Math.max(1, Number(parsed.limit) || 10));
                    const minImportance = Number(parsed.min_importance) || 0.1;
                    const results = memory.search(query, memoryTypes, limit, minImportance);
                    return JSON.stringify({ results, count: results.length, action: "search" });
                }
                case "consolidate": {
                    const fromType = String(parsed.from_type || "working");
                    const toType = String(parsed.to_type || "episodic");
                    const threshold = Number(parsed.importance_threshold) || 0.7;
                    const result = memory.consolidate(fromType, toType, threshold);
                    return JSON.stringify({
                        consolidated: result.consolidated,
                        total: result.total,
                        from_type: fromType,
                        to_type: toType,
                    });
                }
                case "forget": {
                    const strategy = String(parsed.strategy || "importance");
                    const memType = String(parsed.memory_type || "working");
                    const threshold = Number(parsed.threshold) || 0.3;
                    const deleted = memory.forget(strategy, memType, threshold);
                    return JSON.stringify({ deleted, strategy, memory_type: memType });
                }
                case "stats": {
                    return JSON.stringify(memory.stats());
                }
                case "summary": {
                    const limit = Math.min(50, Math.max(1, Number(parsed.limit) || 20));
                    const items = memory.summary(limit);
                    return JSON.stringify({ items, count: items.length });
                }
                default:
                    return JSON.stringify({
                        error: `不支持的操作: ${action}。支持: add, search, consolidate, forget, stats, summary`,
                    });
            }
        } catch (err) {
            return JSON.stringify({ error: `记忆操作失败: ${err.message}` });
        }
    }
});

export const agentTools = [
    getSystemTimeTool,
    getDbMessageCountTool,
    searchKnowledgeBaseTool,
    bochaSearchTool,
    updateTodoTool,
    askUserQuestionTool,
    memoryTool
];

// ── Phase 3: 自动注册到 ToolRegistry ──
// 本地工具注册后，chatGraph.js 和 chatUtils.js 可通过 toolRegistry 统一获取。
// agentTools 导出继续保留，确保向后兼容（TOOL_REGISTRY_ENABLED=false 时使用）。
toolRegistry.registerLocalTools(agentTools);

// ── Phase 6a G4: 工具描述可配置 ──
// 通过 Object.defineProperty getter 让工具描述动态读取 agentConfig，
// 用户在 SettingsModal 修改描述后即时生效（无需重启）。
const _TOOL_DESC_OVERRIDES = {
    get_system_time: "tool.get_system_time.description",
    get_db_message_count: "tool.get_db_message_count.description",
    search_knowledge_base: "tool.search_knowledge_base.description",
    web_search: "tool.web_search.description",
    memory: "tool.memory.description",
};

for (const tool of agentTools) {
    const configKey = _TOOL_DESC_OVERRIDES[tool.name];
    if (!configKey) continue;
    const originalDesc = tool.description;
    Object.defineProperty(tool, "description", {
        get() {
            const custom = agentConfig.get(configKey);
            return custom || originalDesc;
        },
        configurable: true,
        enumerable: true,
    });
}
