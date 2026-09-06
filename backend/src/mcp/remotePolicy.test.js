import { describe, expect, it } from "vitest";
import {
    REMOTE_MCP_HOST_DENIED,
    REMOTE_MCP_PORT_DENIED,
    REMOTE_MCP_SSRF_DENIED,
    REMOTE_MCP_TOO_MANY_REDIRECTS,
    REMOTE_MCP_URL_INVALID,
    REMOTE_MCP_URL_USERINFO,
    assertRedirectChain,
    assertSafeRemoteTarget,
    hostToLiteral,
    ipv4Class,
    parseRemoteServerUrl,
} from "./remotePolicy.js";

/**
 * Phase 7 / R5 (roadmap #5) — pure remote-MCP URL/SSRF/redirect policy. No
 * network: hostnames stay needsDnsCheck unless a resolver is injected.
 */
describe("remotePolicy.parseRemoteServerUrl", () => {
    it("accepts http:// and https:// and returns a parsed URL", () => {
        expect(parseRemoteServerUrl("https://example.com/sse").protocol).toBe("https:");
        expect(parseRemoteServerUrl("http://8.8.8.8:8080/x").host).toBe("8.8.8.8:8080");
    });

    it("rejects non-http(s) schemes with REMOTE_MCP_URL_INVALID", () => {
        for (const bad of ["ftp://example.com", "file:///etc/passwd", "ws://example.com", "not a url", ""]) {
            expect(() => parseRemoteServerUrl(bad)).toThrowError(expect.objectContaining({ code: REMOTE_MCP_URL_INVALID, statusCode: 400 }));
        }
    });

    it("rejects URLs carrying userinfo with REMOTE_MCP_URL_USERINFO", () => {
        expect(() => parseRemoteServerUrl("https://user:pass@example.com/sse")).toThrowError(expect.objectContaining({ code: REMOTE_MCP_URL_USERINFO }));
        expect(() => parseRemoteServerUrl("https://alice@example.com/sse")).toThrowError(expect.objectContaining({ code: REMOTE_MCP_URL_USERINFO }));
    });
});

describe("remotePolicy.ipv4Class", () => {
    it("classifies the private / special ranges", () => {
        expect(ipv4Class("127.0.0.1")).toBe("loopback");
        expect(ipv4Class("127.255.0.1")).toBe("loopback");
        expect(ipv4Class("10.0.0.1")).toBe("private");
        expect(ipv4Class("172.16.0.1")).toBe("private");
        expect(ipv4Class("172.31.255.255")).toBe("private");
        expect(ipv4Class("192.168.1.1")).toBe("private");
        expect(ipv4Class("169.254.169.254")).toBe("link_local");
        expect(ipv4Class("224.0.0.1")).toBe("multicast");
        expect(ipv4Class("239.255.255.250")).toBe("multicast");
        expect(ipv4Class("0.0.0.0")).toBe("reserved");
        expect(ipv4Class("100.64.0.1")).toBe("reserved"); // CGNAT
        expect(ipv4Class("100.127.255.1")).toBe("reserved"); // CGNAT
        expect(ipv4Class("198.18.0.1")).toBe("reserved"); // benchmark
        expect(ipv4Class("198.19.255.255")).toBe("reserved"); // benchmark
        expect(ipv4Class("240.0.0.1")).toBe("reserved");
        expect(ipv4Class("255.255.255.255")).toBe("reserved");
    });

    it("classifies public and unknown inputs", () => {
        expect(ipv4Class("8.8.8.8")).toBe("public");
        expect(ipv4Class("1.1.1.1")).toBe("public");
        expect(ipv4Class("9.9.9.9")).toBe("public");
        expect(ipv4Class("::1")).toBe("unknown");
        expect(ipv4Class("example.com")).toBe("unknown");
        expect(ipv4Class("1.2.3")).toBe("unknown");
        expect(ipv4Class("1.2.3.999")).toBe("unknown");
        expect(ipv4Class("")).toBe("unknown");
    });
});

describe("remotePolicy.hostToLiteral", () => {
    it("returns IPv4 literals, strips IPv6 brackets, null for hostnames", () => {
        expect(hostToLiteral("8.8.8.8")).toBe("8.8.8.8");
        expect(hostToLiteral("127.0.0.1")).toBe("127.0.0.1");
        expect(hostToLiteral("[::1]")).toBe("::1");
        expect(hostToLiteral("example.com")).toBeNull();
        expect(hostToLiteral("999.1.1.1")).toBeNull();
    });
});

