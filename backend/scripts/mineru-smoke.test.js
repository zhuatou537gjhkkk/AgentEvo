import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { runMineruSmoke, runMineruSmokeCli, validateSmokeFile } from "./mineru-smoke.mjs";

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb883b8 & -(crc & 1));
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

describe("MinerU smoke", () => {
    it("runs fake submit/upload/poll/download through real ZIP and ParsedDocument normalization", async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-smoke-test-"));
        const archive = path.join(directory, "result.zip");
        const guardFile = path.join(directory, "guard.json");
        await fs.writeFile(archive, zipFixture([
            ["content_list.json", JSON.stringify([{ type: "text", text_level: 1, text: "Smoke", page_idx: 0 }, { type: "text", text: "OCR result", page_idx: 0 }])],
        ]));
        const calls = [];
        let polls = 0;
        const previousNetwork = process.env.ALLOW_MINERU_NETWORK;
        process.env.ALLOW_MINERU_NETWORK = "1";
        try {
            const result = await runMineruSmoke({
                filePath: path.resolve("src/rag/fixtures/mineru-smoke.pdf"),
                token: "fake-token",
                guardFile,
                pollIntervalMs: 1,
                timeoutMs: 1000,
                client: {
                    async requestUploadSlot() { calls.push("slot"); return { batchId: "fake-batch", uploadUrl: "https://signed.mineru.test/upload" }; },
                    async uploadFile() { calls.push("upload"); },
                    async getBatchResult() { calls.push("poll"); polls += 1; return polls === 1 ? { state: "running" } : { state: "done", resultUrl: "https://signed.mineru.test/result.zip" }; },
                    async downloadResult({ targetPath }) { calls.push("download"); await fs.copyFile(archive, targetPath); },
                },
            });
            expect(result).toMatchObject({ status: "passed", providerState: "done", pages: 1, blocks: 2, hasPageNumbers: true });
            expect(result.blockTypes).toEqual({ heading: 1, paragraph: 1 });
            expect(calls).toEqual(["slot", "upload", "poll", "poll", "download"]);
            await expect(runMineruSmoke({ filePath: path.resolve("src/rag/fixtures/mineru-smoke.pdf"), token: "fake-token", guardFile, client: { requestUploadSlot: () => { throw new Error("must not submit twice"); } } })).rejects.toMatchObject({ code: "MINERU_SMOKE_SUBMISSION_GUARD" });
        } finally {
            if (previousNetwork === undefined) delete process.env.ALLOW_MINERU_NETWORK;
            else process.env.ALLOW_MINERU_NETWORK = previousNetwork;
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("supports dry-run and rejects files outside the fixture/explicit scope", async () => {
        const fixture = path.resolve("src/rag/fixtures/mineru-smoke.pdf");
        const result = await runMineruSmokeCli(["node", "mineru-smoke.mjs", `--file=${fixture}`, "--dry-run"]);
        expect(result).toMatchObject({ status: "dry-run", network: "disabled" });
        expect(() => validateSmokeFile(path.resolve("backend/package.json"))).toThrowError(/outside/);
    });
});
