import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, newFileAdditions, diffLineKind } from "../diffModel";

describe("parseUnifiedDiff", () => {
    it("把 hunk/上下文/增删行分类并按 hunk 头推进双端行号", () => {
        const raw = [
            "diff --git a/a.js b/a.js",
            "index 111..222 100644",
            "--- a/a.js",
            "+++ b/a.js",
            "@@ -1,3 +1,4 @@",
            " const a = 1;",
            "-const b = 2;",
            "+const b = 2; // b",
            "+const c = 3;",
            " const d = 4;",
        ].join("\n");

        const lines = parseUnifiedDiff(raw);
        expect(lines.map((l) => l.type)).toEqual([
            "hdr", "hdr", "hdr", "hdr",
            "hunk", "ctx", "del", "add", "add", "ctx",
        ]);

        const ctx0 = lines[5];
        expect(ctx0.oldLine).toBe(1);
        expect(ctx0.newLine).toBe(1);

        const del = lines[6];
        expect(del.oldLine).toBe(2);
        expect(del.newLine).toBeNull();

        const add0 = lines[7];
        expect(add0.newLine).toBe(2);
        expect(add0.oldLine).toBeNull();

        const add1 = lines[8];
        expect(add1.newLine).toBe(3);

        const ctx1 = lines[9];
        expect(ctx1.oldLine).toBe(3);
        expect(ctx1.newLine).toBe(4);
    });

    it("支持从 0 起始的 hunk（整文件新增语义的 git diff）", () => {
        const lines = parseUnifiedDiff("@@ -0,0 +1,2 @@\n+hello\n+world\n");
        expect(lines[0].type).toBe("hunk");
        expect(lines[1]).toMatchObject({ type: "add", newLine: 1, oldLine: null });
        expect(lines[2]).toMatchObject({ type: "add", newLine: 2 });
    });

    it("\\ No newline 标记归 ctx 且不推进行号", () => {
        const lines = parseUnifiedDiff("@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n");
        expect(lines.map((l) => l.type)).toEqual(["hunk", "del", "ctx", "add"]);
        const add = lines[3];
        expect(add.newLine).toBe(1);
    });

    it("diff 元数据头行归 hdr（不占行号）", () => {
        const raw = [
            "diff --git a/new.txt b/new.txt",
            "new file mode 100644",
            "index 000..111",
            "--- /dev/null",
            "+++ b/new.txt",
            "@@ -0,0 +1 @@",
            "+x",
        ].join("\n");
        const lines = parseUnifiedDiff(raw);
        const hdrs = lines.filter((l) => l.type === "hdr");
        expect(hdrs.length).toBe(5);
        expect(hdrs.map((l) => l.text)).toContain("new file mode 100644");
    });

    it("空输入与坏输入安全退化，不抛错", () => {
        expect(parseUnifiedDiff("")).toEqual([]);
        expect(parseUnifiedDiff(null)).toEqual([]);
        expect(parseUnifiedDiff(undefined)).toEqual([]);
        const junk = parseUnifiedDiff("这是普通文本\n没有前缀也没有 hunk");
        expect(junk.every((l) => l.type === "ctx")).toBe(true);
        expect(junk.length).toBe(2);
    });

    it("去掉行尾 CR（\r），避免 Windows 换行串行号", () => {
        const lines = parseUnifiedDiff("@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+b\r\n");
        expect(lines.map((l) => l.text)).toEqual(["@@ -1,2 +1,2 @@", " a", "-b", "+b"]);
        expect(lines[2].text.endsWith("\r")).toBe(false);
    });
});

describe("newFileAdditions", () => {
    it("把全文逐行合成全绿 + 行", () => {
        const lines = newFileAdditions("line one\nline two\n");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({ type: "add", text: "+line one", oldLine: null, newLine: 1 });
        expect(lines[1]).toMatchObject({ type: "add", text: "+line two", newLine: 2 });
    });

    it("空输入安全返回空数组", () => {
        expect(newFileAdditions("")).toEqual([]);
        expect(newFileAdditions(null)).toEqual([]);
    });
});

describe("diffLineKind", () => {
    it("归一化未知类型到 ctx", () => {
        expect(diffLineKind("add")).toBe("add");
        expect(diffLineKind("nope")).toBe("ctx");
    });
});
