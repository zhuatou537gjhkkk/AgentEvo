import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ChatOpenAI } from "@langchain/openai";
import { defaultMakeLlm, resolveMakeLlm } from "./chatGraph.js";

const SOURCE = readFileSync(new URL("./chatGraph.js", import.meta.url), "utf8");

// W3.3-H: chatGraph 节点 LLM 构造 seam。节点不再直接 new ChatOpenAI，
// 而是经 config.configurable.makeLlm 解析（生产回落 defaultMakeLlm）。
describe("chatGraph LLM makeLlm seam (W3.3-H)", () => {
    it("resolveMakeLlm 优先返回 config.configurable.makeLlm 注入的工厂", () => {
        const fake = () => ({ fake: true });
        expect(resolveMakeLlm({ configurable: { makeLlm: fake } })).toBe(fake);
    });

    it("未注入时回落 defaultMakeLlm（真实 ChatOpenAI）", () => {
        expect(resolveMakeLlm({ configurable: {} })).toBe(defaultMakeLlm);
        expect(resolveMakeLlm({ configurable: undefined })).toBe(defaultMakeLlm);
        expect(resolveMakeLlm(undefined)).toBe(defaultMakeLlm);
    });

    it("defaultMakeLlm 忠实复刻真实 ChatOpenAI 构造（model/temperature 透传，不触发网络）", () => {
        const llm = defaultMakeLlm({ modelName: "seam-test-model", temperature: 0.3 });
        expect(llm).toBeInstanceOf(ChatOpenAI);
        // 该 @langchain/openai 版本把 model 存于 `model` 字段（modelName 已废弃）
        expect(llm.model).toBe("seam-test-model");
        expect(llm.temperature).toBe(0.3);
        expect(llm.timeout).toBe(120000); // buildChatOpenAIConfig 注入的超时被保留
        expect(typeof llm.invoke).toBe("function");
        expect(typeof llm.bindTools).toBe("function");
    });

    it("源码不变量：节点不再直接构造 ChatOpenAI，全部经 resolveMakeLlm 走 seam", () => {
        // 唯一的 new ChatOpenAI 只能出现在 defaultMakeLlm 内部
        const directCtor = (SOURCE.match(/new ChatOpenAI\(/g) || []).length;
        expect(directCtor).toBe(1);
        const seamLine = SOURCE.split("\n").find((l) => l.includes("new ChatOpenAI("));
        expect(seamLine).toContain("return new ChatOpenAI");

        // 8 个节点 LLM 站点（router/planner/general/search×1/knowledge×2/code/synthesizer）
        // 全部改经 resolveMakeLlm(config)(...)；新增节点必须沿用同一缝
        const sites = (SOURCE.match(/resolveMakeLlm\(config\)\(/g) || []).length;
        expect(sites).toBeGreaterThanOrEqual(8);

        // chatWithGraphImpl 必须把注入的 makeLlm 放入 graph config，否则节点收不到
        expect(SOURCE).toMatch(/makeLlm,\s*\/\/ LLM 构造工厂/m);
        // chatWithGraphImpl 从 options.deps 解析注入（生产 singleton bag 无该键 → 回落默认）
        expect(SOURCE).toMatch(/options\?\.deps\?\.services\?\.makeLlm\s*\|\|/);
    });
});
