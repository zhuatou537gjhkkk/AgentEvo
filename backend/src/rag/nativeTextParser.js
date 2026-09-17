import fs from "node:fs";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { PARSED_DOCUMENT_SCHEMA_VERSION, parseParsedDocument } from "./documentContract.js";
import { MineruOutputError } from "./mineruOutput.js";

const DEFAULT_MAX_CHARS = 50 * 1024 * 1024;

function id(index, text) {
    return `native-${index}-${createHash("sha1").update(text).digest("hex").slice(0, 10)}`;
}

function makeDocument({ fileName, mimeType, parserVersion, blocks, warnings = [] }) {
    if (!blocks.length) throw new MineruOutputError("native document is empty", "NATIVE_OUTPUT_EMPTY");
    return parseParsedDocument({
        schemaVersion: PARSED_DOCUMENT_SCHEMA_VERSION,
        parser: "native",
        parserVersion,
        fileName,
        mimeType,
        title: blocks.find((block) => block.type === "heading")?.text || null,
        blocks,
        warnings,
        stats: { pages: null, blocks: blocks.length, chars: blocks.reduce((sum, block) => sum + block.text.length, 0) },
    });
}

/**
 * Parse txt/md line-by-line. This intentionally does not build a second full
 * string, so native small-file support and future large text ingestion share a
 * bounded read boundary.
 */
export async function parseNativeTextFile(filePath, {
    fileName = "document.txt",
    mimeType = "text/plain",
    parserVersion = "native-v1",
    maxChars = DEFAULT_MAX_CHARS,
} = {}) {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const blocks = [];
    const headingPath = [];
    let paragraph = [];
    let chars = 0;
    const flush = () => {
        const text = paragraph.join("\n").trim();
        if (text) blocks.push({ id: id(blocks.length, text), type: /^[-*+]\s/.test(text) ? "list" : "paragraph", text, level: null, page: null, bbox: null, headingPath: [...headingPath], metadata: {} });
        paragraph = [];
    };
    try {
        for await (const line of lines) {
            chars += String(line).length;
            if (chars > maxChars) throw new MineruOutputError("native text exceeds the configured limit", "NATIVE_OUTPUT_TOO_LARGE");
            const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(String(line));
            if (heading) {
                flush();
                const level = heading[1].length;
                const text = heading[2].trim();
                headingPath.splice(Math.max(0, level - 1));
                headingPath.push(text);
                blocks.push({ id: id(blocks.length, text), type: "heading", text, level, page: null, bbox: null, headingPath: [...headingPath], metadata: {} });
            } else if (!String(line).trim()) flush();
            else paragraph.push(String(line));
        }
        flush();
    } finally {
        lines.close();
        stream.destroy();
    }
    return makeDocument({ fileName, mimeType, parserVersion, blocks });
}

export default { parseNativeTextFile };
