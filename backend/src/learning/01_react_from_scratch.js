/**
 * 🧪 练习 1：从零实现 ReAct 循环
 *
 * 对应 Hello-Agents: chapter4/ReAct.py + chapter7/my_react_agent.py
 * 对应 AgentEvo:    chat.js → AgentExecutor.streamEvents("v2")
 *
 * 目标：理解 LangChain AgentExecutor 内部到底在做什么
 *
 * 运行: node src/learning/01_react_from_scratch.js
 */

import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";

// ═══════════════════════════════════════════════════════
// 知识点 1: ReAct 的 Prompt 结构
// ═══════════════════════════════════════════════════════
//
// Hello-Agents 的 REACT_PROMPT_TEMPLATE 包含三个核心部分:
//   1. {tools}      — 可用工具的描述文本
//   2. {question}   — 用户的原始问题
//   3. {history}    — 之前步骤的 Action + Observation
//
// AgentEvo 等价物: buildPrompt() → ChatPromptTemplate.fromMessages([
//   ["system", systemInstruction],          ← 工具描述 + 行为指令
//   MessagesPlaceholder("chat_history"),    ← 对话历史
//   ["user", "{input}"],                   ← 用户问题
//   MessagesPlaceholder("agent_scratchpad") ← ReAct 历史 (Thought/Action/Observation)
// ])
//
// 区别: Hello-Agents 全部塞进一个 user message
//       AgentEvo 用 LangChain 的 MessagesPlaceholder 管理

const REACT_PROMPT = `你是一个可以调用工具的 AI 助手。

## 可用工具
{tools}

## 回答格式
请严格按照以下格式回复：

Thought: 分析当前状态，决定下一步做什么
Action: tool_name[input] 或 Finish[最终答案]

## 对话
Question: {question}
{history}

现在开始:`;


// ═══════════════════════════════════════════════════════
// 知识点 2: ToolExecutor — 工具注册与调度
// ═══════════════════════════════════════════════════════
//
// Hello-Agents: ToolExecutor 类 (tools.py)
//   - registerTool(name, description, func)
//   - getTool(name) → func
//   - getAvailableTools() → 格式化描述文本
//
// AgentEvo 等价物:
//   - chat.js: agentTools 数组 (DynamicTool[])
//   - LangChain 自动从 DynamicTool.name/.description 生成工具描述
//   - LangChain 的 ToolCallingAgent 用 function call 而非文本解析

class ToolExecutor {
    constructor() {
        this.tools = new Map(); // name → { description, func }
    }

    register(name, description, func) {
        this.tools.set(name, { description, func });
    }

    getAvailableTools() {
        return [...this.tools.entries()]
            .map(([name, info]) => `- ${name}: ${info.description}`)
            .join("\n");
    }

    async execute(name, input) {
        const tool = this.tools.get(name);
        if (!tool) return `错误: 未找到工具 "${name}"`;
        return await tool.func(input);
    }
}


// ═══════════════════════════════════════════════════════
// 知识点 3: ReAct 循环 — 核心引擎
// ═══════════════════════════════════════════════════════
//
// Hello-Agents 循环结构:
//   while step < max_steps:
//       1. 拼 Prompt (tools + question + history)
//       2. LLM.think(prompt) → 获取 Thought + Action
//       3. 解析: 正则匹配 "Thought:" 和 "Action:"
//       4. 如果是 Finish → 返回答案
//       5. 否则: 执行工具 → 记录 Observation → 回到循环
//
// AgentEvo 等价物:
//   LangChain AgentExecutor 内部做同样的事，但你不可见
//   区别: LangChain 用 function call (tool_calls) 而不是文本解析
//   所以你不需要写正则，但你也不可控循环过程

