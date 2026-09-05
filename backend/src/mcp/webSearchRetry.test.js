import { afterEach, describe, expect, it, vi } from "vitest";
import { agentTools } from "./tools.js";
import { classifyError } from "../services/resilience.js";

/**
 * W4-R3 (C3) — web_search（bocha）瞬态抛错契约。
 *
 * 改造前 fetchBocha 把一切失败（5xx/超时/网络）吞成 [] → DynamicTool 永不 reject
 * → chatGraph:1241 / chat.js 强制联网步的 withRetry 惰性（无从触发）。
 * 改造后：瞬时（429/408/5xx）抛带 status 的 classifyable 错；10s 自毁 abort →
 * 可重试超时；网络错误原样上抛（走 cause 链 ECONNRESET/ECONNREFUSED 等）；**不再吞 []**。
 * 不可重试的 4xx（如 key 无效 401）保持返回空结果（agent 可继续）。
 *
 * 每个用例用不同 query，避免模块级 bochaResponseCache（key=`freshness::query`）串扰。
 */

const webSearchTool = agentTools.find((tool) => tool.name === "web_search");
expect(webSearchTool).toBeTruthy();

const PREV_FETCH = globalThis.fetch;

afterEach(() => {
    if (PREV_FETCH === undefined) delete globalThis.fetch;
    else globalThis.fetch = PREV_FETCH;
    vi.restoreAllMocks();
});

function stubFetch(handler) {
    globalThis.fetch = vi.fn(async (url, init) => {
        const controller = init?.signal;
        // 模拟 fetch 已随请求被 abort（等价 fetchBocha 的 10s 自毁）
        if (controller?.aborted) {
            throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
        }
        return handler(url, init);
    });
}

function jsonResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** 从 invoke 结果里区分 reject / resolve：resolve 返回 {err:null,value}。 */
async function settle(promise) {
    try {
        return { err: null, value: await promise };
    } catch (err) {
        return { err, value: null };
    }
}

describe("web_search transient errors now reject as classifyable retryable errors (W4-R3 C3)", () => {
    it("503 → rejects with retryable classified error (was: swallowed to empty result)", async () => {
        stubFetch(() => jsonResponse(503, {}));
        const { err, value } = await settle(webSearchTool.invoke("火星移民计划 契约A"));
        expect(err).toBeTruthy();
        expect(value).toBeNull();
        const classified = classifyError(err);
        expect(classified.retryable).toBe(true);
        expect(classified.code).toBe("UPSTREAM_UNAVAILABLE");
    });

    it("429 → rejects retryable", async () => {
        stubFetch(() => jsonResponse(429, {}));
        const { err } = await settle(webSearchTool.invoke("火星移民计划 契约B"));
        expect(classifyError(err).retryable).toBe(true);
    });

    it("network failure (fetch failed w/ ECONNREFUSED cause) → rejects retryable via cause chain", async () => {
        globalThis.fetch = vi.fn(async () => {
            const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
            throw Object.assign(new TypeError("fetch failed"), { cause });
        });
        const { err } = await settle(webSearchTool.invoke("火星移民计划 契约C"));
        expect(err).toBeTruthy();
        expect(classifyError(err).retryable).toBe(true);
    });

    it("10s abort (AbortError) → rejects retryable as UPSTREAM_TIMEOUT", async () => {
        // fetch 直接抛 AbortError → fetchBocha catch 把它转成显式可重试超时
        globalThis.fetch = vi.fn(async () => {
            throw Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" });
        });
        const { err } = await settle(webSearchTool.invoke("火星移民计划 契约D"));
        expect(err).toBeTruthy();
        const classified = classifyError(err);
        expect(classified.retryable).toBe(true);
        expect(classified.code).toBe("UPSTREAM_TIMEOUT");
    });

    it("HTTP 401 (bad key, non-retryable 4xx) → still resolves with empty-result message", async () => {
        stubFetch(() => jsonResponse(401, {}));
        const { err, value } = await settle(webSearchTool.invoke("火星移民计划 契约E"));
        expect(err).toBeNull();
        expect(String(value)).toContain("未检索到可用");
    });

    it("HTTP 200 with no webPages → resolves with empty-result message", async () => {
        stubFetch(() => jsonResponse(200, { data: { webPages: { value: [] } } }));
        const { err, value } = await settle(webSearchTool.invoke("火星移民计划 契约F"));
        expect(err).toBeNull();
        expect(String(value)).toContain("未检索到可用");
    });
});
