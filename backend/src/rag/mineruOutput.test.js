import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
    MineruOutputError,
    normalizeContentList,
    normalizeMarkdown,
    normalizeMineruOutput,
    readMineruArchive,
    validateArchiveEntries,
} from "./mineruOutput.js";

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function zipFixture(files) {
    const local = [];
    const central = [];
    let offset = 0;
    for (const [name, value] of files) {
        const nameBytes = Buffer.from(name);
        const data = Buffer.from(value);
        const compressed = zlib.deflateRawSync(data);
        const crc = crc32(data);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(8, 8);
        header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(compressed.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(nameBytes.length, 26);
        const localRecord = Buffer.concat([header, nameBytes, compressed]);
        local.push(localRecord);
        const directory = Buffer.alloc(46);
        directory.writeUInt32LE(0x02014b50, 0);
        directory.writeUInt16LE(20, 4);
        directory.writeUInt16LE(20, 6);
        directory.writeUInt16LE(8, 10);
        directory.writeUInt32LE(crc, 16);
        directory.writeUInt32LE(compressed.length, 20);
        directory.writeUInt32LE(data.length, 24);
        directory.writeUInt16LE(nameBytes.length, 28);
        directory.writeUInt32LE(0, 38);
        directory.writeUInt32LE(offset, 42);
        central.push(Buffer.concat([directory, nameBytes]));
        offset += localRecord.length;
    }
    const centralData = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralData.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, centralData, eocd]);
}

