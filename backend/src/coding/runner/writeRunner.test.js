/**
 * Phase 7 / R2 — WorkspaceWriteRunner unit tests.
 *
 * Pure runner tests: no HTTP, no DB. `defaultWriteRunner.invoke(root, request)`
 * runs against a scratch temp root (non-git is fine for file ops — the write
 * runner needs no git). Every request is validated through `prepareRunOpRequest`
 * first (the same seam the HTTP route uses) so arg-level guards (payload cap,
 * NUL content) are asserted at their real enforcement point; the runner-level
 * guards (reserved `.git`, traversal, absolute path, binary/large targets,
 * digest staleness, strict patch apply) are asserted through `invoke`.
 *
 * Coverage (R2 DoD):
 *   - create_file new + nested dirs + already-exists 409
 *   - write_file overwrite (digests before/after differ) + missing 404
 *   - delete_file + missing 404
 *   - apply_patch happy path (deterministic bug fix) + strictness 422
 *   - digest stale 409 / RESERVED_PATH 403 / traversal 403 / absolute 403
 *   - binary target 422 / >512KiB content 413 / >4MiB target 413
 *   - root itself 400 / symlink-junction parent escape 403 (skip w/o privilege)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { defaultWriteRunner, sha256Hex } from "./writeRunner.js";
import { prepareRunOpRequest, WORKSPACE_LIMITS } from "./protocol.js";

const writeRunner = defaultWriteRunner;
const cleanup = [];

function tmpDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanup.push(dir);
    return dir;
}

function sha256Buf(buf) {
    return createHash("sha256").update(buf).digest("hex");
}

/** Protocol-validated write op, then invoke — the exact production seam. */
async function write(op, rawArgs) {
    return writeRunner.invoke(writeRoot, prepareRunOpRequest(op, rawArgs));
}

