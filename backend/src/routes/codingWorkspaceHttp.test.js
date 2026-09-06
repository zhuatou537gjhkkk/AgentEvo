import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createApp } from "../app.js";
import { issueAuthToken } from "../auth.js";
import { createSession, createUser, initDB } from "../db/index.js";
import { clearCodingFlags } from "../coding/flags.js";

/**
 * Phase 7 / R1 — workspace runner HTTP contract (real app, real DB, native HTTP).
 *
 * Proves the enforcement boundary over the wire:
 *   - flags OFF by default -> every /coding/... workspace call is 403 (dark gate);
 *   - flags ON -> register -> trust -> open -> read ops over HTTP;
 *   - path security surfaces as HTTP codes (traversal/device/UNC/oob/stale);
 *   - unknown/write ops and malformed args are rejected on the transport;
 *   - two-user isolation: an owner can never open or op another user's project.
 *
 * Mirrors codingRegistrar.test.js fixture style; assertions key on
 * `errorCode` + status (error envelopes rewrite only the human message).
 */

const ALICE = { name: "ws_alice", username: "wsalice" };
const BOB = { name: "ws_bob", username: "wsbob" };

const servers = [];
let base = "";
let allowedBase = "";    // temp dir that is the configured allowed root
let oobDir = "";         // temp dir OUTSIDE the allowed root
let repoDir = "";        // git repo inside allowedBase
let ghostDir = "";       // dir deleted after registration (stale trust)
let aliceProjId = "";

