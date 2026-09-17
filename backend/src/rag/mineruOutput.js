import { createHash } from "node:crypto";
import unzipper from "unzipper";
import {
    DocumentContractError,
    PARSED_DOCUMENT_SCHEMA_VERSION,
    parseParsedDocument,
} from "./documentContract.js";

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_COMPRESSION_RATIO = 100;
const SKIPPED_TYPES = new Set(["header", "footer", "page_number", "page_footer", "page-header", "page-footer"]);

function archiveBasename(name) {
    return String(name || "").split("/").at(-1).toLowerCase();
}

/**
 * MinerU may keep the documented basename or prefix it with the source file
 * name and/or place it below an output directory. Keep this allowlist narrow:
 * only the two known structured content-list artifacts are accepted.
 */
function isContentListEntry(name) {
    return /(?:^|[-_])content_list(?:_v2)?\.json$/i.test(archiveBasename(name));
}

function isFullMarkdownEntry(name) {
    return archiveBasename(name) === "full.md";
}

export class MineruOutputError extends DocumentContractError {
    constructor(message, code = "MINERU_OUTPUT_INVALID", details = null) {
        super(message, code, details);
        this.name = "MineruOutputError";
    }
}

function textValue(value) {
    if (typeof value === "string") return value.trim();
    if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(" ").trim();
    if (value && typeof value === "object") return textValue(value.text || value.content || value.value || "");
    return "";
}

function entryBytes(data) {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof Uint8Array) return Buffer.from(data);
    if (typeof data === "string") return Buffer.from(data, "utf8");
    throw new MineruOutputError("MinerU archive entry has unsupported data", "MINERU_ARCHIVE_ENTRY_INVALID");
}

export function validateArchiveEntryName(name) {
    const raw = String(name || "");
    const normalized = raw.replaceAll("\\", "/");
    const segments = normalized.split("/");
    if (!normalized || normalized.startsWith("/") || segments.some((segment) => segment === "..") || /[\u0000-\u001f]/.test(normalized)) {
        throw new MineruOutputError("MinerU archive contains an unsafe path", "MINERU_ARCHIVE_PATH_TRAVERSAL");
    }
    return normalized;
}

export function validateArchiveEntries(entries, {
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
    maxCompressionRatio = DEFAULT_MAX_COMPRESSION_RATIO,
} = {}) {
    if (!Array.isArray(entries) || entries.length === 0) throw new MineruOutputError("MinerU archive is empty", "MINERU_ARCHIVE_EMPTY");
    if (entries.length > maxEntries) throw new MineruOutputError("MinerU archive has too many entries", "MINERU_ARCHIVE_ENTRY_LIMIT");
    let totalBytes = 0;
    return entries.map((entry) => {
        const name = validateArchiveEntryName(entry?.name);
        if (entry?.type === "symlink") throw new MineruOutputError("MinerU archive contains a symlink", "MINERU_ARCHIVE_SYMLINK");
        const bytes = entryBytes(entry?.data);
        const uncompressedSize = Number(entry?.uncompressedSize ?? bytes.length);
        const compressedSize = Number(entry?.compressedSize ?? 0);
        if (uncompressedSize > maxEntryBytes || bytes.length > maxEntryBytes) throw new MineruOutputError("MinerU archive entry is too large", "MINERU_ARCHIVE_ENTRY_TOO_LARGE");
        if (compressedSize > 0 && uncompressedSize / compressedSize > maxCompressionRatio) throw new MineruOutputError("MinerU archive compression ratio is unsafe", "MINERU_ARCHIVE_COMPRESSION_RATIO");
        totalBytes += Math.max(uncompressedSize, bytes.length);
        if (totalBytes > maxTotalBytes) throw new MineruOutputError("MinerU archive is too large", "MINERU_ARCHIVE_TOTAL_TOO_LARGE");
        return { ...entry, name, data: bytes };
    });
}

