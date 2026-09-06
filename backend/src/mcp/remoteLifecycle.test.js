import { afterEach, describe, expect, it } from "vitest";
import { clearExtensibilityFlags } from "../extensibility/flags.js";
import { REMOTE_MCP_SSRF_DENIED } from "./remotePolicy.js";
import {
    INVALID_STATE_TRANSITION,
    REMOTE_MCP_DISABLED,
    REMOTE_MCP_PLAINTEXT_SECRET,
    REMOTE_MCP_SECRET_MISSING,
    REMOTE_MCP_TRANSPORT_UNSUPPORTED,
    REMOTE_STATES,
    REMOTE_TRANSPORT_AVAILABLE,
    RemoteServerRegistry,
    assertRemoteAllowed,
    transitionValid,
} from "./remoteLifecycle.js";

/**
 * Phase 7 / R5 (roadmap #5) — health lifecycle: master-flag gate, URL policy,
 * plaintext-secret refusal, secret resolvability, transport availability and the
 * owner-scoped state machine. R5 never dials a real transport.
 */
const SCOPE_A = { userId: 1, tenantId: "user:1" };
const SCOPE_B = { userId: 2, tenantId: "user:2" };

function baseCfg(overrides = {}) {
    return {
        name: "cloud-a",
        url: "https://8.8.8.8/mcp",
        transport: "streamable-http",
        env: { API_KEY: "env:TEST_API_KEY" },
        ...overrides,
    };
}

function enableRemoteMcp() {
    process.env.REMOTE_MCP_ENABLED = "true";
}

afterEach(() => {
    clearExtensibilityFlags();
});

describe("remoteLifecycle.transitionValid", () => {
    it("accepts the documented lifecycle chain", () => {
        expect(transitionValid("created", "validating")).toBe(true);
        expect(transitionValid("validating", "connecting")).toBe(true);
        expect(transitionValid("connecting", "ready")).toBe(true);
        expect(transitionValid("ready", "degraded")).toBe(true);
        expect(transitionValid("degraded", "ready")).toBe(true);
        expect(transitionValid("ready", "failed")).toBe(true);
        expect(transitionValid("failed", "closing")).toBe(true);
        expect(transitionValid("closing", "closed")).toBe(true);
    });

    it("rejects illegal jumps with INVALID_STATE_TRANSITION", () => {
        for (const [from, to] of [["created", "closed"], ["created", "ready"], ["ready", "created"], ["closed", "ready"], ["failed", "ready"], ["created", "connecting"]]) {
            expect(() => transitionValid(from, to)).toThrowError(expect.objectContaining({ code: INVALID_STATE_TRANSITION }));
        }
        expect(REMOTE_STATES).toContain("created");
        expect(REMOTE_STATES).toContain("closed");
    });
});

describe("remoteLifecycle.assertRemoteAllowed", () => {
    it("rejects with REMOTE_MCP_DISABLED when the master flag is off", async () => {
        await expect(assertRemoteAllowed(baseCfg())).rejects.toMatchObject({ code: REMOTE_MCP_DISABLED, statusCode: 403 });
    });

    it("rejects a private-IP server URL under SSRF policy (flag on)", async () => {
        enableRemoteMcp();
        await expect(assertRemoteAllowed(baseCfg({ url: "https://192.168.0.5/mcp" }))).rejects.toMatchObject({ code: REMOTE_MCP_SSRF_DENIED });
        await expect(assertRemoteAllowed(baseCfg({ url: "https://example.com/mcp" }))).resolves.toMatchObject({ ok: true, needsDnsCheck: true });
    });

    it("rejects plaintext secrets in env/headers", async () => {
        enableRemoteMcp();
        await expect(assertRemoteAllowed(baseCfg({ env: { API_KEY: "sk-literal" } }))).rejects.toMatchObject({ code: REMOTE_MCP_PLAINTEXT_SECRET });
        await expect(assertRemoteAllowed(baseCfg({ headers: { Authorization: "Bearer xyz" } }))).rejects.toMatchObject({ code: REMOTE_MCP_PLAINTEXT_SECRET });
    });

    it("refuses a transport family other than streamable-http", async () => {
        enableRemoteMcp();
        await expect(assertRemoteAllowed(baseCfg({ transport: "stdio" }))).rejects.toMatchObject({ code: REMOTE_MCP_TRANSPORT_UNSUPPORTED });
        await expect(assertRemoteAllowed(baseCfg({ transport: "streamable-http" }))).resolves.toMatchObject({ ok: true });
    });
});

