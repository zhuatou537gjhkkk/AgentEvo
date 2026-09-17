import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import db, { initDB, createUser } from "../db/index.js";
import * as store from "./knowledgeStore.js";
import { clearRagFlags } from "./flags.js";
import { getKnowledgeQuerySummary } from "./telemetry.js";
import { createFakeEmbedder } from "./embedder.js";
import {
    UPLOAD_DOC_PROJECT,
    sanitizeDocFileName,
    isDurableUploadPathEnabled,
    canaryChoice,
    maybeDualWriteUpload,
    dualReadUpload,
    splitDocChunks,
    rebuildUploadProject,
} from "./durableSync.js";

/**
 * Phase 7 / R4 — durableSync dual-write / dual-read canary tests
 * (roadmap R4 checklist #9).
 *
 * Coverage (all default-OFF safe, per-file temp DB via vitest.setup.js):
 *   - flags off → maybeDualWriteUpload is a no-op, no durable rows.
 *   - flags on → dual-write upload lands docType 'upload' + chunks; unchanged
 *     content → no new revision; changed content → previous revision stale.
 *   - deterministic paragraph/line chunker incl. reconstruction + determinism.
 *   - embedder failure never aborts the durable write (null embeddings persist).
 *   - dual-read canary OFF/ON/rollback semantics + telemetry rows per side.
 *   - default memory reader (no legacy faiss) and default durable reader
 *     (retrieval.js absent) degrade to memory-serve without throwing.
 *   - cross-owner isolation (BOB never sees ALICE rows / telemetry).
 *   - sanitizeDocFileName strips ../ control chars, keeps extension.
 *   - rebuildUploadProject requiresEmbedder + re-embed path.
 *   - CLI `node --check` + no-arg no-op exit 0.
 */

// Ensure the durable tables exist once in this worker (idempotent).
initDB();

let nextOwner = 90000;
function freshOwner() {
    nextOwner += 1;
    // knowledge_* tables FK to users(id) (better-sqlite3 enables FKs by default),
    // so every owner used here must be a real row.
    return createUser(`durable_owner_${nextOwner}`, "durable-hash");
}

function enableWrite() {
    process.env.RAG_DURABLE_ENABLED = "1";
}
function enableRead() {
    process.env.DURABLE_RAG_READ = "1";
}

beforeEach(() => {
    clearRagFlags();
});
afterEach(() => {
    clearRagFlags();
});

// The RA sibling embedder seam (embedder.js) is the deterministic no-network
// embedder used across R4 tests; expose the same `.embed(texts)` contract.
function makeEmbedder() {
    return createFakeEmbedder({ dimension: 8 });
}

function makeThrowingEmbedder() {
    return { embed: async () => { throw new Error("embedding upstream down"); } };
}

function docText(pCount = 3, repeat = 30) {
    const parts = [];
    for (let i = 0; i < pCount; i += 1) {
        parts.push(`durable paragraph ${i} `.repeat(repeat));
    }
    return parts.join("\n\n");
}

// Legacy memory-reader fakes (shape of rag/index.retrieveKnowledgeEvidence).
const memoryOk = async (query) => ({
    status: "ok",
    items: [{ source: "mem.txt", content: `memory hit for ${query}`, score: 0.1 }],
});
const memoryNoMatch = async () => ({ status: "no_match", items: [] });

// Durable retrieval fakes (shape of retrieval.retrieveProjectCode).
const durableOk = async ({ query }) => ({
    status: "ok",
    mode: "hybrid",
    items: [{ source: "doc.txt", content: `durable hit for ${query}`, score: 0.9 }],
    text: `[1] doc.txt:\ndurable hit for ${query}`,
    metrics: { mode: "hybrid", source: "durable" },
});
const durableNoMatch = async () => ({ status: "no_match", items: [] });

function readLog(ownerUserId) {
    return db.prepare(`
        SELECT mode, source, status, items FROM knowledge_query_log
        WHERE owner_user_id = ?
        ORDER BY id ASC
    `).all(ownerUserId);
}

