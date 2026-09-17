import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { runAttachedFileReadProtocol } from "./chatGraph.js";

function descriptor(path = "backend/src/services/chatGraph.js") {
    const calls = [];
    return {
        file: {
            path,
            commit: "abcdef1234567890",
            read: async ({ startLine, maxLines }) => {
                calls.push({ startLine, maxLines });
                return {
                    data: {
                        startLine,
                        endLine: startLine + maxLines - 1,
                        lines: [`marker:${startLine}`],
                    },
                };
            },
        },
        calls,
    };
}

describe("attached-file non-streaming read planner", () => {
    it("uses complete invoke() tool calls, then streams only the final prose", async () => {
        const { file, calls } = descriptor();
        const plannerMessages = [];
        const bound = {
            invoke: async (messages) => {
                plannerMessages.push(messages);
                if (plannerMessages.length === 1) {
                    return new AIMessage({
                        content: "",
                        tool_calls: [{
                            name: "read_attached_file",
                            args: { path: file.path, start_line: 2401, max_lines: 1 },
                            id: "read_late",
                        }],
                    });
                }
                return new AIMessage({ content: "" });
            },
        };
        const streamed = [];
        const llm = {
            bindTools: () => bound,
            stream: async function* (messages) {
                streamed.push(messages);
                yield { content: "读取完成。" };
            },
        };
        const events = { start: [], end: [], text: [] };

        const result = await runAttachedFileReadProtocol({
            llm,
            messages: [new HumanMessage("请读取后段")],
            wholeFiles: [file],
            sse: {
                toolStart: (...args) => events.start.push(args),
                toolEnd: (...args) => events.end.push(args),
                textChunk: (text) => events.text.push(text),
            },
        });

        expect(calls).toEqual([{ startLine: 2401, maxLines: 1 }]);
        expect(plannerMessages).toHaveLength(2);
        expect(events.start).toHaveLength(1);
        expect(events.end[0][2]).toContain("[repo backend/src/services/chatGraph.js:2401-2401 @ abcdef123456]");
        expect(events.text).toEqual(["读取完成。"]);
        expect(result).toMatchObject({ fullText: "读取完成。", reads: 1 });
        expect(streamed).toHaveLength(1);
        expect(streamed[0].at(-1).content).toContain("仅依据已经读取到的代码片段");
    });
});
