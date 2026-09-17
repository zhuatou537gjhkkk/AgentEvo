#!/usr/bin/env node
/** K9 RAG evaluation CLI. */
import "dotenv/config";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRagManifest, readRagDocuments } from "../src/eval/ragDataset.js";
import { createFaithfulnessJudge } from "../src/eval/ragAnswerEvaluation.js";
import { runRagProfileEvaluation, RAG_PROFILES } from "../src/eval/ragProfileEvaluation.js";

function argsFrom(argv) {
    const args = {};
    for (const raw of argv.slice(2)) {
        const match = raw.match(/^--([^=]+)(?:=(.*))?$/);
        if (match) args[match[1]] = match[2] ?? true;
    }
    return args;
}

function usage() {
    return [
        "Usage: node scripts/rag-eval.mjs --manifest=<path> [options]",
        "  --profile=all|lexical,hybrid,...     profiles to run (default: all)",
        "  --output=<path>                      write JSON and adjacent Markdown report",
        "  --driver=<module>                    private retrieval driver for PDF/production corpus",
        "  --allow-absolute --root=<path>      explicitly allow manifest paths under root",
        "  --real-model                         opt-in current chat model judge",
        "  --owner-user-id=<id>                 bind a user-specific report to that authenticated user",
    ].join("\n");
}

function tokens(text) {
    const value = String(text || "").toLowerCase();
    const result = new Set(value.match(/[a-z0-9_./:-]+/g) || []);
    const compact = value.replace(/\s+/g, "");
    for (let index = 0; index < compact.length - 1; index += 1) {
        const pair = compact.slice(index, index + 2);
        if (/[^\x00-\x7f]/.test(pair)) result.add(pair);
    }
    return result;
}

function createOfflineDriver(documents) {
    const chunks = [];
    for (const document of documents) {
        const paragraphs = String(document.content || "").split(/\n\s*\n/).map((content) => content.trim()).filter(Boolean);
        paragraphs.forEach((content, index) => {
            const page = Number(content.match(/<!--\s*page\s*:\s*(\d+)\s*-->/i)?.[1] || index + 1);
            chunks.push({
                chunkId: `${document.id}#${index + 1}`,
                documentId: document.id,
                pageStart: page,
                pageEnd: page,
                content: content.replace(/<!--\s*page\s*:\s*\d+\s*-->/gi, "").trim(),
            });
        });
    }
    return {
        async retrieve({ testCase }) {
            const queryTokens = tokens(testCase.query);
            const ranked = chunks.map((chunk) => {
                const chunkTokens = tokens(chunk.content);
                const overlap = [...queryTokens].filter((token) => chunkTokens.has(token)).length;
                const exact = String(chunk.content).toLowerCase().includes(String(testCase.query || "").toLowerCase()) ? 0.5 : 0;
                return { chunk, score: overlap + exact };
            }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId));
            const items = ranked.slice(0, 5).map((row) => ({ ...row.chunk, score: row.score }));
            return {
                status: items.length ? "ok" : "no_match",
                items,
                metrics: { driver: "offline_fixture", embeddingCalls: 0, llmCalls: 0, tokenCount: 0, compression: { ratio: 1 } },
            };
        },
        async answer({ response }) {
            if (!response.items?.length) return { status: "no_match", items: [], answer: "未找到足够证据回答该问题。" };
            const answer = response.items.slice(0, 3).map((item, index) => `${item.content} [${index + 1}]`).join("\n");
            return { status: "ok", items: response.items, answer };
        },
    };
}