describe("remotePolicy.assertSafeRemoteTarget", () => {
    it("allows a public IP literal", async () => {
        const result = await assertSafeRemoteTarget("https://8.8.8.8/mcp");
        expect(result).toMatchObject({ ok: true, class: "public", needsDnsCheck: false });
    });

    it("denies private and loopback IP literals unless allowPrivate", async () => {
        for (const url of ["https://10.0.0.5/mcp", "https://192.168.0.5/mcp", "https://172.16.0.9/mcp", "https://127.0.0.1/mcp", "https://169.254.1.1/mcp"]) {
            await expect(assertSafeRemoteTarget(url)).rejects.toThrowError(expect.objectContaining({ code: REMOTE_MCP_SSRF_DENIED, statusCode: 403 }));
        }
        await expect(assertSafeRemoteTarget("https://127.0.0.1/mcp", { allowPrivate: true })).resolves.toMatchObject({ ok: true, class: "loopback" });
        await expect(assertSafeRemoteTarget("https://192.168.0.5/mcp", { allowPrivate: true })).resolves.toMatchObject({ ok: true, class: "private" });
    });

    it("honors denyHosts with wildcard suffixes", async () => {
        await expect(assertSafeRemoteTarget("https://sub.example.com/mcp", { denyHosts: ["*.example.com"] }))
            .rejects.toThrowError(expect.objectContaining({ code: REMOTE_MCP_HOST_DENIED }));
        await expect(assertSafeRemoteTarget("https://example.com/mcp", { denyHosts: ["example.com"] }))
            .rejects.toThrowError(expect.objectContaining({ code: REMOTE_MCP_HOST_DENIED }));
        await expect(assertSafeRemoteTarget("https://trusted.dev/mcp", { denyHosts: ["*.example.com"] }))
            .resolves.toMatchObject({ ok: true, needsDnsCheck: true });
    });

    it("flags hostnames as needsDnsCheck when no resolver is injected", async () => {
        const result = await assertSafeRemoteTarget("https://example.com/sse");
        expect(result).toMatchObject({ ok: true, host: "example.com", class: null, needsDnsCheck: true });
    });

    it("re-checks hostname via an injected resolver (DNS-rebinding defence seam)", async () => {
        await expect(assertSafeRemoteTarget("https://example.com/sse", { resolveHost: async () => ["127.0.0.1"] }))
            .rejects.toThrowError(expect.objectContaining({ code: REMOTE_MCP_SSRF_DENIED }));
        await expect(assertSafeRemoteTarget("https://example.com/sse", { resolveHost: async () => ["192.168.0.10", "10.0.0.1"] }))
            .rejects.toThrowError(expect.objectContaining({ code: REMOTE_MCP_SSRF_DENIED }));
        const result = await assertSafeRemoteTarget("https://example.com/sse", { resolveHost: async () => ["8.8.8.8"] });
        expect(result).toMatchObject({ ok: true, class: "public", needsDnsCheck: false });
    });

    it("refuses https targets on non-default ports unless whitelisted", async () => {
        await expect(assertSafeRemoteTarget("https://example.com:8443/sse"))
            .rejects.toThrowError(expect.objectContaining({ code: REMOTE_MCP_PORT_DENIED }));
        await expect(assertSafeRemoteTarget("https://example.com:8443/sse", { allowedPorts: [8443] }))
            .resolves.toMatchObject({ ok: true });
        await expect(assertSafeRemoteTarget("https://8.8.8.8/mcp", { allowedPorts: [8443] }))
            .rejects.toThrowError(expect.objectContaining({ code: REMOTE_MCP_PORT_DENIED }));
    });

    it("requires https (no http escape hatch)", async () => {
        await expect(assertSafeRemoteTarget("http://8.8.8.8/mcp")).rejects.toThrowError(expect.objectContaining({ code: REMOTE_MCP_SSRF_DENIED }));
    });
});

describe("remotePolicy.assertRedirectChain", () => {
    it("validates each hop and caps the chain length", async () => {
        const results = await assertRedirectChain([
            "https://a.example.com/1",
            "https://b.example.com/2",
            "https://c.example.com/3",
        ]);
        expect(results).toHaveLength(3);
        expect(results.every((r) => r.needsDnsCheck === true)).toBe(true);
    });

    it("rejects a chain longer than REMOTE_MAX_REDIRECTS (3)", async () => {
        await expect(assertRedirectChain([
            "https://a.example.com/1",
            "https://b.example.com/2",
            "https://c.example.com/3",
            "https://d.example.com/4",
        ])).rejects.toThrowError(expect.objectContaining({ code: REMOTE_MCP_TOO_MANY_REDIRECTS }));
    });
});
