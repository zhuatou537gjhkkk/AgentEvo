/**
 * agentRetrieval.js — Phase 7 / R3 #6：搜索增强（纯函数、无 LLM、无网络/DB）。
 *
 * 目标：让 chatGraph 的 searchAgentNode（AGENT_RETRIEVAL_ENABLED=true 时）把
 * web_search 工具返回的原始文本做「解析 → 去重 → 新鲜度评分 → 精选 → 引用标注 →
 * 有界上下文块」的确定性后处理，再注入 Synthesizer。
 *
 * 本模块刻意不 import 任何 LLM SDK / LangChain 运行库 / DB，保持可单测、可移植。
 * 所有启发式都是确定性的（同一输入 → 同一输出），没有翻译服务、没有随机数。
 *
 * web_search 原始文本示例（每块一个结果，字段前缀固定）：
 *   时间: 2026-09-01T10:00:00Z
 *   时间校验: 已核验
 *   来源: Example.com
 *   标题: Some Headline
 *   摘要: snippet...
 *   链接: https://example.com/x
 *   检索词: query
 * （块之间以换行分隔；头部可能有"未找到…仅供参考"等说明行。）
 */

// ═══════════════════════════════════════════════════════
// 常量与字符集
// ═══════════════════════════════════════════════════════

/** CJK 区块（含扩展 A/B 常用区），用于判定是否走英文关键词启发式 */
const CJK_RE = /[㐀-䶿一-鿿\u{20000}-\u{2a6df}]/u;

/** 关键词压缩时剔除的常见停用词（中英文各一小撮，纯启发式，无语言学承诺） */
const STOPWORDS = new Set([
    // 中文虚词 / 提问 / 祈使
    "的", "了", "是", "在", "和", "与", "及", "或", "为", "等", "中", "于", "有", "很", "都",
    "如何", "什么", "怎么", "怎么样", "为什么", "怎样", "哪些", "哪个", "多少",
    "请", "搜索", "查找", "检索", "帮我", "帮我查", "介绍", "一下", "吗", "呢", "啊",
    "对比", "比较", "列出", "总结", "分析", "关于", "想要", "需要", "我想", "请问",
    // 英文停用词
    "the", "a", "an", "of", "and", "or", "to", "in", "for", "on", "with", "is", "are",
    "was", "were", "be", "been", "about", "what", "how", "why", "when", "which", "who",
]);

/** 构造 ToolMessage 时要保留的"结构错误"样板书签名（防止把错误文本当数据再加工） */
const CJK_WORD_RE = /[㐀-䶿一-鿿\u{20000}-\u{2a6df}]/gu;

// ═══════════════════════════════════════════════════════
// 内部工具：文本规整
// ═══════════════════════════════════════════════════════

/** 规整文本：折叠空白后 trim（用于子串包含判断，避免只差空格/换行产生假差异） */
function normalizeSpaces(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

/** 抽取字符串里的拉丁/数字 token（型号、品牌、年份等），去重保序 */
function latinTokens(value) {
    const text = String(value == null ? "" : value);
    const tokens = text.match(/[A-Za-z0-9][A-Za-z0-9._+-]*/g) || [];
    const seen = new Set();
    const out = [];
    for (const t of tokens) {
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
    }
    return out;
}

/** 关键词集：query → 用于 relevance 打分的小集合（拉丁 token + CJK 有义片段） */
function extractKeywords(query) {
    const q = String(query == null ? "" : query);
    const tokens = new Set();
    for (const t of latinTokens(q)) {
        const lower = t.toLowerCase();
        if (lower.length > 1 && !STOPWORDS.has(lower)) tokens.add(lower);
    }
    // CJK：直接整段作为候选（不做分词），去掉结尾常见虚字后长度≥2 才保留
    for (const m of q.match(CJK_WORD_RE) || []) {
        const cleaned = m.replace(/[的了是在和与及或为等中于有都很吗呢啊]$/g, "");
        if (cleaned.length >= 2) tokens.add(cleaned);
    }
    return tokens;
}

/**
 * 关键词压缩变体：去掉停用词/标点、折叠空白、统一小写后去重保序。
 * 返回空串表示「压缩后无实质差异」→ 调用方自行决定跳过。
 */
function keywordCompress(query) {
    let s = String(query == null ? "" : query).trim();
    if (!s) return "";
    let lower = s.toLowerCase();
    const originalLower = lower.replace(/\s+/g, " ").trim(); // 停用字剔除前的原貌（用于"是否实质不同"判断）
    // 1) 剔除中文停用字（整串替换，启发式；先长后短避免 "怎么/怎么样" 这类前缀残留）
    const cjkStops = [...STOPWORDS].filter((w) => CJK_RE.test(w)).sort((a, b) => b.length - a.length);
    for (const w of cjkStops) {
        lower = lower.split(w).join("");
    }
    // 2) 仅保留字母/数字/空白（去掉标点）
    const scrubbed = lower.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/-+/g, " ");
    const tokens = scrubbed.split(/\s+/).filter(Boolean);
    const seen = new Set();
    const kept = [];
    for (const t of tokens) {
        if (STOPWORDS.has(t)) continue;
        if (t.length === 1 && /[a-z0-9]/.test(t)) continue;
        const key = t;
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(t);
    }
    const joined = kept.join(" ").trim();
    // 与原查询实质相同 → 空串（避免产生无用重复变体）
    return joined && joined !== originalLower ? joined : "";
}

