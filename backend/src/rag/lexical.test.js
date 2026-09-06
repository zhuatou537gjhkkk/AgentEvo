import { describe, expect, it } from "vitest";
import db, { initDB } from "../db/index.js";
import { insertDocumentRevision, sha256Hex } from "./knowledgeStore.js";
import { extractSymbols } from "./codeChunk.js";
import { lexicalSearch, lexicalCandidateScore } from "./lexical.js";

/**
 * Phase 7 / R4 — lexical.js lexical/path/symbol retrieval (roadmap R4 #6).
 *
 * Rows are written through the real owner/tenant/project-scoped knowledgeStore
 * so every search is automatically filtered to scope — cross-user leakage
 * (DoD: "跨用户零泄漏") is asserted explicitly.
 */

// better-sqlite3 defaults PRAGMA foreign_keys = ON → synthetic owners must be
// real users rows before knowledgeStore/telemetry accept them.
function ensureUser(id) {
    initDB();
    const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
    if (existing) return Number(existing.id);
    const info = db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)")
        .run(id, `lex_owner_${id}`, "x");
    return Number(info.lastInsertRowid);
}

let userSeq = 9000;
function freshUser() {
    userSeq += 1;
    return ensureUser(userSeq);
}

function basename(filePath) {
    const parts = String(filePath).split(/[\\/]+/);
    return parts[parts.length - 1];
}

async function seedFile({ scope, projectId, filePath, content, sourceCommit = null }) {
    const body = String(content ?? "");
    const lines = body.split("\n");
    return insertDocumentRevision({
        scope,
        projectId,
        filePath,
        fileName: basename(filePath),
        docType: "project_file",
        fileHash: sha256Hex(body),
        sizeBytes: Buffer.byteLength(body, "utf8"),
        sourceCommit,
        meta: {},
        previous: null,
        chunks: [
            {
                chunkIndex: 0,
                startLine: 1,
                endLine: lines.length,
                content: body,
                contentHash: sha256Hex(body),
                symbols: extractSymbols(body).join(" "),
                tokenCount: body.length ? Math.ceil(body.length / 4) : 0,
                embedding: null,
            },
        ],
    });
}

describe("lexicalCandidateScore (pure)", () => {
    it("empty tokens → 0", () => {
        expect(lexicalCandidateScore({ content: "anything", symbols: "", filePath: "a.js" }, [])).toBe(0);
    });

    it("path-only match ranks above a bare content match", () => {
        const pathOnly = {
            content: "function serve(){ return handle(); }",
            symbols: "serve handle",
            filePath: "src/users/service.js",
        };
        const contentOnly = {
            content: "const userSummary = tabulate(rows);",
            symbols: "usersummary tabulate rows",
            filePath: "src/misc/tab.js",
        };
        const tokens = ["users"];
        const sPath = lexicalCandidateScore(pathOnly, tokens);
        const sContent = lexicalCandidateScore(contentOnly, tokens);
        expect(sPath).toBeGreaterThan(sContent);
        expect(sPath).toBe(0.5);
        expect(sContent).toBe(1 / 6);
    });

    it("exact symbol hit adds weight over a bare substring hit", () => {
        const symbolOnly = { content: "const x = 1;", symbols: "gatekeeper auth", filePath: "src/misc/a.js" };
        const contentOnly = { content: "authorizer list", symbols: "authorizer list", filePath: "src/misc/b.js" };
        const tokens = ["auth"];
        // symbol-only = (2)/6; content substring-only = (1)/6 — symbol weight wins
        expect(lexicalCandidateScore(symbolOnly, tokens)).toBeCloseTo(1 / 3, 6);
        expect(lexicalCandidateScore(contentOnly, tokens)).toBeCloseTo(1 / 6, 6);
        expect(lexicalCandidateScore(symbolOnly, tokens)).toBeGreaterThan(lexicalCandidateScore(contentOnly, tokens));
    });

    it("content normalized by the number of query tokens", () => {
        // 2 of 4 tokens hit content → (2/4)/6
        const chunk = { content: "alpha beta", symbols: "", filePath: "a.js" };
        expect(lexicalCandidateScore(chunk, ["alpha", "beta", "gamma", "delta"])).toBeCloseTo(2 / 4 / 6, 6);
    });
});

describe("lexicalSearch (real store)", () => {
    it("CJK content matching returns ok with the matching chunk", async () => {
        const user = freshUser();
        const project = "lex-cjk";
        await seedFile({ scope: user, projectId: project, filePath: "src/notes/memo.txt", content: "持久化向量索引 在重启后可用" });

        const result = lexicalSearch({ scope: user, projectId: project, query: "索引持久化" });

        expect(result.mode).toBe("lexical");
        expect(result.status).toBe("ok");
        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({
            filePath: "src/notes/memo.txt",
            rank: 1,
            source: "lexical",
        });
        expect(result.items[0].content).toContain("持久化");
        expect(result.items[0].chunkId).not.toBeUndefined();
        expect(result.items[0].documentId).not.toBeUndefined();
        expect(result.items[0].startLine).toBe(1);
        expect(result.items[0].endLine).toBe(1);
    });

    it("path-only file ranks above content-only file", async () => {
        const user = freshUser();
        const project = "lex-path";
        await seedFile({
            scope: user,
            projectId: project,
            filePath: "src/users/service.js",
            content: "function serve(){ return handle(); }",
        });
        await seedFile({
            scope: user,
            projectId: project,
            filePath: "src/misc/tab.js",
            content: "const userSummary = tabulate(rows);",
        });

        const result = lexicalSearch({ scope: user, projectId: project, query: "users" });

        expect(result.status).toBe("ok");
        expect(result.items.length).toBeGreaterThanOrEqual(2);
        expect(result.items[0].filePath).toBe("src/users/service.js");
        expect(result.items[0].score).toBeGreaterThan(result.items[1].score);
    });

    it("healthy no-match → status no_match, never error", async () => {
        const user = freshUser();
        const project = "lex-nomatch";
        await seedFile({ scope: user, projectId: project, filePath: "a.txt", content: "the quick brown fox" });

        const none = lexicalSearch({ scope: user, projectId: project, query: "zzqxwnotpresent" });
        expect(none.status).toBe("no_match");
        expect(none.items).toEqual([]);

        const blank = lexicalSearch({ scope: user, projectId: project, query: "   " });
        expect(blank.status).toBe("no_match");
    });

    it("cross-owner search is scope-filtered (ALICE rows invisible to BOB)", async () => {
        const alice = freshUser();
        const bob = freshUser();
        const project = "lex-shared";
        await seedFile({
            scope: alice,
            projectId: project,
            filePath: "secret/private.js",
            content: 'const privateAliceSecret = "s3cr3t";',
        });

        const asAlice = lexicalSearch({ scope: alice, projectId: project, query: "privateAliceSecret" });
        expect(asAlice.status).toBe("ok");
        expect(asAlice.items[0].filePath).toBe("secret/private.js");

        const asBob = lexicalSearch({ scope: bob, projectId: project, query: "privateAliceSecret" });
        expect(asBob.status).toBe("no_match");
        expect(asBob.items).toEqual([]);
    });
});
