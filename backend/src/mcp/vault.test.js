import { describe, expect, it } from "vitest";
import {
    REMOTE_MCP_BAD_SECRET_REF,
    REMOTE_MCP_PLAINTEXT_SECRET,
    SECRET_REF_RE,
    describeSecret,
    normalizeSecretRef,
    resolveSecret,
    validateOAuthConfig,
} from "./vault.js";

/**
 * Phase 7 / R5 (roadmap #5) — secret indirection: refs only, no plaintext
 * secrets, transient resolution, redacted audit descriptions, OAuth metadata.
 */
describe("vault.normalizeSecretRef", () => {
    it("accepts env:NAME and vault:KEY", () => {
        expect(normalizeSecretRef("env:MY_KEY")).toEqual({ source: "env", key: "MY_KEY" });
        expect(normalizeSecretRef("vault:api_key_1")).toEqual({ source: "vault", key: "api_key_1" });
        expect(SECRET_REF_RE.test("env:A1_b")).toBe(true);
    });

    it("rejects bare literals used as a secret value", () => {
        for (const bad of ["sk-abc123", "hunter2", "Bearer eyJtoken", ""]) {
            if (bad === "") {
                expect(() => normalizeSecretRef(bad)).toThrowError(expect.objectContaining({ code: REMOTE_MCP_BAD_SECRET_REF }));
            } else {
                expect(() => normalizeSecretRef(bad)).toThrowError(expect.objectContaining({ code: REMOTE_MCP_PLAINTEXT_SECRET }));
            }
        }
    });

    it("rejects unknown prefixes and malformed known prefixes", () => {
        for (const bad of ["other:KEY", "ENV:X", "env:", "vault:bad key", "vault:1bad", "env:-foo"]) {
            expect(() => normalizeSecretRef(bad)).toThrowError(expect.objectContaining({ code: REMOTE_MCP_BAD_SECRET_REF }));
        }
    });
});

describe("vault.resolveSecret", () => {
    it("resolves env refs from the injected env map and reports misses", async () => {
        await expect(resolveSecret("env:PRESENT", { env: { PRESENT: "v" } })).resolves.toEqual({ ok: true, value: "v" });
        await expect(resolveSecret("env:ABSENT", { env: { PRESENT: "v" } })).resolves.toEqual({ ok: false, missing: true });
        await expect(resolveSecret("env:EMPTY", { env: { EMPTY: "" } })).resolves.toEqual({ ok: false, missing: true });
    });

    it("resolves vault refs via an injected vault and reports an unavailable vault", async () => {
        const vault = { get: async (key) => (key === "T" ? "tok" : null) };
        await expect(resolveSecret("vault:T", { vault })).resolves.toEqual({ ok: true, value: "tok" });
        await expect(resolveSecret("vault:MISSING", { vault })).resolves.toEqual({ ok: false, missing: true });
        await expect(resolveSecret("vault:ANY", { vault: null })).resolves.toEqual({
            ok: false, missing: true, reason: "VAULT_UNAVAILABLE",
        });
    });
});

describe("vault.describeSecret", () => {
    it("redacts the value for audit display", () => {
        expect(describeSecret("env:FOO")).toEqual({ source: "env", key: "FOO", redacted: "***" });
        expect(describeSecret("vault:deep_key")).toEqual({ source: "vault", key: "deep_key", redacted: "***" });
        expect(JSON.stringify(describeSecret("env:FOO"))).not.toContain("secret-value");
    });
});

describe("vault.validateOAuthConfig", () => {
    it("accepts a valid oauth metadata config (R5 never exchanges tokens)", async () => {
        const result = await validateOAuthConfig({
            type: "oauth",
            tokenUrl: "https://login.example.com/oauth/token",
            clientRef: "env:OAUTH_CLIENT",
            scope: "openid profile",
        });
        expect(result).toEqual({ ok: true, errors: [] });
    });

    it("rejects wrong types, plaintext clientRefs and unsafe tokenUrls", async () => {
        const wrongType = await validateOAuthConfig({ type: "bearer", clientRef: "env:C" });
        expect(wrongType.ok).toBe(false);
        expect(wrongType.errors.some((e) => e.includes("'oauth'"))).toBe(true);

        const plaintext = await validateOAuthConfig({ type: "oauth", clientRef: "sk-literal" });
        expect(plaintext.ok).toBe(false);
        expect(plaintext.errors.some((e) => e.includes("clientRef"))).toBe(true);

        const httpUrl = await validateOAuthConfig({ type: "oauth", tokenUrl: "http://login.example.com/token", clientRef: "env:C" });
        expect(httpUrl.ok).toBe(false);

        const privateUrl = await validateOAuthConfig({ type: "oauth", tokenUrl: "https://192.168.0.1/token", clientRef: "env:C" });
        expect(privateUrl.ok).toBe(false);
    });
});