async function reactLoop(llm, toolExecutor, question, maxSteps = 5) {
    const history = [];
    console.log(`\n🤖 ReAct 开始: "${question}"\n`);

    for (let step = 1; step <= maxSteps; step++) {
        console.log(`--- 第 ${step} 步 ---`);

        // ① 拼 Prompt
        const toolsDesc = toolExecutor.getAvailableTools();
        const historyStr = history.join("\n") || "(无历史)";
        const prompt = REACT_PROMPT
            .replace("{tools}", toolsDesc)
            .replace("{question}", question)
            .replace("{history}", historyStr);

        // ② 调 LLM
        const response = await llm.invoke([{ role: "user", content: prompt }]);
        const text = typeof response.content === "string"
            ? response.content
            : response.content?.text || "";

        // ③ 解析 Thought 和 Action (Hello-Agents 用正则，AgentEvo 用 function call)
        const thoughtMatch = text.match(/Thought:\s*(.*?)(?=\nAction:|$)/s);
        const actionMatch = text.match(/Action:\s*(.*)/s);
        const thought = thoughtMatch?.[1]?.trim() || "";
        const action = actionMatch?.[1]?.trim() || "";

        console.log(`🤔 Thought: ${thought}`);
        console.log(`🎬 Action: ${action}`);

        // ④ 检查终止条件
        if (action.startsWith("Finish[")) {
            const answer = action.match(/Finish\[(.*)\]/s)?.[1] || "";
            console.log(`✅ 完成! 答案: ${answer}`);
            return answer;
        }

        // ⑤ 解析工具调用并执行
        const toolMatch = action.match(/^(\w+)\[(.*)\]$/s);
        if (!toolMatch) {
            history.push(`Action: ${action}`);
            history.push("Observation: 格式错误，请使用 tool_name[input] 格式");
            continue;
        }

        const [, toolName, toolInput] = toolMatch;
        console.log(`🔧 调用工具: ${toolName}("${toolInput}")`);

        const observation = await toolExecutor.execute(toolName, toolInput);
        console.log(`👀 Observation: ${observation.slice(0, 100)}...`);

        // ⑥ 记录历史 (这就是 agent_scratchpad 的内容)
        history.push(`Action: ${action}`);
        history.push(`Observation: ${observation}`);
    }

    return "达到最大步数限制";
}


// ═══════════════════════════════════════════════════════
// 知识点 4: 对比 — AgentEvo 怎么做同样的事
// ═══════════════════════════════════════════════════════
//
// AgentEvo chat.js 等价代码:
//
//   const agentExecutor = await getAgentExecutor(...);
//   const eventStream = await agentExecutor.streamEvents(
//     { input, chat_history, current_date },
//     { version: "v2" }
//   );
//   for await (const event of eventStream) {
//     if (event.event === "on_tool_start") { /* SSE 发射 tool_start */ }
//     if (event.event === "on_tool_end")   { /* SSE 发射 tool_end */ }
//     if (event.event === "on_chat_model_stream") { /* SSE 发射 text */ }
//   }
//
// 区别对照:
//   ┌────────────────────┬───────────────────┬─────────────────────┐
//   │ 步骤               │ Hello-Agents      │ AgentEvo (LangChain) │
//   ├────────────────────┼───────────────────┼─────────────────────┤
//   │ 循环控制           │ 自己写 while      │ AgentExecutor 内部  │
//   │ 工具调用解析       │ 正则匹配文本      │ function call 协议  │
//   │ 流式输出           │ print(chunk)      │ SSE 事件发射        │
//   │ 工具状态管理       │ 无                │ FSM 状态机          │
//   │ 中断/取消          │ 无                │ AbortController     │
//   └────────────────────┴───────────────────┴─────────────────────┘


// ═══════════════════════════════════════════════════════
// 运行
// ═══════════════════════════════════════════════════════

async function main() {
    // 用你 AgentEvo 的 LLM 配置
    const llm = new ChatOpenAI({
        modelName: process.env.OPENAI_MODEL || process.env.QWEN_MODEL || "deepseek-v4-flash",
        temperature: 0,
        configuration: {
            baseURL: process.env.OPENAI_BASE_URL,
        },
    });

    const tools = new ToolExecutor();

    // 注册一个简单的搜索模拟工具
    tools.register("search", "搜索互联网获取信息", async (query) => {
        // 模拟: 实际使用会调博查 API
        return `关于"${query}"的搜索结果: Python由Guido van Rossum于1991年发布。`;
    });

    tools.register("calculator", "执行数学计算", async (expr) => {
        try {
            return String(eval(expr)); // 安全简化版，生产环境用 AST
        } catch {
            return "计算失败";
        }
    });

    console.log("可用的工具:\n" + tools.getAvailableTools());

    // 测试问题
    await reactLoop(llm, tools, "Python是什么时候发布的？发布年份乘以2是多少？", 5);
}

main().catch(console.error);
