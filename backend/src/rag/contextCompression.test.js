import { describe, expect, it } from "vitest";
import { compressContext } from "./contextCompression.js";

const candidates = [{
    chunkId: "chunk-1",
    pageStart: 4,
    pageEnd: 4,
    content: [
        "# 部署指南",
        "这是与问题无关的背景描述。",
        "部署 AgentEvo 时需要启动 worker，并等待索引进入 ready 状态。",
        "| 字段 | 说明 |",
        "| --- | --- |",
        "| status | ready 表示可以检索 |",
        "$$ ready = indexed && active $$",
    ].join("\n"),
}];

describe("K6 extractive context compression", () => {
    it("keeps Chinese hit sentences, headings, table and formula without rewriting", () => {
        const result = compressContext({
            query: "部署 worker ready",
            candidates,
            enabled: true,
            perChunkChars: 360,
            totalChars: 360,
        });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].compressedContent).toContain("部署 AgentEvo");
        expect(result.items[0].compressedContent).toContain("| 字段 | 说明 |");
        expect(result.items[0].compressedContent).toContain("ready = indexed");
        expect(result.items[0].compressedContent.length).toBeLessThanOrEqual(360);
        expect(result.metrics.afterChars).toBeLessThan(result.metrics.beforeChars);
        expect(result.metrics.keptEvidenceIds).toEqual(["chunk-1"]);
    });

    it("compresses parent plus leaf context without dropping provenance fields", () => {
        const result = compressContext({
            query: "部署",
            candidates: [{ chunkId: "leaf", pageStart: 7, contextContent: "父章节说明\n部署 worker" }],
            enabled: true,
            perChunkChars: 100,
            totalChars: 100,
        });
        expect(result.items[0].compressedContent).toContain("部署 worker");
        expect(result.items[0].pageStart).toBe(7);
    });

    it("returns original candidates when disabled", () => {
        const result = compressContext({ query: "部署", candidates, enabled: false, totalChars: 10 });
        expect(result.items).toBe(candidates);
        expect(result.metrics.enabled).toBe(false);
        expect(result.metrics.beforeChars).toBe(result.metrics.afterChars);
    });

    it("falls back to the first healthy evidence when extraction has no text", () => {
        const result = compressContext({
            query: "missing",
            candidates: [{ chunkId: "empty", content: "" }, { chunkId: "ok", content: "fallback evidence" }],
            enabled: true,
            totalChars: 100,
        });
        expect(result.items[0].chunkId).toBe("ok");
        expect(result.metrics.fallback).toBe(false);
    });
});
