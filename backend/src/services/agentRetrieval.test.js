/**
 * agentRetrieval 单元测试 — Phase 7 / R3 #6（纯函数，无网络/DB/LLM）。
 *
 * 覆盖：
 *   - decomposeQuery    原文优先 / 关键词压缩变体 / CJK→英文关键词启发式 / 上限与空输入
 *   - dedupeResults     URL 归一化去重（utm_*、source=、尾斜杠）/ 内容包含去重 / contentHash=false
 *   - scoreFreshness    0（缺失/非法）与 1（<24h/未来）与指数衰减
 *   - selectBest        预算上限 / 关键词命中优先 / 命中并列按新鲜度 / requireFresh / 字符预算
 *   - citeSources       确定性（同输入同输出）/ 格式 / markMap
 *   - buildSearchContext maxChars 有界 / 编号
 *   - parseResultBlocks / postProcessSearchResults  工具原文样例的端到端 + 错误文本原样透传
 */

import { describe, it, expect } from "vitest";
import {
    decomposeQuery,
    dedupeResults,
    scoreFreshness,
    selectBest,
    citeSources,
    buildSearchContext,
    parseResultBlocks,
    postProcessSearchResults,
    normalizeUrl,
} from "./agentRetrieval.js";

// 距今 n 小时 的 ISO（相对测试执行时刻，避免硬编码绝对时间）
const hoursAgoIso = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const daysAgoIso = (d) => hoursAgoIso(d * 24);

describe("agentRetrieval #1 decomposeQuery", () => {
    it("总是把修剪后的原文放第一，绝不为空数组", () => {
        expect(decomposeQuery("  Hello World  ")[0]).toBe("Hello World");
        expect(decomposeQuery("")).toEqual([""]);
        expect(decomposeQuery("   ").length).toBeGreaterThan(0);
        expect(decomposeQuery("xxx").length).toBeLessThanOrEqual(3);
    });

    it("英文查询生成关键词压缩变体（去停用词）", () => {
        const parts = decomposeQuery("The latest React 19 features");
        expect(parts.length).toBeGreaterThanOrEqual(2);
        expect(parts[1]).toContain("react");
        expect(parts[1]).not.toContain("the");
        // 不含重复变体
        expect(new Set(parts.map((p) => p.toLowerCase())).size).toBe(parts.length);
    });

    it("含 CJK 时追加英文关键词变体（提取已有拉丁 token，无翻译服务）", () => {
        const parts = decomposeQuery("React 的生态与2024年趋势");
        expect(parts.length).toBe(3);
        expect(parts[0]).toBe("React 的生态与2024年趋势");
        const english = parts[parts.length - 1].toLowerCase();
        expect(english).toContain("react");
        expect(english).toContain("2024");
    });

    it("关键词压缩会去掉中文停用字（先长后短，避免 '怎么样' 残留 '样'）", () => {
        const parts = decomposeQuery("今天天气怎么样");
        expect(parts[1]).toBe("今天天气");
    });

    it("最多 3 条，且变体互不重复", () => {
        const parts = decomposeQuery("如何学习 LangChain 与 LangGraph 和 LangChain");
        expect(parts.length).toBeLessThanOrEqual(3);
        expect(parts[0]).toBe("如何学习 LangChain 与 LangGraph 和 LangChain");
    });
});

