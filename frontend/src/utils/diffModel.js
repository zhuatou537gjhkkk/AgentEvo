/**
 * Phase 7 / R7 — unified-diff line model for the CodingAgent change review.
 *
 * DOM-free on purpose so the node test suite can lock parsing/numbering without
 * jsdom (mirrors utils/workspaceModel.js). Two exports:
 *
 *   - parseUnifiedDiff(text): 把原始 git unified-diff 文本解析成一行行的
 *     { type, text, oldLine, newLine }，供 DiffView 按行着色/编号渲染。
 *   - newFileAdditions(text):  新增文件没有 git diff（untracked 不在 diff 里，
 *     前端用 read_file 取全文），这里把全文合成为"整文件新增"的全绿 + 行视图。
 *
 * type 取值：'hdr'（diff --git/index/---/+++ 等头行，渲染时压暗）、'hunk'（@@ 行）、
 * 'add'/'del'/'ctx'。解析失败或非 diff 文本一律退化为 ctx，绝不抛错/白屏。
 */

/** @@ -oldStart[,oldCount] +newStart[,newCount] @@ … */
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** git diff 的文件级/元数据头行前缀（出现在首个 hunk 之前/之间）。 */
const HEADER_RE = /^(diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index |rename (from|to) |copy (from|to) |Binary files |GIT binary patch )/;

/**
 * @param {string} raw
 * @returns {Array<{type:string,text:string,oldLine:number|null,newLine:number|null}>}
 */
export function parseUnifiedDiff(raw) {
    const text = String(raw || "");
    if (!text) return [];

    const out = [];
    let oldCursor = null; // next old-side line number in the current hunk
    let newCursor = null;

    const push = (type, line, oldLine = null, newLine = null) => {
        if (type !== "hdr" && line.endsWith("\r")) line = line.slice(0, -1);
        out.push({ type, text: line, oldLine, newLine });
    };

    for (const line of text.split("\n")) {
        if (line === "") {
            // 空行（如 diff 间空白行）：安全跳过，不推进任何行号。
            continue;
        }
        const hunk = HUNK_RE.exec(line);
        if (hunk) {
            oldCursor = Number(hunk[1]);
            newCursor = Number(hunk[3]);
            push("hunk", line);
            continue;
        }
        if (line.startsWith("+++") || line.startsWith("---")) {
            push("hdr", line);
            continue;
        }
        if (line.startsWith("+")) {
            const ln = newCursor == null ? null : newCursor;
            if (newCursor != null) newCursor += 1;
            push("add", line, null, ln);
            continue;
        }
        if (line.startsWith("-")) {
            const ln = oldCursor == null ? null : oldCursor;
            if (oldCursor != null) oldCursor += 1;
            push("del", line, ln, null);
            continue;
        }
        if (line.startsWith(" ")) {
            push("ctx", line, oldCursor, newCursor);
            if (oldCursor != null) oldCursor += 1;
            if (newCursor != null) newCursor += 1;
            continue;
        }
        if (line.startsWith("\\")) {
            // "\ No newline at end of file" — 附属于上一条 add/del，无自身行号。
            push("ctx", line);
            continue;
        }
        if (HEADER_RE.test(line)) {
            push("hdr", line);
            continue;
        }
        // 无法识别的行（空 diff、或格式异常）：退化为 ctx 原样展示。
        push("ctx", line);
    }
    return out;
}

/**
 * 把新增文件的原始全文合成全绿 + 行。text 是 read_file 拼出来的纯文本
 * （不含 git diff 的 +/- 前缀），因此逐行加上 '+'。
 * @param {string} text
 * @returns {Array<{type:'add',text:string,oldLine:null,newLine:number}>}
 */
export function newFileAdditions(text) {
    const raw = String(text || "");
    if (!raw) return [];
    // read_file 的 body 是 lines.join('\n')，本身不带结尾换行；若确有结尾换行
    // （末行恰为空串），剥掉它再拆，避免多出一行空的合成 +。
    const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    return body.split("\n").map((line, i) => ({
        type: "add",
        text: `+${line}`,
        oldLine: null,
        newLine: i + 1,
    }));
}

/** 行类型 → 渲染类名后缀（DiffView 用）。hdr 也常被调用方整体跳过。 */
export function diffLineKind(type) {
    if (type === "hunk" || type === "add" || type === "del" || type === "hdr" || type === "ctx") {
        return type;
    }
    return "ctx";
}
