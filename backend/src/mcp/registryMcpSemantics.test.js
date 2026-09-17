import { describe, expect, it, vi } from "vitest";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolRegistry } from "./registry.js";
import { McpObservationRecorder } from "./observations.js";

function clientFor(callTool) {
    return {
        listTools: vi.fn().mockResolvedValue({ tools: [{
            name: "probe",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
        }] }),
        callTool,
        close: vi.fn().mockResolvedValue(undefined),
    };
}

describe("MCP wrapper protocol/error/retry contract", () => {
    it("isError rejects as protocol_error and is not retried", async () => {
        const callTool = vi.fn().mockResolvedValue({ isError: true, content: [{ type: "text", text: "fixture error" }] });
        const observations = new McpObservationRecorder();
        const registry = new ToolRegistry({ connect: async () => clientFor(callTool), observations });
        await registry.registerMCPServer({ name: "fixture", command: "fixture", scope: { userId: 1, tenantId: "user:1" } });

        await expect(registry.invokeTool("fixture/probe", {}, { scope: { userId: 1, tenantId: "user:1" } })).rejects.toMatchObject({ code: "MCP_PROTOCOL_ERROR", protocolError: true });
        const call = observations.snapshot().find((item) => item.operation === "call_tool");
        expect(call).toMatchObject({ status: "protocol_error", attempt_count: 1 });
        expect(callTool).toHaveBeenCalledTimes(1);
    });

    it("transport failure is thrown, not returned as an ok:false string, and has one retry budget", async () => {
        const callTool = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error("temporary"), { status: 503, retryable: true }))
            .mockRejectedValueOnce(Object.assign(new Error("still down"), { status: 503, retryable: true }));
        const observations = new McpObservationRecorder();
        const registry = new ToolRegistry({ connect: async () => clientFor(callTool), observations });
        await registry.registerMCPServer({ name: "fixture", command: "fixture", scope: { userId: 1, tenantId: "user:1" } });

        const result = registry.invokeTool("fixture/probe", {}, { scope: { userId: 1, tenantId: "user:1" } });
        await expect(result).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
        expect(callTool).toHaveBeenCalledTimes(2);
        const call = observations.snapshot().find((item) => item.operation === "call_tool");
        expect(call).toMatchObject({ status: "transport_error", attempt_count: 2 });
        expect(String(call.error_code)).not.toContain("fixture");
    });

    it("namespace and bare alias share the same MCP identity without duplicate observations", async () => {
        const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
        const observations = new McpObservationRecorder();
        const registry = new ToolRegistry({ connect: async () => clientFor(callTool), observations });
        await registry.registerMCPServer({ name: "fixture", command: "fixture", scope: { userId: 1, tenantId: "user:1" } });
        expect(registry.getTool("fixture/probe", { userId: 1, tenantId: "user:1" })).toBeInstanceOf(DynamicStructuredTool);
        await registry.invokeTool("fixture/probe", {}, { scope: { userId: 1, tenantId: "user:1" } });
        const calls = observations.snapshot().filter((item) => item.operation === "call_tool");
        expect(calls).toHaveLength(1);
        expect(calls[0].tool_name).toBe("probe");
    });
});
