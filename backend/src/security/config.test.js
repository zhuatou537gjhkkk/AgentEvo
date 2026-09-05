import { describe, expect, it, afterEach } from "vitest";
import { getAllowedMCPCommands, isAllowedCorsOrigin, assertProductionSecurityConfig } from "./config.js";
import { validateMCPServerConfig } from "../mcp/security.js";

const originalEnv = { ...process.env };
afterEach(() => {
    process.env = { ...originalEnv };
});

describe("security configuration", () => {
    it("accepts local development CORS origins and rejects unknown origins", () => {
        delete process.env.CORS_ORIGINS;
        process.env.NODE_ENV = "development";
        expect(isAllowedCorsOrigin("http://localhost:5173")).toBe(true);
        expect(isAllowedCorsOrigin("https://evil.example")).toBe(false);
    });

    it("rejects weak production auth configuration", () => {
        process.env.NODE_ENV = "production";
        process.env.AUTH_TOKEN_SECRET = "weak";
        process.env.CORS_ORIGINS = "https://app.example";
        expect(() => assertProductionSecurityConfig()).toThrow(/AUTH_TOKEN_SECRET/);
    });

    it("validates MCP command and env references", () => {
        process.env.MCP_ALLOWED_COMMANDS = "node";
        process.env.MCP_ALLOWED_ROOTS = process.cwd();
        expect(getAllowedMCPCommands()).toContain("node");
        expect(validateMCPServerConfig({ name: "safe", command: "node", args: ["script.js"], env: { API_KEY: "env:API_KEY" } }).name).toBe("safe");
        expect(() => validateMCPServerConfig({ name: "bad", command: "sh -c", args: [] })).toThrow(/MCP command/);
        expect(() => validateMCPServerConfig({ name: "bad", command: "node", env: { API_KEY: "plaintext" } })).toThrow(/environment/);
    });
});