describe("MinerU output normalization", () => {
    it("normalizes pipeline content_list into the shared parsed document contract", () => {
        const document = normalizeContentList([
            { type: "text", text_level: 1, text: "Installation Guide", page_idx: 0, bbox: [1, 2, 3, 4] },
            { type: "text", text: "Run the command", page_idx: 0 },
            { type: "table", table_body: "| key | value |", page_idx: 1 },
            { type: "equation", text: "x = y", page_idx: 1 },
            { type: "image", img_caption: ["Architecture diagram"], page_idx: 2 },
            { type: "footer", text: "ignored", page_idx: 2 },
        ], { fileName: "guide.pdf", parserVersion: "pipeline-v1" });
        expect(document.parser).toBe("mineru");
        expect(document.blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "table", "equation", "image_caption"]);
        expect(document.blocks[0].headingPath).toEqual(["Installation Guide"]);
        expect(document.stats.pages).toBe(3);
    });

    it("inherits page wrapper metadata while preserving explicit child pages", () => {
        const document = normalizeContentList({
            pages: [
                {
                    page_idx: 0,
                    blocks: [
                        { type: "text", text: "Inherited page" },
                        { type: "text", text: "Explicit one-based page", page_number: 3 },
                        { type: "text", text: "Invalid child page", page_idx: -1 },
                    ],
                },
                { page_number: 2, content: [{ type: "text", text: "One-based wrapper" }] },
            ],
        });
        expect(document.blocks.map((block) => block.page)).toEqual([1, 3, null, 2]);
        expect(document.stats.pages).toBe(3);
    });

    it("normalizes supported zero-based and one-based page aliases", () => {
        const document = normalizeContentList([
            { type: "text", text: "page_index", page_index: 1 },
            { type: "text", text: "metadata page_idx", metadata: { page_idx: 2 } },
            { type: "text", text: "pageNum", pageNum: 4 },
            { type: "text", text: "invalid", page_number: "not-a-page" },
        ]);
        expect(document.blocks.map((block) => block.page)).toEqual([2, 3, 4, null]);
    });

    it("normalizes MinerU V2 outer page arrays with page inheritance", () => {
        const document = normalizeContentList([
            [{ type: "title", content: { level: 1, title_content: "Page one" } }],
            [{ type: "paragraph", content: { paragraph_content: "Page two" } }, { type: "paragraph", text: "explicit page", page_number: 3 }],
        ]);
        expect(document.blocks.map((block) => block.page)).toEqual([1, 2, 3]);
        expect(document.blocks.map((block) => block.text)).toEqual(["Page one", "Page two", "explicit page"]);
        expect(document.stats.pages).toBe(3);
    });

    it("uses full.md when structured JSON is missing or invalid", () => {
        const document = normalizeMineruOutput({
            entries: [
                { name: "content_list.json", data: "{invalid" },
                { name: "full.md", data: "# Title\n\nA paragraph." },
            ],
            fileName: "manual.pdf",
        });
        expect(document.blocks.map((block) => block.type)).toEqual(["heading", "paragraph"]);
        expect(document.warnings[0]).toContain("full.md");
    });

    it("reads a real ZIP central directory and only returns supported output files", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-output-"));
        const archive = path.join(dir, "result.zip");
        await fs.writeFile(archive, zipFixture([
            ["assets/ignored.bin", "ignore"],
            ["content_list.json", JSON.stringify([{ type: "text", text: "structured result", page_idx: 0 }])],
            ["full.md", "# fallback"],
        ]));
        const entries = await readMineruArchive(archive);
        expect(entries.map((entry) => entry.name)).toEqual(["content_list.json", "full.md"]);
        expect(normalizeMineruOutput({ entries }).blocks[0].text).toBe("structured result");
        await fs.rm(dir, { recursive: true, force: true });
    });

    it("accepts a prefixed structured content-list artifact below an output directory", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-output-prefixed-"));
        const archive = path.join(dir, "result.zip");
        await fs.writeFile(archive, zipFixture([
            ["nested/agent-evo-rag_content_list.json", JSON.stringify({ pages: [{ page_idx: 2, blocks: [{ type: "text", text: "page three" }] }] })],
            ["nested/full.md", "# fallback should not win"],
            ["nested/ignored.json", "{}"],
        ]));
        const entries = await readMineruArchive(archive);
        expect(entries.map((entry) => entry.name)).toEqual([
            "nested/agent-evo-rag_content_list.json",
            "nested/full.md",
        ]);
        const document = normalizeMineruOutput({ entries });
        expect(document.blocks[0]).toMatchObject({ text: "page three", page: 3 });
        await fs.rm(dir, { recursive: true, force: true });
    });

    it("tries the next structured artifact when a preferred V2 content list is unusable", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-output-multiple-structured-"));
        const archive = path.join(dir, "result.zip");
        await fs.writeFile(archive, zipFixture([
            ["nested/source_content_list_v2.json", JSON.stringify([[], [], []])],
            ["nested/source_content_list.json", JSON.stringify([
                { type: "text", text: "page one", page_idx: 0 },
                { type: "text", text: "page two", page_idx: 1 },
                { type: "text", text: "page three", page_idx: 2 },
            ])],
            ["nested/full.md", "# markdown fallback must not win"],
        ]));
        const entries = await readMineruArchive(archive);
        const document = normalizeMineruOutput({ entries });
        expect(document.blocks.map((block) => block.page)).toEqual([1, 2, 3]);
        expect(document.warnings).toEqual([]);
        await fs.rm(dir, { recursive: true, force: true });
    });

    it("accepts VLM-style nested content and keeps provider-specific fields in metadata", () => {
        const document = normalizeContentList({ pages: [{ blocks: [{ type: "code", code_body: "const x = 1", page_idx: 0, sub_type: "javascript" }] }] });
        expect(document.blocks[0]).toMatchObject({ type: "code", text: "const x = 1", metadata: { mineruType: "code", subType: "javascript" } });
    });

    it("rejects traversal, symlinks, entry limits, and compression bombs", () => {
        expect(() => validateArchiveEntries([{ name: "../full.md", data: "x" }])).toThrowError(MineruOutputError);
        expect(() => validateArchiveEntries([{ name: "full.md", type: "symlink", data: "x" }])).toThrowError(/symlink/);
        expect(() => validateArchiveEntries([{ name: "full.md", data: "x" }], { maxEntries: 0 })).toThrowError(/too many entries/);
        expect(() => validateArchiveEntries([{ name: "full.md", data: "x", compressedSize: 1, uncompressedSize: 101 }], { maxCompressionRatio: 100 })).toThrowError(/compression ratio/);
    });

    it("rejects missing and empty output instead of indexing an empty document", () => {
        expect(() => normalizeMineruOutput()).toThrowError(/does not contain supported output/);
        expect(() => normalizeMarkdown("\n\n")).toThrowError(/empty/);
    });
});