function markdownReport(report) {
    const lines = [
        "# RAG Evaluation Report", "", `- Dataset: ${report.datasetVersion}`,
        `- Driver: ${report.driver}`, `- Model alias: ${report.modelAlias || "none (deterministic/offline)"}`,
        `- Gate status: ${report.gates.status}`, "",
        "| Profile | Samples | Recall@K | MRR | nDCG | No-answer | Citation pages | Faithfulness | p50/p95 ms |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ];
    for (const profile of RAG_PROFILES) {
        const summary = report.profiles[profile]?.summary;
        if (!summary) continue;
        const value = (item) => item == null ? "-" : Number(item).toFixed(3);
        lines.push(`| ${profile} | ${summary.sampleCount} | ${value(summary.recallAtK)} | ${value(summary.mrr)} | ${value(summary.ndcgAtK)} | ${value(summary.noAnswerPrecision)} (${summary.noAnswerSamples}) | ${value(summary.citationPageAccuracy)} (${summary.citationSamples}) | ${value(summary.faithfulness)} (${summary.faithfulnessSamples}) | ${value(summary.p50LatencyMs)} / ${value(summary.p95LatencyMs)} |`);
    }
    lines.push("", "## Gate Summary", "", "```json", JSON.stringify(report.gates, null, 2), "```", "");
    return lines.join("\n");
}

async function loadDriver(driverPath, manifest, documents) {
    if (!driverPath) return createOfflineDriver(documents);
    const imported = await import(pathToFileURL(path.resolve(String(driverPath))).href);
    if (typeof imported.createRagEvalDriver !== "function") throw Object.assign(new Error("driver must export createRagEvalDriver"), { code: "RAG_EVAL_DRIVER_INVALID" });
    return imported.createRagEvalDriver({ manifest, documents });
}

const args = argsFrom(process.argv);
if (!args.manifest) {
    console.error(usage());
    process.exitCode = 2;
} else {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentevo-rag-eval-"));
    const previousDbPath = process.env.DB_PATH;
    process.env.DB_PATH = path.join(tempDir, "eval.sqlite");
    try {
        const manifest = await loadRagManifest(String(args.manifest), {
            allowAbsolute: args["allow-absolute"] === true,
            rootDir: args.root ? path.resolve(String(args.root)) : null,
        });
        const documents = args.driver ? [] : await readRagDocuments(manifest);
        const driver = await loadDriver(args.driver ? String(args.driver) : null, manifest, documents);
        if (!driver || typeof driver.retrieve !== "function") throw Object.assign(new Error("driver retrieve function is required"), { code: "RAG_EVAL_DRIVER_INVALID" });
        const selectedProfiles = args.profile && args.profile !== "all" ? String(args.profile).split(",").map((profile) => profile.trim()).filter(Boolean) : RAG_PROFILES;
        const realModel = args["real-model"] === true || String(process.env.RAG_FAITHFULNESS_EVAL_ENABLED || "").toLowerCase() === "true";
        if (realModel && process.env.ALLOW_RAG_REAL_MODEL !== "1") throw Object.assign(new Error("real model requires ALLOW_RAG_REAL_MODEL=1"), { code: "RAG_REAL_MODEL_OPT_IN_REQUIRED" });
        const judge = realModel ? createFaithfulnessJudge() : null;
        const result = await runRagProfileEvaluation({
            cases: manifest.cases, profiles: selectedProfiles,
            retrieve: (input) => driver.retrieve(input),
            answer: typeof driver.answer === "function" ? (input) => driver.answer(input) : null,
            judge, judgeDisabledReason: realModel ? "RAG_JUDGE_UNAVAILABLE" : "RAG_REAL_MODEL_DISABLED",
        });
        const ownerUserId = args["owner-user-id"] == null ? null : Number(args["owner-user-id"]);
        if (ownerUserId != null && (!Number.isInteger(ownerUserId) || ownerUserId <= 0)) {
            throw Object.assign(new Error("owner user id must be a positive integer"), { code: "RAG_EVAL_OWNER_INVALID" });
        }
        const report = {
            schemaVersion: "rag-eval-k9-v2", generatedAt: new Date().toISOString(),
            visibility: ownerUserId == null ? "global" : "user",
            ...(ownerUserId == null ? {} : { ownerUserId }),
            datasetVersion: manifest.datasetVersion, manifestFile: path.basename(manifest.manifestPath),
            driver: args.driver ? "custom_driver" : "offline_fixture", modelAlias: judge?.model || null,
            profiles: result.profiles, gates: result.gates,
        };
        const markdown = markdownReport(report);
        if (args.output) {
            const outputPath = path.resolve(String(args.output));
            await fs.mkdir(path.dirname(outputPath), { recursive: true });
            await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
            await fs.writeFile(outputPath.replace(/\.json$/i, "") + ".md", markdown, "utf8");
        }
        console.log(JSON.stringify({ ...report, markdownReport: args.output ? undefined : markdown }, null, 2));
        if (result.gates.status === "fail") process.exitCode = 1;
    } catch (error) {
        console.error(JSON.stringify({ ok: false, error: String(error?.code || "RAG_EVAL_FAILED").slice(0, 80) }));
        process.exitCode = 1;
    } finally {
        if (previousDbPath === undefined) delete process.env.DB_PATH;
        else process.env.DB_PATH = previousDbPath;
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}
