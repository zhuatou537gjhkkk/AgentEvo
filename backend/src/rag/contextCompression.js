/**
 * K6 bounded extractive context compression.
 *
 * It selects original lines/sentences only. No model rewrites the evidence,
 * and the returned item retains its original chunk/page/provenance fields.
 */
import { tokenizeQuery } from "./codeChunk.js";

const DEFAULT_PER_CHUNK_CHARS = 1000;
const DEFAULT_TOTAL_CHARS = 6000;

function queryTokens(query) {
    const { terms, cjk } = tokenizeQuery(query);
    return [...terms, ...cjk].filter(Boolean);
}

function splitEvidence(text) {
    const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
    const units = [];
    let code = false;
    let table = [];
    const flushTable = () => {
        if (table.length > 0) {
            units.push(...table);
            table = [];
        }
    };
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
            code = !code;
            units.push({ text: line, kind: "code" });
            continue;
        }
        if (!code && trimmed.startsWith("|")) {
            table.push({ text: line, kind: "table" });
            continue;
        }
        flushTable();
        if (code || /^#{1,6}\s|^\s*\$\$|\\begin\{|\$[^$]+\$/.test(trimmed)) {
            units.push({ text: line, kind: code ? "code" : "structured" });
            continue;
        }
        const parts = line.split(/(?<=[。！？!?；;])\s+|(?<=[。！？!?；;])(?=[^\s])/g).filter(Boolean);
        if (parts.length === 0) units.push({ text: line, kind: "plain" });
        else units.push(...parts.map((part) => ({ text: part, kind: "plain" })));
    }
    flushTable();
    return units.filter((unit) => unit.text.trim());
}

function unitScore(unit, tokens) {
    const text = unit.text.toLowerCase();
    const hits = tokens.reduce((count, token) => count + (text.includes(token.toLowerCase()) ? 1 : 0), 0);
    let score = hits * 10;
    if (unit.kind === "structured") score += 3;
    if (unit.kind === "table") score += 4;
    if (unit.kind === "code") score += 2;
    return score;
}

function compactUnitText(units, charBudget, tokens) {
    if (charBudget <= 0) return "";
    const scored = units.map((unit, index) => ({ unit, index, score: unitScore(unit, tokens) }));
    const selected = new Set();
    // Always retain headings, table headers/separators, formulas and code fence
    // markers when the budget permits; then add query-relevant units.
    for (const entry of scored) {
        if (entry.unit.kind === "structured" || entry.unit.kind === "table" || entry.unit.kind === "code") selected.add(entry.index);
    }
    for (const entry of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
        if (entry.score <= 0 && selected.size > 0) continue;
        selected.add(entry.index);
    }
    const ordered = [...selected].sort((a, b) => a - b);
    const output = [];
    let used = 0;
    for (const index of ordered) {
        const text = units[index].text.trim();
        const separator = output.length > 0 ? 1 : 0;
        if (used + separator + text.length <= charBudget) {
            output.push(text);
            used += separator + text.length;
            continue;
        }
        if (output.length === 0 && charBudget > 0) output.push(text.slice(0, charBudget));
        break;
    }
    return output.join("\n");
}

function bounded(value, fallback, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(1, Math.min(max, Math.trunc(number))) : fallback;
}

/** Extractively compress retrieved candidates under per-item and global budgets. */
export function compressContext({
    query,
    candidates = [],
    enabled = true,
    perChunkChars = DEFAULT_PER_CHUNK_CHARS,
    totalChars = DEFAULT_TOTAL_CHARS,
} = {}) {
    const source = Array.isArray(candidates) ? candidates : [];
    const perChunk = bounded(perChunkChars, DEFAULT_PER_CHUNK_CHARS, 8000);
    const total = bounded(totalChars, DEFAULT_TOTAL_CHARS, 20000);
    const getSourceContent = (item) => String(item?.contextContent ?? item?.content ?? "");
    const beforeChars = source.reduce((sum, item) => sum + getSourceContent(item).length, 0);
    if (!enabled || source.length === 0) {
        return {
            items: source,
            metrics: { enabled: false, beforeChars, afterChars: beforeChars, ratio: 1, keptEvidenceIds: source.map((item) => item.chunkId), fallback: false },
        };
    }
    const tokens = queryTokens(query);
    const items = [];
    let remaining = total;
    for (const candidate of source) {
        if (remaining <= 0) break;
        const content = getSourceContent(candidate);
        if (!content) continue;
        const budget = Math.min(perChunk, remaining);
        const compressed = compactUnitText(splitEvidence(content), budget, tokens);
        const value = compressed || content.slice(0, budget);
        if (!value) continue;
        remaining -= value.length + (items.length > 0 ? 1 : 0);
        items.push({ ...candidate, compressedContent: value });
    }
    let fallback = false;
    if (items.length === 0 && source.length > 0) {
        const first = source[0];
        const value = getSourceContent(first).slice(0, Math.min(perChunk, total));
        if (value) items.push({ ...first, compressedContent: value });
        fallback = true;
    }
    const afterChars = items.reduce((sum, item) => sum + String(item.compressedContent ?? "").length, 0);
    return {
        items,
        metrics: {
            enabled: true,
            beforeChars,
            afterChars,
            ratio: beforeChars > 0 ? afterChars / beforeChars : 1,
            keptEvidenceIds: items.map((item) => item.chunkId),
            fallback,
        },
    };
}

export { DEFAULT_PER_CHUNK_CHARS, DEFAULT_TOTAL_CHARS, splitEvidence };

export default { compressContext };
