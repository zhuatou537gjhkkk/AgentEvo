import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * W4-R4 (T4) — C1 死角源级护栏。
 *
 * buildChatOpenAIConfig 默认 maxRetries:0 → 任何"config-default 构造 + 无 withRetry"
 * 的 LLM 调用都会静默零重试。W4-R4 已把仅剩的两个死代码裸点
 * （eval/reflection.js reflectionLlm、services/memory.js llmMemoryConsolidation）
 * 包上 withRetry。本文件用只读源码断言锁住不变量，防止回归：
 *
 *  1. allowlist：任何含 `new ChatOpenAI(` 的生产模块必须至少含一个 `withRetry(` 调用
 *     （捕获"新增 config-default 构造但忘包 withRetry"类回归）。
 *  2. reflection.js / memory.js：各自唯一的裸 invoke 必须落在最近的 `withRetry(` 之后
 *     的包裹区间内（正则邻近断言）——死代码路径即使将来被接线也带重试。
 *  3. 护栏自检：全量扫描 src/（除 learning/ 教学代码与测试），凡含 `new ChatOpenAI(`
 *     的模块必须已入 allowlist——新构造点不会静默漏网。
 *
 * 纯 readFileSync/readdirSync，无网络/无 DB/不加载运行模块。
 */

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url)); // backend/src/services/
const SRC_ROOT = path.resolve(TEST_DIR, "..");                  // backend/src/
const SEP = path.sep;

/** src-root 相对路径 → 该模块为 config-default 构造点且已审核（必须带 withRetry）。 */
const ALLOWLIST = [
    "app.js",
    "services/chatUtils.js",
    "services/chatGraph.js",
    "eval/judge.js",
    "eval/generator.js",
    "services/optimize.js",
    "eval/reflection.js",
];

const read = (srcRel) => readFileSync(path.join(SRC_ROOT, srcRel), "utf8");
const sources = new Map(ALLOWLIST.map((rel) => [rel, read(rel)]));

/** 递归收集 src 下所有 .js（src-relative，POSIX），跳过 learning/ 与 *.test.js。 */
function walk(srcRelDir = "") {
    const abs = path.join(SRC_ROOT, srcRelDir);
    const out = [];
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const rel = srcRelDir ? `${srcRelDir}/${entry.name}` : entry.name;
        const full = path.join(abs, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "learning") continue; // 教学示例，非生产链路
            out.push(...walk(rel));
        } else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) {
            out.push(rel);
        }
    }
    return out;
}

describe("retry invariant — config-default LLM invoke 必须包 withRetry (W4-R4 T4)", () => {
    it("allowlist：含 `new ChatOpenAI(` 的模块必含 `withRetry(` 调用", () => {
        const constructors = [...sources.entries()].filter(([, src]) => src.includes("new ChatOpenAI("));
        expect(constructors.length).toBeGreaterThan(0); // 护栏自检：样本非空
        for (const [rel, src] of constructors) {
            // 须是"调用"而非仅 import：import 形如 `withRetry } from`，不含左括号
            expect(src, `${rel} 构造 ChatOpenAI 却无任何 withRetry( 调用`)
                .toMatch(/withRetry\(/);
        }
    });

    it("reflection.js：reflectionLlm.invoke 仍在 withRetry( 包裹区间内", () => {
        const src = sources.get("eval/reflection.js");
        const invokeIdx = src.indexOf("this.reflectionLlm.invoke(");
        expect(invokeIdx).toBeGreaterThan(-1);
        const retryIdx = src.lastIndexOf("withRetry(", invokeIdx);
        expect(retryIdx).toBeGreaterThan(-1);
        const slice = src.slice(retryIdx, invokeIdx + "this.reflectionLlm.invoke(".length);
        expect(slice).toMatch(/withRetry\([\s\S]{0,400}\.invoke\(/);
        expect(src.split("this.reflectionLlm.invoke(").length - 1).toBe(1);
    });

    it("memory.js：llmMemoryConsolidation 的 llm.invoke 仍在 withRetry( 包裹区间内", () => {
        const src = read("services/memory.js");
        const invokeIdx = src.indexOf("llm.invoke(");
        expect(invokeIdx).toBeGreaterThan(-1);
        const retryIdx = src.lastIndexOf("withRetry(", invokeIdx);
        expect(retryIdx).toBeGreaterThan(-1);
        const slice = src.slice(retryIdx, invokeIdx + "llm.invoke(".length);
        expect(slice).toMatch(/withRetry\([\s\S]{0,400}\.invoke\(/);
        expect(src.split("llm.invoke(").length - 1).toBe(1);
    });

    it("护栏自检：src 下全部 ChatOpenAI 构造模块都在 allowlist 内（除 learning/）", () => {
        const offenders = walk()
            .filter((rel) => !sources.has(rel))
            .filter((rel) => read(rel).includes("new ChatOpenAI("));
        expect(offenders).toEqual([]);
    });
});
