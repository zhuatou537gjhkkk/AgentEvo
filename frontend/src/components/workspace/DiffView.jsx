import { parseUnifiedDiff, newFileAdditions } from '../../utils/diffModel';

/**
 * Phase 7 / R7 — 行级着色的 unified diff 渲染（CodingAgent 改动审查用）。
 *
 * mode='diff'：body 是 git unified diff 文本 → 解析成 hunk/add/del/ctx 行，
 *   文件级元数据头（diff --git / index / --- / +++ …）忽略不渲染（路径信息已由
 *   外层文件行提供），避免噪声。
 * mode='new'：body 是新增文件的原始全文（untracked 没有 git diff，前端 read_file
 *   取全文）→ 合成"整文件新增"的全绿 + 行。
 *
 * 行首双列显示 old/new 行号；颜色复用主题 status-* 语义变量，浅色/深色都可读。
 * 不引入第三方 diff 库；滚动/高度保护由外层容器控制。
 */
export default function DiffView({ diff = '', mode = 'diff', truncated = false }) {
    const lines = mode === 'new' ? newFileAdditions(diff) : parseUnifiedDiff(diff);
    const body = lines.filter((l) => l.type !== 'hdr');

    if (body.length === 0) {
        return <div className="ws-diff-empty">（无文本内容）</div>;
    }

    return (
        <div className="ws-diff">
            {body.map((l, i) => (
                <div key={i} className={`ws-diff-line ws-diff-${l.type}`}>
                    <span className="ws-diff-num">{l.oldLine != null ? l.oldLine : ''}</span>
                    <span className="ws-diff-num">{l.newLine != null ? l.newLine : ''}</span>
                    <span className="ws-diff-text">{l.text || ' '}</span>
                </div>
            ))}
            {truncated && <div className="ws-diff-more">…（内容较长，已截断）</div>}
        </div>
    );
}
