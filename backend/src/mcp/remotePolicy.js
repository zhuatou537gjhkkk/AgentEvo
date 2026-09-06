/**
 * Phase 7 / R5 (roadmap #5) — remote MCP pre-connect policy: SSRF / redirect /
 * IP-classification / host-deny / port policy. Pure & deterministic — no network,
 * no DNS by default (a domain target is tagged `needsDnsCheck` and a real connect
 * path must inject a resolver and re-verify, DNS-rebinding defence is R7).
 *
 * The actual Streamable HTTP transport is R7 (see mcp/remoteLifecycle.js
 * REMOTE_TRANSPORT_AVAILABLE=false). This module only decides whether a URL /
 * redirect chain is *permitted to be dialed*, never dials it.
 */
import { codingError } from "../coding/util.js";

export const REMOTE_MCP_URL_INVALID = "REMOTE_MCP_URL_INVALID";
export const REMOTE_MCP_URL_USERINFO = "REMOTE_MCP_URL_USERINFO";
export const REMOTE_MCP_SSRF_DENIED = "REMOTE_MCP_SSRF_DENIED";
export const REMOTE_MCP_HOST_DENIED = "REMOTE_MCP_HOST_DENIED";
export const REMOTE_MCP_PORT_DENIED = "REMOTE_MCP_PORT_DENIED";
export const REMOTE_MCP_TOO_MANY_REDIRECTS = "REMOTE_MCP_TOO_MANY_REDIRECTS";

/** Maximum accepted redirect hops on a remote-MCP endpoint (a hop beyond this is refused). */
export const REMOTE_MAX_REDIRECTS = 3;

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const V6_BRACKET_RE = /^\[[0-9A-Fa-f:.]+\]$/;
const DEFAULT_ALLOWED_PORTS = Object.freeze([443, 80]);

/**
 * Parse a remote MCP server URL. Accepts only `http:`/`https:` and refuses any
 * URL that carries userinfo (`user:pass@`). Returns the parsed URL or throws
 * codingError(REMOTE_MCP_URL_INVALID, 400) / (REMOTE_MCP_URL_USERINFO, 400).
 * @param {string} raw
 * @returns {URL}
 */
export function parseRemoteServerUrl(raw) {
    const text = String(raw ?? "").trim();
    let url;
    try {
        url = new URL(text);
    } catch {
        throw codingError(REMOTE_MCP_URL_INVALID, "invalid remote MCP server url", 400);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw codingError(REMOTE_MCP_URL_INVALID, "remote MCP server url must be http(s)", 400);
    }
    if (url.username || url.password) {
        throw codingError(REMOTE_MCP_URL_USERINFO, "userinfo in remote MCP url is not allowed", 400);
    }
    if (!url.hostname) {
        throw codingError(REMOTE_MCP_URL_INVALID, "remote MCP server url requires a host", 400);
    }
    return url;
}

/**
 * Pure IPv4 octet-string classification. Returns:
 *   "loopback" | "private" | "link_local" | "multicast" | "reserved" | "public"
 * for a dotted-quad literal, or "unknown" for anything that is not four numeric
 * octets in range. IPv6 is intentionally out of scope here (returns "unknown",
 * which the caller treats as not-public → denied unless allowPrivate).
 * @param {string} ip
 * @returns {string}
 */
export function ipv4Class(ip) {
    const p = String(ip ?? "").split(".");
    if (p.length !== 4 || !IPV4_RE.test(String(ip ?? ""))) return "unknown";
    const octets = p.map((n) => Number(n));
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return "unknown";
    const [a, b, c] = octets;
    if (a === 0) return "reserved";            // 0.0.0.0/8 (incl. 0.0.0.0)
    if (a === 10) return "private";            // 10/8
    if (a === 100 && b >= 64 && b <= 127) return "reserved"; // 100.64/10 CGNAT
    if (a === 127) return "loopback";          // 127/8
    if (a === 169 && b === 254) return "link_local"; // 169.254/16
    if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16/12
    if (a === 192 && b === 168) return "private"; // 192.168/16
    if (a === 192 && b === 0 && c === 0) return "reserved"; // 192.0.0.0/24
    if (a === 198 && (b === 18 || b === 19)) return "reserved"; // 198.18/15
    if (a >= 224 && a <= 239) return "multicast"; // 224/4
    if (a >= 240) return "reserved";           // 240/4 + 255.255.255.255
    return "public";
}

/**
 * Return the literal form of a host when it is an IP literal, else null.
 *  - IPv4 dotted-quad "1.2.3.4" → itself (only if every octet is in range).
 *  - bracketed IPv6 "[::1]" → the inner "::1" (IPv6 is not dialable in R5 but
 *    remains classifiable as non-public).
 *  - a hostname → null (R5 does no DNS; a resolver must be injected at connect
 *    time and the result re-checked — DNS-rebinding defence is R7).
 * @param {string} host
 * @returns {string|null}
 */