describe("agentRetrieval #2 dedupeResults", () => {
    it("URL 归一化去重：尾斜杠 / utm_* / source= 视为同一结果", () => {
        const input = [
            { url: "https://a.com/x?utm_source=g&utm_medium=o", title: "A" },
            { url: "https://a.com/x/?source=rss", title: "A dup" }, // 仅尾斜杠+追踪参数差异 → 应判重
            { url: "https://b.com/y", title: "B" },
        ];
        const { results, deduped } = dedupeResults(input);
        expect(deduped).toBe(1);
        expect(results).toHaveLength(2);
        expect(results[0].title).toBe("A");
        expect(results[1].title).toBe("B");
    });

    it("normalizeUrl 幂等且去追踪参数", () => {
        const first = normalizeUrl("https://a.com/x/?utm_source=g&b=2#frag");
        const second = normalizeUrl(first);
        expect(first).toBe(second);
        expect(first).toBe("https://a.com/x/?b=2");
        expect(first.includes("utm_")).toBe(false);
        expect(first.includes("source=")).toBe(false);
    });

    it("内容包含去重：较短全文被较长结果包含时丢弃短的", () => {
        const short = "天气晴朗适合出行适合户外活动适合拍照记录生活".repeat(3); // ≥40
        const input = [
            { url: "https://a.com/1", content: `今日预报：${short}。以上是今日天气。` },
            { url: "https://a.com/2", content: short }, // 与上面完全相同的长串（被包含）
            { url: "https://b.com/3", content: "另一条完全不同的内容啊啊啊".repeat(6) },
        ];
        const { results, deduped } = dedupeResults(input);
        expect(deduped).toBe(1);
        expect(results).toHaveLength(2);
        expect(results[0].url).toBe("https://a.com/1");
        // 被包含的短结果必须排在后面被丢弃的只剩较长的 a.com/1
        expect(results.map((r) => r.url).includes("https://a.com/2")).toBe(false);
    });

    it("contentHash=false 时不做内容去重（仅 URL 去重）", () => {
        const long = "相同内容完全相同的内容块用于测试相同".repeat(5);
        const input = [
            { url: "https://a.com/1", content: long },
            { url: "https://a.com/2", content: long },
        ];
        const { deduped } = dedupeResults(input, { contentHash: false });
        expect(deduped).toBe(0); // URL 不同 → 不过滤
        const sameUrl = dedupeResults([{ url: "https://a.com/x" }, { url: "https://a.com/x" }], { contentHash: false });
        expect(sameUrl.deduped).toBe(1);
    });

    it("短内容（<40）不做内容包含去重", () => {
        const input = [
            { url: "https://a.com/1", content: "short" },
            { url: "https://a.com/2", content: "short" },
        ];
        const { deduped } = dedupeResults(input);
        expect(deduped).toBe(0);
    });

    it("返回新数组，不修改输入", () => {
        const input = [{ url: "https://a.com/x", title: "A" }, { url: "https://a.com/y", title: "B" }];
        const copy = input.map((r) => ({ ...r }));
        const { results } = dedupeResults(input);
        expect(results).not.toBe(input);
        expect(input).toEqual(copy);
    });
});

describe("agentRetrieval #3 scoreFreshness", () => {
    it("缺失 / 非法时间戳 → 0", () => {
        expect(scoreFreshness(null)).toBe(0);
        expect(scoreFreshness(undefined)).toBe(0);
        expect(scoreFreshness("not-a-date")).toBe(0);
        expect(scoreFreshness("")).toBe(0);
    });

    it("<24h → 1；未来时间戳（防未来）也按最新处理 → 1", () => {
        expect(scoreFreshness(hoursAgoIso(1))).toBe(1);
        expect(scoreFreshness(hoursAgoIso(23))).toBe(1);
        expect(scoreFreshness(hoursAgoIso(-2))).toBe(1);
    });

    it("超过 24h → 指数衰减（0..1 且 <1），对齐 exp(-0.1*ageDays)", () => {
        const days = 10;
        const score = scoreFreshness(daysAgoIso(days));
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThan(1);
        expect(score).toBeCloseTo(Math.exp(-0.1 * days), 5);
        expect(score).toBeGreaterThanOrEqual(0.1); // 下限 0.1，与 calculateRecency 风格一致
    });
});