describe("default-off safety", () => {
    it("flag off → maybeDualWriteUpload is a no-op even with an invalid scope", async () => {
        clearRagFlags();
        const owner = freshOwner();
        expect(isDurableUploadPathEnabled()).toBe(false);
        expect(canaryChoice()).toEqual({ enabled: false, readDurable: false });

        const result = await maybeDualWriteUpload({
            scope: undefined,
            text: "should never be indexed",
            fileName: "off.txt",
        });
        expect(result).toEqual({ written: false, reason: "disabled" });
        expect(store.countDocuments(owner, UPLOAD_DOC_PROJECT)).toBe(0);
        expect(store.countChunks(owner, UPLOAD_DOC_PROJECT)).toBe(0);
    });

    it("flag off → dualReadUpload serves legacy memory, no telemetry, no durable read", async () => {
        clearRagFlags();
        const owner = freshOwner();
        let durableCalled = false;
        const durableReader = async () => {
            durableCalled = true;
            return { status: "ok", items: [] };
        };
        const result = await dualReadUpload({
            scope: owner,
            query: "x",
            deps: { memoryReader: memoryOk, durableReader },
        });
        expect(result.servedBy).toBe("memory");
        expect(result.canary).toBe(false);
        expect(result.enabled).toBe(false);
        expect(result.durable).toBeNull();
        expect(durableCalled).toBe(false);
        expect(result.items[0].source).toBe("mem.txt");
        expect(readLog(owner)).toHaveLength(0);
    });
});

describe("dual-write (enabled)", () => {
    it("new upload lands docType 'upload' + chunks; same content → unchanged; changed → revision bump", async () => {
        enableWrite();
        const owner = freshOwner();
        const embedder = makeEmbedder();
        const text = docText();
        const changedText = docText(4, 35) + "\n\nappendix";

        const first = await maybeDualWriteUpload({
            scope: owner,
            text,
            fileName: "uploads/../deep/Report.Notes.txt",
            embedder,
        });
        expect(first.written).toBe(true);
        expect(first.reason).toBe("indexed");
        expect(first.chunkCount).toBeGreaterThan(0);
        expect(first.embeddingErrors).toBe(0);

        const active = store.getActiveDocumentByPath(owner, UPLOAD_DOC_PROJECT, "Report.Notes.txt");
        expect(active).toBeTruthy();
        expect(active.doc_type).toBe("upload");
        expect(active.file_name).toBe("Report.Notes.txt");
        expect(active.file_path).toBe("Report.Notes.txt");
        expect(active.file_hash).toBe(store.sha256Hex(text));
        expect(active.revision).toBe(1);
        expect(store.countDocuments(owner, UPLOAD_DOC_PROJECT)).toBe(1);
        expect(store.countChunks(owner, UPLOAD_DOC_PROJECT)).toBe(first.chunkCount);

        // Same content re-upload → unchanged, no new revision.
        const second = await maybeDualWriteUpload({
            scope: owner,
            text,
            fileName: "Report.Notes.txt",
            embedder,
        });
        expect(second.written).toBe(false);
        expect(second.reason).toBe("unchanged");
        expect(second.revision).toBe(1);
        expect(store.countDocuments(owner, UPLOAD_DOC_PROJECT)).toBe(1);

        // Changed content → previous revision stale, new active revision 2.
        const third = await maybeDualWriteUpload({
            scope: owner,
            text: changedText,
            fileName: "Report.Notes.txt",
            embedder,
        });
        expect(third.written).toBe(true);
        expect(third.reason).toBe("updated");
        expect(third.revision).toBe(2);
        const latest = store.getLatestDocumentByPath(owner, UPLOAD_DOC_PROJECT, "Report.Notes.txt");
        expect(latest.revision).toBe(2);
        expect(latest.file_hash).toBe(store.sha256Hex(changedText));
        expect(store.countDocuments(owner, UPLOAD_DOC_PROJECT)).toBe(1);
        expect(store.countDocuments(owner, UPLOAD_DOC_PROJECT, { status: "stale" })).toBe(1);
        const staleDoc = store.getDocumentById(owner, first.documentId);
        expect(staleDoc.status).toBe("stale");
    });

    it("embedder throwing still persists chunks with null embeddings (lexical works)", async () => {
        enableWrite();
        const owner = freshOwner();
        const text = docText(2, 40);
        const res = await maybeDualWriteUpload({
            scope: owner,
            text,
            fileName: "fail-embed.txt",
            embedder: makeThrowingEmbedder(),
        });
        expect(res.written).toBe(true);
        expect(res.reason).toBe("indexed");
        expect(res.chunkCount).toBeGreaterThan(0);
        expect(res.embeddingErrors).toBe(res.chunkCount);

        const chunks = store.getActiveChunks(owner, UPLOAD_DOC_PROJECT, { filePath: "fail-embed.txt" });
        expect(chunks.length).toBe(res.chunkCount);
        expect(chunks.every((c) => c.embedding == null)).toBe(true);
    });
});

