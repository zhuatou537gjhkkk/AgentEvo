import { useState } from 'react';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useChatStore } from '../../store/chatStore';
import {
    classifyGitEntry,
    summarizeGitStatus,
    runStatusLabel,
    canOpenWorkspace,
    flattenTreeForDisplay,
} from '../../utils/workspaceModel';

function formatBytes(value) {
    if (value == null) return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function shortId(id) {
    return String(id || '').slice(0, 12);
}

const TAB_STYLES = [
    { key: 'files', label: '文件' },
    { key: 'search', label: '搜索' },
    { key: 'git', label: 'Git' },
    { key: 'run', label: '运行' },
];

// ── project selector + trust + register ──
function ProjectControls() {
    const projects = useWorkspaceStore((s) => s.projects);
    const projectsLoading = useWorkspaceStore((s) => s.projectsLoading);
    const selectedProjectId = useWorkspaceStore((s) => s.selectedProjectId);
    const workspace = useWorkspaceStore((s) => s.workspace);
    const openingProject = useWorkspaceStore((s) => s.openingProject);
    const openError = useWorkspaceStore((s) => s.openError);
    const setSelectedProject = useWorkspaceStore((s) => s.setSelectedProject);
    const setTrusted = useWorkspaceStore((s) => s.setTrusted);
    const revokeProject = useWorkspaceStore((s) => s.revokeProject);
    const registerProject = useWorkspaceStore((s) => s.registerProject);

    const [showRegister, setShowRegister] = useState(false);
    const [name, setName] = useState('');
    const [root, setRoot] = useState('');

    const selected = projects.find((p) => p.id === selectedProjectId) || null;

    const submitRegister = async (event) => {
        event.preventDefault();
        const created = await registerProject({ name, rootPath: root });
        if (created) {
            setName('');
            setRoot('');
            setShowRegister(false);
        }
    };

    return (
        <div className="flex flex-col gap-2 border-b border-[var(--glass-border)] px-3 py-2">
            <div className="flex items-center gap-2">
                <select
                    value={selectedProjectId || ''}
                    onChange={(event) => setSelectedProject(event.target.value)}
                    disabled={projectsLoading}
                    aria-label="选择项目"
                    className="w-full min-w-0 flex-1 rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-2 py-1.5 text-xs text-[var(--text-main)] outline-none"
                >
                    {projects.length === 0 && <option value="">（还没有项目）</option>}
                    {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.name}{p.trusted ? ' ✓' : p.status === 'revoked' ? '（已撤销）' : p.status === 'archived' ? '（已归档）' : ''}
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    onClick={() => setShowRegister((v) => !v)}
                    className="shrink-0 rounded-lg border border-[var(--glass-border)] px-2 py-1.5 text-xs text-[var(--text-muted)] transition hover:bg-[var(--panel-soft)] hover:text-[var(--text-main)]"
                >
                    ＋
                </button>
            </div>

            {showRegister && (
                <form onSubmit={submitRegister} className="flex flex-col gap-1.5">
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="项目名（如 my-repo）"
                        className="rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-2 py-1.5 text-xs text-[var(--text-main)] outline-none"
                    />
                    <input
                        value={root}
                        onChange={(e) => setRoot(e.target.value)}
                        placeholder="本机绝对路径（需位于服务端允许的根目录内）"
                        className="rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-2 py-1.5 text-xs text-[var(--text-main)] outline-none"
                    />
                    <button type="submit" className="btn-gradient rounded-lg px-2 py-1.5 text-xs font-semibold">
                        登记项目
                    </button>
                </form>
            )}

            {selected && (
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-[var(--text-muted)]">当前：</span>
                        <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-main)]" title={selected.rootPath}>
                            {selected.rootPath}
                        </span>
                        {selected.trusted ? (
                            <button
                                type="button"
                                onClick={() => setTrusted(selected.id, false)}
                                className="shrink-0 rounded-md border border-[var(--glass-border)] px-2 py-0.5 text-[0.68rem] text-[var(--text-muted)] transition hover:text-[var(--text-main)]"
                            >
                                取消信任
                            </button>
                        ) : selected.status !== 'revoked' ? (
                            <button
                                type="button"
                                onClick={() => setTrusted(selected.id, true)}
                                className="btn-gradient shrink-0 rounded-md px-2 py-0.5 text-[0.68rem] font-semibold"
                            >
                                信任并打开
                            </button>
                        ) : null}
                        {selected.status !== 'revoked' && (
                            <button
                                type="button"
                                onClick={() => revokeProject(selected.id)}
                                title="撤销项目（不可恢复）"
                                className="shrink-0 rounded-md border border-[var(--glass-border)] px-2 py-0.5 text-[0.68rem] text-[var(--text-muted)] transition hover:text-red-500"
                            >
                                撤销
                            </button>
                        )}
                    </div>
                    {openingProject && <span className="text-[0.68rem] text-[var(--text-muted)]">正在打开...</span>}
                    {openError && <span className="text-[0.68rem] text-red-500">{openError}</span>}
                    {workspace && (
                        <span className="text-[0.68rem] text-[var(--text-muted)]">
                            {workspace.isRepo ? `repo ✓ ${workspace.branch ? `@ ${workspace.branch} ` : ''}${workspace.commit ? shortId(workspace.commit) : ''}` : '非 Git 仓库（只读浏览）'}
                            {' · R1 只读'}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}

// ── file tree / viewer tab ──
function FilesTab() {
    const treeEntries = useWorkspaceStore((s) => s.treeEntries);
    const treeCounts = useWorkspaceStore((s) => s.treeCounts);
    const treeBase = useWorkspaceStore((s) => s.treeBase);
    const treeDepth = useWorkspaceStore((s) => s.treeDepth);
    const treeTruncated = useWorkspaceStore((s) => s.treeTruncated);
    const treeLoading = useWorkspaceStore((s) => s.treeLoading);
    const treeError = useWorkspaceStore((s) => s.treeError);
    const workspace = useWorkspaceStore((s) => s.workspace);
    const loadTree = useWorkspaceStore((s) => s.loadTree);
    const goUpTree = useWorkspaceStore((s) => s.goUpTree);
    const openFile = useWorkspaceStore((s) => s.openFile);
    const attachWholeFile = useWorkspaceStore((s) => s.attachWholeFile);

    const rows = flattenTreeForDisplay(treeEntries);

    const openRow = (row) => {
        if (row.type === 'dir') {
            loadTree(row.rel, treeDepth);
        } else {
            openFile(row.rel, 1);
        }
    };

    return (
        <div className="flex flex-col gap-1.5 p-2">
            <div className="flex items-center gap-1.5 text-[0.68rem] text-[var(--text-muted)]">
                <button type="button" onClick={() => loadTree('', 2)} className="rounded border border-[var(--glass-border)] px-1.5 py-0.5 hover:text-[var(--text-main)]">根</button>
                {treeBase && (
                    <button type="button" onClick={goUpTree} className="rounded border border-[var(--glass-border)] px-1.5 py-0.5 hover:text-[var(--text-main)]">上一级</button>
                )}
                <span className="min-w-0 flex-1 truncate" title={treeBase || '/'}>/{treeBase}</span>
                <button
                    type="button"
                    onClick={() => loadTree(treeBase, treeDepth >= 6 ? 6 : treeDepth + 2)}
                    title="展开更深一层"
                    className="rounded border border-[var(--glass-border)] px-1.5 py-0.5 hover:text-[var(--text-main)]"
                >
                    更深
                </button>
            </div>

            {treeLoading && <div className="py-3 text-center text-xs text-[var(--text-muted)]">加载目录...</div>}
            {treeError && <div className="py-2 text-xs text-red-500">{treeError}</div>}
            {!treeLoading && !treeError && (
                <div className="flex flex-col">
                    {rows.map((row) => (
                        <button
                            type="button"
                            key={row.rel}
                            onClick={() => openRow(row)}
                            className="ws-row-clickable flex items-center gap-1.5 rounded px-1.5 py-[0.19rem] text-left text-xs text-[var(--text-main)]"
                            style={{ paddingLeft: `${8 + row.depth * 13}px` }}
                        >
                            <span aria-hidden="true">{row.type === 'dir' ? '📁' : row.type === 'link' ? '🔗' : '📄'}</span>
                            <span className="min-w-0 flex-1 truncate">{row.name}</span>
                            {row.type === 'file' && (
                                <button
                                    type="button"
                                    title="引用整个文件到对话"
                                    onClick={(event) => { event.stopPropagation(); attachWholeFile(row.rel); }}
                                    className="shrink-0 text-[0.62rem] text-[var(--text-muted)] hover:text-[var(--brand-start)]"
                                >
                                    ＋引用
                                </button>
                            )}
                            {row.size != null && <span className="shrink-0 text-[0.62rem] text-[var(--text-muted)]">{formatBytes(row.size)}</span>}
                        </button>
                    ))}
                    {rows.length === 0 && !treeLoading && (
                        <div className="py-3 text-center text-xs text-[var(--text-muted)]">{workspace ? '（空目录）' : '请先选择并信任项目'}</div>
                    )}
                    {treeTruncated && <div className="pt-1 text-[0.62rem] text-[var(--text-muted)]">已截断，请缩小范围或展开更深层级</div>}
                    {treeCounts && (
                        <div className="pt-1 text-[0.62rem] text-[var(--text-muted)]">
                            {treeCounts.dirs} 目录 · {treeCounts.files} 文件
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function SearchTab() {
    const search = useWorkspaceStore((s) => s.search);
    const runSearch = useWorkspaceStore((s) => s.runSearch);
    const openFile = useWorkspaceStore((s) => s.openFile);
    const attachWholeFile = useWorkspaceStore((s) => s.attachWholeFile);

    return (
        <div className="flex flex-col gap-1.5 p-2">
            <form
                onSubmit={(event) => { event.preventDefault(); runSearch(search.query); }}
                className="flex items-center gap-1.5"
            >
                <input
                    value={search.query}
                    onChange={(e) => { e.preventDefault(); useWorkspaceStore.setState({ search: { ...useWorkspaceStore.getState().search, query: e.target.value } }); }}
                    placeholder="搜文件内容（默认文本，忽略大小写）"
                    className="w-full min-w-0 flex-1 rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-2 py-1.5 text-xs text-[var(--text-main)] outline-none"
                />
                <button type="submit" disabled={search.running} className="btn-gradient shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-60">
                    搜索
                </button>
            </form>
            {search.running && <div className="py-2 text-center text-xs text-[var(--text-muted)]">搜索中...</div>}
            {search.error && <div className="py-1 text-xs text-red-500">{search.error}</div>}
            {!search.running && !search.error && search.results.length === 0 && search.query && (
                <div className="py-2 text-center text-xs text-[var(--text-muted)]">无匹配</div>
            )}
            <div className="flex flex-col">
                {search.results.map((m, index) => (
                    <button
                        type="button"
                        key={`${m.path}:${m.line}:${index}`}
                        onClick={() => openFile(m.path, m.line)}
                        className="ws-row-clickable flex flex-col rounded px-1.5 py-1 text-left"
                    >
                        <span className="truncate text-xs text-[var(--text-main)]">
                            <span className="text-[var(--brand-start)]">{m.path}</span>
                            <span className="text-[var(--text-muted)]">:{m.line}</span>
                        </span>
                        <span className="truncate text-[0.66rem] text-[var(--text-muted)]">{String(m.text || '').trim()}</span>
                    </button>
                ))}
                {search.truncated && <div className="pt-1 text-[0.62rem] text-[var(--text-muted)]">结果已截断（仅展示前 {search.results.length} 条）</div>}
                {!search.running && search.query && (
                    <button
                        type="button"
                        onClick={() => { const m = search.results[0]; if (m) attachWholeFile(m.path); }}
                        className="mt-1 self-start rounded-md border border-[var(--glass-border)] px-2 py-0.5 text-[0.62rem] text-[var(--text-muted)] hover:text-[var(--text-main)]"
                    >
                        引用首个结果全文
                    </button>
                )}
            </div>
        </div>
    );
}

// ── git status / diff tab ──
function GitTab() {
    const git = useWorkspaceStore((s) => s.git);
    const diff = useWorkspaceStore((s) => s.diff);
    const loadGitStatus = useWorkspaceStore((s) => s.loadGitStatus);
    const showDiff = useWorkspaceStore((s) => s.showDiff);

    const summary = summarizeGitStatus(git.status);

    return (
        <div className="flex flex-col gap-1.5 p-2">
            <div className="flex items-center gap-1.5">
                <button type="button" onClick={loadGitStatus} disabled={git.loading} className="btn-gradient rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-60">
                    刷新状态
                </button>
                <button type="button" onClick={() => showDiff(false, null)} className="rounded-lg border border-[var(--glass-border)] px-2 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-main)]">
                    未暂存 diff
                </button>
                <button type="button" onClick={() => showDiff(true, null)} className="rounded-lg border border-[var(--glass-border)] px-2 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-main)]">
                    已暂存 diff
                </button>
            </div>
            {git.error && <div className="text-xs text-red-500">{git.error}</div>}
            {git.loading && <div className="py-1 text-xs text-[var(--text-muted)]">读取 Git 状态...</div>}
            {git.status && !git.error && (
                <div className="flex flex-col gap-1">
                    <div className="text-[0.66rem] text-[var(--text-muted)]">
                        {git.status.branch ? `分支 ${git.status.branch}` : 'detached'} · {git.status.commit ? shortId(git.status.commit) : ''}
                        {' · '}{summary.clean ? '工作区干净' : `${summary.counts.modified} 改 ${summary.counts.added} 增 ${summary.counts.deleted} 删 ${summary.counts.untracked} 未跟踪`}
                    </div>
                    <div className="flex flex-col">
                        {(git.status.entries || []).map((entry, index) => {
                            const cls = classifyGitEntry(entry);
                            return (
                                <button
                                    type="button"
                                    key={`${entry.path}:${index}`}
                                    onClick={() => showDiff(entry.x === 'M' && entry.y !== 'M' ? true : false, entry.path)}
                                    className="ws-row-clickable flex items-center gap-1.5 rounded px-1.5 py-[0.19rem] text-left text-xs"
                                    title={`${cls.title} — 点击查看 diff`}
                                >
                                    <span className="w-4 shrink-0 text-center text-[var(--brand-start)]">{cls.mark}</span>
                                    <span className="min-w-0 flex-1 truncate text-[var(--text-main)]">{cls.path}</span>
                                </button>
                            );
                        })}
                        {(git.status.entries || []).length === 0 && !git.loading && (
                            <div className="py-2 text-center text-xs text-[var(--text-muted)]">没有改动</div>
                        )}
                    </div>
                </div>
            )}

            {diff.loading && <div className="py-1 text-xs text-[var(--text-muted)]">读取 diff...</div>}
            {diff.error && <div className="text-xs text-red-500">{diff.error}</div>}
            {!diff.loading && !diff.error && diff.text && (
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-1 text-[0.66rem] text-[var(--text-muted)]">
                        <span>diff {diff.staged ? '(已暂存)' : '(未暂存)'} {diff.path ? `— ${diff.path}` : ''}</span>
                        {diff.filesChanged.length > 0 && <span>· {diff.filesChanged.length} 个文件</span>}
                        {diff.truncated && <span>· 已截断</span>}
                        <span>· {formatBytes(diff.byteLength)}</span>
                    </div>
                    <div className="ws-code-block max-h-56 overflow-auto rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] p-2 text-[var(--text-main)]">
                        {diff.text}
                    </div>
                </div>
            )}
        </div>
    );
}

// ── observe run tab ──
function RunTab() {
    const runs = useWorkspaceStore((s) => s.runs);
    const runEvents = useWorkspaceStore((s) => s.runEvents);
    const runActionId = useWorkspaceStore((s) => s.runActionId);
    const workspace = useWorkspaceStore((s) => s.workspace);
    const loadRuns = useWorkspaceStore((s) => s.loadRuns);
    const createObserveRun = useWorkspaceStore((s) => s.createObserveRun);
    const toggleRunStart = useWorkspaceStore((s) => s.toggleRunStart);
    const loadRunEvents = useWorkspaceStore((s) => s.loadRunEvents);

    const currentSessionId = useChatStore((s) => s.currentSessionId);

    const eventSummary = (event) => {
        try {
            const payload = event?.payload;
            if (payload && typeof payload === 'object') {
                const text = payload.message || payload.summary || Object.keys(payload).map((k) => `${k}=${typeof payload[k] === 'object' ? JSON.stringify(payload[k]) : payload[k]}`).join(' ');
                return text || event?.type || '';
            }
        } catch { /* fall through */ }
        return String(event?.type || '');
    };

    return (
        <div className="flex flex-col gap-1.5 p-2">
            <div className="flex items-center gap-1.5">
                <button
                    type="button"
                    disabled={!workspace}
                    onClick={() => createObserveRun(currentSessionId)}
                    title={workspace ? '创建一条 observe run（R0 仅记录快照，不执行代码）' : '请先打开并信任项目'}
                    className="btn-gradient rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                >
                    ＋ 新建 observe run
                </button>
                <button type="button" onClick={loadRuns} disabled={runs.loading} className="rounded-lg border border-[var(--glass-border)] px-2 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-main)]">
                    刷新
                </button>
            </div>
            {runs.error && <div className="text-xs text-red-500">{runs.error}</div>}
            <div className="flex flex-col">
                {runs.items.map((run) => {
                    const terminal = ['completed', 'failed', 'cancelled'].includes(String(run.status));
                    const active = run.status === 'running';
                    const busy = runActionId === run.id;
                    return (
                        <div key={run.id} className="flex flex-col gap-0.5 rounded-lg border border-[var(--glass-border)] px-2 py-1.5">
                            <div className="flex items-center gap-1.5 text-xs">
                                <span className="text-[var(--text-main)]">{shortId(run.id)}</span>
                                <span className="text-[var(--text-muted)]">{run.mode}</span>
                                <span className={`rounded px-1 text-[0.62rem] ${terminal ? 'bg-[var(--panel-soft)] text-[var(--text-muted)]' : active ? 'text-[var(--brand-start)]' : 'text-[var(--text-muted)]'}`}>
                                    {runStatusLabel(run.status)}
                                </span>
                                <span className="min-w-0 flex-1" />
                                {!terminal && (
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => toggleRunStart(run)}
                                        className="rounded-md border border-[var(--glass-border)] px-1.5 py-0.5 text-[0.62rem] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-50"
                                    >
                                        {active ? '取消' : '启动'}
                                    </button>
                                )}
                            </div>
                            <div className="flex items-center gap-1.5">
                                <span className="text-[0.62rem] text-[var(--text-muted)]">创建 {String(run.createdAt || '').slice(0, 16)}</span>
                                <span className="min-w-0 flex-1" />
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (runEvents.runId === run.id) {
                                            loadRunEvents(run.id);
                                        } else {
                                            loadRunEvents(run.id);
                                        }
                                    }}
                                    className="rounded-md border border-[var(--glass-border)] px-1.5 py-0.5 text-[0.62rem] text-[var(--text-muted)] hover:text-[var(--text-main)]"
                                >
                                    {runEvents.runId === run.id ? '刷新事件' : '事件'}
                                </button>
                            </div>
                            {runEvents.runId === run.id && (
                                <div className="flex flex-col border-t border-[var(--glass-border)] pt-1">
                                    {runEvents.loading && <span className="text-[0.62rem] text-[var(--text-muted)]">加载事件...</span>}
                                    {runEvents.error && <span className="text-[0.62rem] text-red-500">{runEvents.error}</span>}
                                    {runEvents.events.map((event) => (
                                        <div key={event.seq ?? event.id} className="flex items-baseline gap-1.5 py-0.5 text-[0.64rem]">
                                            <span className="w-8 shrink-0 text-right text-[var(--text-muted)]">#{event.seq}</span>
                                            <span className="text-[var(--brand-start)]">{event.type}</span>
                                            <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">{eventSummary(event)}</span>
                                        </div>
                                    ))}
                                    {runEvents.events.length === 0 && !runEvents.loading && (
                                        <span className="text-[0.62rem] text-[var(--text-muted)]">暂无事件</span>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
                {runs.items.length === 0 && !runs.loading && !runs.error && (
                    <div className="py-2 text-center text-xs text-[var(--text-muted)]">
                        {workspace ? '还没有 run，点上方按钮创建（仅记录快照）' : '请先打开并信任项目'}
                    </div>
                )}
            </div>
        </div>
    );
}

// ── bottom file viewer ──
function ViewerPane() {
    const viewer = useWorkspaceStore((s) => s.viewer);
    const openFile = useWorkspaceStore((s) => s.openFile);
    const scrollViewer = useWorkspaceStore((s) => s.scrollViewer);
    const attachCurrentView = useWorkspaceStore((s) => s.attachCurrentView);
    const attach = useWorkspaceStore((s) => s.attach);

    if (!viewer.path) return null;
    const attached = attach && viewer.path ? (attach.refs?.[0]?.path === viewer.path) : false;

    return (
        <div className="flex h-[44%] min-h-0 flex-[0_0_44%] flex-col border-t border-[var(--glass-border)]">
            <div className="flex items-center gap-2 border-b border-[var(--glass-border)] px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-main)]" title={viewer.path}>
                    {viewer.path}
                    <span className="text-[var(--text-muted)]">:{viewer.startLine}-{viewer.endLine}</span>
                </span>
                <span className="text-[0.62rem] text-[var(--text-muted)]">
                    {viewer.byteLength != null ? formatBytes(viewer.byteLength) : ''}{viewer.truncated ? ' · 已截断' : ''}
                </span>
                <button
                    type="button"
                    onClick={() => scrollViewer(-1)}
                    disabled={viewer.startLine <= 1}
                    className="rounded-md border border-[var(--glass-border)] px-1.5 py-0.5 text-[0.64rem] text-[var(--text-muted)] disabled:opacity-40"
                >
                    ←
                </button>
                <button
                    type="button"
                    onClick={() => scrollViewer(1)}
                    disabled={!viewer.truncated}
                    className="rounded-md border border-[var(--glass-border)] px-1.5 py-0.5 text-[0.64rem] text-[var(--text-muted)] disabled:opacity-40"
                >
                    →
                </button>
                <button
                    type="button"
                    onClick={attachCurrentView}
                    disabled={viewer.loading}
                    className={attached
                        ? 'rounded-md border border-[var(--brand-start)] px-2 py-0.5 text-[0.64rem] font-semibold text-[var(--brand-start)]'
                        : 'btn-gradient rounded-md px-2 py-0.5 text-[0.64rem] font-semibold disabled:opacity-50'}
                >
                    {attached ? '已引用 ✓' : '引用到对话'}
                </button>
            </div>
            {viewer.error && <div className="p-2 text-xs text-red-500">{viewer.error}</div>}
            {viewer.loading && <div className="p-2 text-xs text-[var(--text-muted)]">加载文件...</div>}
            {!viewer.error && !viewer.loading && (
                <div className="min-h-0 flex-1 overflow-auto bg-[var(--glass-bg-strong)]">
                    <div className="ws-code-block min-w-max p-2 text-[var(--text-main)]">
                        {viewer.lines.map((line, index) => {
                            const lineNo = viewer.startLine + index;
                            return (
                                <div key={lineNo} className="flex">
                                    <span className="w-10 shrink-0 select-none pr-2 text-right text-[var(--text-muted)]">{lineNo}</span>
                                    <span className="break-all pr-4">{line === '' ? ' ' : line}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

// ── main panel ──
export default function WorkspacePanel({ onClose }) {
    const capabilities = useWorkspaceStore((s) => s.capabilities);
    const capabilitiesLoaded = useWorkspaceStore((s) => s.capabilitiesLoaded);
    const capabilitiesError = useWorkspaceStore((s) => s.capabilitiesError);
    const projectsLoading = useWorkspaceStore((s) => s.projectsLoading);
    const selectedProjectId = useWorkspaceStore((s) => s.selectedProjectId);
    const attach = useWorkspaceStore((s) => s.attach);
    const attachLabel = useWorkspaceStore((s) => s.attachLabel);
    const clearAttach = useWorkspaceStore((s) => s.clearAttach);
    const toastKind = useWorkspaceStore((s) => s.toastKind);
    const toastText = useWorkspaceStore((s) => s.toastText);

    const [tab, setTab] = useState('files');

    const showGate = capabilitiesLoaded && !canOpenWorkspace(capabilities);
    const showEmpty = canOpenWorkspace(capabilities) && !projectsLoading && !selectedProjectId;
    const bodyVisible = canOpenWorkspace(capabilities) && (projectsLoading || selectedProjectId);

    return (
        <aside className="workspace-panel relative z-[5] text-[var(--text-main)]">
            <header className="flex flex-none items-center gap-2 border-b border-[var(--glass-border)] px-3 py-2">
                <span className="text-sm font-semibold">工作区</span>
                {attach && attachLabel && (
                    <span className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-[var(--brand-start)] px-1.5 py-0.5 text-[0.62rem] text-[var(--brand-start)]">
                        <span className="min-w-0 flex-1 truncate" title={attachLabel}>已附加：{attachLabel}</span>
                        <button type="button" onClick={clearAttach} aria-label="清除引用" className="shrink-0 hover:text-red-500">✕</button>
                    </span>
                )}
                <span className="min-w-0 flex-1" />
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="关闭工作区面板"
                    className="rounded-md px-1.5 py-0.5 text-xs text-[var(--text-muted)] hover:bg-[var(--panel-soft)] hover:text-[var(--text-main)]"
                >
                    ✕
                </button>
            </header>

            {!capabilitiesLoaded && (
                <div className="flex-1 p-4 text-center text-xs text-[var(--text-muted)]">正在检查工作区能力...</div>
            )}
            {showGate && (
                <div className="flex-1 space-y-2 p-4 text-xs text-[var(--text-muted)]">
                    {capabilitiesError ? (
                        <>
                            <p className="text-red-500">{capabilitiesError}</p>
                            <p className="text-[0.66rem]">请确认后端已升级到包含 /coding/capabilities 的版本。</p>
                        </>
                    ) : (
                        <>
                            <p>工作区能力当前未启用。</p>
                            <p className="text-[0.66rem]">需在服务端设置 <code className="ws-code-block text-[var(--brand-start)]">CODING_WORKSPACE_ENABLED=true</code> 并配置允许根目录后重启。</p>
                        </>
                    )}
                </div>
            )}
            {showEmpty && (
                <div className="flex-1 p-4 text-center text-xs text-[var(--text-muted)]">
                    还没有项目，点上方 ＋ 登记一个 Git 仓库。
                </div>
            )}

            {bodyVisible && (
                <>
                    <ProjectControls />
                    <nav className="flex flex-none items-center gap-1 border-b border-[var(--glass-border)] px-2 py-1">
                        {TAB_STYLES.map((t) => (
                            <button
                                type="button"
                                key={t.key}
                                onClick={() => setTab(t.key)}
                                className={`rounded-md px-2 py-1 text-xs transition ${tab === t.key ? 'bg-[var(--panel-soft)] font-semibold text-[var(--text-main)]' : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'}`}
                            >
                                {t.label}
                            </button>
                        ))}
                    </nav>
                    <div className="flex min-h-0 flex-1 flex-col">
                        <div className="workspace-panel-scroll">
                            {tab === 'files' && <FilesTab />}
                            {tab === 'search' && <SearchTab />}
                            {tab === 'git' && <GitTab />}
                            {tab === 'run' && <RunTab />}
                        </div>
                        <ViewerPane />
                    </div>
                </>
            )}

            {toastText && (
                <div className={`absolute inset-x-2 bottom-2 z-10 rounded-lg border px-2.5 py-1.5 text-xs backdrop-blur ${toastKind === 'error' ? 'border-red-500/50 bg-red-500/10 text-red-500' : toastKind === 'ok' ? 'border-[var(--glass-border-active)] bg-[var(--surface-elevated)] text-[var(--text-main)]' : 'border-[var(--glass-border)] bg-[var(--surface-elevated)] text-[var(--text-muted)]'}`}>
                    {toastText}
                </div>
            )}
        </aside>
    );
}