export function hostToLiteral(host) {
    const h = String(host ?? "");
    if (IPV4_RE.test(h)) {
        const octets = h.split(".").map(Number);
        if (octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return h;
        return null;
    }
    if (V6_BRACKET_RE.test(h)) return h.slice(1, -1);
    return null;
}

/** Wildcard host-deny matcher: exact match or `*.suffix`. */
function denyMatch(pattern, host) {
    const p = String(pattern ?? "");
    if (p === host) return true;
    if (p.startsWith("*.")) return host.endsWith(p.slice(1));
    return false;
}

function isDenied(hostname, denyHosts) {
    return (Array.isArray(denyHosts) ? denyHosts : []).some((p) => denyMatch(p, hostname));
}

/**
 * Policy gate for a single remote target URL (the URL is never dialed here).
 *
 * @param {string|URL} target
 * @param {{allowPrivate?: boolean, denyHosts?: string[], allowedPorts?: number[]|null,
 *          resolveHost?: (hostname:string)=>string[]|Promise<string[]>}} [opts]
 * @returns {Promise<{ok:boolean, url:string, host:string, class?: string|null, needsDnsCheck:boolean}>}
 *   class: ipv4 class when host is an IP literal (or after a successful DNS
 *   re-check), null for a not-yet-checked hostname.
 */
export async function assertSafeRemoteTarget(target, opts = {}) {
    const { allowPrivate = false, denyHosts = [], allowedPorts = null, resolveHost = null } = opts || {};
    const url = parseRemoteServerUrl(String(target));
    if (url.protocol !== "https:") {
        // No allowHttp escape hatch: remote MCP targets must be TLS.
        throw codingError(REMOTE_MCP_SSRF_DENIED, "only https remote MCP targets are allowed", 403);
    }
    const hostname = url.hostname;
    if (isDenied(hostname, denyHosts)) {
        throw codingError(REMOTE_MCP_HOST_DENIED, `host "${hostname}" is denied by remote MCP policy`, 403);
    }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const portAllowed = allowedPorts != null
        ? (Array.isArray(allowedPorts) ? allowedPorts : [allowedPorts]).includes(port)
        : DEFAULT_ALLOWED_PORTS.includes(port);
    if (!portAllowed) {
        throw codingError(REMOTE_MCP_PORT_DENIED, `port ${port} is not allowed for remote MCP`, 403);
    }

    const literal = hostToLiteral(hostname);
    if (literal != null) {
        const klass = ipv4Class(literal);
        if (!allowPrivate && klass !== "public") {
            throw codingError(REMOTE_MCP_SSRF_DENIED, `remote target ${hostname} is a ${klass} address (blocked by SSRF policy)`, 403);
        }
        return { ok: true, url: url.href, host: hostname, class: klass, needsDnsCheck: false };
    }

    // Hostname (domain). If a resolver was injected, re-check every resolved IP;
    // otherwise tag the target as needsDnsCheck — a connect path MUST NOT proceed
    // without a resolver re-check (enforced by remoteLifecycle for R5, and DNS
    // rebinding defence is R7).
    if (typeof resolveHost === "function") {
        const results = await resolveHost(hostname);
        const ips = Array.isArray(results) ? results : (results == null ? [] : [results]);
        if (ips.length === 0) {
            throw codingError(REMOTE_MCP_SSRF_DENIED, `no DNS results for remote MCP target "${hostname}"`, 403);
        }
        for (const raw of ips) {
            const klass = ipv4Class(String(raw));
            if (!allowPrivate && klass !== "public") {
                throw codingError(REMOTE_MCP_SSRF_DENIED, `remote target ${hostname} resolves to a ${klass} address (blocked by SSRF policy)`, 403);
            }
        }
        return { ok: true, url: url.href, host: hostname, class: "public", needsDnsCheck: false };
    }
    return { ok: true, url: url.href, host: hostname, class: null, needsDnsCheck: true };
}

/**
 * Validate an entire redirect chain: no more than REMOTE_MAX_REDIRECTS hops and
 * every hop must independently pass assertSafeRemoteTarget (SSRF/deny/port).
 * @param {Array<string|URL>} urls
 * @param {object} [options]
 * @returns {Promise<Array>}
 */
export async function assertRedirectChain(urls, options = {}) {
    const list = Array.isArray(urls) ? urls : [];
    if (list.length > REMOTE_MAX_REDIRECTS) {
        throw codingError(REMOTE_MCP_TOO_MANY_REDIRECTS, `redirect chain exceeds ${REMOTE_MAX_REDIRECTS} hops`, 400);
    }
    const results = [];
    for (const target of list) {
        results.push(await assertSafeRemoteTarget(target, options));
    }
    return results;
}

export default {
    REMOTE_MCP_URL_INVALID, REMOTE_MCP_URL_USERINFO, REMOTE_MCP_SSRF_DENIED,
    REMOTE_MCP_HOST_DENIED, REMOTE_MCP_PORT_DENIED, REMOTE_MCP_TOO_MANY_REDIRECTS,
    REMOTE_MAX_REDIRECTS, parseRemoteServerUrl, ipv4Class, hostToLiteral,
    assertSafeRemoteTarget, assertRedirectChain,
};
