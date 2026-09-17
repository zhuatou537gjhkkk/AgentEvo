import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createApp } from "../../app.js";
import { issueAuthToken } from "../../auth.js";
import { createUser, initDB } from "../../db/index.js";

const old = { eval: process.env.MCP_EVAL_ENABLED, telemetry: process.env.MCP_TELEMETRY_ENABLED, admins: process.env.ADMIN_USER_IDS };
const users = {};
let base;
let server;

function headers(user) {
    return { Authorization: `Bearer ${issueAuthToken({ id: user.id, username: user.username })}`, "Content-Type": "application/json" };
}

async function request(path, user, options = {}) {
    const response = await fetch(`${base}${path}`, { ...options, headers: { ...headers(user), ...(options.headers || {}) } });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

beforeAll(async () => {
    process.env.MCP_EVAL_ENABLED = "true";
    process.env.MCP_TELEMETRY_ENABLED = "true";
    initDB();
    users.alice = { id: createUser("mcp_http_alice", "hash-a"), username: "mcp_http_alice" };
    users.bob = { id: createUser("mcp_http_bob", "hash-b"), username: "mcp_http_bob" };
    process.env.ADMIN_USER_IDS = `${users.alice.id},${users.bob.id}`;
    server = createServer(createApp());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe("MCP fixture HTTP acceptance", () => {
    it("admin can run/query a fixture and a second user cannot read the run", async () => {
        const run = await request("/eval/mcp/runs", users.alice, {
            method: "POST",
            body: JSON.stringify({ caseIds: ["mcp.call.protocol-is-error", "mcp.call.retry-once"], variant: "candidate" }),
        });
        expect(run.status).toBe(200);
        expect(run.body.summary.layers.find((item) => item.layer === "tool_call").passRate).toMatchObject({ numerator: 2, denominator: 2, value: 1 });

        const own = await request(`/eval/mcp/runs/${run.body.runId}`, users.alice);
        expect(own.status).toBe(200);
        expect(own.body.run.cases).toHaveLength(2);

        const cross = await request(`/eval/mcp/runs/${run.body.runId}`, users.bob);
        expect(cross.status).toBe(404);
        const ops = await request("/observability/mcp/operations?server=fixture", users.alice);
        expect(ops.status).toBe(200);
        expect(ops.body.operations.some((item) => item.status === "protocol_error")).toBe(true);
        const bobOps = await request("/observability/mcp/operations", users.bob);
        expect(bobOps.status).toBe(200);
        expect(bobOps.body.operations).toEqual([]);
    });

    it("does not accept arbitrary commands or unknown fixture cases", async () => {
        const response = await request("/eval/mcp/runs", users.alice, {
            method: "POST",
            body: JSON.stringify({ caseIds: ["unknown"], command: "rm -rf /" }),
        });
        expect(response.status).toBe(400);
        expect(response.body.errorCode).toBe("MCP_CASE_NOT_ALLOWED");
    });
});
