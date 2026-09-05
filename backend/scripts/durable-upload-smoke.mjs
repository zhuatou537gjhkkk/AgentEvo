#!/usr/bin/env node
/**
 * Durable upload-quota production-write smoke (A1 acceptance).
 *
 * Proves the REAL production path — module-level durable singleton activated by
 * DURABLE_UPLOAD_QUOTA=true, spawned server, real HTTP /upload route, multer,
 * withUploadLock chain, RAG indexing, settle → durable SQLite commit — against an
 * isolated throwaway database. No dev data is touched.
 *
 * Two roles in one script:
 *   node scripts/durable-upload-smoke.mjs            # orchestrator (spawns the server)
 *   node scripts/durable-upload-smoke.mjs --serve    # server role (started by the orchestrator)
 *
 * Determinism: the orchestrator runs an in-process OpenAI-compatible embeddings
 * stub and points OPENAI_EMBEDDING_BASE_URL at it, so document indexing always
 * succeeds and the upload commits (rather than falling through to a release).
 * It then asserts committed_bytes > 0 on the temp DB.
 *
 * Exit code 0 = PASS, 1 = FAIL.
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..");
const SELF = fileURLToPath(import.meta.url);

if (process.argv.includes("--serve")) {
    await serve();
    // keep-alive until killed by the orchestrator
} else {
    process.exitCode = await orchestrate();
}

// ── server role: real backend singleton on a temp DB, durable quota on ──
async function serve() {
    const { startServer } = await import(pathToFileURL(path.join(BACKEND_ROOT, "src", "app.js")).href);
    const port = Number(process.env.SMOKE_PORT || 0);
    const server = await startServer({ port, autoConnectMCP: false });
    process.stderr.write(`[durable-smoke] ready on :${port} db=${process.env.DB_PATH}\n`);
    const shutdown = () => server.close(() => process.exit(0));
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    setInterval(() => {}, 1 << 30); // keep the event loop alive until signalled
}

// ── orchestrator ──
async function orchestrate() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-smoke-"));
    const dbPath = path.join(dir, "agent_data.db");
    let stub = null;
    let child = null;
    try {
        stub = await startEmbeddingStub();
        const port = await freePort();
        process.stderr.write(`[durable-smoke] temp db=${dbPath} server=:${port} stub=:${stub.port}\n`);

        child = spawn(process.execPath, [SELF, "--serve"], {
            cwd: BACKEND_ROOT,
            env: {
                ...process.env,
                DB_PATH: dbPath,
                SMOKE_PORT: String(port),
                DURABLE_UPLOAD_QUOTA: "true",
                OPENAI_EMBEDDING_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
                OPENAI_EMBEDDING_API_KEY: "smoke-key",
                OPENAI_EMBEDDING_MODEL: "smoke-embed",
                NODE_ENV: "development",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let childErr = "";
        child.stderr.on("data", (d) => { childErr += d; });
        child.stdout.on("data", () => {});

        try {
            await waitForPing(port);
            const { token, userId } = await registerUser(port);
            const upload = await uploadDocument(port, token);
            const rows = readQuotaRows(dbPath, userId);

            const committedBytes = rows.usage.reduce((sum, u) => sum + Number(u.committed_bytes), 0);
            const activeLeft = rows.reservations.filter((r) => r.status === "active").length;

            if (upload.status !== 200 || committedBytes <= 0) {
                throw new Error(
                    `durable commit not observed: http=${upload.status} committedBytes=${committedBytes} `
                    + `activeLeft=${activeLeft} uploadBody=${upload.body.slice(0, 300)} rows=${JSON.stringify(rows)}`
                );
            }

            process.stdout.write(`${JSON.stringify({
                ok: true,
                mode: "durable-upload-smoke",
                httpStatus: upload.status,
                uploadKey: upload.key,
                committedBytes,
                activeReservationsLeft: activeLeft,
                committedRows: rows.reservations.filter((r) => r.status === "committed").length,
                dbPath,
                serverPort: port,
            }, null, 2)}\n`);
            return 0;
        } finally {
            child.kill("SIGTERM");
            await onceExit(child, 15_000);
            child = null;
        }
    } catch (error) {
        process.stderr.write(`[durable-smoke] FAIL: ${error.message}\n`);
        if (childErr) process.stderr.write(`[durable-smoke] server stderr:\n${childErr.slice(0, 2000)}\n`);
        return 1;
    } finally {
        if (stub) stub.server.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

// ── helpers ──

function startEmbeddingStub() {
    return new Promise((resolve) => {
        // Respond to ANY POST with a fixed-dimension embedding payload so the
        // LangChain OpenAI embeddings client always succeeds against the stub.
        const dim = 1024;
        const vec = Array.from({ length: dim }, (_, i) => ((i % 97) + 1) / 1000);
        const server = http.createServer((req, res) => {
            if (req.method !== "POST") {
                res.writeHead(404);
                res.end("not found");
                return;
            }
            let body = "";
            req.on("data", (d) => { body += d; });
            req.on("end", () => {
                let parsed = {};
                try { parsed = JSON.parse(body || "{}"); } catch { /* keep empty */ }
                const input = parsed.input;
                const count = Array.isArray(input) ? input.length : 1;
                const data = Array.from({ length: count }, (_, i) => ({
                    object: "embedding",
                    embedding: vec,
                    index: i,
                }));
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    object: "list",
                    data,
                    model: parsed.model || "smoke-embed",
                    usage: { prompt_tokens: 0, total_tokens: 0 },
                }));
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
    });
}

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on("error", reject);
        s.listen(0, "127.0.0.1", () => {
            const port = s.address().port;
            s.close(() => resolve(port));
        });
    });
}

