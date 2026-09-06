/**
 * Phase 7 / R4 — code chunking + lexical token primitives.
 *
 * Pure, deterministic, zero-network / zero-LangChain helpers shared by the
 * file-hash incremental indexer (roadmap R4 checklist #5) and the lexical /
 * hybrid retrieval layers (roadmap R4 #6). Everything here is a pure function
 * of its inputs so the indexer and retrievers stay unit-testable without any
 * embedder or provider.
 *
 * R4 DoD alignment:
 *   - line-window chunking keeps 1-based start/end lines so every retrieved
 *     item can cite a valid path/line range (DoD: "path/line citation 有效");
 *   - symbol / path / query tokenizers are what let lexical retrieval hit code
 *     identifiers even when the natural-language query does not embed.
 *
 * Deliberate behaviours:
 *   - splitCodeByLines preserves original '\n' between lines (trailing newline
 *     dropped) so a caller can reconstruct the file text from chunk ranges;
 *   - a single logical line longer than maxChars is hard-sliced into isolated
 *     fragments that all carry startLine === endLine of that original line, so
 *     no chunk ever exceeds maxChars and minified/long lines are still indexed.
 */
const STOPWORDS = new Set([
    // JS/TS keywords + common identifiers with little retrieval value
    "the", "and", "for", "are", "was", "that", "this", "with", "from", "your",
    "you", "all", "can", "may", "will", "than", "then", "which", "while", "when",
    "where", "there", "here", "been", "have", "has", "had", "not", "but", "its",
    "into", "each", "other", "some", "such", "only", "also", "were", "more",
    // JS keywords
    "function", "const", "let", "var", "return", "if", "else", "for", "in",
    "of", "do", "new", "class", "import", "export", "from", "async", "await",
    "try", "catch", "finally", "throw", "typeof", "instanceof", "switch", "case",
    "default", "break", "continue", "extends", "super", "static", "get", "set",
    "this", "null", "true", "false", "undefined", "void", "delete", "yield",
    // Python keywords
    "def", "lambda", "pass", "raise", "except", "with", "as", "global", "nonlocal",
    "assert", "del", "elif", "is", "none", "self", "print", "range", "return",
    "true", "false", "not", "or", "and", "in", "if", "else", "while", "for",
]);

function clampInt(value, fallback, min, max = Infinity) {
    const n = Number(value);
    const v = Number.isFinite(n) ? Math.trunc(n) : fallback;
    return Math.min(max, Math.max(min, v));
}

/**
 * Split code text into deterministic overlapping line windows.
 * @param {string} text
 * @param {{maxLines?:number, overlapLines?:number, maxChars?:number}} [opts]
 * @returns {{content:string,startLine:number,endLine:number}[]} windows (1-based
 *   inclusive lines). Empty input → [].
 */
export function splitCodeByLines(text, { maxLines = 40, overlapLines = 8, maxChars = 4000 } = {}) {
    const maxWin = clampInt(maxLines, 40, 1);
    const overlap = clampInt(overlapLines, 8, 0, maxWin - 1);
    const cap = clampInt(maxChars, 4000, 1);
    const src = String(text ?? "");
    if (src.length === 0) return [];

    const normalized = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    // trailing newline is not an empty logical line
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) return [];

    const chunks = [];
    let i = 0;
    while (i < lines.length) {
        let j = Math.min(lines.length, i + maxWin);
        // never join an oversized line into a window: stop the window at the
        // first oversized line so it is emitted as isolated fragment(s).
        let boundary = j;
        for (let k = i; k < j; k += 1) {
            if (lines[k].length > cap) { boundary = k; break; }
        }
        if (boundary === i) {
            // current line itself is oversized → hard-slice it at maxChars into
            // fragments that all keep startLine === endLine of that line.
            const text = lines[i];
            let offset = 0;
            while (offset < text.length) {
                chunks.push({
                    content: text.slice(offset, offset + cap),
                    startLine: i + 1,
                    endLine: i + 1,
                });
                offset += cap;
            }
            i += 1;
            continue;
        }
        j = boundary;
        // nominal window of up to maxWin lines, shrunk only when the joined text
        // would exceed the maxChars guard (each line here individually fits).
        while (j - i > 1 && joinedLength(lines, i, j) > cap) j -= 1;
        chunks.push({
            content: lines.slice(i, j).join("\n"),
            startLine: i + 1,
            endLine: j,
        });
        if (j >= lines.length) break; // final window covers to the file end
        if (boundary < Math.min(lines.length, i + maxWin)) {
            // window was truncated by an oversized line → advance exactly to it
            // (no overlap may cross an isolated huge line)
            i = j;
        } else {
            let next = j - overlap;
            if (next <= i) next = i + 1; // tiny window / char-cap shrink → progress
            i = next;
        }
    }
    return chunks;
}

function joinedLength(lines, from, to) {
    let len = 0;
    for (let k = from; k < to; k += 1) len += lines[k].length + (k > from ? 1 : 0);
    return len;
}

/**
 * Sorted, unique, lowercase identifier tokens (length ≥ 3) filtered against the
 * stopword set and capped at maxSymbols.
 * @returns {string[]}
 */
export function extractSymbols(text, { maxSymbols = 40 } = {}) {
    const cap = clampInt(maxSymbols, 40, 0);
    const matches = String(text ?? "").match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) || [];
    const seen = new Set();
    const out = [];
    for (const raw of matches) {
        const token = raw.toLowerCase();
        if (STOPWORDS.has(token)) continue;
        if (seen.has(token)) continue;
        seen.add(token);
        out.push(token);
        if (cap > 0 && out.length >= cap) break;
    }
    return out.sort();
}

/**
 * Lowercase tokens extracted from a file path: split on /[\\/._-]/ keeping
 * tokens of length ≥ 2, plus the full basename-minus-extension always.
 * @returns {string[]} sorted unique
 */
export function extractPathTerms(filePath) {
    const fp = String(filePath ?? "");
    if (!fp) return [];
    const parts = String(fp).split(/[\\/._-]+/);
    const set = new Set();
    for (const part of parts) {
        const p = String(part).toLowerCase();
        if (p.length >= 2) set.add(p);
    }
    const base = String(fp).split(/[\\/]+/).pop() || "";
    const baseNoExt = String(base).replace(/\.[^.]+$/, "").toLowerCase();
    if (baseNoExt && baseNoExt.length > 0) set.add(baseNoExt);
    return [...set].sort();
}

function uniquePush(arr, set, value) {
    if (!value) return;
    if (set.has(value)) return;
    set.add(value);
    arr.push(value);
}

/**
 * Deterministic query tokenization for lexical retrieval.
 * @returns {{terms:string[], cjk:string[]}} terms = alnum runs (len ≥ 3,
 *   lowercased); cjk = overlapping 2-grams of each contiguous CJK run.
 */
export function tokenizeQuery(text) {
    const src = String(text ?? "");
    const terms = [];
    const termsSeen = new Set();
    for (const m of src.matchAll(/[A-Za-z0-9]+/g)) {
        const t = m[0].toLowerCase();
        if (t.length >= 3) uniquePush(terms, termsSeen, t);
    }
    const cjk = [];
    const cjkSeen = new Set();
    if (/[一-鿿]/.test(src)) {
        for (const run of src.matchAll(/[一-鿿]+/g)) {
            const chars = run[0];
            for (let i = 0; i + 2 <= chars.length; i += 1) {
                uniquePush(cjk, cjkSeen, chars.slice(i, i + 2));
            }
        }
    }
    return { terms, cjk };
}

export default { splitCodeByLines, extractSymbols, extractPathTerms, tokenizeQuery };
