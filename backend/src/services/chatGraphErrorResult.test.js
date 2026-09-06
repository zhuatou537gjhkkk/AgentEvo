import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isErrorResultText } from "./chatGraph.js";

/**
 * W4-R5 (T2) — Synthesizer/融合消费者"只接收成功文本或明确 blocked 结果"守卫。
 *
 * 改造前：synthesizerNode 内部 isErrorResult 只匹配文本前缀
 * （(工具不可用)/知识库检索出错:/联网搜索出错:/工具调用失败:/Error:），
 * 结构化降级 JSON（web_search 的 `{"ok":false,...}`、`{"status":"error"}`）会被
 * 当作"成功数据"注入融合上下文 —— LLM 看到一块声明失败的结果却不知其失败。
 *
 * W4-R5 把分类器提升为模块级 `isErrorResultText` 并补结构化失败标记；
 * 本文件断言分类语义（"成功但空"的 no_match/空库文案保持成功侧，不误伤），
 * 并用源级断言锁死 synthesizer 不再内联重复实现。
 */

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const CHAT_GRAPH_SRC = readFileSync(path.join(TEST_DIR, "chatGraph.js"), "utf8");

describe("isErrorResultText — 只收成功/明确 blocked 结果 (W4-R5 T2)", () => {
    it("文本失败前缀 → blocked", () => {
        expect(isErrorResultText("")).toBe(true);
        expect(isErrorResultText("   \n  ")).toBe(true);
        expect(isErrorResultText("(Web搜索工具不可用)")).toBe(true);
        expect(isErrorResultText("知识库检索出错: embedding timeout")).toBe(true);
        expect(isErrorResultText("联网搜索出错: upstream 503")).toBe(true);
        expect(isErrorResultText("工具调用失败: registry no tool")).toBe(true);
        expect(isErrorResultText("Error: provider key rejected")).toBe(true);
    });

    it("结构化降级 JSON → blocked（W4-R5 新增）", () => {
        expect(isErrorResultText('{"ok":false,"errorCode":"MCP_TOOL_FAILED","message":"联网检索暂时不可用","retryable":true}')).toBe(true);
        expect(isErrorResultText('{"status": "error", "detail": "faiss open failed"}')).toBe(true);
        expect(isErrorResultText('{"ok" : false, "errorCode":"UPSTREAM_UNAVAILABLE"}')).toBe(true);
        expect(isErrorResultText('正文前 {"status":"failed"} 正文后')).toBe(true);
    });

    it("成功结果（含空知识库/无匹配文案）→ 非 blocked，保持成功侧", () => {
        expect(isErrorResultText('{"ok":true,"data":["片段A"]}')).toBe(false);
        expect(isErrorResultText('{"status":"ok","items":[{"content":"x"}]}')).toBe(false);
        expect(isErrorResultText("未检索到相关知识片段")).toBe(false);
        expect(isErrorResultText("当前知识库为空")).toBe(false);
        expect(isErrorResultText("模拟检索结果（命中条目 x3）")).toBe(false);
        expect(isErrorResultText("普通回答文本")).toBe(false);
    });

    it("源级不变量：synthesizer 不再内联重复分类器，统一走导出函数", () => {
        expect(CHAT_GRAPH_SRC).not.toMatch(/const isErrorResult\s*=/);
        // 导出函数本身 + 至少 4 处消费调用（planResults / search / knowledge / code）
        expect(CHAT_GRAPH_SRC.match(/isErrorResultText\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    });
});
