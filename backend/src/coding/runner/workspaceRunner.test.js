/**
 * Phase 7 / R1 — WorkspaceReadRunner + path-security matrix tests.
 *
 * These are *pure* runner tests: no HTTP, no DB. They exercise the runner
 * boundary with real git fixtures under a real temp allowed root, verifying the
 * R1 checklist:
 *   - runner protocol skeleton (structured op/args; only reads dispatch; writes 400);
 *   - list_tree / read_file / search_text + git.status/diff/show_file;
 *   - path security: traversal, absolute, drive/device/UNC, symlink/junction
 *     escape, out-of-bounds root, stale trust (deleted / re-pointed root),
 *     untrusted/terminal projects, limits/budgets.
 * Cross-user + flags gates are covered in the HTTP contract file.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import defaultWorkspaceRunner from "./readRunner.js";
import { clearAllowedRootsOverride, setAllowedRootsOverride } from "./pathSecurity.js";

const runner = defaultWorkspaceRunner;
let base;      // allowed root
let rootPath;  // temp parent holding git fixtures (also allowed root)
const cleanup = [];

function tmpDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanup.push(dir);
    return dir;
}

function git(cwd, args) {
    return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
}

function gitCommitAll(cwd, message) {
    git(cwd, ["add", "-A"]);
    git(cwd, [
        "-c", "user.name=Test Runner",
        "-c", "user.email=runner@test.local",
        "commit", "-q", "-m", message,
    ]);
}

function writeFile(rel, content) {
    const target = path.join(base, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

/** Multi-line source used by read/line tests. */
const APP_JS = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i}; // TODO line ${i + 1}`).join("\n");

function mkProject(over = {}) {
    return {
        id: "proj_unit_test",
        name: "unit",
        owner_user_id: 1,
        tenant_id: "user:1",
        status: "trusted",
        trusted: true,
        rootPath: path.join(base, "cleanRepo"),
        ...over,
    };
}

async function expectCodingError(promise, code, status) {
    try {
        await promise;
    } catch (error) {
        expect(error.code).toBe(code);
        expect(error.statusCode).toBe(status);
        return;
    }
    throw new Error(`expected coding error ${code} (${status}) but op succeeded`);
}

/** Best-effort link creation; skip test silently when OS refuses (no symlink privilege). */
function tryLink(target, link) {
    try {
        fs.mkdirSync(path.dirname(link), { recursive: true });
        if (process.platform === "win32") {
            fs.symlinkSync(target, link, "junction");
        } else {
            fs.symlinkSync(target, link, "dir");
        }
        return true;
    } catch {
        return false;
    }
}