describe("agentRetrieval #4 selectBest", () => {
    const mk = (url, title, content, publishedAt) => ({ url, title, content, publishedAt });

    it("maxResults 上限生效，字符预算也生效", () => {
        const items = [0, 1, 2, 3].map((i) => mk(`https://s.com/${i}`, `t${i}`, `内容块 ${i} `.repeat(60)));
        const capped = selectBest(items, { maxResults: 2, maxChars: Infinity });
        expect(capped.results).toHaveLength(2);
        expect(capped.chars).toBeLessThanOrEqual(capped.results[0].content.length + capped.results[1].content.length);

        // 每条 60 字符：maxChars=100 → 只能塞下第 1 条，其余都被预算挡掉
        const tiny = [0, 1, 2, 3].map((i) => mk(`https://s.com/t${i}`, `t${i}`, "x".repeat(60)));
        const charLimited = selectBest(tiny, { maxResults: 10, maxChars: 100 });
        expect(charLimited.results).toHaveLength(1);
        expect(charLimited.chars).toBeLessThanOrEqual(60);
    });

    it("字符预算下贪心塞入多条小结果；首条超预算时保底保留", () => {
        const small = [0, 1, 2, 3].map((i) => mk(`https://s.com/s${i}`, `s${i}`, "y".repeat(30)));
        const fill = selectBest(small, { maxResults: 10, maxChars: 100 }); // 30+30+30=90 ≤100，第四条超
        expect(fill.results).toHaveLength(3);
        expect(fill.chars).toBe(90);
        // 首条本身就超预算 → 保底 1 条（不因预算直接返回空）
        const oversize = [mk("https://s.com/o1", "o", "z".repeat(500)), mk("https://s.com/o2", "o2", "z".repeat(30))];
        const guard = selectBest(oversize, { maxResults: 10, maxChars: 100 });
        expect(guard.results).toHaveLength(1);
        expect(guard.results[0].url).toBe("https://s.com/o1");
    });

    it("无查询时保持输入顺序（不按新鲜度重排）", () => {
        const items = [
            mk("https://s.com/old", "old", "很久以前的老内容".repeat(6), daysAgoIso(20)),
            mk("https://s.com/fresh", "fresh", "今天的新内容".repeat(6), hoursAgoIso(2)),
        ];
        const { results } = selectBest(items, { maxResults: 6 });
        expect(results.map((r) => r.url)).toEqual(["https://s.com/old", "https://s.com/fresh"]);
    });

    it("有查询时命中关键词的结果优先；命中并列按新鲜度决出先者", () => {
        const freshHit = mk("https://s.com/f", "apple pie fresh", "fresh homemade apple pie recipe", hoursAgoIso(2));
        const oldHit = mk("https://s.com/o", "apple pie old", "old apple pie recipe from grandma", daysAgoIso(30));
        const noHit = mk("https://s.com/n", "banana cake", "banana bread and cake", hoursAgoIso(1));
        const { results } = selectBest([noHit, oldHit, freshHit], "apple pie", { maxResults: 6 });
        // 两个命中项都在未命中项前；命中内部按新鲜度：freshHit(新) 应排在 oldHit(旧) 前
        expect(results[0].url).toBe("https://s.com/f");
        expect(results[1].url).toBe("https://s.com/o");
        expect(results[2].url).toBe("https://s.com/n");
    });

    it("requireFresh=true 剔除时间确知且陈旧的结果，保留无日期结果", () => {
        const stale = mk("https://s.com/stale", "stale", "三十天前旧闻".repeat(8), daysAgoIso(30));
        const undated = mk("https://s.com/u", "undated", "无日期但可能是新内容".repeat(8), null);
        const fresh = mk("https://s.com/f2", "fresh2", "刚刚发布的新内容".repeat(8), hoursAgoIso(1));
        const { results } = selectBest([stale, undated, fresh], { maxResults: 6, requireFresh: true });
        const urls = results.map((r) => r.url);
        expect(urls.includes("https://s.com/stale")).toBe(false);
        expect(urls.includes("https://s.com/u")).toBe(true);
        expect(urls.includes("https://s.com/f2")).toBe(true);
    });

    it("返回 sources 标签数组与 chars 统计", () => {
        const items = [mk("https://s.com/1", "一", "内容一".repeat(10), hoursAgoIso(1))];
        const { results, sources, chars } = selectBest(items, "一", { maxResults: 6 });
        expect(results).toHaveLength(1);
        expect(sources[0].url).toBe("https://s.com/1");
        expect(sources[0].title).toBe("一");
        expect(chars).toBe(items[0].content.length);
    });
});

describe("agentRetrieval #5 citeSources", () => {
    it("确定性：同输入两次输出逐字符一致", () => {
        const items = [
            { title: "T1", url: "https://a.com/1" },
            { title: "T2", url: "" },
        ];
        const a = citeSources(items);
        const b = citeSources(items);
        expect(a.citations).toBe(b.citations);
        expect([...a.markMap.entries()]).toEqual([...b.markMap.entries()]);
    });

    it("inline 格式产出 '来源：\\n[n] title (url)' 块与 markMap", () => {
        const items = [
            { title: "OpenAI Blog", url: "https://openai.com/blog" },
            { title: "无链接条目", url: "" },
        ];
        const { citations, markMap } = citeSources(items);
        expect(markMap.get(0)).toBe("[1]");
        expect(markMap.get(1)).toBe("[2]");
        expect(citations).toBe("来源：\n[1] OpenAI Blog (https://openai.com/blog)\n[2] 无链接条目");
    });

    it("markdown 格式可选", () => {
        const { citations } = citeSources([{ title: "T", url: "https://a.com" }], { format: "markdown" });
        expect(citations).toBe("来源：\n1. [T](https://a.com)");
    });

    it("空结果也有确定输出（不会抛错）", () => {
        expect(citeSources([]).citations).toBe("来源：暂无可用来源");
        expect(citeSources(undefined).citations).toBe("来源：暂无可用来源");
    });
});

