import path from "node:path";
import { getAllowedMCPCommands, getAllowedMCPRoots } from "../security/config.js";

const MAX_NAME_LENGTH = 64;
const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 512;
const MAX_ENV_KEYS = 16;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const SHELL_META_RE = /[;&|`$()<>\r\n]/;

function fail(message) {
    const error = new Error(message);
    error.code = "MCP_POLICY_DENIED";
    error.statusCode = 403;
    throw error;
}

export function validateMCPServerConfig(config = {}, { resolvedEnv = false } = {}) {
    const name = String(config.name || "").trim();
    const command = String(config.command || "").trim();
    const args = Array.isArray(config.args) ? config.args : [];
    const cwd = config.cwd == null ? null : String(config.cwd).trim();
    const env = config.env && typeof config.env === "object" && !Array.isArray(config.env)
        ? config.env
        : {};

    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) || name.length > MAX_NAME_LENGTH) {
        fail("invalid MCP server name");
    }
    if (!command || SHELL_META_RE.test(command)) {
        fail("invalid MCP command");
    }
    const commandBase = path.basename(command).toLowerCase();
    const allowedCommands = getAllowedMCPCommands().map((item) => path.basename(item).toLowerCase());
    const commandIsBare = command === path.basename(command) && !path.isAbsolute(command);
    if (!commandIsBare || !allowedCommands.includes(commandBase)) {
        fail("MCP command is not allowlisted");
    }
    if (args.length > MAX_ARGS || args.some((arg) => typeof arg !== "string" || arg.length > MAX_ARG_LENGTH || SHELL_META_RE.test(arg))) {
        fail("MCP arguments are not allowed");
    }
    if (cwd) {
        const resolvedCwd = path.resolve(cwd);
        const allowed = getAllowedMCPRoots().some((root) => resolvedCwd === root || resolvedCwd.startsWith(`${root}${path.sep}`));
        if (!allowed) fail("MCP cwd is outside the allowed roots");
    }
    const envKeys = Object.keys(env);
    if (envKeys.length > MAX_ENV_KEYS || envKeys.some((key) => !ENV_KEY_RE.test(key))) {
        fail("invalid MCP environment keys");
    }
    for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string" || value.length > MAX_ARG_LENGTH) {
            fail(`invalid MCP environment value: ${key}`);
        }
        if (resolvedEnv) {
            if (key === "PATH" || key === "NODE_PATH") fail(`MCP environment key is not allowed: ${key}`);
            if (!value) fail(`MCP environment value is empty: ${key}`);
            continue;
        }
        if (!value.startsWith("env:") || !ENV_KEY_RE.test(value.slice(4))) {
            fail("MCP environment values must reference env: variables");
        }
    }

    return { ...config, name, command, args: [...args], ...(cwd ? { cwd: path.resolve(cwd) } : {}), env: { ...env } };
}
