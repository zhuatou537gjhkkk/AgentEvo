import { describe, expect, it, beforeEach, afterEach } from "vitest";
import db, { initDB } from "../db/index.js";
import { createFakeEmbedder } from "./embedder.js";
import { indexProjectSnapshot } from "./indexer.js";
import { clearDurableStoreCache, createVectorStoreAdapter } from "./vectorStoreAdapter.js";
import { hybridRetrieve, buildCitationText, retrieveProjectCode } from "./retrieval.js";
import { getKnowledgeQuerySummary, getRecentKnowledgeQueries } from "./telemetry.js";

/**
 * Phase 7 / R4 — retrieval.js hybrid retrieval + citations + shared service
 * (roadmap R4 #6/#7; DoD: no-match vs backend failure distinguished, valid
 * path/line citation, hit/no-match telemetry, cross-owner zero leak).
 *
 * Fixtures are indexed through the real indexer + fake embedder so the durable
 * vector store is loaded from the same persisted DB the way it would be after a
 * restart.
 */

// better-sqlite3 defaults PRAGMA foreign_keys = ON → synthetic owners must be
// real users rows before knowledgeStore/telemetry accept them.
function ensureUser(id) {
    initDB();
    const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
    if (existing) return Number(existing.id);
    const info = db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)")
        .run(id, `ret_owner_${id}`, "x");
    return Number(info.lastInsertRowid);
}

let userSeq = 12000;
function freshUser() {
    userSeq += 1;
    return ensureUser(userSeq);
}

const EMBEDDER = createFakeEmbedder({ dimension: 128 });
const COMMIT = "a1b2c3d4e5f67890";

async function indexFile({ scope, projectId, filePath, content, embedder = EMBEDDER, commit = COMMIT }) {
    const summary = await indexProjectSnapshot({
        scope,
        projectId,
        files: [{ path: filePath, text: content }],
        sourceRunId: "run-fixture",
        sourceCommit: commit,
        embedder,
    });
    return summary;
}

function freshAdapter(scope, projectId) {
    clearDurableStoreCache();
    return createVectorStoreAdapter({ scope, projectId });
}

beforeEach(() => {
    clearDurableStoreCache();
});

afterEach(() => {
    clearDurableStoreCache();
});

const FILE_A = "src/auth/loginUser.js";
const FILE_A_CONTENT = "export function loginUser(id) {\n  const row = db.get(id);\n  return row;\n}";
const FILE_B = "src/session/handler.js";
const FILE_B_CONTENT = "// keep the session token fresh and valid for the caller\nhandle login requests before signing the user out";

describe("hybridRetrieve", () => {
    it("fuses lexical + embedding ranks (mode hybrid, both sources present)", async () => {
        const user = freshUser();
        const project = "p-hybrid";
        await indexFile({ scope: user, projectId: project, filePath: FILE_A, content: FILE_A_CONTENT });
        await indexFile({ scope: user, projectId: project, filePath: FILE_B, content: FILE_B_CONTENT });
        const adapter = freshAdapter(user, project);

        const result = await hybridRetrieve({ scope: user, projectId: project, query: "loginUser", embedder: EMBEDDER, vectorStore: adapter });

        expect(result.status).toBe("ok");
        expect(result.mode).toBe("hybrid");
        expect(result.metrics.lexicalCount).toBeGreaterThan(0);
        expect(result.metrics.embeddingCount).toBeGreaterThan(0);
        expect(result.metrics.embeddingError).toBeNull();

        const itemA = result.items.find((i) => i.filePath === FILE_A);
        const itemB = result.items.find((i) => i.filePath === FILE_B);
        expect(itemA).toBeDefined();
        expect(itemA.sources).toEqual(expect.arrayContaining(["lexical", "embedding"]));
        expect(itemA.provenance).toEqual({ file: FILE_A, startLine: 1, endLine: 4, commit: COMMIT });
        // embedding-only item (file B is not a lexical candidate)
        expect(itemB).toBeDefined();
        expect(itemB.sources).toEqual(["embedding"]);
        // lexical+embedding winner ranks first
        expect(result.items[0].filePath).toBe(FILE_A);
        expect(result.items[0].rank).toBe(1);
        expect(result.items[0].score).toBeGreaterThanOrEqual(0);
        expect(result.items[0].score).toBeLessThanOrEqual(1);
        expect(result.metrics.groundedness).toBe(result.items[0].score);
    });

    it("embedding failure degrades to lexical without turning a hit into error", async () => {
        const user = freshUser();
        const project = "p-degrade";
        await indexFile({ scope: user, projectId: project, filePath: "src/webhook.js", content: "function handleWebhook(payload) {\n  return queue.push(payload);\n}" });
        const adapter = freshAdapter(user, project);
        const throwing = { dimension: null, async embed() { throw new Error("embedding upstream down"); } };

        const result = await hybridRetrieve({ scope: user, projectId: project, query: "handleWebhook", embedder: throwing, vectorStore: adapter });

        expect(result.status).toBe("ok");
        expect(result.mode).toBe("lexical");
        expect(result.items.length).toBeGreaterThan(0);
        expect(result.items[0].content).toContain("handleWebhook");
        expect(result.metrics.embeddingError).toBe("EMBEDDING_UNAVAILABLE");
        expect(result.metrics.lexicalCount).toBeGreaterThan(0);
    });

    it("lexical-only mode when no embedder/vector store are supplied", async () => {
        const user = freshUser();
        const project = "p-lexonly";
        await indexFile({ scope: user, projectId: project, filePath: "src/scan.js", content: "function scanFiles(root) { return walk(root); }" });

        const result = await hybridRetrieve({ scope: user, projectId: project, query: "scanFiles", embedder: null, vectorStore: null });

        expect(result.status).toBe("ok");
        expect(result.mode).toBe("lexical");
        expect(result.metrics.embeddingCount).toBe(0);
        expect(result.items[0].filePath).toBe("src/scan.js");
    });

    it("healthy no-match returns no_match (never error)", async () => {
        const user = freshUser();
        const project = "p-healthy";
        await indexFile({ scope: user, projectId: project, filePath: "src/util.js", content: "function divide(a, b) { return a / b; }" });

        const none = await hybridRetrieve({ scope: user, projectId: project, query: "zzqxwunmatched" });
        expect(none.status).toBe("no_match");
        expect(none.items).toEqual([]);
        expect(none.metrics.embeddingError).toBeNull();

        const blank = await hybridRetrieve({ scope: user, projectId: project, query: "" });
        expect(blank.status).toBe("no_match");
    });
});

