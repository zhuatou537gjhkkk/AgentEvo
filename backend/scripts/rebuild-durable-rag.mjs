#!/usr/bin/env node
/**
 * Phase 7 / R4 — offline durable-RAG rebuild / rollback CLI
 * (roadmap R4 checklist #9).
 *
 * Re-embeds the durable knowledge rows that were ingested offline (or with an
 * embedder down): the durable upload pseudo-project (`PROJECT_ID=__uploads__`,
 * rebuilt via durableSync.rebuildUploadProject) or, when PROJECT_ID names a
 * per-project *code* index and the sibling retrieval module has landed, that
 * project via retrieval.rebuildProjectIndex.
 *
 * Pure DB + embedder: this script deliberately does NOT import rag/index.js
 * (no faiss / legacy in-memory side effects).
 *
 * Usage:
 *   OWNER_USER_ID=<id> TENANT_ID=<tenant,optional> PROJECT_ID=__uploads__ \
 *     node scripts/rebuild-durable-rag.mjs            # read-only: reports total
 *   OWNER_USER_ID=<id> PROJECT_ID=__uploads__ ALLOW_EMBED=1 \
 *     node scripts/rebuild-durable-rag.mjs --embed    # actually re-embed
 *
 * Guards:
 *   - No OWNER_USER_ID + PROJECT_ID → prints help and exits 0 (no side effects;
 *     durableSync / db are imported lazily so a bare invocation opens nothing).
 *   - --embed refuses unless ALLOW_EMBED=1 (a careless run cannot spend tokens).
 */

const HELP = `rebuild-durable-rag.mjs — offline durable RAG rebuild/rollback

Requires env vars (no work is done without all of them):
  OWNER_USER_ID   owner id (number)
  TENANT_ID       optional tenant override (default: user:<OWNER_USER_ID>)
  PROJECT_ID      "__uploads__" (durable uploaded docs) or a per-project code id

Optional:
  --embed         actually re-embed (refuses unless ALLOW_EMBED=1)

Examples:
  OWNER_USER_ID=3 PROJECT_ID=__uploads__ node scripts/rebuild-durable-rag.mjs
  OWNER_USER_ID=3 PROJECT_ID=__uploads__ ALLOW_EMBED=1 \\
    node scripts/rebuild-durable-rag.mjs --embed`;

function parseScope() {
    const ownerRaw = String(process.env.OWNER_USER_ID || "").trim();
    const projectRaw = String(process.env.PROJECT_ID || "").trim();
    const tenantRaw = String(process.env.TENANT_ID || "").trim();
    const owner = Number(ownerRaw);
    if (!ownerRaw || !projectRaw || !Number.isInteger(owner) || owner <= 0) return null;
    return {
        ownerUserId: owner,
        tenantId: tenantRaw || `user:${owner}`,
        projectId: projectRaw,
        scope: tenantRaw ? { userId: owner, tenantId: tenantRaw } : { userId: owner },
    };
}

/** Build a LangChain-style OpenAI embeddings embedder from env (no faiss). */
async function buildEmbedder() {
    const { OpenAIEmbeddings } = await import("@langchain/openai");
    const model = process.env.OPENAI_EMBEDDING_MODEL || "qwen3.7-text-embedding";
    return new OpenAIEmbeddings({
        modelName: model,
        model,
        batchSize: 25,
        maxRetries: 0,
        configuration: {
            apiKey: process.env.OPENAI_EMBEDDING_API_KEY
                || process.env.OPENAI_API_KEY
                || process.env.DASHSCOPE_API_KEY,
            baseURL: process.env.OPENAI_EMBEDDING_BASE_URL
                || process.env.OPENAI_BASE_URL
                || process.env.DASHSCOPE_BASE_URL,
        },
    });
}

const cfg = parseScope();
if (!cfg) {
    process.stdout.write(`${HELP}\n`);
    process.exit(0); // safe no-op: nothing touched
}

const wantEmbed = process.argv.includes("--embed");
if (wantEmbed && process.env.ALLOW_EMBED !== "1") {
    process.stderr.write(
        "rebuild-durable-rag.mjs: --embed refused (ALLOW_EMBED=1 not set); "
        + "embedding would spend tokens.\n",
    );
    process.exit(1);
}

const embedder = wantEmbed ? await buildEmbedder() : null;

// Import the durable service only after the no-op guard has passed, so a bare
// invocation never opens a DB connection or touches the durable store.
const durableSync = await import("../src/rag/durableSync.js");
const UPLOAD_DOC_PROJECT = durableSync.UPLOAD_DOC_PROJECT || "__uploads__";

let result;
let used = "durableSync.rebuildUploadProject";
if (cfg.projectId === UPLOAD_DOC_PROJECT || cfg.projectId === "__uploads__") {
    result = await durableSync.rebuildUploadProject({ scope: cfg.scope, embedder });
} else {
    // Per-project code index rebuild: reuse the RA indexer's rebuildProjectIndex
    // (indexer.js — roadmap R4 #5; the durableSync contract pointed at
    // retrieval.js, but the export actually landed in indexer.js). Otherwise fail
    // loudly, no side effects.
    let rebuildFn = null;
    for (const modPath of ["../src/rag/indexer.js", "../src/rag/retrieval.js"]) {
        try {
            const mod = await import(modPath);
            if (typeof mod.rebuildProjectIndex === "function") {
                rebuildFn = mod.rebuildProjectIndex;
                used = `${modPath.includes("indexer") ? "indexer" : "retrieval"}.rebuildProjectIndex`;
                break;
            }
        } catch {
            rebuildFn = null;
        }
    }
    if (!rebuildFn) {
        process.stderr.write(
            `rebuild-durable-rag.mjs: PROJECT_ID="${cfg.projectId}" is not the upload `
            + `pseudo-project (${UPLOAD_DOC_PROJECT}) and no rebuildProjectIndex is `
            + "available yet; nothing rebuilt.\n",
        );
        process.exit(1);
    }
    result = await rebuildFn({ scope: cfg.scope, projectId: cfg.projectId, embedder });
}

const requiresEmbedder = Boolean(result?.requiresEmbedder);
const embeddingErrors = Number(result?.embeddingErrors || result?.errors?.length || 0);
// A clean completion: no exception, no embedder errors. A read-only
// (requiresEmbedder) run is a successful no-op summary, not a failure.
const ok = Boolean(!result?.error && embeddingErrors === 0);
process.stdout.write(`${JSON.stringify({
    ok,
    mode: "rebuild-durable-rag",
    used,
    project: cfg.projectId,
    ownerUserId: cfg.ownerUserId,
    tenantId: cfg.tenantId,
    embed: wantEmbed,
    requiresEmbedder,
    embedded: Number(result?.embedded || 0),
    total: Number(result?.total || 0),
    embeddingErrors,
}, null, 2)}\n`);
process.exit(ok ? 0 : 1);