/**
 * 英文关键词变体（仅当查询含 CJK 时可能产生）：把查询里已经存在的
 * 拉丁/数字 token（如 "React"、"2024"）抽出来当检索关键词 —— 这是简单启发式，
 * 不做任何翻译服务。纯中文查询没有可用 token 时返回空串。
 */
function englishKeywordVariant(query) {
    const q = String(query == null ? "" : query);
    if (!CJK_RE.test(q)) return "";
    return latinTokens(q).join(" ");
}

// ═══════════════════════════════════════════════════════
// #1 decomposeQuery — 查询分解
// ═══════════════════════════════════════════════════════

/**
 * 把用户一条查询拆成至多 3 个互补检索子句：
 *   1. 修剪后的原文（总是第一项）
 *   2. 关键词压缩变体（去停用词/标点）
 *   3. 若含 CJK，追加英文关键词变体（提取查询中已有的拉丁/数字 token）
 * 返回数组永不重复自身、永不包含空串、绝不为空（最坏只有原文一项）。
 * @param {string} query
 * @returns {string[]}
 */
export function decomposeQuery(query) {
    const original = String(query == null ? "" : query).trim();
    const parts = [original];
    const add = (candidate) => {
        if (!candidate) return;
        const norm = candidate.trim();
        if (!norm || parts.some((p) => p.toLowerCase() === norm.toLowerCase())) return;
        parts.push(norm);
    };
    add(keywordCompress(original));
    if (CJK_RE.test(original)) add(englishKeywordVariant(original));
    return parts.slice(0, 3);
}

// ═══════════════════════════════════════════════════════
// URL / 内容去重
// ═══════════════════════════════════════════════════════

