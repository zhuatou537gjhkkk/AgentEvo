import path from "node:path";
import { parseTrustedProxyConfig } from "./access.js";

const DEFAULT_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const DEFAULT_MCP_COMMANDS = process.platform === "win32"
    ? ["node", "node.exe", "npx", "npx.cmd"]
    : ["node", "npx"];

function parseList(value, fallback = []) {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
    return String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .length > 0
        ? String(value).split(",").map((item) => item.trim()).filter(Boolean)
        : fallback;
}

export function isProduction() {
    return process.env.NODE_ENV === "production";
}

export function getAllowedCorsOrigins() {
    return parseList(process.env.CORS_ORIGINS, isProduction() ? [] : DEFAULT_DEV_ORIGINS);
}

export function isAllowedCorsOrigin(origin) {
    if (!origin) return true;
    return getAllowedCorsOrigins().includes(origin);
}

export function getAllowedMCPCommands() {
    return parseList(process.env.MCP_ALLOWED_COMMANDS, DEFAULT_MCP_COMMANDS)
        .map((command) => path.basename(command).toLowerCase());
}

export function getAllowedMCPRoots() {
    const roots = parseList(process.env.MCP_ALLOWED_ROOTS, [process.cwd()]);
    return roots.map((root) => path.resolve(root));
}

export function assertProductionSecurityConfig() {
    if (!isProduction()) return;
    const secret = String(process.env.AUTH_TOKEN_SECRET || "");
    if (!secret || secret === "change-this-secret" || secret.length < 32) {
        throw new Error("AUTH_TOKEN_SECRET must be configured with at least 32 characters in production");
    }
    if (getAllowedCorsOrigins().length === 0) {
        throw new Error("CORS_ORIGINS must contain at least one origin in production");
    }
    if (process.env.TRUST_PROXY === "true") parseTrustedProxyConfig(process.env);
}