describe("buildCitationText", () => {
    it("formats [n] file:start-end with short commit and content", () => {
        const item = {
            filePath: "src/auth/loginUser.js",
            startLine: 1,
            endLine: 4,
            content: "export function loginUser(id) {}",
            commit: COMMIT,
        };
        const text = buildCitationText([item]);
        const lines = text.split("\n");
        expect(lines[0]).toBe(`[1] src/auth/loginUser.js:1-4 @ a1b2c3d`);
        expect(text).toContain("export function loginUser(id) {}");
    });

    it("omits commit marker when commit is null", () => {
        const text = buildCitationText([{ filePath: "a.js", startLine: 2, endLine: 5, content: "x" }]);
        expect(text.startsWith("[1] a.js:2-5\n")).toBe(true);
        expect(text).not.toContain("@");
    });

    it("truncates long content with … and returns '' for no items", () => {
        const text = buildCitationText([{ filePath: "a.js", startLine: 1, endLine: 1, content: "y".repeat(500) }]);
        expect(text.length).toBeLessThan(400);
        expect(text).toContain("…");
        expect(buildCitationText([])).toBe("");
    });
});

describe("retrieveProjectCode (shared service + telemetry)", () => {
    it("records hit and no_match telemetry rows + summary", async () => {
        const user = freshUser();
        const project = "p-tele";
        await indexFile({ scope: user, projectId: project, filePath: "src/tele.js", content: "function getSessionToken() { return tokenStore.get(); }" });

        const hit = await retrieveProjectCode({ scope: user, projectId: project, query: "getSessionToken", deps: {} });
        expect(hit.status).toBe("ok");
        expect(hit.mode).toBe("lexical");
        expect(hit.text).toContain("[1] src/tele.js:1-1");
        expect(hit.errorCode).toBeNull();

        const miss = await retrieveProjectCode({ scope: user, projectId: project, query: "notPresentZZ", deps: {} });
        expect(miss.status).toBe("no_match");
        expect(miss.text).toBe("");

        const summary = getKnowledgeQuerySummary(user);
        expect(summary.total).toBeGreaterThanOrEqual(2);
        expect(summary.hit).toBeGreaterThanOrEqual(1);
        expect(summary.noMatch).toBeGreaterThanOrEqual(1);
        expect(summary.error).toBe(0);

        const recent = getRecentKnowledgeQueries(user, { limit: 10 });
        const hitRow = recent.find((r) => r.status === "hit");
        expect(hitRow).toBeDefined();
        expect(hitRow.mode).toBe("lexical");
        expect(hitRow.query_preview).toContain("getSessionToken");
    });

    it("cross-owner query returns empty and records under the querying owner", async () => {
        const alice = freshUser();
        const bob = freshUser();
        const project = "p-owned";
        await indexFile({ scope: alice, projectId: project, filePath: "src/owner.js", content: "function ownerOnlySecret() { return 42; }" });

        const asAlice = await retrieveProjectCode({ scope: alice, projectId: project, query: "ownerOnlySecret", deps: {} });
        expect(asAlice.status).toBe("ok");

        const asBob = await retrieveProjectCode({ scope: bob, projectId: project, query: "ownerOnlySecret", deps: {} });
        expect(asBob.status).toBe("no_match");
        expect(asBob.items).toEqual([]);
        expect(asBob.text).toBe("");

        const bobSummary = getKnowledgeQuerySummary(bob);
        expect(bobSummary.hit).toBe(0);
        expect(bobSummary.noMatch).toBeGreaterThanOrEqual(1);
        expect(bobSummary.error).toBe(0);
    });
});