describe("agentRetrieval buildSearchContext", () => {
    it("块级有界：输出不超 maxChars，带 '[搜索结果]' 头与 [n] 编号", () => {
        const items = [0, 1, 2, 3].map((i) => ({
            title: `标题 ${i}`,
            url: `https://s.com/${i}`,
            content: `内容 ${i} `.repeat(40),
        }));
        const ctx = buildSearchContext(items, { maxChars: 300 });
        expect(ctx.startsWith("[搜索结果]")).toBe(true);
        expect(ctx.length).toBeLessThanOrEqual(300);
        expect(ctx).toContain("[1] 标题 0");
        expect(ctx).not.toContain("[4] 标题 3"); // 超预算块被丢弃
    });

    it("保留编号顺序与链接行", () => {
        const ctx = buildSearchContext([
            { title: "AAA", url: "https://a.com/1", content: "body", publishedAt: "2026-09-01T00:00:00Z" },
        ], { maxChars: 4000 });
        expect(ctx).toContain("链接: https://a.com/1");
        expect(ctx).toContain("时间: 2026-09-01T00:00:00Z");
    });
});

describe("agentRetrieval parseResultBlocks + postProcessSearchResults", () => {
    // 与 mcp/tools.js web_search 输出格式一致的样例（两块、第二块无链接时以空行或字段续接）
    const TOOL_TEXT = [
        "时间: 2026-09-01T00:00:00Z",
        "时间校验: 已核验",
        "来源: Alpha",
        "标题: First Result Title",
        "摘要: snippet one that is reasonably long enough to count as content",
        "链接: https://alpha.example/post?utm_source=news",
        "检索词: react",
        "时间: 2026-09-02T00:00:00Z",
        "时间校验: 待核验",
        "来源: Beta",
        "标题: Second Result Title",
        "摘要: snippet two content here but with more text to stay safe",
        "链接: https://beta.example/post",
        "检索词: react",
    ].join("\n");

    it("行启发式解析出候选结果（字段映射正确，utm 参数保留待 URL 归一化）", () => {
        const parsed = parseResultBlocks(TOOL_TEXT);
        expect(parsed).toHaveLength(2);
        expect(parsed[0].title).toBe("First Result Title");
        expect(parsed[0].url).toBe("https://alpha.example/post?utm_source=news");
        expect(parsed[0].publishedAt).toBe("2026-09-01T00:00:00Z");
        expect(parsed[0].source).toBe("Alpha");
        expect(parsed[1].content).toContain("snippet two");
    });

    it("端到端后处理：输出含去重后的块 + 引用来源，且不超 maxChars", () => {
        // 追加一个与首块同 URL 的重复块（只有摘要不同）
        const dupBlock = [
            "时间: 2026-09-03T00:00:00Z",
            "来源: Alpha",
            "标题: Duplicate Alpha Headline",
            "摘要: this is a near duplicate snippet for alpha example",
            "链接: https://alpha.example/post",
            "检索词: react",
        ].join("\n");
        const out = postProcessSearchResults(`${TOOL_TEXT}\n${dupBlock}`, { maxChars: 4000 });
        expect(out.startsWith("[搜索结果]")).toBe(true);
        expect(out).toContain("来源：");
        // 去重后只保留 2 条（alpha 一条 + beta 一条）
        const urlCount = (out.match(/链接: https:\/\/alpha\.example\/post/g) || []).length;
        expect(urlCount).toBe(1);
        expect(out).toContain("https://beta.example/post");
        expect(out.length).toBeLessThanOrEqual(4000);
    });

    it("错误样 / 空 / 无法解析的文本原样返回，绝不被加工破坏", () => {
        expect(postProcessSearchResults("")).toBe("");
        expect(postProcessSearchResults('{"ok":false,"data":null,"errorCode":"MCP_TOOL_FAILED","message":"联网检索暂时不可用"}')).toBe('{"ok":false,"data":null,"errorCode":"MCP_TOOL_FAILED","message":"联网检索暂时不可用"}');
        expect(postProcessSearchResults("已执行联网搜索，但未检索到可用结果。")).toBe("已执行联网搜索，但未检索到可用结果。");
        expect(postProcessSearchResults("(web_search 工具不可用)")).toBe("(web_search 工具不可用)");
        expect(postProcessSearchResults("一段随意的非 web_search 结构化文本，没有任何字段前缀，应当保持原样不被改动。")).toBe("一段随意的非 web_search 结构化文本，没有任何字段前缀，应当保持原样不被改动。");
    });
});