/** 规整 URL：去掉 fragment 与尾部斜杠、删除 utm_* 与 source= 追踪参数 */
export function normalizeUrl(url) {
    let u = String(url == null ? "" : url).trim();
    if (!u) return "";
    u = u.split("#")[0];
    try {
        const parsed = new URL(u);
        const dropKeys = [];
        for (const key of parsed.searchParams.keys()) {
            const lower = key.toLowerCase();
            if (lower.startsWith("utm_") || lower === "source") dropKeys.push(key);
        }
        for (const key of dropKeys) parsed.searchParams.delete(key);
        u = parsed.toString();
    } catch (e) {
        // 非绝对 URL（测试可能传入裸 path）：降级朴素清洗，仅删裸追踪参数
        u = u.replace(/[?&](utm_[^=#&]+|source)=[^#&]*/gi, "");
    }
    return u.replace(/\/+$/, "");
}

/**
 * 去重：
 *  (a) 归一化 URL 完全相同 → 只留第一个；
 *  (b) contentHash=true 时再做内容包含去重：若 A 的内容（长度≥40）整体被 B 的内容
 *      包含且 B 不更短 → 丢弃更短的 A（等长完全相同时保留先出现者）。
 * @param {Array<{url?:string,title?:string,content?:string,publishedAt?:string,source?:string}>} results
 * @param {{contentHash?: boolean}} [opts]
 * @returns {{results: Array, deduped: number}}
 */
export function dedupeResults(results, { contentHash = true } = {}) {
    const list = Array.isArray(results) ? results.filter(Boolean) : [];
    // (a) URL 去重
    const urlSeen = new Set();
    const urlKept = [];
    for (const r of list) {
        const nu = normalizeUrl(r.url);
        if (!nu) {
            urlKept.push(r);
            continue;
        }
        if (urlSeen.has(nu)) continue;
        urlSeen.add(nu);
        urlKept.push(r);
    }
    if (contentHash === false) {
        return { results: urlKept, deduped: list.length - urlKept.length };
    }
    // (b) 内容包含去重
    const items = urlKept.map((r, i) => ({ r, i, c: normalizeSpaces(r.content) }));
    const kept = [];
    let dropped = 0;
    for (const it of items) {
        let dup = false;
        if (it.c.length >= 40) {
            for (const o of items) {
                if (o === it) continue;
                const oc = o.c;
                if (oc.length < 40) continue;
                const strictlyLonger = oc.length > it.c.length;
                const earlierWhenEqual = oc.length === it.c.length ? o.i < it.i : true;
                if (oc.includes(it.c) && (strictlyLonger || earlierWhenEqual)) {
                    dup = true;
                    break;
                }
            }
        }
        if (dup) dropped += 1;
        else kept.push(it.r);
    }
    return { results: kept, deduped: list.length - kept.length };
}

// ═══════════════════════════════════════════════════════
// #3 scoreFreshness — 新鲜度评分（0..1）
// ═══════════════════════════════════════════════════════

/**
 * 把 publishedAt 映射到 0..1 的新鲜度分：
 *  - 非法 / 缺失 → 0；
 *  - 距今 <24h（含未来时间戳，视为"即将发布"，同样给满分）→ 1；
 *  - 更早 → 指数衰减（风格对齐 contextBuilder.calculateRecency：exp(-0.1 * age/24)，
 *    下限 0.1），保证永不为负。
 * @param {string|number|Date} publishedAtIso
 * @returns {number}
 */
export function scoreFreshness(publishedAtIso) {
    if (publishedAtIso == null) return 0;
    const ts = Date.parse(publishedAtIso);
    if (!Number.isFinite(ts) || Number.isNaN(ts)) return 0;
    const ageHours = (Date.now() - ts) / (1000 * 3600);
    if (ageHours <= 24) return 1;
    return Math.max(0.1, Math.exp((-0.1 * ageHours) / 24));
}

// ═══════════════════════════════════════════════════════
// #4 selectBest — 精选（relevance 命中 + 新鲜度决胜 + 预算）
// ═══════════════════════════════════════════════════════

/**
 * 精选 results：
 *  - 顺序默认保持输入序；给到非空 query 时，按 title+content 命中 query 关键词数
 *    降序排序，命中数相同按新鲜度降序，再相同回到原始索引（稳定）。
 *  - requireFresh=true → 剔除「时间已知且确实陈旧（新鲜度 < 0.5）」的结果；
 *    时间未知的结果不因缺日期被误杀。
 *  - 预算：最多 maxResults 条；内容总字符不超过 maxChars（超预算条目跳过，但至少
 *    保留一条）。
 * @param {Array} results
 * @param {string|object} [queryOrOptions]  query 字符串 或 {maxResults,maxChars,requireFresh}
 * @param {{maxResults?:number, maxChars?:number, requireFresh?:boolean}} [maybeOptions]
 * @returns {{results: Array, sources: Array, chars: number}}
 */
export function selectBest(results, queryOrOptions, maybeOptions) {
    let query = "";
    let options = {};
    if (typeof queryOrOptions === "string") {
        query = queryOrOptions;
        options = maybeOptions || {};
    } else {
        options = queryOrOptions || {};
    }
    const { maxResults = 6, maxChars = 4000, requireFresh = false } = options;
    const list = Array.isArray(results) ? results.filter(Boolean) : [];
    const keywords = query ? extractKeywords(query) : new Set();

    const scored = list
        .map((r, idx) => {
            const title = String(r.title == null ? "" : r.title);
            const content = String(r.content == null ? "" : r.content);
            const fresh = scoreFreshness(r.publishedAt);
            let hits = 0;
            if (keywords.size > 0) {
                const hay = `${title}\n${content}`.toLowerCase();
                for (const kw of keywords) if (hay.includes(kw)) hits += 1;
            }
            return { r, idx, hits, fresh, len: content.length };
        })
        .filter((s) => {
            if (!requireFresh) return true;
            // requireFresh：有确切时间且陈旧(<0.5) 才剔除；缺时间不误杀
            if (s.r.publishedAt == null) return true;
            return s.fresh >= 0.5;
        });

    // 排序：有查询关键词信号才重排（命中多 > 命中同看新鲜度 > 仍同回原始索引）；
    // 无查询时保持输入顺序（工具自带排序比"仅按新鲜度重排"更有意义，也更确定）。
    if (keywords.size > 0) {
        scored.sort((a, b) => {
            if (b.hits !== a.hits) return b.hits - a.hits;
            if (b.fresh !== a.fresh) return b.fresh - a.fresh;
            return a.idx - b.idx;
        });
    }

    const selected = [];
    let chars = 0;
    for (const s of scored) {
        if (selected.length >= maxResults) break;
        if (selected.length > 0 && chars + s.len > maxChars) continue; // 跳过超预算，继续看更短的
        selected.push(s.r);
        chars += s.len;
    }

    const sources = selected.map((r) => ({
        title: r.title,
        url: r.url,
        publishedAt: r.publishedAt,
    }));
    return { results: selected, sources, chars };
}

// ═══════════════════════════════════════════════════════
// #5 citeSources — 确定性引用标注
// ═══════════════════════════════════════════════════════

/** 标题兜底：去掉空白折叠后若空，用 `来源{n}` 占位（保持确定输出） */
function displayTitle(r, i) {
    const t = normalizeSpaces(r?.title);
    return t || `来源${i + 1}`;
}

/**
 * 为精选结果生成引用标注：
 *  - markMap: Map<index, label>，index 是传入数组的下标 → label 形如 "[1]"；
 *  - citations: 可直接粘进上下文的 "来源：\n[n] title (url)" 文本块（确定格式）。
 * @param {Array} results
 * @param {{format?: 'inline'|'markdown'}} [opts]
 * @returns {{citations: string, markMap: Map<number,string>}}
 */
export function citeSources(results, { format = "inline" } = {}) {
    const list = Array.isArray(results) ? results : [];
    const markMap = new Map();
    const lines = [];
    for (let i = 0; i < list.length; i += 1) {
        const r = list[i];
        const label = `[${i + 1}]`;
        markMap.set(i, label);
        const title = displayTitle(r, i);
        const url = String(r?.url == null ? "" : r.url);
        if (format === "markdown") {
            lines.push(url ? `${i + 1}. [${title}](${url})` : `${i + 1}. ${title}`);
        } else {
            lines.push(url ? `${label} ${title} (${url})` : `${label} ${title}`);
        }
    }
    const citations = lines.length > 0 ? `来源：\n${lines.join("\n")}` : "来源：暂无可用来源";
    return { citations, markMap };
}

// ═══════════════════════════════════════════════════════
// buildSearchContext — "[搜索结果]" 有界块
// ═══════════════════════════════════════════════════════

/**
 * 把（已精选的）结果渲染成 Synthesizer 可消费的 `[搜索结果]` 文本块，
 * 每项带 "[n]" 标注 + 链接，总字符不超过 maxChars（块级截断，尽量保留整块）。
 * @param {Array} results
 * @param {{maxChars?: number}} [opts]
 * @returns {string}
 */
export function buildSearchContext(results, { maxChars = 4000 } = {}) {
    const list = Array.isArray(results) ? results : [];
    const blocks = [];
    for (let i = 0; i < list.length; i += 1) {
        const r = list[i] || {};
        const label = `[${i + 1}]`;
        const title = displayTitle(r, i);
        const content = normalizeSpaces(r.content);
        const url = String(r.url == null ? "" : r.url);
        let block = `${label} ${title}`;
        if (content) block += `\n${content}`;
        if (url) block += `\n链接: ${url}`;
        if (r.publishedAt) block += `\n时间: ${r.publishedAt}`;
        blocks.push(block);
    }
    const cap = Math.max(0, Number(maxChars) || 0);
    const header = "[搜索结果]";
    if (blocks.length === 0) return header;
    let out = header;
    for (const b of blocks) {
        const sep = out === header ? "\n" : "\n\n";
        if (out.length + sep.length + b.length > cap) {
            if (out === header) out += sep + b.slice(0, Math.max(0, cap - out.length - sep.length));
            break;
        }
        out += sep + b;
    }
    return out;
}

// ═══════════════════════════════════════════════════════
// 原始文本解析（行启发式，确定性）
// ═══════════════════════════════════════════════════════

/** 结果块字段前缀（web_search 输出固定格式；兼容中英文冒号） */
const FIELD_RE = /^(时间|时间校验|来源|标题|摘要|链接|检索词)[:：]\s*/;

/**
 * 把 web_search 原始文本拆成候选结果对象数组（{title,url,content,publishedAt,source}）。
 * 行启发式：
 *  - 空行 ⇒ 块结束；
 *  - "时间:" 行的再次出现 ⇒ 新块开始（web_search 每块首字段是 时间:）；
 *  - 块内非字段行视为摘要续行；块外的头部说明行被忽略。
 * 解析不出任何候选时返回 []（调用方据此保留原文，不误伤非结构化文本）。
 * @param {string} rawText
 * @returns {Array}
 */
export function parseResultBlocks(rawText) {
    const text = String(rawText == null ? "" : rawText);
    if (!text.trim()) return [];
    const results = [];
    let cur = null;
    const flush = () => {
        if (cur && (cur.title || cur.url || (cur.snippetLines && cur.snippetLines.length))) {
            results.push(toResultObject(cur));
        }
        cur = null;
    };
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
            if (cur) flush();
            continue;
        }
        const m = FIELD_RE.exec(trimmed);
        if (!m) {
            if (cur) (cur.snippetLines = cur.snippetLines || []).push(trimmed);
            continue;
        }
        const key = m[1];
        const value = trimmed.slice(m[0].length).trim();
        if (key === "时间") {
            if (cur) flush();
            cur = { time: value, snippetLines: [] };
        } else if (key === "标题") {
            if (cur && cur.title) flush();
            if (!cur) cur = { snippetLines: [] };
            cur.title = value;
        } else if (key === "链接") {
            if (!cur) cur = { snippetLines: [] };
            cur.url = value;
        } else if (key === "来源") {
            if (!cur) cur = { snippetLines: [] };
            cur.source = value;
        } else if (key === "时间校验") {
            if (!cur) cur = { snippetLines: [] };
            cur.timeVerified = value;
        } else if (key === "摘要") {
            if (!cur) cur = { snippetLines: [] };
            cur.snippetLines.push(value);
        } else if (key === "检索词") {
            if (!cur) cur = { snippetLines: [] };
            cur.searchQuery = value;
        }
    }
    flush();
    return results;
}

/** 把解析中间对象映射为结果候选对象；时间字段只在能解析为日期时才带出。 */
function toResultObject(cur) {
    const content = (cur.snippetLines || []).join("\n");
    let publishedAt = null;
    const tv = cur.time;
    if (tv && tv !== "未知时间") {
        const ts = Date.parse(tv);
        if (!Number.isFinite(ts) || Number.isNaN(ts)) {
            // 相对时间（"x小时前"等）当前文本无绝对时间 → 视为未知
        } else {
            publishedAt = tv;
        }
    }
    return {
        title: cur.title || "",
        url: cur.url || "",
        content,
        publishedAt,
        source: cur.source || "",
    };
}

/** 内建的轻量"错误样"文本识别：这些不应被当作结构化结果加工（chatGraph 另有 isErrorResultText 兜底）。 */
function isErrorLikeText(text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return true;
    if (/^\(.*工具不可用\)$/.test(s)) return true;
    if (/^知识库检索出错:/i.test(s)) return true;
    if (/^联网搜索出错:/i.test(s)) return true;
    if (/^Error:/i.test(s)) return true;
    if (/"ok"\s*:\s*false/.test(s)) return true;
    if (/"errorCode"\s*:/.test(s)) return true;
    if (/"status"\s*:\s*"(?:error|failed)"/.test(s)) return true;
    return false;
}

// ═══════════════════════════════════════════════════════
// postProcessSearchResults — searchAgentNode 接线用总入口
// ═══════════════════════════════════════════════════════

/**
 * web_search 原始文本 → 去重 + 精选 + 引用标注 + 有界上下文块 的完整后处理。
 * 安全保证：无法解析出候选 / 错误样文本 / 空文本 → 原样返回，绝不把结果改坏。
 * @param {string} rawText
 * @param {{maxChars?: number, maxResults?: number}} [opts]
 * @returns {string}
 */
export function postProcessSearchResults(rawText, { maxChars = 8000, maxResults = 6 } = {}) {
    const text = String(rawText == null ? "" : rawText);
    if (!text.trim()) return text;
    if (isErrorLikeText(text)) return text;

    const candidates = parseResultBlocks(text);
    if (candidates.length === 0) return text; // 非 web_search 块格式 → 保持原样

    const { results: deduped } = dedupeResults(candidates);
    const { results: best } = selectBest(deduped, { maxResults, maxChars: Infinity });
    const { citations } = citeSources(best);

    const footer = citations ? `\n\n${citations}` : "";
    const bodyCap = Math.max(64, maxChars - footer.length);
    const body = buildSearchContext(best, { maxChars: bodyCap });
    let out = body + footer;
    if (out.length > maxChars) out = out.slice(0, maxChars); // 保底钳制（不截断引用块优先）
    return out;
}