beforeAll(() => {
    rootPath = tmpDir("agentevo-ws-root-");
    base = tmpDir("agentevo-ws-");
    setAllowedRootsOverride([base]);

    // ── cleanRepo: a committed repo that is NEVER mutated by tests ──
    const clean = path.join(base, "cleanRepo");
    fs.mkdirSync(path.join(clean, "src"), { recursive: true });
    fs.mkdirSync(path.join(clean, "docs"), { recursive: true });
    fs.mkdirSync(path.join(clean, "data"), { recursive: true });
    fs.mkdirSync(path.join(clean, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(clean, "deep", "a", "b", "c"), { recursive: true });
    fs.writeFileSync(path.join(clean, "README.md"), "# Demo\n\nthe needle lives here\n");
    fs.writeFileSync(path.join(clean, "src", "app.js"), APP_JS);
    fs.writeFileSync(path.join(clean, "docs", "guide.md"), "Ref: agentevo-needle-42 in guide\n");
    fs.writeFileSync(path.join(clean, "node_modules", "pkg", "x.js"), "// hidden needle in node_modules\n");
    fs.writeFileSync(path.join(clean, "deep", "a", "b", "c", "deep.txt"), "a deep needle at the bottom\n");
    fs.writeFileSync(path.join(clean, "data", "binary.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x41]));
    fs.writeFileSync(path.join(clean, "data", "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    git(clean, ["init", "-q"]);
    gitCommitAll(clean, "seed");

    // ── mutRepo: dedicated to the mutation / diff / show tests ──
    const mut = path.join(base, "mutRepo");
    fs.mkdirSync(mut, { recursive: true });
    fs.writeFileSync(path.join(mut, "file.txt"), "v1 original\n");
    git(mut, ["init", "-q"]);
    gitCommitAll(mut, "seed v1");

    // ── plainDir: NOT a git repo (file ops must still work) ──
    fs.mkdirSync(path.join(base, "plainDir", "nested"), { recursive: true });
    fs.writeFileSync(path.join(base, "plainDir", "top.txt"), "plain top\n");
    fs.writeFileSync(path.join(base, "plainDir", "nested", "inner.txt"), "plain inner\n");

    // ── nestedRoot: not a repo itself but CONTAINS one (git toplevel != root) ──
    fs.mkdirSync(path.join(base, "nestedRoot", "inner", "src"), { recursive: true });
    fs.writeFileSync(path.join(base, "nestedRoot", "inner", "src", "f.js"), "export const inside = 1;\n");
    git(path.join(base, "nestedRoot", "inner"), ["init", "-q"]);
    gitCommitAll(path.join(base, "nestedRoot", "inner"), "inner repo");

    // ── escRoot + secretBase: junction/symlink escape target outside the project root ──
    fs.mkdirSync(path.join(base, "escRoot"), { recursive: true });
    fs.writeFileSync(path.join(base, "escRoot", "ok.txt"), "ok content\n");
    fs.mkdirSync(path.join(base, "secretBase"), { recursive: true });
    fs.writeFileSync(path.join(base, "secretBase", "leak.txt"), "top secret\n");

    // ── out-of-bounds root lives OUTSIDE the allowed root ──
    const oob = tmpDir("agentevo-ws-oob-");
    fs.writeFileSync(path.join(oob, "outside.txt"), "outside\n");
    global.__oobRoot = oob;
});

afterAll(() => {
    clearAllowedRootsOverride();
    for (const dir of cleanup) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

describe("runner protocol skeleton", () => {
    it("rejects an unknown op with INVALID_WORKSPACE_OP before touching disk", async () => {
        await expectCodingError(
            runner.invoke(mkProject(), "rm -rf", { path: "" }),
            "INVALID_WORKSPACE_OP", 400,
        );
    });

    it("rejects an R2 write/exec op on the R1 read-only transport", async () => {
        await expectCodingError(
            runner.invoke(mkProject(), "file.write", { path: "x", content: "y" }),
            "INVALID_WORKSPACE_OP", 400,
        );
        await expectCodingError(
            runner.invoke(mkProject(), "command.run", { command: "whoami" }),
            "INVALID_WORKSPACE_OP", 400,
        );
    });

    it("validates args before path resolution", async () => {
        await expectCodingError(
            runner.invoke(mkProject(), "read_file", { path: "README.md", max_lines: "not-a-number" }),
            "INVALID_WORKSPACE_ARGS", 400,
        );
        await expectCodingError(
            runner.invoke(mkProject(), "read_file", { path: "x".repeat(600) }),
            "INVALID_WORKSPACE_ARGS", 400,
        );
        await expectCodingError(
            runner.invoke(mkProject(), "search_text", { path: "", query: "" }),
            "INVALID_WORKSPACE_ARGS", 400,
        );
        await expectCodingError(
            runner.invoke(mkProject(), "search_text", { path: "", query: "q".repeat(201) }),
            "INVALID_WORKSPACE_ARGS", 400,
        );
    });
});

describe("list_tree", () => {
    const proj = () => mkProject({ rootPath: path.join(base, "cleanRepo") });

    it("returns a typed, dirs-first tree and skips .git / node_modules", async () => {
        const result = await runner.invoke(proj(), "list_tree", { path: "", depth: 6 });
        expect(result.ok).toBe(true);
        const rels = result.data.entries.map((e) => e.rel);
        // dirs-first: README/docs order — README is a file, src/docs/data/deep are dirs.
        const types = new Map(result.data.entries.map((e) => [e.rel, e.type]));
        expect(types.get("README.md")).toBe("file");
        expect(types.get("docs")).toBe("dir");
        expect(types.get("src")).toBe("dir");
        expect(types.get("data")).toBe("dir");
        expect(rels).not.toContain(".git");
        expect(rels).not.toContain("node_modules");
        expect(rels).not.toContain("node_modules/pkg/x.js");
        // files carry a size; dirs carry none
        const readme = result.data.entries.find((e) => e.rel === "README.md");
        expect(readme.size).toBeTypeOf("number");
        const docs = result.data.entries.find((e) => e.rel === "docs");
        expect(docs.size).toBeUndefined();
        // entries are project-root-relative (deep -> a -> b -> c files)
        expect(rels).toContain("deep/a/b/c/deep.txt");
    });

    it("bounds depth and truncates with a flag rather than failing", async () => {
        const shallow = await runner.invoke(proj(), "list_tree", { path: "deep", depth: 1 });
        const deepRels = shallow.data.entries.map((e) => e.rel);
        expect(deepRels).toContain("deep/a");
        expect(deepRels).not.toContain("deep/a/b");
        expect(deepRels).not.toContain("deep/a/b/c/deep.txt");
        // a depth request beyond the max is clamped, not an error
        const clamped = await runner.invoke(proj(), "list_tree", { path: "deep", depth: 999 });
        expect(clamped.data.depth).toBeLessThanOrEqual(6);
    });

    it("rejects a file path as a list base", async () => {
        await expectCodingError(
            runner.invoke(proj(), "list_tree", { path: "README.md", depth: 1 }),
            "PATH_NOT_DIRECTORY", 400,
        );
    });

    it("404s on a missing list base", async () => {
        await expectCodingError(
            runner.invoke(proj(), "list_tree", { path: "nope", depth: 1 }),
            "WORKSPACE_PATH_NOT_FOUND", 404,
        );
    });

    it("works on a plain (non-git) directory", async () => {
        const result = await runner.invoke(mkProject({ rootPath: path.join(base, "plainDir") }), "list_tree", { path: "", depth: 3 });
        const rels = result.data.entries.map((e) => e.rel);
        expect(rels).toContain("nested/inner.txt");
        expect(rels).toContain("top.txt");
    });
});

describe("read_file", () => {
    const proj = () => mkProject({ rootPath: path.join(base, "cleanRepo") });

    it("reads a file body with line range + truncation flags", async () => {
        const full = await runner.invoke(proj(), "read_file", { path: "src/app.js", start_line: 1, max_lines: 40 });
        expect(full.data.lineCount).toBe(40);
        expect(full.data.lines[0]).toBe("const v0 = 0; // TODO line 1");
        expect(full.data.truncated).toBe(false);
        expect(full.data.endLine).toBe(40);

        const head = await runner.invoke(proj(), "read_file", { path: "src/app.js", start_line: 5, max_lines: 3 });
        expect(head.data.startLine).toBe(5);
        expect(head.data.endLine).toBe(7);
        expect(head.data.lines).toHaveLength(3);
        expect(head.data.lines[0]).toContain("line 5");
    });

    it("truncates when the requested window exceeds the file", async () => {
        const beyond = await runner.invoke(proj(), "read_file", { path: "src/app.js", start_line: 1, max_lines: 2000 });
        expect(beyond.data.lineCount).toBeLessThanOrEqual(2000);
        // reading past EOF is bounded, not an error
        const late = await runner.invoke(proj(), "read_file", { path: "src/app.js", start_line: 10_000, max_lines: 10 });
        expect(late.data.lines).toHaveLength(0);
    });

    it("rejects binary files as FILE_IS_BINARY", async () => {
        await expectCodingError(
            runner.invoke(proj(), "read_file", { path: "data/binary.dat" }),
            "FILE_IS_BINARY", 422,
        );
        await expectCodingError(
            runner.invoke(proj(), "read_file", { path: "data/image.png" }),
            "FILE_IS_BINARY", 422,
        );
    });

    it("rejects a directory as a read target", async () => {
        await expectCodingError(
            runner.invoke(proj(), "read_file", { path: "src" }),
            "PATH_NOT_FILE", 400,
        );
    });

    it("404s on a missing file", async () => {
        await expectCodingError(
            runner.invoke(proj(), "read_file", { path: "missing.txt" }),
            "WORKSPACE_PATH_NOT_FOUND", 404,
        );
    });
});

describe("search_text", () => {
    const proj = () => mkProject({ rootPath: path.join(base, "cleanRepo") });

    it("finds literal matches across files and skips .git/node_modules/binary", async () => {
        const result = await runner.invoke(proj(), "search_text", { path: "", query: "needle", regex: false });
        const paths = result.data.matches.map((m) => m.path).sort();
        expect(paths).toEqual(["README.md", "deep/a/b/c/deep.txt", "docs/guide.md"]);
        expect(result.data.filesWithMatches).toBe(3);
        expect(result.data.filesScanned).toBeGreaterThan(0);
        expect(result.data.matches.every((m) => typeof m.line === "number")).toBe(true);
        // node_modules + binary files were not scanned into results
        expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    });

    it("supports regex queries and scoped base", async () => {
        const result = await runner.invoke(proj(), "search_text", { path: "src", query: "TO\\w+O", regex: true });
        expect(result.data.matches.length).toBeGreaterThan(0);
        expect(result.data.matches[0].path).toBe("src/app.js");
        expect(result.data.matches[0].text).toContain("TODO");
    });

    it("rejects an invalid regex", async () => {
        await expectCodingError(
            runner.invoke(proj(), "search_text", { path: "", query: "(", regex: true }),
            "INVALID_WORKSPACE_ARGS", 400,
        );
    });

    it("returns an empty result set (not an error) when nothing matches", async () => {
        const result = await runner.invoke(proj(), "search_text", { path: "", query: "zzz-no-such-token-zzz" });
        expect(result.data.matches).toEqual([]);
        expect(result.data.truncated).toBe(false);
        expect(result.data.timedOut).toBe(false);
    });
});

describe("git ops", () => {
    it("open reports repo facts + read-only capabilities", async () => {
        const clean = mkProject({ rootPath: path.join(base, "cleanRepo") });
        const opened = await runner.open(clean);
        expect(opened.projectId).toBe("proj_unit_test");
        expect(opened.isRepo).toBe(true);
        expect(opened.isRepoTopLevel).toBe(true);
        expect(opened.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(opened.capabilities).toEqual({ write: false, exec: false });
        // plain dir is not a repo
        const plain = await runner.open(mkProject({ rootPath: path.join(base, "plainDir") }));
        expect(plain.isRepo).toBe(false);
        expect(plain.isRepoTopLevel).toBe(false);
    });

    it("reports clean status on an untouched repo", async () => {
        const result = await runner.invoke(mkProject({ rootPath: path.join(base, "cleanRepo") }), "git.status", {});
        expect(result.data.clean).toBe(true);
        expect(result.data.entries).toEqual([]);
        expect(result.data.branch).toBeTruthy();
    });

    it("status/diff/show track working-tree + staged + committed views", async () => {
        const mut = path.join(base, "mutRepo");
        const proj = () => mkProject({ rootPath: mut });
        const file = path.join(mut, "file.txt");

        // pristine
        let result = await runner.invoke(proj(), "git.status", {});
        expect(result.data.clean).toBe(true);

        // working-tree modification (unstaged -> porcelain " M": y column)
        fs.writeFileSync(file, "v2 changed\n");
        result = await runner.invoke(proj(), "git.status", {});
        expect(result.data.clean).toBe(false);
        expect(result.data.entries).toHaveLength(1);
        expect(result.data.entries[0].path).toBe("file.txt");
        expect(result.data.entries[0].x).toBe("");
        expect(result.data.entries[0].y).toBe("M");

        // working diff vs HEAD
        result = await runner.invoke(proj(), "git.diff", { staged: false });
        expect(result.data.filesChanged).toContain("file.txt");
        expect(result.data.diff).toContain("+v2 changed");
        expect(result.data.diff).toContain("-v1 original");

        // stage, then a staged diff
        git(mut, ["add", "file.txt"]);
        result = await runner.invoke(proj(), "git.diff", { staged: true });
        expect(result.data.staged).toBe(true);
        expect(result.data.diff).toContain("+v2 changed");

        // committed view still shows v1 at HEAD
        result = await runner.invoke(proj(), "git.show_file", { path: "file.txt", ref: "HEAD" });
        expect(result.data.content).toBe("v1 original\n");
        expect(result.data.commit).toMatch(/^[0-9a-f]{40}$/);

        // status filtered to a relPath
        result = await runner.invoke(proj(), "git.status", { path: "file.txt" });
        expect(result.data.entries.length).toBeGreaterThan(0);

        // git.show_file must reject traversal refs
        await expectCodingError(
            runner.invoke(proj(), "git.show_file", { path: "file.txt", ref: "HEAD~1" }),
            "INVALID_GIT_REF", 400,
        );
    });

    it("git ops refuse a non-git project root (NOT_GIT_REPO)", async () => {
        await expectCodingError(
            runner.invoke(mkProject({ rootPath: path.join(base, "plainDir") }), "git.status", {}),
            "NOT_GIT_REPO", 422,
        );
        await expectCodingError(
            runner.invoke(mkProject({ rootPath: path.join(base, "plainDir") }), "git.diff", {}),
            "NOT_GIT_REPO", 422,
        );
        await expectCodingError(
            runner.invoke(mkProject({ rootPath: path.join(base, "plainDir") }), "git.show_file", { path: "top.txt" }),
            "NOT_GIT_REPO", 422,
        );
    });

    it("git ops refuse a project root that is not the repo top-level, while file ops still work", async () => {
        const nested = path.join(base, "nestedRoot");
        await expectCodingError(
            runner.invoke(mkProject({ rootPath: nested }), "git.status", {}),
            "NOT_GIT_REPO", 422,
        );
        // file ops are unaffected by the git-top-level rule (and .git is skipped)
        const listed = await runner.invoke(mkProject({ rootPath: nested }), "list_tree", { path: "", depth: 4 });
        const rels = listed.data.entries.map((e) => e.rel);
        expect(rels).toContain("inner/src/f.js");
        expect(rels).not.toContain("inner/.git");
    });
});

describe("path security matrix", () => {
    const proj = () => mkProject({ rootPath: path.join(base, "cleanRepo") });

    it("rejects traversal segments", async () => {
        await expectCodingError(runner.invoke(proj(), "read_file", { path: "../secret.txt" }), "PATH_TRAVERSAL", 403);
        await expectCodingError(runner.invoke(proj(), "read_file", { path: "docs/../../README.md" }), "PATH_TRAVERSAL", 403);
        await expectCodingError(runner.invoke(proj(), "list_tree", { path: ".." }), "PATH_TRAVERSAL", 403);
    });

    it("rejects absolute, drive, device and UNC forms", async () => {
        await expectCodingError(runner.invoke(proj(), "read_file", { path: "/etc/hosts" }), "ABSOLUTE_PATH_NOT_ALLOWED", 403);
        await expectCodingError(runner.invoke(proj(), "read_file", { path: "C:/Windows/win.ini" }), "DEVICE_PATH_NOT_ALLOWED", 403);
        await expectCodingError(runner.invoke(proj(), "read_file", { path: "\\\\server\\share\\x" }), "UNC_PATH_NOT_ALLOWED", 403);
        await expectCodingError(runner.invoke(proj(), "read_file", { path: "\\\\?\\C:\\Windows\\x" }), "DEVICE_PATH_NOT_ALLOWED", 403);
        await expectCodingError(runner.invoke(proj(), "read_file", { path: "\\\\.\\C:\\x" }), "DEVICE_PATH_NOT_ALLOWED", 403);
    });

    it("rejects control characters and NUL inside a path", async () => {
        await expectCodingError(runner.invoke(proj(), "read_file", { path: "a\tb.txt" }), "INVALID_WORKSPACE_ARGS", 400);
        await expectCodingError(runner.invoke(proj(), "read_file", { path: "nul\u0000name.txt" }), "INVALID_WORKSPACE_ARGS", 400);
    });

    it("prevents symlink/junction escape outside the project root", async () => {
        // escRoot is its own project root; the junction points OUTSIDE escRoot into
        // base/secretBase — canonical realpath + containment must reject it.
        const escRoot = path.join(base, "escRoot");
        const link = path.join(escRoot, "escape-link");
        if (!tryLink(path.join(base, "secretBase"), link)) {
            console.warn("[skip] no symlink privilege; junction escape test skipped");
            return;
        }
        cleanup.push(link); // rm on the link, not its target
        const escProj = () => mkProject({ rootPath: escRoot });
        // The literal path exists and realpath resolves outside the root.
        await expectCodingError(
            runner.invoke(escProj(), "read_file", { path: "escape-link/leak.txt" }),
            "PATH_ESCAPE", 403,
        );
        // Traversal INTO the junction is rejected earlier and must never be followed.
        await expectCodingError(
            runner.invoke(escProj(), "list_tree", { path: "escape-link" }),
            "PATH_ESCAPE", 403,
        );
    });

    it("allows a symlink that stays inside the project root", async () => {
        const escRoot = path.join(base, "escRoot");
        const link = path.join(escRoot, "ok-link.txt");
        if (process.platform === "win32") {
            // Windows junction only targets directories; skip file-symlink case.
            return;
        }
        try {
            fs.symlinkSync(path.join(escRoot, "ok.txt"), link, "file");
        } catch {
            return; // no privilege
        }
        cleanup.push(link);
        const result = await runner.invoke(mkProject({ rootPath: escRoot }), "read_file", { path: "ok-link.txt" });
        expect(result.data.lines.join("\n")).toBe("ok content");
    });

    it("rejects a project root outside the allowed roots (ROOT_OUT_OF_BOUNDS)", async () => {
        await expectCodingError(
            runner.invoke(mkProject({ rootPath: global.__oobRoot }), "list_tree", { path: "" }),
            "ROOT_OUT_OF_BOUNDS", 403,
        );
    });

    it("treats a deleted project root as stale (PROJECT_ROOT_MISSING)", async () => {
        const ghost = path.join(base, "ghost-root");
        fs.mkdirSync(ghost, { recursive: true });
        fs.writeFileSync(path.join(ghost, "x.txt"), "x");
        fs.rmSync(ghost, { recursive: true, force: true });
        await expectCodingError(
            runner.invoke(mkProject({ rootPath: ghost }), "list_tree", { path: "" }),
            "PROJECT_ROOT_MISSING", 422,
        );
    });

    it("treats a re-pointed (junction) root outside the allowed root as out of bounds", async () => {
        const pointer = path.join(rootPath, "repointed-root"); // rootPath is outside `base`
        fs.mkdirSync(pointer, { recursive: true });
        fs.writeFileSync(path.join(pointer, "x.txt"), "x");
        const alias = path.join(base, "stale-alias");
        if (!tryLink(pointer, alias)) {
            console.warn("[skip] no symlink privilege; stale-trust alias test skipped");
            return;
        }
        cleanup.push(alias);
        // canonical root now lives under rootPath, which is NOT an allowed root
        await expectCodingError(
            runner.invoke(mkProject({ rootPath: alias }), "list_tree", { path: "" }),
            "ROOT_OUT_OF_BOUNDS", 403,
        );
    });

    it("requires an explicitly trusted, non-terminal project", async () => {
        await expectCodingError(
            runner.invoke(mkProject({ trusted: false, status: "registered" }), "list_tree", { path: "" }),
            "PROJECT_NOT_TRUSTED", 403,
        );
        await expectCodingError(
            runner.invoke(mkProject({ status: "revoked", trusted: false }), "list_tree", { path: "" }),
            "PROJECT_TERMINAL", 409,
        );
        await expectCodingError(
            runner.invoke(mkProject({ status: "archived", trusted: false }), "list_tree", { path: "" }),
            "PROJECT_TERMINAL", 409,
        );
    });

    it("demands at least one configured allowed root", async () => {
        clearAllowedRootsOverride();
        try {
            await expectCodingError(
                runner.invoke(mkProject(), "list_tree", { path: "" }),
                "NO_ALLOWED_ROOTS", 403,
            );
        } finally {
            setAllowedRootsOverride([base]);
        }
    });
});