describe("remoteLifecycle.RemoteServerRegistry (owner-scoped, default-OFF)", () => {
    it("register is 403 REMOTE_MCP_DISABLED while the flag is dark", async () => {
        const registry = new RemoteServerRegistry({ env: { TEST_API_KEY: "k" } });
        await expect(registry.register(SCOPE_A, baseCfg())).rejects.toMatchObject({ code: REMOTE_MCP_DISABLED, statusCode: 403 });
        expect(registry.stats(SCOPE_A)).toEqual({ count: 0, names: [] });
    });

    it("registers a server and never stores the resolved secret value", async () => {
        enableRemoteMcp();
        const registry = new RemoteServerRegistry({ env: { TEST_API_KEY: "super-secret-k" } });
        const session = await registry.register(SCOPE_A, baseCfg());
        expect(session.name).toBe("cloud-a");
        expect(session.state).toBe("created");
        expect(session.cfg.url).toBe("https://8.8.8.8/mcp");
        expect(session.cfg.env).toEqual({ API_KEY: { source: "env", key: "TEST_API_KEY", redacted: "***" } });
        expect(JSON.stringify(session)).not.toContain("super-secret-k");
        expect(JSON.stringify(session)).not.toContain("secret");
    });

    it("refuses registration when a referenced secret is missing", async () => {
        enableRemoteMcp();
        const registry = new RemoteServerRegistry({ env: {} });
        await expect(registry.register(SCOPE_A, baseCfg({ env: { API_KEY: "env:NOT_SET" } })))
            .rejects.toMatchObject({ code: REMOTE_MCP_SECRET_MISSING });
        expect(registry.stats(SCOPE_A).count).toBe(0);
    });

    it("reports the server as unreachable (R5 never pretends to connect)", async () => {
        enableRemoteMcp();
        const registry = new RemoteServerRegistry({ env: { TEST_API_KEY: "k" } });
        await registry.register(SCOPE_A, baseCfg());
        expect(REMOTE_TRANSPORT_AVAILABLE).toBe(false);
        const health = await registry.health(SCOPE_A, "cloud-a");
        expect(health).toEqual({ status: "unreachable", reason: "REMOTE_TRANSPORT_NOT_IMPLEMENTED_R7" });
        // No pretending: still 'created', no probe ran.
        expect(registry.get(SCOPE_A, "cloud-a").state).toBe("created");
        expect(registry.get(SCOPE_A, "cloud-a").healthChecks).toBe(0);
    });

    it("runs an injected probe and moves between ready/degraded/failed, then unregisters", async () => {
        enableRemoteMcp();
        const registry = new RemoteServerRegistry({ env: { TEST_API_KEY: "k" } });
        await registry.register(SCOPE_A, baseCfg());

        const ok = await registry.health(SCOPE_A, "cloud-a", { probe: async () => true });
        expect(ok).toMatchObject({ status: "ready", healthChecks: 1, failureCount: 0 });
        expect(registry.get(SCOPE_A, "cloud-a").state).toBe("ready");

        await registry.health(SCOPE_A, "cloud-a", { probe: async () => false });
        await registry.health(SCOPE_A, "cloud-a", { probe: async () => false });
        expect(registry.get(SCOPE_A, "cloud-a")).toMatchObject({ state: "degraded", failureCount: 2 });

        const failed = await registry.health(SCOPE_A, "cloud-a", { probe: async () => { throw new Error("down"); } });
        expect(failed).toMatchObject({ status: "failed", failureCount: 3 });

        const recovered = await registry.health(SCOPE_A, "cloud-a", { probe: async () => true });
        expect(recovered).toMatchObject({ status: "ready", failureCount: 0 });

        expect(registry.unregister(SCOPE_A, "cloud-a")).toBe(true);
        expect(registry.get(SCOPE_A, "cloud-a")).toBeUndefined();
        expect(registry.unregister(SCOPE_A, "cloud-a")).toBe(false);
    });

    it("isolates sessions across owners", async () => {
        enableRemoteMcp();
        const registry = new RemoteServerRegistry({ env: { TEST_API_KEY: "k" } });
        const sa = await registry.register(SCOPE_A, baseCfg());
        const sb = await registry.register(SCOPE_B, baseCfg());
        expect(sa.id).not.toBe(sb.id);
        expect(registry.get(SCOPE_A, "cloud-a").id).toBe(sa.id);
        expect(registry.get(SCOPE_B, "cloud-a").id).toBe(sb.id);
        expect(registry.stats(SCOPE_A)).toEqual({ count: 1, names: ["cloud-a"] });
        expect(registry.stats(SCOPE_B)).toEqual({ count: 1, names: ["cloud-a"] });

        expect(registry.unregister(SCOPE_A, "cloud-a")).toBe(true);
        expect(registry.get(SCOPE_A, "cloud-a")).toBeUndefined();
        expect(registry.get(SCOPE_B, "cloud-a").id).toBe(sb.id);
    });
});