/**
 * Inspect the ZIP central directory first, then buffer only the two output
 * files consumed by the normalizer. No archive entry is extracted to a path.
 */
export async function readMineruArchive(zipPath, {
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
    maxCompressionRatio = DEFAULT_MAX_COMPRESSION_RATIO,
} = {}) {
    let directory;
    try {
        directory = await unzipper.Open.file(zipPath);
    } catch (error) {
        throw new MineruOutputError("MinerU archive cannot be opened", "MINERU_ARCHIVE_INVALID", error);
    }
    if (!Array.isArray(directory?.files) || directory.files.length === 0) throw new MineruOutputError("MinerU archive is empty", "MINERU_ARCHIVE_EMPTY");
    if (directory.files.length > maxEntries) throw new MineruOutputError("MinerU archive has too many entries", "MINERU_ARCHIVE_ENTRY_LIMIT");
    let totalBytes = 0;
    const selected = [];
    for (const entry of directory.files) {
        const name = validateArchiveEntryName(entry.path);
        if (String(entry.type || "").toLowerCase().includes("directory") || String(entry.type || "").toLowerCase().includes("symlink")) {
            if (String(entry.type || "").toLowerCase().includes("symlink")) throw new MineruOutputError("MinerU archive contains a symlink", "MINERU_ARCHIVE_SYMLINK");
            continue;
        }
        const uncompressedSize = Number(entry.vars?.uncompressedSize || 0);
        const compressedSize = Number(entry.vars?.compressedSize || 0);
        if (uncompressedSize > maxEntryBytes) throw new MineruOutputError("MinerU archive entry is too large", "MINERU_ARCHIVE_ENTRY_TOO_LARGE");
        if (compressedSize > 0 && uncompressedSize / compressedSize > maxCompressionRatio) throw new MineruOutputError("MinerU archive compression ratio is unsafe", "MINERU_ARCHIVE_COMPRESSION_RATIO");
        totalBytes += uncompressedSize;
        if (totalBytes > maxTotalBytes) throw new MineruOutputError("MinerU archive is too large", "MINERU_ARCHIVE_TOTAL_TOO_LARGE");
        if (isFullMarkdownEntry(name) || isContentListEntry(name)) {
            selected.push({ entry, name, uncompressedSize, compressedSize });
        }
    }
    const result = [];
    for (const candidate of selected.sort((a, b) => a.name.localeCompare(b.name))) {
        const data = await candidate.entry.buffer();
        if (data.length > maxEntryBytes) throw new MineruOutputError("MinerU archive entry is too large", "MINERU_ARCHIVE_ENTRY_TOO_LARGE");
        result.push({ name: candidate.name, data, uncompressedSize: candidate.uncompressedSize, compressedSize: candidate.compressedSize });
    }
    return result;
}

function blockId(index, text) {
    return `mineru-${index}-${createHash("sha1").update(text).digest("hex").slice(0, 10)}`;
}

function firstPageField(item, fields) {
    for (const field of fields) {
        if (item && item[field] != null) return { present: true, value: item[field] };
    }
    return { present: false, value: null };
}

function pageNumberInfo(item) {
    const metadata = item?.metadata && typeof item.metadata === "object" ? item.metadata : null;
    const zeroBased = firstPageField(item, ["page_idx", "pageIndex", "page_index"]);
    const metadataZeroBased = firstPageField(metadata, ["page_idx", "pageIndex", "page_index"]);
    const oneBased = firstPageField(item, ["page_number", "pageNum", "page"]);
    const metadataOneBased = firstPageField(metadata, ["page_number", "pageNum", "page"]);
    const selected = zeroBased.present ? { ...zeroBased, base: 0 }
        : metadataZeroBased.present ? { ...metadataZeroBased, base: 0 }
            : oneBased.present ? { ...oneBased, base: 1 }
                : metadataOneBased.present ? { ...metadataOneBased, base: 1 }
                    : { present: false, value: null, base: null };
    if (!selected.present) return { present: false, value: null };
    const page = Number(selected.value);
    const valid = Number.isInteger(page) && (selected.base === 0 ? page >= 0 : page >= 1);
    return { present: true, value: valid ? page + (selected.base === 0 ? 1 : 0) : null };
}