function open(app) {
    return new Promise((resolve) => {
        const server = createServer(app);
        server.listen(0, "127.0.0.1", () => {
            servers.push(server);
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });
}

function headers(user) {
    return {
        Authorization: `Bearer ${issueAuthToken({ id: user.id, username: user.username })}`,
        "Content-Type": "application/json",
    };
}

async function request(method, reqPath, user, body) {
    const response = await fetch(`${base}${reqPath}`, {
        method,
        headers: headers(user),
        body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: response.status, body: json, text };
}

function git(cwd, args) {
    return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
}

beforeAll(async () => {
    initDB();
    ALICE.id = createUser(ALICE.name, "hash-wsa");
    BOB.id = createUser(BOB.name, "hash-wsb");
    createSession(ALICE.id, "alice ws session");
    createSession(BOB.id, "bob ws session");

    allowedBase = fs.mkdtempSync(path.join(os.tmpdir(), "agentevo-wshttp-"));
    oobDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentevo-wsoob-"));
    process.env.CODING_ALLOWED_ROOTS = allowedBase;
    process.env.CODING_WORKSPACE_ENABLED = "true";

    repoDir = path.join(allowedBase, "repo");
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# R1 repo\n");
    fs.writeFileSync(path.join(repoDir, "src", "a.js"), "export const needle = 42;\n");
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["-c", "user.name=HTTP", "-c", "user.email=http@local", "commit", "-q", "-m", "seed"]);

    ghostDir = path.join(allowedBase, "ghost");
    fs.mkdirSync(ghostDir, { recursive: true });

    base = await open(createApp());
});

afterAll(async () => {
    while (servers.length) {
        const server = servers.pop();
        await new Promise((resolve) => server.close(resolve));
    }
    delete process.env.CODING_ALLOWED_ROOTS;
    clearCodingFlags();
    for (const dir of [allowedBase, oobDir]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

describe("R1 workspace — default dark gate", () => {
    it("returns 403 CODING_FEATURE_DISABLED before any handler runs", async () => {
        delete process.env.CODING_WORKSPACE_ENABLED;
        try {
            const opened = await request("POST", `/coding/projects/proj_none/open`, ALICE, {});
            expect(opened.status).toBe(403);
            expect(opened.body.errorCode).toBe("CODING_FEATURE_DISABLED");

            const op = await request("POST", `/coding/projects/proj_none/ops`, ALICE, { op: "list_tree", args: { path: "" } });
            expect(op.status).toBe(403);
            expect(op.body.errorCode).toBe("CODING_FEATURE_DISABLED");
        } finally {
            process.env.CODING_WORKSPACE_ENABLED = "true";
        }
    });

    it("requires auth on workspace endpoints", async () => {
        const anon = await fetch(`${base}/coding/projects/proj_none/ops`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op: "list_tree", args: {} }),
        });
        expect(anon.status).toBe(401);
    });
});

describe("R1 workspace — HTTP flow over an allowed, trusted repo", () => {
    it("register -> untrusted ops blocked -> trust -> open reveals repo facts", async () => {
        const created = await request("POST", "/coding/projects", ALICE, { name: "alice repo", root_path: repoDir });
        expect(created.status).toBe(201);
        aliceProjId = created.body.project.id;
        expect(created.body.project.status).toBe("registered");
        expect(created.body.project.trusted).toBe(false);

        // untrusted project: capability refused before any path work
        const blocked = await request("POST", `/coding/projects/${aliceProjId}/ops`, ALICE, { op: "list_tree", args: { path: "" } });
        expect(blocked.status).toBe(403);
        expect(blocked.body.errorCode).toBe("PROJECT_NOT_TRUSTED");

        const trusted = await request("PATCH", `/coding/projects/${aliceProjId}`, ALICE, { trusted: true });
        expect(trusted.status).toBe(200);
        expect(trusted.body.project.status).toBe("trusted");
        expect(trusted.body.project.trusted).toBe(true);

        const opened = await request("POST", `/coding/projects/${aliceProjId}/open`, ALICE, {});
        expect(opened.status).toBe(200);
        expect(opened.body.workspace.isRepo).toBe(true);
        expect(opened.body.workspace.isRepoTopLevel).toBe(true);
        expect(opened.body.workspace.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(opened.body.workspace.capabilities).toEqual({ write: false, exec: false });
    });

    it("runs read ops over HTTP and returns structured data", async () => {
        const tree = await request("POST", `/coding/projects/${aliceProjId}/ops`, ALICE, { op: "list_tree", args: { path: "", depth: 3 } });
        expect(tree.status).toBe(200);
        const rels = tree.body.data.entries.map((e) => e.rel);
        expect(rels).toContain("src");
        expect(rels).toContain("README.md");
        expect(rels).not.toContain(".git");

        const read = await request("POST", `/coding/projects/${aliceProjId}/ops`, ALICE, { op: "read_file", args: { path: "src/a.js" } });
        expect(read.status).toBe(200);
        expect(read.body.data.lines.join("\n")).toContain("needle");

        const search = await request("POST", `/coding/projects/${aliceProjId}/ops`, ALICE, { op: "search_text", args: { path: "", query: "needle" } });
        expect(search.status).toBe(200);
        expect(search.body.data.matches.map((m) => m.path)).toContain("src/a.js");

        const status = await request("POST", `/coding/projects/${aliceProjId}/ops`, ALICE, { op: "git.status", args: {} });
        expect(status.status).toBe(200);
        expect(status.body.data.clean).toBe(true);
        expect(status.body.data.branch).toBeTruthy();
    });

    it("rejects traversal/absolute paths over HTTP with path-security codes", async () => {
        const trav = await request("POST", `/coding/projects/${aliceProjId}/ops`, ALICE, { op: "read_file", args: { path: "../x" } });
        expect(trav.status).toBe(403);
        expect(trav.body.errorCode).toBe("PATH_TRAVERSAL");

        const abs = await request("POST", `/coding/projects/${aliceProjId}/ops`, ALICE, { op: "read_file", args: { path: "/etc/hosts" } });
        expect(abs.status).toBe(403);
        expect(abs.body.errorCode).toBe("ABSOLUTE_PATH_NOT_ALLOWED");

        const dev = await request("POST", `/coding/projects/${aliceProjId}/ops`, ALICE, { op: "read_file", args: { path: "C:/Windows/win.ini" } });
        expect(dev.status).toBe(403);
        expect(dev.body.errorCode).toBe("DEVICE_PATH_NOT_ALLOWED");
    });

    it("rejects unknown + R2 write ops and malformed args on the transport", async () => {
        const write = await request("POST", `/coding/projects/${aliceProjId}/ops`, ALICE, { op: "file.write", args: { path: "x", content: "y" } });
        expect(write.status).toBe(400);
        expect(write.body.errorCode).toBe("INVALID_WORKSPACE_OP");

        const unknown = await request("POST", `/coding/projects/${aliceProjId}/ops`, ALICE, { op: "hack()", args: {} });
        expect(unknown.status).toBe(400);
        expect(unknown.body.errorCode).toBe("INVALID_WORKSPACE_OP");

        const noPath = await request("POST", `/coding/projects/${aliceProjId}/ops`, ALICE, { op: "read_file", args: {} });
        expect(noPath.status).toBe(400);
        expect(noPath.body.errorCode).toBe("INVALID_WORKSPACE_ARGS");
    });

    it("refuses roots outside the allowed roots (ROOT_OUT_OF_BOUNDS)", async () => {
        const created = await request("POST", "/coding/projects", ALICE, { name: "oob", root_path: oobDir });
        expect(created.status).toBe(201);
        await request("PATCH", `/coding/projects/${created.body.project.id}`, ALICE, { trusted: true });
        const op = await request("POST", `/coding/projects/${created.body.project.id}/ops`, ALICE, { op: "list_tree", args: { path: "" } });
        expect(op.status).toBe(403);
        expect(op.body.errorCode).toBe("ROOT_OUT_OF_BOUNDS");
    });

    it("treats a deleted root as stale over HTTP (PROJECT_ROOT_MISSING)", async () => {
        const created = await request("POST", "/coding/projects", ALICE, { name: "ghost", root_path: ghostDir });
        expect(created.status).toBe(201);
        const ghostProjId = created.body.project.id;
        await request("PATCH", `/coding/projects/${ghostProjId}`, ALICE, { trusted: true });
        fs.rmSync(ghostDir, { recursive: true, force: true });
        const op = await request("POST", `/coding/projects/${ghostProjId}/ops`, ALICE, { op: "list_tree", args: { path: "" } });
        expect(op.status).toBe(422);
        expect(op.body.errorCode).toBe("PROJECT_ROOT_MISSING");
    });

    it("isolates projects across users (cross-owner -> 404)", async () => {
        // BOB cannot open or op ALICE's trusted project
        const crossOpen = await request("POST", `/coding/projects/${aliceProjId}/open`, BOB, {});
        expect(crossOpen.status).toBe(404);
        expect(crossOpen.body.error).toBe("NOT_FOUND");

        const crossOps = await request("POST", `/coding/projects/${aliceProjId}/ops`, BOB, { op: "list_tree", args: { path: "" } });
        expect(crossOps.status).toBe(404);

        // BOB's own project works normally
        const bobRepo = path.join(allowedBase, "bob-repo");
        fs.mkdirSync(bobRepo, { recursive: true });
        fs.writeFileSync(path.join(bobRepo, "b.txt"), "bob file\n");
        const created = await request("POST", "/coding/projects", BOB, { name: "bob repo", root_path: bobRepo });
        const bobProjId = created.body.project.id;
        await request("PATCH", `/coding/projects/${bobProjId}`, BOB, { trusted: true });
        const bobRead = await request("POST", `/coding/projects/${bobProjId}/ops`, BOB, { op: "read_file", args: { path: "b.txt" } });
        expect(bobRead.status).toBe(200);
        expect(bobRead.body.data.lines.join("\n")).toBe("bob file");
    });
});
