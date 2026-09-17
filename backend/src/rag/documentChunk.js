/**
 * K4 — structure-aware parent/leaf chunking for parsed knowledge documents.
 *
 * Parent chunks preserve section context and are expanded after retrieval.
 * Leaf chunks are the only rows intended for lexical/vector candidate search.
 * This module is provider-independent: it consumes ParsedDocument v1 only.
 */
import { sha256Hex } from "./knowledgeStore.js";

const TOKENS_PER_CHAR = 4;
const DEFAULTS = Object.freeze({
    leafTargetTokens: 600,
    leafMaxTokens: 900,
    leafOverlapTokens: 80,
    parentTargetTokens: 1600,
    parentMaxTokens: 2000,
});

function asText(value) {
    return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function tokenEstimate(text) {
    return Math.max(1, Math.ceil(asText(text).length / TOKENS_PER_CHAR));
}

function headingPrefix(block) {
    const path = Array.isArray(block?.headingPath) ? block.headingPath.filter(Boolean) : [];
    return path.length ? `${path.join(" > ")}\n` : "";
}

function blockText(block) {
    const text = asText(block?.text);
    const path = Array.isArray(block?.headingPath) ? block.headingPath.filter(Boolean) : [];
    if (block?.type === "heading" && path.at(-1) === text) return path.join(" > ");
    return `${headingPrefix(block)}${text}`.trim();
}

function sectionKey(block, index) {
    const path = Array.isArray(block?.headingPath) ? block.headingPath.filter(Boolean) : [];
    return path.length ? path.join("\u001f") : "__root__";
}

function splitOversizedText(text, maxChars, overlapChars, { repeatFirstLine = false } = {}) {
    const value = asText(text);
    if (!value) return [];
    if (value.length <= maxChars) return [value];
    const lines = value.split("\n");
    const firstLine = lines[0];
    const output = [];
    let cursor = 0;
    while (cursor < value.length) {
        const end = Math.min(value.length, cursor + maxChars);
        let boundary = value.lastIndexOf("\n", end);
        if (boundary <= cursor + Math.floor(maxChars * 0.55)) boundary = end;
        let piece = value.slice(cursor, boundary).trim();
        if (repeatFirstLine && cursor > 0 && firstLine && !piece.startsWith(firstLine)) {
            piece = `${firstLine}\n${piece}`.slice(0, maxChars).trim();
        }
        if (piece) output.push(piece);
        if (boundary >= value.length) break;
        const next = Math.max(cursor + 1, boundary - Math.max(0, overlapChars));
        cursor = next;
    }
    return output;
}

function blockUnits(block, maxChars) {
    const text = blockText(block);
    if (!text) return [];
    const atomic = new Set(["table", "equation", "code"]);
    return splitOversizedText(text, maxChars, Math.floor(maxChars * 0.12), {
        repeatFirstLine: atomic.has(block.type) && block.type === "table",
    }).map((content, index) => ({
        content,
        block,
        splitIndex: index,
        blockType: block.type,
    }));
}

function packUnits(units, maxChars, overlapChars) {
    const chunks = [];
    let current = "";
    let metadata = [];
    for (const unit of units) {
        const candidate = current ? `${current}\n\n${unit.content}` : unit.content;
        if (current && candidate.length > maxChars) {
            chunks.push({ content: current.trim(), metadata });
            const availableOverlap = Math.max(0, maxChars - unit.content.length - 2);
            const overlap = current.slice(Math.max(0, current.length - Math.min(overlapChars, availableOverlap))).trim();
            current = overlap ? `${overlap}\n\n${unit.content}` : unit.content;
            metadata = [unit];
        } else {
            current = candidate;
            metadata.push(unit);
        }
    }
    if (current.trim()) chunks.push({ content: current.trim(), metadata });
    return chunks;
}

function pageRange(metadata) {
    const pages = metadata.map((item) => Number(item.block?.page)).filter((page) => Number.isInteger(page) && page > 0);
    return {
        pageStart: pages.length ? Math.min(...pages) : null,
        pageEnd: pages.length ? Math.max(...pages) : null,
    };
}

function blockTypes(metadata) {
    return [...new Set(metadata.map((item) => item.blockType).filter(Boolean))];
}

function makeRow({ content, level, index, parentKey = null, metadata = [], headingPath = [] }) {
    const range = pageRange(metadata);
    const types = blockTypes(metadata);
    return {
        chunkIndex: index,
        chunkLevel: level,
        parentKey,
        parentChunkId: null,
        startLine: null,
        endLine: null,
        pageStart: range.pageStart,
        pageEnd: range.pageEnd,
        headingPath: Array.isArray(headingPath) ? headingPath : [],
        content: asText(content),
        contentHash: sha256Hex(content),
        symbols: "",
        tokenCount: tokenEstimate(content),
        embedding: null,
        meta: {
            blockTypes: types,
            blockCount: metadata.length,
            chunkLevel: level,
            parentKey,
            headingPath: Array.isArray(headingPath) ? headingPath : [],
        },
    };
}

/**
 * Convert ParsedDocument blocks to stable parent/leaf rows.
 * Parents are emitted before leaves so the store can resolve parentChunkId in
 * one transaction. Only leaves should be embedded and searched.
 */
export function chunkParsedDocument(parsed, options = {}) {
    const config = { ...DEFAULTS, ...(options || {}) };
    const leafMaxChars = Math.max(256, Number(config.leafMaxTokens) * TOKENS_PER_CHAR);
    const leafOverlapChars = Math.max(0, Number(config.leafOverlapTokens) * TOKENS_PER_CHAR);
    const parentMaxChars = Math.max(512, Number(config.parentMaxTokens) * TOKENS_PER_CHAR);
    const parentOverlapChars = Math.max(0, Math.floor(parentMaxChars * 0.05));
    const sections = new Map();

    for (const [index, block] of (parsed?.blocks || []).entries()) {
        const text = blockText(block);
        if (!text) continue;
        const key = sectionKey(block, index);
        if (!sections.has(key)) sections.set(key, { key, headingPath: [...(block.headingPath || [])], blocks: [] });
        sections.get(key).blocks.push(block);
    }

    const parents = [];
    const leaves = [];
    for (const section of sections.values()) {
        const units = section.blocks.flatMap((block) => blockUnits(block, parentMaxChars));
        const parentParts = packUnits(units, parentMaxChars, parentOverlapChars);
        parentParts.forEach((parentPart, parentIndex) => {
            const parentKey = `${section.key}:${parentIndex}`;
            parents.push(makeRow({
                content: parentPart.content,
                level: "parent",
                index: parents.length,
                parentKey,
                metadata: parentPart.metadata,
                headingPath: section.headingPath,
            }));
            const leafUnits = parentPart.metadata.flatMap((unit) => splitOversizedText(
                unit.content,
                leafMaxChars,
                leafOverlapChars,
                { repeatFirstLine: unit.blockType === "table" },
            ).map((content, splitIndex) => ({
                content,
                block: unit.block,
                splitIndex,
                blockType: unit.blockType,
            })));
            const leafParts = packUnits(leafUnits, leafMaxChars, leafOverlapChars);
            leafParts.forEach((leafPart) => leaves.push(makeRow({
                content: leafPart.content,
                level: "leaf",
                index: 0,
                parentKey,
                metadata: leafPart.metadata,
                headingPath: section.headingPath,
            })));
        });
    }

    const rows = [...parents, ...leaves];
    rows.forEach((row, index) => { row.chunkIndex = index; });
    return rows;
}

export function chunkStats(rows = []) {
    const list = Array.isArray(rows) ? rows : [];
    return {
        total: list.length,
        parents: list.filter((row) => row.chunkLevel === "parent").length,
        leaves: list.filter((row) => row.chunkLevel !== "parent").length,
        maxTokens: list.reduce((max, row) => Math.max(max, Number(row.tokenCount) || 0), 0),
    };
}

const DOCUMENT_CHUNK_DEFAULTS = DEFAULTS;

export { DOCUMENT_CHUNK_DEFAULTS, tokenEstimate };

export default { chunkParsedDocument, chunkStats, DOCUMENT_CHUNK_DEFAULTS, tokenEstimate };
