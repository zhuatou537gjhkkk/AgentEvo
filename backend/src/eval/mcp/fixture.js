import { MCP_FIXTURE_TOOL_SCHEMAS } from "./cases.js";

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
    }, ms);
    const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(Object.assign(new Error("fixture cancelled"), { name: "AbortError", code: "ABORT_ERR" }));
    };
    if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
    }
});

export function createMcpFixtureClient({ variant = "candidate", counters = {} } = {}) {
    const calls = counters.calls || (counters.calls = {});
    const tools = Object.entries(MCP_FIXTURE_TOOL_SCHEMAS).map(([name, inputSchema]) => ({
        name,
        description: `Deterministic local fixture tool: ${name}`,
        inputSchema,
    }));
    return {
        tools,
        listTools: async () => ({ tools }),
        close: async () => undefined,
        callTool: async ({ name, arguments: input = {}, signal }) => {
            calls[name] = (calls[name] || 0) + 1;
            if (name === "echo" || name === "required_echo") {
                return { content: [{ type: "text", text: JSON.stringify({ ok: true, value: input.value }) }] };
            }
            if (name === "protocol_error") {
                return { isError: true, content: [{ type: "text", text: "fixture protocol failure" }] };
            }
            if (name === "throw_error") {
                throw Object.assign(new Error("fixture upstream failure"), { status: 503, code: "UPSTREAM_UNAVAILABLE", retryable: true });
            }
            if (name === "retry_once") {
                if (calls[name] === 1) throw Object.assign(new Error("fixture transient failure"), { status: 503, code: "UPSTREAM_UNAVAILABLE", retryable: true });
                return { content: [{ type: "text", text: "retry-success" }] };
            }
            if (name === "timeout_error") {
                throw Object.assign(new Error("fixture timeout"), { code: "ETIMEDOUT", name: "TimeoutError", retryable: true });
            }
            if (name === "slow") {
                await sleep(100, signal);
                return { content: [{ type: "text", text: "slow-success" }] };
            }
            throw Object.assign(new Error(`unknown fixture tool ${name}`), { code: "MCP_TOOL_UNAVAILABLE" });
        },
    };
}

export function createMcpFixtureConnector({ variant = "candidate", counters = {} } = {}) {
    return async (config = {}) => {
        if (config.name === "unavailable") {
            throw Object.assign(new Error("fixture server unavailable"), { code: "MCP_SERVER_UNAVAILABLE", statusCode: 503, retryable: false });
        }
        return createMcpFixtureClient({ variant, counters });
    };
}