describe("splitDocChunks", () => {
    const opts = { maxChars: 600, overlapChars: 120 };

    it("is deterministic and caps every chunk at maxChars", () => {
        const text = docText(6, 50); // paragraphs ~1000 chars each
        const a = splitDocChunks(text, opts);
        const b = splitDocChunks(text, opts);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        expect(a.length).toBeGreaterThan(1);
        expect(a.every((c) => c.content.length <= 600)).toBe(true);
    });

    it("prefers paragraph breaks near maxChars and whole text is reconstructible after de-overlap", () => {
        const paras = Array.from({ length: 5 }, (_, i) => `p${i} ` + "x".repeat(250 - 3 - String(i).length));
        const text = paras.join("\n\n");
        const chunks = splitDocChunks(text, opts);
        expect(chunks.every((c) => c.content.length <= 600)).toBe(true);
        // The first three chunks end right after a \n\n (paragraph) boundary.
        expect(chunks[0].content.endsWith("\n\n")).toBe(true);
        expect(chunks[1].content.endsWith("\n\n")).toBe(true);
        expect(chunks[2].content.endsWith("\n\n")).toBe(true);
        // Dropping the overlapChars carried at the head of each later chunk
        // reconstructs the source exactly (all middle chunks exceed the overlap).
        let joined = chunks[0].content;
        for (let i = 1; i < chunks.length; i += 1) joined += chunks[i].content.slice(opts.overlapChars);
        expect(joined).toBe(text);
    });

    it("hard-slices long runs without boundaries, overlap keeps every char reconstructible", () => {
        const text = "abcd".repeat(500); // 2000 chars, no newlines
        const chunks = splitDocChunks(text, opts);
        expect(chunks.every((c) => c.content.length <= 600)).toBe(true);
        expect(chunks.map((c) => c.content).join("").length).toBeGreaterThan(text.length); // overlap duplicated
        let joined = chunks[0].content;
        for (let i = 1; i < chunks.length; i += 1) joined += chunks[i].content.slice(opts.overlapChars);
        expect(joined).toBe(text);
    });

    it("returns [] for empty text and a single chunk for tiny text", () => {
        expect(splitDocChunks("")).toEqual([]);
        const single = splitDocChunks("hello world", opts);
        expect(single).toHaveLength(1);
        expect(single[0].content).toBe("hello world");
    });
});

describe("sanitizeDocFileName", () => {
    it("strips ../, backslashes, control chars and keeps a lowercased extension", () => {
        expect(sanitizeDocFileName("../../secret/notes.TXT")).toBe("notes.txt");
        expect(sanitizeDocFileName("a\\b\\c.md")).toBe("c.md");
        expect(sanitizeDocFileName("../evil/../ReadMe.MD")).toBe("ReadMe.md");
        expect(sanitizeDocFileName("report.md")).toBe("report.md");
        expect(sanitizeDocFileName("README.Markdown")).toBe("README.markdown");
        expect(sanitizeDocFileName("A.B.C.TXT")).toBe("A.B.C.txt");
        const withControl = `bad${String.fromCharCode(0)}name${String.fromCharCode(0x1f)}.txt`;
        expect(sanitizeDocFileName(withControl)).toBe("badname.txt");
    });

    it("falls back to doc-<sha12> for empty, all-dots, or over-long names", () => {
        const isFallback = /^doc-[0-9a-f]{12}$/;
        expect(sanitizeDocFileName("")).toMatch(isFallback);
        expect(sanitizeDocFileName("...")).toMatch(isFallback);
        expect(sanitizeDocFileName("f".repeat(300) + ".txt")).toMatch(isFallback);
        // deterministic fallback: same input → same doc- prefix
        expect(sanitizeDocFileName("x".repeat(500))).toBe(sanitizeDocFileName("x".repeat(500)));
    });
});

