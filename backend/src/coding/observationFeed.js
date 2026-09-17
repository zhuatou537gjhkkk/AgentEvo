/**
 * Phase 7 / R5 — ObservationFeed: a bounded, in-memory feed that lets a real
 * LLM decider "see" the content of the read ops it issues.
 *
 * The bounded loop (codingAgent.js) executes read ops but deliberately never
 * puts file content into its durable/transcript summary (maxTranscriptChars is a
 * "never file content" bound). That leaves a model-driven decider blind: it can
 * issue `read_file` but never learns what it read. This module renders read-op
 * payloads into compact text snippets and keeps a small sliding window so each
 * `decide(ctx)` call can see the recent repo state the decider itself produced.
 *
 * IN-MEMORY ONLY: this feed lives on the in-memory CodeAgentService session and
 * is never written to the DB, never enters steps/transcriptChars/finalResult,
 * and never reaches an action/approval/artifact row. Reads still count against
 * budgets and still append op steps exactly as before.
 *
 * Pure + dependency-free so it unit-tests without any runner/filesystem.
 */

export const OBS_LIMITS = Object.freeze({
    maxEntries: 10, // ring size (entries kept at most)
    perSnippetChars: 6000, // hard cap for a single rendered op
    maxTotalChars: 32 * 1024, // whole feed cap (oldest dropped first to stay under)
});

function sliceTo(text, cap) {
    const str = String(text == null ? "" : text);
    return str.length > cap ? str.slice(0, cap) : str;
}

function isNonEmptyObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Render a read-op payload into a single bounded text snippet. Returns "" when
 * the payload carries nothing usable (so callers can skip the entry).
 */
export function renderReadObservation(op, data) {
    const cap = OBS_LIMITS.perSnippetChars;
    switch (op) {
        case "read_file": {
            const d = isNonEmptyObject(data) ? data : {};
            const path = String(d.path || "");
            const lines = Array.isArray(d.lines) ? d.lines : [];
            if (lines.length === 0) return ""; // nothing to see → skip the entry
            const start = Number.isFinite(d.startLine) ? Number(d.startLine) : 1;
            const header = `read_file ${path} L${start}-${start + lines.length - 1} (${lines.length} lines${d.truncated ? ", truncated" : ""})`;
            const body = lines
                .map((line, i) => `${start + i}|${line}`)
                .join("\n");
            return sliceTo(`${header}\n${body}`, cap);
        }
        case "list_tree": {
            const d = isNonEmptyObject(data) ? data : {};
            const entries = Array.isArray(d.entries) ? d.entries : [];
            if (entries.length === 0) return `list_tree ${String(d.path || "")}: (empty)`;
            const counts = d.counts && typeof d.counts === "object"
                ? d.counts
                : {};
            const header = `list_tree ${String(d.path || "")} (dirs=${counts.dirs ?? 0} files=${counts.files ?? 0} links=${counts.links ?? 0}${d.truncated ? ", truncated" : ""})`;
            const body = entries
                .map((e) => {
                    if (!e || typeof e !== "object") return String(e);
                    const rel = String(e.rel ?? e.name ?? "");
                    if (e.type === "dir") return `[dir] ${rel}`;
                    if (e.type === "link") return `[link] ${rel}`;
                    return e.size == null ? `file ${rel}` : `file ${rel} (${e.size}B)`;
                })
                .join("\n");
            return sliceTo(`${header}\n${body}`, cap);
        }
        case "search_text": {
            const d = isNonEmptyObject(data) ? data : {};
            const matches = Array.isArray(d.matches) ? d.matches : [];
            const header = `search_text "${String(d.query || "")}" in ${String(d.base || ".")} (${matches.length} matches, ${d.filesWithMatches ?? 0} files${d.truncated ? ", truncated" : ""})`;
            if (matches.length === 0) return header;
            const body = matches
                .map((m) => {
                    if (!m || typeof m !== "object") return String(m);
                    return `${String(m.path || "")}:${m.line ?? "?"}: ${String(m.text ?? "")}`;
                })
                .join("\n");
            return sliceTo(`${header}\n${body}`, cap);
        }
        case "git.status": {
            const d = isNonEmptyObject(data) ? data : {};
            const entries = Array.isArray(d.entries) ? d.entries : [];
            const head = `git status branch=${String(d.branch || "")} commit=${String(d.commit || "").slice(0, 8)} ${d.clean ? "clean" : `${entries.length} changed`}${d.truncated ? " (truncated)" : ""}`;
            if (entries.length === 0) return head;
            const body = entries
                .map((e) => {
                    if (!e || typeof e !== "object") return String(e);
                    const x = String(e.x || " ");
                    const y = String(e.y || " ");
                    const target = e.renameTo ? `${e.path} -> ${e.renameTo}` : String(e.path || "");
                    return `${x}${y} ${target}`;
                })
                .join("\n");
            return sliceTo(`${head}\n${body}`, cap);
        }
        case "git.diff": {
            const d = isNonEmptyObject(data) ? data : {};
            const files = Array.isArray(d.filesChanged) ? d.filesChanged : [];
            const head = `git diff ${d.staged ? "(staged) " : ""}${files.length} file(s): ${files.join(", ")}${d.truncated ? " (truncated)" : ""}`;
            if (!d.diff) return head;
            const diffSnippet = sliceTo(String(d.diff), cap);
            return sliceTo(`${head}\n${diffSnippet}`, cap);
        }
        case "git.show_file": {
            const d = isNonEmptyObject(data) ? data : {};
            const path = String(d.path || "");
            if (!path && !d.content) return "";
            const head = `git show @ ${String(d.ref || "HEAD")}:${path}`;
            if (!d.content) return head;
            return sliceTo(`${head}\n${String(d.content)}`, cap);
        }
        default: {
            // Unknown shape (future op) → bounded JSON; never throw.
            try {
                const json = JSON.stringify(data);
                if (json && json !== "{}") return sliceTo(`${String(op)} ${json}`, cap);
            } catch {
                /* circular / non-serializable → fall through */
            }
            const plain = String(data ?? "");
            return plain ? sliceTo(plain, cap) : "";
        }
    }
}

function totalChars(list) {
    let total = 0;
    for (const item of list) total += item.length;
    return total;
}

/**
 * Append one read observation to the feed, evicting the OLDEST entries until both
 * maxEntries and maxTotalChars hold. Returns a NEW array (does not mutate input).
 * @param {string[]} list current feed (strings)
 * @param {{op:string, args?:object, data?:object}} obs
 */
export function pushReadObservation(list, { op, args, data }) {
    const snippet = renderReadObservation(String(op || ""), data);
    if (!snippet) return Array.isArray(list) ? [...list] : [];
    const next = Array.isArray(list) ? [...list, snippet] : [snippet];
    while (next.length > OBS_LIMITS.maxEntries) next.shift();
    while (totalChars(next) > OBS_LIMITS.maxTotalChars && next.length > 1) next.shift();
    return next;
}
