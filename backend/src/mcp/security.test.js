import { describe, expect, it } from "vitest";
import { validateMCPServerConfig } from "./security.js";

describe("MCP server security policy", () => {
    it("rejects path-qualified executables", () => {
        expect(() => validateMCPServerConfig({ name: "x", command: "C:\\tmp\\node.exe" })).toThrow(/allowlisted/);
        expect(() => validateMCPServerConfig({ name: "x", command: "node", args: ["--version"] })).not.toThrow();
    });

    it("allows declarative env references and resolved env only at the client boundary", () => {
        expect(() => validateMCPServerConfig({ name: "x", command: "node", env: { API_KEY: "env:API_KEY" } })).not.toThrow();
        expect(() => validateMCPServerConfig({ name: "x", command: "node", env: { API_KEY: "secret" } })).toThrow(/environment/);
        expect(() => validateMCPServerConfig({ name: "x", command: "node", env: { API_KEY: "secret" } }, { resolvedEnv: true })).not.toThrow();
    });
});