describe("dualReadUpload", () => {
    it("canary OFF: serves memory but still computes + records durable (2 telemetry rows)", async () => {
        enableWrite(); // not read canary
        const owner = freshOwner();
        const result = await dualReadUpload({
            scope: owner,
            query: "alpha",
            deps: { memoryReader: memoryOk, durableReader: durableOk },
        });
        expect(result.servedBy).toBe("memory");
        expect(result.canary).toBe(false);
        expect(result.note).toBeNull();
        expect(result.memory.status).toBe("ok");
        expect(result.memory.itemsCount).toBe(1);
        expect(result.durable.status).toBe("ok");
        expect(result.durable.itemsCount).toBe(1);
        expect(result.agree).toBe(true);
        expect(result.items[0].source).toBe("mem.txt"); // legacy shape served

        const rows = readLog(owner);
        expect(rows).toHaveLength(2);
        const sources = rows.map((r) => r.source).sort();
        expect(sources).toEqual(["durable", "memory"]);
        expect(rows.every((r) => r.mode === "dual-read")).toBe(true);
    });

    it("canary ON + durable hits → servedBy durable (3 telemetry rows incl canary)", async () => {
        enableWrite();
        enableRead();
        const owner = freshOwner();
        const result = await dualReadUpload({
            scope: owner,
            query: "beta",
            deps: { memoryReader: memoryOk, durableReader: durableOk },
        });
        expect(result.servedBy).toBe("durable");
        expect(result.canary).toBe(true);
        expect(result.note).toBeNull();
        expect(result.items[0].source).toBe("doc.txt");
        expect(result.text).toContain("beta");

        const rows = readLog(owner);
        expect(rows).toHaveLength(3);
        const canaryRow = rows.find((r) => r.mode === "canary");
        expect(canaryRow).toBeTruthy();
        expect(canaryRow.source).toBe("durable");
        expect(canaryRow.status).toBe("hit");
    });

    it("canary ON + durable no_match → serves durable no_match instead of unrelated memory hits", async () => {
        enableWrite();
        enableRead();
        const owner = freshOwner();
        const result = await dualReadUpload({
            scope: owner,
            query: "gamma",
            deps: { memoryReader: memoryOk, durableReader: durableNoMatch },
        });
        expect(result.servedBy).toBe("durable");
        expect(result.canary).toBe(true);
        expect(result.note).toBeNull();
        expect(result.items).toEqual([]);
        expect(result.durable.status).toBe("no_match");
        expect(result.durable.itemsCount).toBe(0);
        expect(result.agree).toBe(false); // memory hit vs durable miss

        const rows = readLog(owner);
        expect(rows).toHaveLength(3);
        const durableDual = rows.find((r) => r.mode === "dual-read" && r.source === "durable");
        expect(durableDual.status).toBe("no_match");
        const canaryRow = rows.find((r) => r.mode === "canary");
        expect(canaryRow.source).toBe("durable");
        expect(canaryRow.status).toBe("no_match");
    });

    it("canary ON + durable store empty (reader yields null) → serves durable empty state", async () => {
        enableWrite();
        enableRead();
        const owner = freshOwner();
        // A durable reader that reports no content → normalized to empty_store.
        const result = await dualReadUpload({
            scope: owner,
            query: "delta",
            deps: { memoryReader: memoryOk, durableReader: async () => null },
        });
        expect(result.servedBy).toBe("durable");
        expect(result.canary).toBe(true);
        expect(result.note).toBeNull();
        expect(result.durable.status).toBe("empty_store");
        expect(result.durable.itemsCount).toBe(0);
        expect(result.items).toEqual([]);

        const rows = readLog(owner);
        expect(rows).toHaveLength(3);
        const durableDual = rows.find((r) => r.mode === "dual-read" && r.source === "durable");
        expect(durableDual.status).toBe("no_match");
    });

    it("memoryReader absence (no legacy faiss) + durable empty → durable empty state is served", async () => {
        enableWrite();
        enableRead();
        const owner = freshOwner();
        // No memoryReader injected → the default lazy rag/index reader returns
        // { status: 'empty' } for a user that never indexed anything (handled,
        // never thrown). Durable side injected as empty to keep this test
        // independent of the (now-landed) retrieval.js self-recording telemetry.
        const result = await dualReadUpload({
            scope: owner,
            query: "epsilon",
            deps: { durableReader: async () => null },
        });
        expect(result.servedBy).toBe("durable");
        expect(result.note).toBeNull();
        expect(result.memory.status).toBe("no_match"); // empty store normalized
        expect(result.memory.emptyStore).toBe(true);
        expect(result.memory.itemsCount).toBe(0);
        expect(result.durable.status).toBe("empty_store");
        expect(result.items).toEqual([]);

        const rows = readLog(owner);
        expect(rows).toHaveLength(3);
        expect(rows.every((r) => r.status === "no_match")).toBe(true);
    });

    it("real retrieval.js default reader serves durable hits off the pseudo-project (integration)", async () => {
        enableWrite();
        enableRead();
        const owner = freshOwner();
        const text = "durable paragraphs ".repeat(40)
            + "retrievable token durable searchable "
            + "shared knowledge durable again ".repeat(30);
        await maybeDualWriteUpload({ scope: owner, text, fileName: "real.txt", embedder: makeEmbedder() });

        // No durableReader injected → default lazy retrieval.retrieveProjectCode
        // over UPLOAD_DOC_PROJECT (lexical-only: no embedder/vectorStore passed).
        const result = await dualReadUpload({
            scope: owner,
            query: "durable",
            deps: { memoryReader: memoryNoMatch },
        });
        expect(result.servedBy).toBe("durable");
        expect(result.canary).toBe(true);
        expect(result.note).toBeNull();
        expect(result.durable.status).toBe("ok");
        expect(result.durable.itemsCount).toBeGreaterThan(0);
        expect(result.items.length).toBeGreaterThan(0);
        expect(result.text).toContain("[1]");

        // Rows: retrieval self-recorded a fused read (mode lexical) + durableSync
        // dual-read memory + dual-read durable + canary served choice.
        const rows = readLog(owner);
        expect(rows.length).toBe(4);
        expect(rows.filter((r) => r.mode === "canary" && r.source === "durable" && r.status === "hit")).toHaveLength(1);
        expect(rows.filter((r) => r.source === "lexical")).toHaveLength(1);
    });

    it("telemetry summary counts hit/no_match per status", async () => {
        enableWrite();
        const owner = freshOwner();
        const result = await dualReadUpload({
            scope: owner,
            query: "zeta",
            deps: { memoryReader: memoryNoMatch, durableReader: durableOk },
        });
        expect(result.servedBy).toBe("memory"); // canary off
        const summary = getKnowledgeQuerySummary(owner);
        expect(summary.total).toBe(2);
        expect(summary.hit).toBe(1); // durable
        expect(summary.noMatch).toBe(1); // memory
        expect(summary.error).toBe(0);
    });
});

