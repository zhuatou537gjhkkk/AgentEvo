#!/usr/bin/env node
/**
 * MinerU end-to-end smoke test.
 *
 * Real network submission is opt-in and guarded by an explicit file path,
 * ALLOW_MINERU_NETWORK=1, a configured token, and a one-submission marker.
 * The reusable runMineruSmoke() function is also used by fake/local ZIP tests.
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMineruClient } from "../src/rag/mineruClient.js";
import { normalizeMineruOutput, readMineruArchive } from "../src/rag/mineruOutput.js";
import { parseParsedDocument } from "../src/rag/documentContract.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_FIXTURE_DIR = path.resolve(REPOSITORY_ROOT, "backend/src/rag/fixtures");
const DEFAULT_GUARD_FILE = path.resolve(REPOSITORY_ROOT, "backend/tmp/mineru-smoke/submission.guard.json");

function arg(name, argv = process.argv) {
    const prefix = `--${name}=`;
    const value = argv.find((item) => item.startsWith(prefix));
    return value ? value.slice(prefix.length) : null;
}

function hasFlag(name, argv = process.argv) {
    return argv.includes(`--${name}`);
}

function publicCode(error, fallback = "MINERU_SMOKE_FAILED") {
    return String(error?.code || fallback).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

function isWithin(candidate, root) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function validateSmokeFile(filePath, { repositoryRoot = REPOSITORY_ROOT, allowedDirs = [] } = {}) {
    const resolved = path.resolve(String(filePath || ""));
    const roots = [DEFAULT_FIXTURE_DIR, ...allowedDirs.map((dir) => path.resolve(dir))];
    if (!roots.some((root) => isWithin(resolved, root))) {
        throw Object.assign(new Error("smoke file is outside the allowed fixture or explicit directory"), { code: "MINERU_SMOKE_FILE_SCOPE" });
    }
    if (!isWithin(resolved, repositoryRoot) && allowedDirs.length === 0) {
        throw Object.assign(new Error("smoke file is outside the repository"), { code: "MINERU_SMOKE_FILE_SCOPE" });
    }
    return resolved;
}

async function reserveSubmission(guardFile, { fileName, bytes, forceNewSubmission = false } = {}) {
    const resolved = path.resolve(guardFile || DEFAULT_GUARD_FILE);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    const marker = { status: "reserved", fileName: String(fileName || "").slice(0, 240), bytes: Number(bytes) || 0, reservedAt: new Date().toISOString() };
    if (forceNewSubmission) {
        await fs.writeFile(resolved, `${JSON.stringify(marker)}\n`, { encoding: "utf8", flag: "w" });
    } else {
        let handle;
        try {
            handle = await fs.open(resolved, "wx");
            await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
        } catch (error) {
            if (error?.code === "EEXIST") throw Object.assign(new Error("a smoke submission is already reserved"), { code: "MINERU_SMOKE_SUBMISSION_GUARD" });
            throw error;
        } finally {
            await handle?.close();
        }
    }
    return resolved;
}

async function completeSubmission(guardFile, { status, batchId = null } = {}) {
    const marker = JSON.parse(await fs.readFile(guardFile, "utf8"));
    const batchHash = batchId ? crypto.createHash("sha256").update(String(batchId)).digest("hex").slice(0, 12) : null;
    await fs.writeFile(guardFile, `${JSON.stringify({ ...marker, status, completedAt: new Date().toISOString(), batchHash })}\n`, "utf8");
}

function summarizeDocument(document) {
    const blockTypes = {};
    for (const block of document.blocks || []) blockTypes[block.type] = (blockTypes[block.type] || 0) + 1;
    return { pages: document.stats?.pages ?? null, blocks: document.blocks?.length || 0, blockTypes, hasPageNumbers: Boolean(document.blocks?.some((block) => Number.isInteger(block.page) && block.page > 0)) };
}

export async function runMineruSmoke({
    filePath,
    client = null,
    token = process.env.MINERU_API_TOKEN,
    outputReader = readMineruArchive,
    outputNormalizer = normalizeMineruOutput,
    guardFile = DEFAULT_GUARD_FILE,
    pollIntervalMs = Number(process.env.MINERU_SMOKE_POLL_MS) || 2_000,
    timeoutMs = Number(process.env.MINERU_SMOKE_TIMEOUT_MS) || 180_000,
    dryRun = false,
    forceNewSubmission = false,
} = {}) {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw Object.assign(new Error("smoke file is not regular"), { code: "MINERU_SMOKE_FILE_INVALID" });
    const fileName = path.basename(filePath).slice(0, 240);
    if (dryRun) return { status: "dry-run", fileName, bytes: stat.size };
    if (String(process.env.ALLOW_MINERU_NETWORK || "") !== "1") throw Object.assign(new Error("network disabled"), { code: "MINERU_NETWORK_DISABLED" });
    if (!String(token || "").trim()) throw Object.assign(new Error("MinerU token is missing"), { code: "MINERU_TOKEN_MISSING" });

    const guard = await reserveSubmission(guardFile, { fileName, bytes: stat.size, forceNewSubmission });
    const smokeDir = await fs.mkdtemp(path.join(process.cwd(), ".mineru-smoke-"));
    const archivePath = path.join(smokeDir, "result.zip");
    const smokeClient = client || createMineruClient({ token, retries: 0 });
    let batchId = null;
    try {
        const submitted = await smokeClient.requestUploadSlot({
            fileName,
            dataId: `smoke-${Date.now()}`,
            options: { isOcr: true, modelVersion: process.env.MINERU_MODEL_VERSION || undefined, language: process.env.MINERU_LANGUAGE || undefined, enableFormula: true, enableTable: true },
        });
        batchId = submitted.batchId;
        await smokeClient.uploadFile({ uploadUrl: submitted.uploadUrl, filePath });
        const deadline = Date.now() + Math.max(5_000, Number(timeoutMs) || 180_000);
        let completed = null;
        while (Date.now() < deadline) {
            const result = await smokeClient.getBatchResult({ batchId });
            if (result.state === "done") { completed = result; break; }
            await new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(pollIntervalMs) || 2_000)));
        }
        if (!completed) throw Object.assign(new Error("MinerU smoke timed out"), { code: "MINERU_SMOKE_TIMEOUT" });
        await smokeClient.downloadResult({ resultUrl: completed.resultUrl, targetPath: archivePath });
        const entries = await outputReader(archivePath);
        const document = parseParsedDocument(outputNormalizer({ entries, fileName, mimeType: "application/pdf", parserVersion: "mineru-smoke" }));
        const summary = summarizeDocument(document);
        if (summary.blocks < 1 || !summary.hasPageNumbers) throw Object.assign(new Error("normalized document has no block/page metadata"), { code: "MINERU_SMOKE_CONTRACT_FAILED" });
        await completeSubmission(guard, { status: "passed", batchId });
        return { status: "passed", fileName, bytes: stat.size, batchHash: crypto.createHash("sha256").update(String(batchId)).digest("hex").slice(0, 12), providerState: "done", ...summary };
    } catch (error) {
        await completeSubmission(guard, { status: "failed", batchId }).catch(() => {});
        throw Object.assign(new Error(publicCode(error)), { code: publicCode(error) });
    } finally {
        await fs.rm(smokeDir, { recursive: true, force: true });
    }
}

export async function runMineruSmokeCli(argv = process.argv) {
    const supplied = arg("file", argv);
    const dryRun = hasFlag("dry-run", argv);
    if (!supplied) throw Object.assign(new Error("missing explicit --file=<path>"), { code: "MINERU_SMOKE_FILE_REQUIRED" });
    const allowedDirs = [arg("allowed-dir", argv) || process.env.MINERU_SMOKE_ALLOWED_DIR].filter(Boolean).flatMap((value) => String(value).split(","));
    const filePath = validateSmokeFile(supplied, { allowedDirs });
    const stat = await fs.stat(filePath);
    if (dryRun) return { status: "dry-run", fileName: path.basename(filePath), bytes: stat.size, network: "disabled" };
    return runMineruSmoke({ filePath, guardFile: arg("guard-file", argv) || process.env.MINERU_SMOKE_GUARD_FILE || DEFAULT_GUARD_FILE, timeoutMs: Number(process.env.MINERU_SMOKE_TIMEOUT_MS) || 180_000, pollIntervalMs: Number(process.env.MINERU_SMOKE_POLL_MS) || 2_000, forceNewSubmission: hasFlag("force-new-submission", argv) });
}

async function main() {
    try {
        const result = await runMineruSmokeCli(process.argv);
        console.log(`[mineru-smoke] file=${result.fileName} bytes=${result.bytes} status=${result.status}`);
        if (result.status === "dry-run") console.log("[mineru-smoke] network=disabled PASS");
        else console.log(`[mineru-smoke] batch=${result.batchHash} state=${result.providerState} pages=${result.pages} blocks=${JSON.stringify(result.blockTypes)} hasPages=${result.hasPageNumbers} PASS`);
    } catch (error) {
        console.error(`[mineru-smoke] failed code=${publicCode(error)}`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