function pageNumber(item, inheritedPage = null) {
    const own = pageNumberInfo(item);
    return own.present ? own.value : inheritedPage;
}

function bbox(item) {
    return Array.isArray(item?.bbox) && item.bbox.length === 4 ? item.bbox.map(Number) : null;
}

function blockText(item) {
    const type = String(item?.type || "text").toLowerCase();
    const content = item?.content && typeof item.content === "object" && !Array.isArray(item.content) ? item.content : null;
    if (type === "title" || type === "paragraph") {
        return textValue(item.text || content?.title_content || content?.paragraph_content || item.paragraph_content || item.title);
    }
    if (type === "table") return textValue(item.table_body || item.text || item.table_caption || item.table_footnote);
    if (type === "equation") return textValue(item.text || item.content || item.equation);
    if (type === "code") return textValue(item.code_body || item.text || item.content);
    if (type === "list") return textValue(item.text || item.list_items || item.content);
    if (type === "image" || type === "chart") return textValue(item.img_caption || item.caption || item.text || item.title);
    return textValue(item.text || item.content || item.paragraph_content || item.title);
}

function blockType(item, text) {
    const type = String(item?.type || "text").toLowerCase();
    if (type === "title") return "heading";
    if (type === "table") return "table";
    if (type === "equation") return "equation";
    if (type === "code") return "code";
    if (type === "list") return "list";
    if (type === "image" || type === "chart") return "image_caption";
    if (Number(item?.text_level) > 0 || /^#{1,6}\s/.test(text)) return "heading";
    return "paragraph";
}

export function normalizeContentList(contentList, {
    fileName = "document",
    mimeType = "application/pdf",
    parserVersion = null,
} = {}) {
    const source = Array.isArray(contentList) ? contentList : contentList?.content_list ?? contentList;
    const items = Array.isArray(source)
        ? source.every((page) => Array.isArray(page))
            // MinerU content_list_v2 uses an explicit outer page array. The
            // page position is the wrapper's 1-based page number; it is not a
            // guess from block order or Markdown separators.
            ? source.flatMap((page, pageIndex) => page.map((item) => ({ item, inheritedPage: pageIndex + 1 })))
            : source.map((item) => ({ item, inheritedPage: null }))
        : Array.isArray(source?.pages)
            ? source.pages.flatMap((page) => {
                const inheritedPage = pageNumber(page);
                const children = Array.isArray(page?.blocks)
                    ? page.blocks
                    : Array.isArray(page?.content) ? page.content : [];
                return children.map((item) => ({ item, inheritedPage }));
            })
            : [];
    const blocks = [];
    const headingPath = [];
    for (const { item, inheritedPage } of items) {
        const type = String(item?.type || "text").toLowerCase();
        if (SKIPPED_TYPES.has(type)) continue;
        const text = blockText(item);
        if (!text) continue;
        const level = Number(item?.text_level);
        const normalizedLevel = Number.isInteger(level) && level > 0 ? Math.min(level, 12) : null;
        while (normalizedLevel && headingPath.length >= normalizedLevel) headingPath.pop();
        const currentPath = [...headingPath];
        const normalizedType = blockType(item, text);
        if (normalizedType === "heading") {
            currentPath.push(text);
            headingPath.splice(0, headingPath.length, ...currentPath);
        }
        blocks.push({
            id: blockId(blocks.length, text),
            type: normalizedType,
            text,
            level: normalizedType === "heading" ? (normalizedLevel || 1) : null,
            page: pageNumber(item, inheritedPage),
            bbox: bbox(item),
            headingPath: currentPath,
            metadata: {
                mineruType: type,
                subType: item?.sub_type || null,
                imagePath: item?.img_path || null,
            },
        });
    }
    return buildDocument({ fileName, mimeType, parserVersion, title: headingPath[0] || null, blocks, warnings: [] });
}

function buildDocument({ fileName, mimeType, parserVersion, title, blocks, warnings }) {
    if (!blocks.length) throw new MineruOutputError("MinerU output has no usable content", "MINERU_OUTPUT_EMPTY");
    return parseParsedDocument({
        schemaVersion: PARSED_DOCUMENT_SCHEMA_VERSION,
        parser: "mineru",
        parserVersion,
        fileName,
        mimeType,
        title,
        blocks,
        warnings,
        stats: { pages: Math.max(0, ...blocks.map((block) => block.page || 0)) || null, blocks: blocks.length, chars: blocks.reduce((sum, block) => sum + block.text.length, 0) },
    });
}

export function normalizeMarkdown(markdown, {
    fileName = "document",
    mimeType = "application/pdf",
    parserVersion = null,
} = {}) {
    const source = String(markdown || "").replaceAll("\r\n", "\n").trim();
    if (!source) throw new MineruOutputError("MinerU full.md is empty", "MINERU_OUTPUT_EMPTY");
    const blocks = [];
    let paragraph = [];
    let headingPath = [];
    const flush = () => {
        const text = paragraph.join("\n").trim();
        if (text) blocks.push({ id: blockId(blocks.length, text), type: /^[-*+]\s/.test(text) ? "list" : "paragraph", text, level: null, page: null, bbox: null, headingPath: [...headingPath], metadata: {} });
        paragraph = [];
    };
    for (const line of source.split("\n")) {
        const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (heading) {
            flush();
            const level = heading[1].length;
            const text = heading[2].trim();
            headingPath = headingPath.slice(0, level - 1);
            headingPath.push(text);
            blocks.push({ id: blockId(blocks.length, text), type: "heading", text, level, page: null, bbox: null, headingPath: [...headingPath], metadata: {} });
        } else if (!line.trim()) flush();
        else paragraph.push(line);
    }
    flush();
    return buildDocument({ fileName, mimeType, parserVersion, title: blocks.find((block) => block.type === "heading")?.text || null, blocks, warnings: ["structured content_list.json unavailable; parsed full.md"] });
}

export function normalizeMineruOutput({ entries, fullMarkdown, contentList, fileName = "document", mimeType = "application/pdf", parserVersion = null, limits } = {}) {
    if (entries) {
        const safeEntries = validateArchiveEntries(entries, limits);
        const structuredEntries = safeEntries
            .filter((entry) => isContentListEntry(entry.name))
            .sort((a, b) => a.name.localeCompare(b.name));
        const markdown = safeEntries
            .filter((entry) => isFullMarkdownEntry(entry.name))
            .sort((a, b) => a.name.localeCompare(b.name))[0];
        let structuredError = null;
        for (const structured of structuredEntries) {
            try {
                return normalizeContentList(JSON.parse(structured.data.toString("utf8")), { fileName, mimeType, parserVersion });
            } catch (error) {
                structuredError ||= error;
            }
        }
        if (structuredEntries.length > 0 && !markdown) {
            throw new MineruOutputError("MinerU content_list.json is invalid", "MINERU_OUTPUT_JSON_INVALID", structuredError);
        }
        if (markdown) return normalizeMarkdown(markdown.data.toString("utf8"), { fileName, mimeType, parserVersion });
    }
    if (contentList) {
        try { return normalizeContentList(contentList, { fileName, mimeType, parserVersion }); } catch (error) { if (!fullMarkdown) throw error; }
    }
    if (fullMarkdown) return normalizeMarkdown(fullMarkdown, { fileName, mimeType, parserVersion });
    throw new MineruOutputError("MinerU archive does not contain supported output", "MINERU_OUTPUT_MISSING");
}

export default { normalizeMineruOutput, normalizeContentList, normalizeMarkdown, readMineruArchive, validateArchiveEntries, validateArchiveEntryName };