describe("cross-owner isolation", () => {
    it("BOB's dual-write/dual-read never sees ALICE rows or telemetry", async () => {
        enableWrite();
        const alice = freshOwner();
        const bob = freshOwner();
        const embedder = makeEmbedder();

        const aliceText = docText(2, 20);
        const bobChanged = docText(2, 20) + "\n\nbob edit";

        const a1 = await maybeDualWriteUpload({ scope: alice, text: aliceText, fileName: "notes.txt", embedder });
        expect(a1.reason).toBe("indexed");

        const b1 = await maybeDualWriteUpload({ scope: bob, text: aliceText, fileName: "notes.txt", embedder });
        expect(b1.reason).toBe("indexed"); // BOB has his own (empty) scope, not ALICE's

        expect(store.countDocuments(alice, UPLOAD_DOC_PROJECT)).toBe(1);
        expect(store.countDocuments(bob, UPLOAD_DOC_PROJECT)).toBe(1);

        // BOB updates his copy → BOB's previous goes stale; ALICE untouched.
        const b2 = await maybeDualWriteUpload({ scope: bob, text: bobChanged, fileName: "notes.txt", embedder });
        expect(b2.reason).toBe("updated");
        expect(store.getActiveDocumentByPath(bob, UPLOAD_DOC_PROJECT, "notes.txt").file_hash)
            .toBe(store.sha256Hex(bobChanged));
        expect(store.getActiveDocumentByPath(alice, UPLOAD_DOC_PROJECT, "notes.txt").file_hash)
            .toBe(store.sha256Hex(aliceText));
        expect(store.countDocuments(alice, UPLOAD_DOC_PROJECT)).toBe(1);

        // BOB reads (canary on, durable no content) → only BOB telemetry recorded
        // (durableReader injected so retrieval.js self-recording rows are not added).
        enableRead();
        await dualReadUpload({
            scope: bob,
            query: "private",
            deps: { memoryReader: memoryNoMatch, durableReader: durableNoMatch },
        });
        expect(getKnowledgeQuerySummary(bob).total).toBe(3);
        expect(getKnowledgeQuerySummary(alice).total).toBe(0); // ALICE unaffected
    });
});

