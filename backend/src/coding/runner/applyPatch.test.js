/**
 * Phase 7 / R2 — Unified-diff applier tests (pure; no fs, no network).
 *
 * The parser must read standard git-style unified diffs (`--- a/…` / `+++ b/…`
 * file headers, `@@ … @@` hunks). Applying is atomic and loud: any context that
 * cannot be matched exactly throws APPLY_PATCH_FAILED and never mutates input;
 * size-cap violations throw PATCH_TOO_LARGE. `tryApplyUnifiedPatch` is the
 * non-throwing single-file variant (writeOps-facing).
 */
import { describe, expect, it } from "vitest";
import {
    applyUnifiedPatch,
    canApplyPatch,
    parseUnifiedPatch,
    PATCH_LIMITS,
    tryApplyUnifiedPatch,
    VALIDATE_PATCH_MAX_CHARS,
} from "./applyPatch.js";

const NO_NL = "\\ No newline at end of file";

/** git-style per-file header for a normal text modification. */
function fileHeaders(name = "src/out.txt") {
    return `diff --git a/${name} b/${name}\nindex 1111111..2222222 100644\n--- a/${name}\n+++ b/${name}\n`;
}

function hunk(oldStart, oldCount, newStart, newCount, bodyLines) {
    return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${bodyLines.join("\n")}`;
}

function patchOf(name, ...hunks) {
    return fileHeaders(name) + hunks.join("\n") + "\n";
}

/** Capture the error thrown by `fn` (assumed to throw); returns it or null. */
function caught(fn) {
    try {
        fn();
        return null;
    } catch (error) {
        return error;
    }
}

describe("parseUnifiedPatch", () => {
    it("returns hunks with parsed headers, pre/post images and marker counts", () => {
        const patch = patchOf(
            "app.js",
            hunk(1, 4, 1, 5, [
                " function sum(a, b) {",
                "-    let total = a + b;",
                "+    const total = a + b;",
                "+    if (total > 10) return total * 2;",
                "     return total;",
                " }",
            ]),
        );
        const parsed = parseUnifiedPatch(patch);
        expect(parsed.malformed).toBe(false);
        expect(parsed.error).toBeNull();
        expect(parsed.hunks).toHaveLength(1);
        const [h] = parsed.hunks;
        expect(h.header).toEqual({ oldStart: 1, oldCount: 4, newStart: 1, newCount: 5 });
        expect(h.pre).toEqual([
            "function sum(a, b) {",
            "    let total = a + b;",
            "    return total;",
            "}",
        ]);
        expect(h.post).toEqual([
            "function sum(a, b) {",
            "    const total = a + b;",
            "    if (total > 10) return total * 2;",
            "    return total;",
            "}",
        ]);
        expect(h.removedMarkers).toBe(1);
        expect(h.addedMarkers).toBe(2);
    });

    it("handles new-file style headers (-0,0) and normalizes oldStart 0 -> 1", () => {
        const patch = "--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+hi\n";
        const parsed = parseUnifiedPatch(patch);
        expect(parsed.malformed).toBe(false);
        expect(parsed.hunks).toHaveLength(1);
        expect(parsed.hunks[0].header).toEqual({ oldStart: 1, oldCount: 0, newStart: 1, newCount: 1 });
        expect(parsed.hunks[0].pre).toEqual([]);
        expect(parsed.hunks[0].post).toEqual(["hi"]);
    });

    it("flags a malformed body line and a count mismatch", () => {
        const badBody = parseUnifiedPatch(hunk(1, 2, 1, 2, [" aaa", " bbb", "?oops"]));
        expect(badBody.malformed).toBe(true);
        expect(badBody.error).toContain("malformed hunk body");

        const mismatch = parseUnifiedPatch(hunk(1, 2, 1, 2, [" aaa"])); // pre 1 != oldCount 2
        expect(mismatch.malformed).toBe(true);
        expect(mismatch.error).toContain("count mismatch");
    });
});

describe("applyUnifiedPatch", () => {
    it("1. inserts lines at the top of a file (context = first 2 original lines)", () => {
        const oldText = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"].join("\n") + "\n";
        const patch = patchOf(
            "app.js",
            hunk(1, 2, 1, 4, ["+// generated", "+const aa = a * 2;", " const a = 1;", " const b = 2;"]),
        );
        const result = applyUnifiedPatch(oldText, patch);
        expect(result.ok).toBe(true);
        expect(result.newText).toBe(
            ["// generated", "const aa = a * 2;", "const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"].join(
                "\n",
            ) + "\n",
        );
        expect(result.hunksApplied).toBe(1);
        expect(result.added).toBe(2);
        expect(result.removed).toBe(0);
        expect(result.truncated).toBe(false);
    });

    it("2. deletes a middle block", () => {
        const oldText = ["keep1", "keep2", "gone3", "gone4", "keep5", "keep6"].join("\n") + "\n";
        const patch = patchOf(
            "data.txt",
            hunk(2, 4, 2, 2, [" keep2", "-gone3", "-gone4", " keep5"]),
        );
        const result = applyUnifiedPatch(oldText, patch);
        expect(result.ok).toBe(true);
        expect(result.newText).toBe(["keep1", "keep2", "keep5", "keep6"].join("\n") + "\n");
        expect(result.removed).toBe(2);
        expect(result.added).toBe(0);
    });

    it("3. replaces a function body (additions + removals + context in one hunk)", () => {
        const oldText = [
            "function sum(a, b) {",
            "    let total = a + b;",
            "    return total;",
            "}",
        ].join("\n") + "\n";
        const patch = patchOf(
            "app.js",
            hunk(1, 4, 1, 5, [
                " function sum(a, b) {",
                "-    let total = a + b;",
                "+    const total = a + b;",
                "+    if (total > 10) return total * 2;",
                "     return total;",
                " }",
            ]),
        );
        const result = applyUnifiedPatch(oldText, patch);
        expect(result.newText).toBe(
            [
                "function sum(a, b) {",
                "    const total = a + b;",
                "    if (total > 10) return total * 2;",
                "    return total;",
                "}",
            ].join("\n") + "\n",
        );
        expect(result.added).toBe(2);
        expect(result.removed).toBe(1);
    });

    it("4. applies multiple hunks in one patch, in order", () => {
        const oldText = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
        const patch = patchOf(
            "multi.txt",
            hunk(1, 3, 1, 3, [" line 1", "-line 2", "+TWO", " line 3"]),
            hunk(7, 3, 7, 3, [" line 7", "-line 8", "+EIGHT", " line 9"]),
        );
        const result = applyUnifiedPatch(oldText, patch);
        expect(result.ok).toBe(true);
        expect(result.hunksApplied).toBe(2);
        expect(result.newText).toBe(
            [
                "line 1",
                "TWO",
                "line 3",
                "line 4",
                "line 5",
                "line 6",
                "line 7",
                "EIGHT",
                "line 9",
                "line 10",
            ].join("\n") + "\n",
        );
    });

    it("5. applies a hunk whose oldStart is wrong but whose pre-image exists elsewhere (lenient scan)", () => {
        const oldText = ["aaa", "bbb", "ccc", "target1", "target2", "target3", "ddd"].join("\n") + "\n";
        // Declares the change at line 1, but target lines actually live at 4-6.
        const patch = patchOf(
            "len.txt",
            hunk(1, 3, 1, 3, ["-target1", "+NEW1", "-target2", "+NEW2", "-target3", "+NEW3"]),
        );
        const result = applyUnifiedPatch(oldText, patch);
        expect(result.ok).toBe(true);
        expect(result.hunksApplied).toBe(1);
        expect(result.newText).toBe(["aaa", "bbb", "ccc", "NEW1", "NEW2", "NEW3", "ddd"].join("\n") + "\n");
    });

    it("6. tolerates omitted counts (header @@ -2 +2 @@)", () => {
        const oldText = ["first line", "second line", "third line"].join("\n") + "\n";
        const patch = fileHeaders("t.txt") + "@@ -2 +2 @@\n-second line\n+line B\n";
        const result = applyUnifiedPatch(oldText, patch);
        expect(result.ok).toBe(true);
        expect(result.newText).toBe(["first line", "line B", "third line"].join("\n") + "\n");
        expect(result.removed).toBe(1);
        expect(result.added).toBe(1);
    });

    it("7. preserves trailing-newline state of the input", () => {
        const patch = patchOf("nl.txt", hunk(1, 2, 1, 2, [" alpha", "-beta", "+BETA"]));
        const without = applyUnifiedPatch("alpha\nbeta", patch);
        expect(without.newText).toBe("alpha\nBETA"); // no trailing newline stays without
        expect(without.newText.endsWith("\n")).toBe(false);

        const withTrailing = applyUnifiedPatch("alpha\nbeta\n", patch);
        expect(withTrailing.newText).toBe("alpha\nBETA\n"); // trailing newline is kept
        expect(withTrailing.newText.endsWith("\n")).toBe(true);
    });

    it("8. tolerates and strips `\\ No newline at end of file` marker lines", () => {
        const oldText = "alpha\nbravo\ncharlie"; // no trailing newline
        const patch =
            patchOf("nl.txt", hunk(1, 3, 1, 4, [" alpha", " bravo", "-charlie", NO_NL, "+charlie", "+extra", NO_NL]));
        expect(parseUnifiedPatch(patch).malformed).toBe(false);
        const result = applyUnifiedPatch(oldText, patch);
        expect(result.ok).toBe(true);
        expect(result.newText).toBe("alpha\nbravo\ncharlie\nextra");
    });

    it("9. throws APPLY_PATCH_FAILED on a context mismatch and never mutates its input", () => {
        const oldText = "aaa\nbbb\nccc\n";
        const patch = patchOf("bad.txt", hunk(1, 2, 1, 2, [" aaa", "-NOT_PRESENT", "+xxx"]));
        const error = caught(() => applyUnifiedPatch(oldText, patch));
        expect(error).not.toBeNull();
        expect(error.code).toBe("APPLY_PATCH_FAILED");
        expect(error.statusCode).toBe(422);
        expect(String(error.message)).toContain("context not found");
        expect(oldText).toBe("aaa\nbbb\nccc\n"); // pure: input untouched after the throw
    });

    it("10. throws APPLY_PATCH_FAILED for a malformed hunk body line", () => {
        const patch = patchOf("bad.txt", hunk(1, 2, 1, 2, [" aaa", " bbb", "?oops"]));
        const error = caught(() => applyUnifiedPatch("aaa\nbbb\nccc\n", patch));
        expect(error).not.toBeNull();
        expect(error.code).toBe("APPLY_PATCH_FAILED");
        expect(error.statusCode).toBe(422);
    });

    it("11. canApplyPatch is true for a good patch and false for a mismatch", () => {
        const oldText = "alpha\nbeta\n";
        const good = patchOf("g.txt", hunk(1, 2, 1, 2, [" alpha", "-beta", "+BETA"]));
        const bad = patchOf("b.txt", hunk(1, 2, 1, 2, [" aaa", "-NOT_PRESENT", "+xxx"]));
        expect(canApplyPatch(oldText, good)).toBe(true);
        expect(canApplyPatch(oldText, bad)).toBe(false);
    });

    it("12. rejects oversized patch text with PATCH_TOO_LARGE (413)", () => {
        const oversized = `@@ -1,2 +1,2 @@\n ${"x".repeat(300 * 1024)}\n alpha\n beta\n`;
        expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(PATCH_LIMITS.maxPatchBytes);
        const error = caught(() => applyUnifiedPatch("alpha\nbeta\n", oversized));
        expect(error).not.toBeNull();
        expect(error.code).toBe("PATCH_TOO_LARGE");
        expect(error.statusCode).toBe(413);
    });

    it("honors a lowered maxHunks limit via the options override", () => {
        const multi = patchOf(
            "m.txt",
            hunk(1, 3, 1, 3, [" line 1", "-line 2", "+TWO", " line 3"]),
            hunk(4, 1, 4, 1, [" line 4"]),
        );
        const oldText = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
        const ok = applyUnifiedPatch(oldText, multi);
        expect(ok.ok).toBe(true);
        const error = caught(() => applyUnifiedPatch(oldText, multi, { limits: { maxHunks: 1 } }));
        expect(error).not.toBeNull();
        expect(error.code).toBe("PATCH_TOO_LARGE");
        expect(error.statusCode).toBe(413);
    });

    it("returns the input unchanged when the patch has zero hunks", () => {
        const oldText = "line one\nline two\n";
        const onlyHeaders = fileHeaders("empty.txt");
        const result = applyUnifiedPatch(oldText, onlyHeaders);
        expect(result).toEqual({ ok: true, newText: oldText, hunksApplied: 0, added: 0, removed: 0, truncated: false });
    });

    it("exports the input cap alias used by callers", () => {
        expect(VALIDATE_PATCH_MAX_CHARS).toBe(PATCH_LIMITS.maxPatchBytes);
    });
});

describe("tryApplyUnifiedPatch (non-throwing, strict single-file)", () => {
    const oldText = "alpha\nbeta\n";
    const good = patchOf("g.txt", hunk(1, 2, 1, 2, [" alpha", "-beta", "+BETA"]));

    it("returns ok:true + text + matched:true on a clean exact apply", () => {
        const result = tryApplyUnifiedPatch(oldText, good);
        expect(result).toEqual({ ok: true, text: "alpha\nBETA\n", hunksApplied: 1, matched: true });
    });

    it("never throws: returns ok:false + reason for a mismatch", () => {
        const bad = patchOf("b.txt", hunk(1, 2, 1, 2, [" aaa", "-NOT_PRESENT", "+xxx"]));
        let result;
        expect(() => {
            result = tryApplyUnifiedPatch(oldText, bad);
        }).not.toThrow();
        expect(result.ok).toBe(false);
        expect(result.matched).toBe(false);
        expect(result.text).toBeNull();
        expect(result.hunksApplied).toBe(0);
        expect(typeof result.reason).toBe("string");
        expect(result.reason).toContain("context not found");
    });

    it("is strict: no offset search, unlike the throwing applier", () => {
        const lenientText = ["aaa", "bbb", "target1", "target2", "target3", "ddd"].join("\n") + "\n";
        const misplaced = patchOf("l.txt", hunk(1, 3, 1, 3, ["-target1", "+NEW1", "-target2", "+NEW2", "-target3", "+NEW3"]));
        // declared at line 1, actual content at lines 3-5
        expect(applyUnifiedPatch(lenientText, misplaced).ok).toBe(true);
        const result = tryApplyUnifiedPatch(lenientText, misplaced);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain("context not found");
    });

    it("rejects add/delete and binary/mode/rename file headers", () => {
        const newFile = "diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0000000..45b983b\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n";
        const result = tryApplyUnifiedPatch("", newFile);
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/new file mode|add\/delete/);
    });

    it("never throws even for non-string inputs", () => {
        const result = tryApplyUnifiedPatch(123, "not-a-patch");
        expect(result.ok).toBe(false);
        expect(typeof result.reason).toBe("string");
    });
});