/** Drive the runner directly (bypass protocol validation) for runner-level guards. */
async function rawWrite(op, rawArgs) {
    return writeRunner.invoke(writeRoot, { op, args: rawArgs });
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

/** Best-effort junction/dir-symlink creation; skip test silently when OS refuses. */
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

let writeRoot;
let outsideDir; // sibling of writeRoot used as a junction-escape target

beforeAll(() => {
    writeRoot = tmpDir("agentevo-wrunner-");
    outsideDir = tmpDir("agentevo-wrunner-out-");
    fs.writeFileSync(path.join(outsideDir, "leak.txt"), "secret outside\n");
});

afterAll(() => {
    for (const dir of cleanup) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

describe("create_file", () => {
    it("creates a new file under an existing (nested) directory and returns digest/size", async () => {
        // A worktree arrives with its tracked directory tree already present —
        // create_file lands a new file inside an existing ancestor chain.
        fs.mkdirSync(path.join(writeRoot, "src", "lib"), { recursive: true });
        const result = await write("create_file", { path: "src/lib/new.txt", content: "hello world\n" });
        expect(result.op).toBe("create_file");
        expect(result.path).toBe("src/lib/new.txt");
        expect(result.existed).toBe(false);
        expect(result.kind).toBe("file.create");
        expect(result.beforeDigest).toBeNull();
        expect(result.afterDigest).toBe(sha256Hex("hello world\n"));
        expect(result.sizeBytes).toBe(Buffer.byteLength("hello world\n", "utf8"));

        const abs = path.join(writeRoot, "src", "lib", "new.txt");
        expect(fs.readFileSync(abs, "utf8")).toBe("hello world\n");
        // ancestors were not clobbered
        expect(fs.statSync(path.join(writeRoot, "src", "lib")).isDirectory()).toBe(true);
    });

    it("404s when the immediate parent directory does not exist (no silent auto-mkdir)", async () => {
        await expectCodingError(
            write("create_file", { path: "absent-dir/new.txt", content: "x" }),
            "WORKSPACE_PATH_NOT_FOUND", 404,
        );
    });

    it("409s when the target already exists (create_file is create-only)", async () => {
        fs.writeFileSync(path.join(writeRoot, "exists.txt"), "old\n");
        await expectCodingError(
            write("create_file", { path: "exists.txt", content: "new" }),
            "WORKSPACE_PATH_ALREADY_EXISTS", 409,
        );
        expect(fs.readFileSync(path.join(writeRoot, "exists.txt"), "utf8")).toBe("old\n");
    });
});

describe("write_file", () => {
    it("overwrites an existing file and records distinct before/after digests", async () => {
        fs.writeFileSync(path.join(writeRoot, "over.txt"), "before content\n");
        const result = await write("write_file", { path: "over.txt", content: "after content\n" });
        expect(result.op).toBe("write_file");
        expect(result.path).toBe("over.txt");
        expect(result.existed).toBe(true);
        expect(result.kind).toBe("file.write");
        expect(result.beforeDigest).toBe(sha256Hex("before content\n"));
        expect(result.afterDigest).toBe(sha256Hex("after content\n"));
        expect(result.beforeDigest).not.toBe(result.afterDigest);
        expect(fs.readFileSync(path.join(writeRoot, "over.txt"), "utf8")).toBe("after content\n");
    });

    it("404s when the write target does not exist (write_file is update-only)", async () => {
        await expectCodingError(
            write("write_file", { path: "nope.txt", content: "x" }),
            "WORKSPACE_PATH_NOT_FOUND", 404,
        );
    });
});

describe("delete_file", () => {
    it("removes a file and reports its prior digest", async () => {
        fs.writeFileSync(path.join(writeRoot, "gone.txt"), "bye\n");
        const result = await write("delete_file", { path: "gone.txt" });
        expect(result.op).toBe("delete_file");
        expect(result.kind).toBe("file.delete");
        expect(result.existed).toBe(true);
        expect(result.beforeDigest).toBe(sha256Hex("bye\n"));
        expect(result.afterDigest).toBeNull();
        expect(fs.existsSync(path.join(writeRoot, "gone.txt"))).toBe(false);
    });

    it("404s when the delete target is missing", async () => {
        await expectCodingError(
            write("delete_file", { path: "missing.txt" }),
            "WORKSPACE_PATH_NOT_FOUND", 404,
        );
    });
});

describe("apply_patch (strict, deterministic)", () => {
    it("applies a deterministic bug fix and updates the file content + digest", async () => {
        const seed = "function add(a, b) {\n  return a - b;\n}\n";
        fs.writeFileSync(path.join(writeRoot, "math.js"), seed);

        const patch = [
            "--- a/math.js",
            "+++ b/math.js",
            "@@ -1,3 +1,3 @@",
            " function add(a, b) {",
            "-  return a - b;",
            "+  return a + b;",
            " }",
        ].join("\n");

        const result = await write("apply_patch", { path: "math.js", patch });
        expect(result.op).toBe("apply_patch");
        expect(result.path).toBe("math.js");
        expect(result.existed).toBe(true);
        expect(result.kind).toBe("file.patch");
        expect(result.hunksApplied).toBe(1);
        expect(result.beforeDigest).toBe(sha256Hex(seed));

        const expected = "function add(a, b) {\n  return a + b;\n}\n";
        expect(fs.readFileSync(path.join(writeRoot, "math.js"), "utf8")).toBe(expected);
        expect(result.afterDigest).toBe(sha256Hex(expected));
    });

    it("refuses a patch whose context does not match (422) and leaves the file untouched", async () => {
        fs.writeFileSync(path.join(writeRoot, "strict.txt"), "alpha\nbeta\ngamma\n");
        const before = fs.readFileSync(path.join(writeRoot, "strict.txt"), "utf8");
        const patch = [
            "--- a/strict.txt",
            "+++ b/strict.txt",
            "@@ -1,3 +1,3 @@",
            " alpha",
            "-BOGUS",
            "+BOGUS-CHANGED",
            " gamma",
        ].join("\n");

        await expectCodingError(
            write("apply_patch", { path: "strict.txt", patch }),
            "PATCH_APPLY_FAILED", 422,
        );
        // no fuzzy/partial application: the file is byte-identical
        expect(fs.readFileSync(path.join(writeRoot, "strict.txt"), "utf8")).toBe(before);
    });

    it("rejects a stale digest with 409 WORKSPACE_STALE before touching the file", async () => {
        const seed = "keep me\n";
        fs.writeFileSync(path.join(writeRoot, "stale.txt"), seed);
        const preparedDigest = sha256Hex(seed);
        // someone changed the file after the digest was prepared
        fs.writeFileSync(path.join(writeRoot, "stale.txt"), "changed meanwhile\n");

        const patch = [
            "--- a/stale.txt",
            "+++ b/stale.txt",
            "@@ -1 +1 @@",
            "-keep me",
            "+keep you",
        ].join("\n");
        await expectCodingError(
            write("apply_patch", { path: "stale.txt", patch, digest: preparedDigest }),
            "WORKSPACE_STALE", 409,
        );
        expect(fs.readFileSync(path.join(writeRoot, "stale.txt"), "utf8")).toBe("changed meanwhile\n");
    });
});

describe("write-path security guards", () => {
    it("refuses a reserved .git path with 403 RESERVED_PATH", async () => {
        await expectCodingError(
            write("create_file", { path: ".git/config", content: "[core]\n" }),
            "RESERVED_PATH", 403,
        );
        await expectCodingError(
            write("write_file", { path: "dir/.git/hooks/pre-commit", content: "x" }),
            "RESERVED_PATH", 403,
        );
        expect(fs.existsSync(path.join(writeRoot, ".git"))).toBe(false);
    });

    it("refuses traversal and absolute paths with 403 before any write", async () => {
        await expectCodingError(
            write("create_file", { path: "../x.txt", content: "x" }),
            "PATH_TRAVERSAL", 403,
        );
        await expectCodingError(
            write("write_file", { path: "sub/../../y.txt", content: "x" }),
            "PATH_TRAVERSAL", 403,
        );
        await expectCodingError(
            rawWrite("create_file", { path: "/etc/pwned", content: "x" }),
            "ABSOLUTE_PATH_NOT_ALLOWED", 403,
        );
        // nothing leaked outside the root
        expect(fs.existsSync(path.join(path.dirname(writeRoot), "x.txt"))).toBe(false);
    });

    it("refuses to mutate the root itself (400 INVALID_WORKSPACE_ARGS)", async () => {
        await expectCodingError(
            rawWrite("create_file", { path: "", content: "x" }),
            "INVALID_WORKSPACE_ARGS", 400,
        );
        await expectCodingError(
            write("delete_file", { path: "" }),
            "INVALID_WORKSPACE_ARGS", 400,
        );
    });

    it("refuses to overwrite an existing binary target (422 FILE_IS_BINARY)", async () => {
        // PNG-ish magic + NUL byte
        fs.writeFileSync(path.join(writeRoot, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a]));
        await expectCodingError(
            write("write_file", { path: "image.png", content: "text now" }),
            "FILE_IS_BINARY", 422,
        );
        // untouched on disk
        const head = fs.readFileSync(path.join(writeRoot, "image.png"));
        expect(head.includes(0)).toBe(true);
    });

    it("rejects a write target larger than the 4MiB cap (413 FILE_TOO_LARGE)", async () => {
        const bigPath = path.join(writeRoot, "huge.txt");
        const big = Buffer.alloc(4 * 1024 * 1024 + 1, 0x41);
        fs.writeFileSync(bigPath, big);
        await expectCodingError(
            write("write_file", { path: "huge.txt", content: "tiny" }),
            "FILE_TOO_LARGE", 413,
        );
        expect(fs.statSync(bigPath).size).toBe(big.length);
    });

    it("rejects content over the 512KiB payload cap at protocol validation (413 PAYLOAD_TOO_LARGE)", async () => {
        const oversized = "x".repeat(WORKSPACE_LIMITS.writeContentMaxBytes + 1);
        await expectCodingError(
            write("create_file", { path: "big.txt", content: oversized }),
            "PAYLOAD_TOO_LARGE", 413,
        );
        expect(fs.existsSync(path.join(writeRoot, "big.txt"))).toBe(false);
    });

    it("never lets a symlink/junction parent redirect a write outside the root (PATH_ESCAPE)", async () => {
        const link = path.join(writeRoot, "escape-link");
        if (!tryLink(outsideDir, link)) {
            console.warn("[skip] no symlink privilege; junction escape test skipped");
            return;
        }
        cleanup.push(link); // rm the link, never the target
        await expectCodingError(
            write("create_file", { path: "escape-link/new.txt", content: "x" }),
            "PATH_ESCAPE", 403,
        );
        await expectCodingError(
            write("write_file", { path: "escape-link/leak.txt", content: "clobbered" }),
            "PATH_ESCAPE", 403,
        );
        // the outside secret was never touched
        expect(fs.readFileSync(path.join(outsideDir, "leak.txt"), "utf8")).toBe("secret outside\n");
        expect(fs.existsSync(path.join(outsideDir, "new.txt"))).toBe(false);
    });
});

describe("digest helpers", () => {
    it("sha256Hex is stable across calls and matches a raw-buffer digest", async () => {
        const text = "stable bytes\n";
        expect(sha256Hex(text)).toBe(sha256Buf(Buffer.from(text, "utf8")));
        expect(sha256Hex(text)).toBe(sha256Hex(text));
    });
});