describe("rebuildUploadProject", () => {
    it("requires an embedder and reports total without side effects", async () => {
        const owner = freshOwner();
        enableWrite();
        await maybeDualWriteUpload({ scope: owner, text: docText(2, 30), fileName: "rebuild-me.txt" }); // no embedder
        const result = await rebuildUploadProject({ scope: owner });
        expect(result.requiresEmbedder).toBe(true);
        expect(result.total).toBeGreaterThan(0);
        expect(result.embedded).toBe(0);
    });

    it("re-embeds previously null-embedding active chunks and persists vectors", async () => {
        const owner = freshOwner();
        enableWrite();
        // Written offline (no embedder) → all chunk embeddings null.
        const written = await maybeDualWriteUpload({
            scope: owner, text: docText(3, 40), fileName: "rebuild-embed.txt",
        });
        expect(written.chunkCount).toBeGreaterThan(1);
        expect(store.getEmbeddedActiveChunks(owner, UPLOAD_DOC_PROJECT)).toHaveLength(0);

        const result = await rebuildUploadProject({ scope: owner, embedder: makeEmbedder() });
        expect(result.requiresEmbedder).toBe(false);
        expect(result.embedded).toBe(written.chunkCount);
        expect(result.total).toBe(written.chunkCount);
        expect(result.embeddingErrors).toBe(0);
        expect(store.getEmbeddedActiveChunks(owner, UPLOAD_DOC_PROJECT)).toHaveLength(written.chunkCount);
    });
});

describe("CLI scripts/rebuild-durable-rag.mjs", () => {
    const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const script = path.join(backendRoot, "scripts", "rebuild-durable-rag.mjs");

    it("passes node --check", () => {
        expect(() => execFileSync(process.execPath, ["--check", script], { cwd: backendRoot })).not.toThrow();
    });

    it("no-args prints help/no-op and exits 0 (no DB side effects)", () => {
        const env = { ...process.env, OWNER_USER_ID: "", PROJECT_ID: "", TENANT_ID: "" };
        const out = execFileSync(process.execPath, [script], { cwd: backendRoot, env, encoding: "utf8" });
        expect(out).toContain("rebuild-durable-rag.mjs");
        expect(out).toContain("Requires env vars");
    });
});