async function waitForPing(port, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/ping`);
            if (res.ok) return;
        } catch (error) { lastErr = error; }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`server not ready on :${port} (${lastErr?.message || "no response"})`);
}

async function registerUser(port) {
    const username = `smoke_${Date.now().toString(36)}`;
    const password = "smoke-pass-123";
    const res = await fetch(`http://127.0.0.1:${port}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
    });
    const body = await res.json();
    if (!res.ok || !body.token) {
        throw new Error(`register failed: http=${res.status} body=${JSON.stringify(body)}`);
    }
    return { token: body.token, userId: Number(body.user?.id) };
}

async function uploadDocument(port, token) {
    const content = "durable upload smoke document: AgentEvo production-write acceptance. "
        + "This plain text is indexed into the isolated tenant store and its size "
        + "must be settled into the durable upload quota ledger.\n";
    const key = crypto.createHash("sha256").update(content, "utf8").digest("hex");
    const fileName = `durable-smoke-${Date.now().toString(36)}.txt`;
    const fd = new FormData();
    fd.append("file", new Blob([content], { type: "text/plain" }), fileName);
    const res = await fetch(`http://127.0.0.1:${port}/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
    });
    const body = await res.text();
    return { status: res.status, key, body };
}

function readQuotaRows(dbPath, ownerUserId) {
    // Normal (read-write) open so a leftover -wal from the force-killed server is
    // recovered/replayed and committed rows are visible.
    const conn = new Database(dbPath);
    try {
        return {
            usage: conn.prepare("SELECT usage_day, committed_bytes, reserved_bytes FROM upload_quota_usage WHERE owner_user_id = ? ORDER BY usage_day").all(ownerUserId),
            reservations: conn.prepare("SELECT upload_key, status, reserved_bytes FROM upload_reservations WHERE owner_user_id = ?").all(ownerUserId),
        };
    } finally {
        conn.close();
    }
}

function onceExit(child, timeoutMs) {
    return new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(); }, timeoutMs);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.once("error", () => { clearTimeout(timer); resolve(); });
    });
}
