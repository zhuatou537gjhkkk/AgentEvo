import { useState } from 'react';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useChatStore } from '../../store/chatStore';
import {
    classifyGitEntry,
    summarizeGitStatus,
    runStatusLabel,
    canOpenWorkspace,
    flattenTreeForDisplay,
    canWriteToWorkspace,
    canRunCommands,
    presetLabel,
    presetHint,
    worktreeStatusLabel,
    actionStatusMeta,
    approvalStatusMeta,
    isOpenApproval,
    actionToolLabel,
    isCommandAction,
    isFileArtifact,
    artifactChangedFiles,
    gitStatusPaths,
    changedFilesForRun,
    maskSensitiveArgs,
    approvalCommandArgs,
    friendlyWorkspaceError,
    buildRunSummary,
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
            <RunWriteSection />
            <div className="my-1 border-t border-[var(--glass-border)]" />
            <div className="text-[0.68rem] font-semibold text-[var(--text-muted)]">只读快照 run（记录，不执行代码）</div>
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
                {runs.items
                    .filter((r) => String(r.mode || r.preset || 'observe') === 'observe')
                    .map((run) => {
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

// ═══════════════════════════════════════════════════════════
// R2 write-run console (Phase 7 / R2) — run-scoped write/exec.
// The server is authoritative: capability = /coding/capabilities;
// preset policy (observe/edit/trusted) decides whether a write pauses
// awaiting_approval or auto-executes. Live op args live only in
// pendingRunOps (client memory) so approve→execute re-sends the same args.
// ═══════════════════════════════════════════════════════════

const TONE_TEXT = {
    ok: 'text-emerald-500',
    error: 'text-red-500',
    warn: 'text-amber-400',
    accent: 'text-[var(--brand-start)]',
    muted: 'text-[var(--text-muted)]',
};

function ToneChip({ tone = 'muted', children }) {
    return <span className={`shrink-0 rounded bg-[var(--panel-soft)] px-1 py-px text-[0.62rem] ${TONE_TEXT[tone] || TONE_TEXT.muted}`}>{children}</span>;
}

function isRunActive(status) {
    return ['running', 'executing', 'waiting_approval', 'planning', 'preparing', 'verifying'].includes(String(status || ''));
}

function isRunTerminal(status) {
    return ['completed', 'failed', 'cancelled'].includes(String(status || ''));
}

/** Approval card for one open (requested) approval with 批准/拒绝/批准并执行. */
function RunApprovalQueue({ runId }) {
    const runApprovals = useWorkspaceStore((s) => s.runApprovals);
    const runOpsBusy = useWorkspaceStore((s) => s.runOpsBusy);
    const pendingRunOps = useWorkspaceStore((s) => s.pendingRunOps);
    const decideRunApproval = useWorkspaceStore((s) => s.decideRunApproval);
    const approveAndExecuteRunOp = useWorkspaceStore((s) => s.approveAndExecuteRunOp);
    const reloadRunApprovals = useWorkspaceStore((s) => s.reloadRunApprovals);

    const open = runApprovals.items.filter((a) => isOpenApproval(a));
    if (open.length === 0) return null;

    const actionFor = (approval) => {
        const s = useWorkspaceStore.getState();
        return (s.runActions.items || []).find((a) => a.id === approval.actionId) || null;
    };

    const describe = (action, approval) => {
        if (action && isCommandAction(action)) {
            const safe = approvalCommandArgs(action);
            const args = Array.isArray(safe.args) ? safe.args : [];
            return `命令 ${safe.executable || '?'} ${args.join(' ')}`;
        }
        return `文件 ${action?.input?.path || approval?.reason || '未知路径'}`;
    };

    return (
        <div className="flex flex-col gap-1">
            <div className="text-[0.66rem] text-[var(--text-muted)]">审批队列（{open.length}）</div>
            {open.map((approval) => {
                const action = actionFor(approval);
                const meta = approvalStatusMeta(approval.status);
                const held = pendingRunOps[runId];
                const canResume = held && held.approvalId === approval.id;
                const busy = runOpsBusy;
                return (
                    <div key={approval.id} className="flex flex-col gap-1 rounded-lg border border-amber-400/30 bg-[var(--panel-soft)] px-2 py-1.5">
                        <div className="flex items-center gap-1.5 text-xs">
                            <ToneChip tone={meta.tone}>{meta.label}</ToneChip>
                            <span className="text-[0.62rem] text-[var(--text-muted)]">{action ? actionToolLabel(action.tool) : '操作'}</span>
                            <span className="min-w-0 flex-1" />
                        </div>
                        <div className="break-all text-xs text-[var(--text-main)]">{describe(action, approval)}</div>
                        {approval.reason && <div className="break-all text-[0.62rem] text-[var(--text-muted)]">原因：{approval.reason}</div>}
                        <div className="flex flex-wrap items-center gap-1.5">
                            {canResume && (
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => approveAndExecuteRunOp(runId, held.actionId)}
                                    className="btn-gradient rounded-md px-2 py-0.5 text-[0.64rem] font-semibold disabled:opacity-50"
                                >
                                    批准并执行
                                </button>
                            )}
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => decideRunApproval(runId, approval.id, true)}
                                className="rounded-md border border-[var(--glass-border)] px-2 py-0.5 text-[0.64rem] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-50"
                            >
                                仅批准
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => decideRunApproval(runId, approval.id, false)}
                                className="rounded-md border border-[var(--glass-border)] px-2 py-0.5 text-[0.64rem] text-[var(--text-muted)] hover:text-red-500 disabled:opacity-50"
                            >
                                拒绝
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => reloadRunApprovals(runId)}
                                title="刷新审批状态"
                                className="rounded-md border border-[var(--glass-border)] px-1.5 py-0.5 text-[0.62rem] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-50"
                            >
                                ⟳
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

/** Actions ledger — each action row with its status chip. */
function RunActionsLedger({ runId }) {
    const runActions = useWorkspaceStore((s) => s.runActions);
    const pendingRunOps = useWorkspaceStore((s) => s.pendingRunOps);
    const reloadRunActions = useWorkspaceStore((s) => s.reloadRunActions);

    const pending = pendingRunOps[runId];
    const reconnectLoss = runActions.items.filter(
        (a) => a.status === 'approved' && !(pending && pending.actionId === a.id),
    );

    const describe = (action) => {
        if (!action) return '';
        if (isCommandAction(action)) {
            const safe = approvalCommandArgs(action);
            const args = Array.isArray(safe.args) ? safe.args : [];
            return `${safe.executable || '?'} ${args.join(' ')}`;
        }
        return String(action.input?.path || action.input?.op || action.tool || '');
    };

    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-[0.66rem] text-[var(--text-muted)]">
                <span>已执行操作（{runActions.items.length}）</span>
                <button type="button" onClick={() => reloadRunActions(runId)} className="rounded border border-[var(--glass-border)] px-1 py-px text-[0.6rem] hover:text-[var(--text-main)]">刷新</button>
            </div>
            {reconnectLoss.length > 0 && (
                <div className="rounded border border-amber-400/30 bg-[var(--panel-soft)] px-1.5 py-1 text-[0.62rem] text-amber-400">
                    {reconnectLoss.length} 个已批准但未执行的操作：实时参数不落库，重连后需重新发起该操作以执行。
                </div>
            )}
            <div className="flex max-h-40 flex-col overflow-auto">
                {runActions.items.map((action) => {
                    const meta = actionStatusMeta(action.status);
                    return (
                        <div key={action.id} className="flex items-center gap-1.5 py-0.5 text-xs">
                            <ToneChip tone={meta.tone}>{meta.label}</ToneChip>
                            <span className="text-[0.62rem] text-[var(--text-muted)]">{actionToolLabel(action.tool)}</span>
                            <span className="min-w-0 flex-1 truncate text-[var(--text-main)]" title={describe(action)}>
                                {describe(action)}
                            </span>
                        </div>
                    );
                })}
                {runActions.items.length === 0 && <div className="py-1 text-[0.62rem] text-[var(--text-muted)]">还没有操作</div>}
            </div>
        </div>
    );
}

/** Artifacts + changed-files (union of file-artifact paths and git status/diff). */
function RunArtifactsBlock({ runId, readEnabled }) {
    const runArtifacts = useWorkspaceStore((s) => s.runArtifacts);
    const runGit = useWorkspaceStore((s) => s.runGit);
    const runDiff = useWorkspaceStore((s) => s.runDiff);
    const readRunFile = useWorkspaceStore((s) => s.readRunFile);
    const showRunDiff = useWorkspaceStore((s) => s.showRunDiff);
    const reloadRunArtifacts = useWorkspaceStore((s) => s.reloadRunArtifacts);

    const fileArts = runArtifacts.items.filter((a) => isFileArtifact(a));
    const cmdArts = runArtifacts.items.filter((a) => !isFileArtifact(a));
    const changed = [
        ...new Set([
            ...artifactChangedFiles(runArtifacts.items),
            ...gitStatusPaths(runGit.status),
            ...(runDiff.filesChanged || []),
        ]),
    ];

    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-[0.66rem] text-[var(--text-muted)]">
                <span>产物（{fileArts.length} 文件 · {cmdArts.length} 命令）</span>
                <button type="button" onClick={() => reloadRunArtifacts(runId)} className="rounded border border-[var(--glass-border)] px-1 py-px text-[0.6rem] hover:text-[var(--text-main)]">刷新</button>
            </div>
            <div className="flex flex-wrap gap-1">
                {fileArts.slice(-12).map((a) => (
                    <span key={a.id} title={`${a.kind} · ${a.path}`} className="max-w-full truncate rounded bg-[var(--panel-soft)] px-1.5 py-px text-[0.62rem] text-emerald-500">
                        {a.path}
                    </span>
                ))}
                {cmdArts.slice(-4).map((a) => (
                    <span key={a.id} title={`command · ${a.meta?.executable || ''} exit=${a.meta?.exitCode ?? ''}`} className="rounded bg-[var(--panel-soft)] px-1.5 py-px text-[0.62rem] text-[var(--brand-start)]">
                        ⌘ {a.meta?.executable || '?'}
                    </span>
                ))}
            </div>
            <div className="flex flex-col gap-0.5">
                {changed.length > 0 && (
                    <div className="text-[0.66rem] text-[var(--text-muted)]">改动文件（{changed.length}）：</div>
                )}
                {changed.map((path) => (
                    <div key={path} className="flex items-center gap-1.5 text-[0.64rem]">
                        <span className="min-w-0 flex-1 truncate text-[var(--text-main)]">{path}</span>
                        <button
                            type="button"
                            disabled={!readEnabled}
                            onClick={() => readRunFile(runId, path, 1)}
                            className="shrink-0 rounded border border-[var(--glass-border)] px-1 py-px text-[0.6rem] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-40"
                        >
                            读
                        </button>
                        <button
                            type="button"
                            disabled={!readEnabled}
                            onClick={() => showRunDiff(runId, path)}
                            className="shrink-0 rounded border border-[var(--glass-border)] px-1 py-px text-[0.6rem] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-40"
                        >
                            diff
                        </button>
                    </div>
                ))}
                {changed.length === 0 && <div className="text-[0.62rem] text-[var(--text-muted)]">没有可显示的改动</div>}
            </div>
        </div>
    );
}

/** Final client-side run-summary card (built from buildRunSummary). */
function RunSummaryCard({ run }) {
    const runActions = useWorkspaceStore((s) => s.runActions);
    const runApprovals = useWorkspaceStore((s) => s.runApprovals);
    const runArtifacts = useWorkspaceStore((s) => s.runArtifacts);
    const runGit = useWorkspaceStore((s) => s.runGit);
    const lastCommandOutputs = useWorkspaceStore((s) => s.lastCommandOutputs);

    const s = buildRunSummary({
        run,
        actions: runActions.items,
        approvals: runApprovals.items,
        artifacts: runArtifacts.items,
        gitStatus: runGit.status,
        commandOutputs: lastCommandOutputs.filter((o) => o.runId === run.id),
    });

    return (
        <div className="flex flex-col gap-1 rounded-lg border border-[var(--glass-border-active)] bg-[var(--surface-elevated)] px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-xs">
                <ToneChip tone={run.status === 'completed' ? 'ok' : 'error'}>{runStatusLabel(run.status)}</ToneChip>
                <span className="text-[var(--text-main)]">run 总结</span>
                <span className="min-w-0 flex-1" />
                <span className="text-[0.62rem] text-[var(--text-muted)]">{presetLabel(s.preset)}</span>
            </div>
            <div className="text-[0.66rem] text-[var(--text-muted)]">
                执行 {s.counts.executed} · 失败 {s.counts.failed} · 批准 {s.counts.approved} · 拒绝 {s.counts.denied} · 改动 {s.counts.changedFiles} 文件
            </div>
            {s.changedFiles.length > 0 && (
                <div className="max-h-24 overflow-auto text-[0.64rem]">
                    {s.changedFiles.map((p) => <div key={p} className="truncate text-[var(--text-main)]">{p}</div>)}
                </div>
            )}
            {s.commandOutputs.length > 0 && (
                <div className="flex flex-col gap-0.5 border-t border-[var(--glass-border)] pt-1 text-[0.62rem]">
                    <span className="text-[var(--text-muted)]">最近命令输出：</span>
                    {s.commandOutputs.map((o, i) => (
                        <div key={i} className="text-[var(--text-muted)]">
                            {o.executable} → exit {o.code ?? '?'}{o.timedOut ? '（超时）' : ''}{o.cancelled ? '（已取消）' : ''}
                            {o.stdout ? `：${o.stdout}` : ''}{o.stderr ? ` stderr：${o.stderr}` : ''}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/** Run-scoped reads: git.status / git.diff + runDiff frame. */
function RunGitReadBlock({ runId, readEnabled }) {
    const runGit = useWorkspaceStore((s) => s.runGit);
    const runDiff = useWorkspaceStore((s) => s.runDiff);
    const refreshRunGit = useWorkspaceStore((s) => s.refreshRunGit);
    const showRunDiff = useWorkspaceStore((s) => s.showRunDiff);

    const summary = summarizeGitStatus(runGit.status);

    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
                <button
                    type="button"
                    disabled={!readEnabled || runGit.loading}
                    onClick={() => refreshRunGit(runId)}
                    className="rounded-lg border border-[var(--glass-border)] px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-50"
                >
                    Git 状态 + diff
                </button>
            </div>
            {runGit.error && <div className="text-xs text-red-500">{runGit.error}</div>}
            {runGit.status && !runGit.error && (
                <div className="text-[0.66rem] text-[var(--text-muted)]">
                    {runGit.status.branch ? `分支 ${runGit.status.branch}` : 'detached'}
                    {runGit.status.commit ? ` · ${shortId(runGit.status.commit)}` : ''}
                    {' · '}{summary.clean ? '干净' : `${summary.counts.modified} 改 ${summary.counts.added} 增 ${summary.counts.deleted} 删 ${summary.counts.untracked} 未跟踪`}
                </div>
            )}
            <div className="flex flex-col">
                {(runGit.status?.entries || []).map((entry, index) => {
                    const cls = classifyGitEntry(entry);
                    return (
                        <button
                            type="button"
                            key={`${entry.path}:${index}`}
                            disabled={!readEnabled}
                            onClick={() => showRunDiff(runId, entry.path)}
                            title={`${cls.title} — 点击查看 diff`}
                            className="ws-row-clickable flex items-center gap-1.5 rounded px-1.5 py-px text-left text-[0.64rem] disabled:opacity-40"
                        >
                            <span className="w-4 shrink-0 text-center text-[var(--brand-start)]">{cls.mark}</span>
                            <span className="min-w-0 flex-1 truncate text-[var(--text-main)]">{cls.path}</span>
                        </button>
                    );
                })}
            </div>
            {runDiff.loading && <div className="py-1 text-xs text-[var(--text-muted)]">读取 diff...</div>}
            {runDiff.error && <div className="text-xs text-red-500">{runDiff.error}</div>}
            {!runDiff.loading && !runDiff.error && runDiff.text && (
                <div className="flex flex-col gap-0.5">
                    <div className="text-[0.62rem] text-[var(--text-muted)]">
                        diff{runDiff.filesChanged.length > 0 ? `（${runDiff.filesChanged.length} 文件）` : ''}{runDiff.truncated ? ' · 已截断' : ''}
                    </div>
                    <div className="ws-code-block max-h-40 overflow-auto rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] p-1.5 text-[var(--text-main)]">
                        {runDiff.text}
                    </div>
                </div>
            )}
        </div>
    );
}

/** File ops: read into editor → write_file; delete_file; apply_patch. */
function RunFileEditOps({ runId, writeEnabled, readEnabled }) {
    const [path, setPath] = useState('');
    const [body, setBody] = useState('');
    const [patch, setPatch] = useState('');
    const [note, setNote] = useState(null);
    const runOpsBusy = useWorkspaceStore((s) => s.runOpsBusy);
    const submitRunOp = useWorkspaceStore((s) => s.submitRunOp);
    const readRunFile = useWorkspaceStore((s) => s.readRunFile);

    const busy = runOpsBusy;

    const readFile = async () => {
        setNote(null);
        if (!path) { setNote({ kind: 'error', text: '先填文件路径' }); return; }
        await readRunFile(runId, path, 1);
        const fv = useWorkspaceStore.getState().runFileView;
        if (fv.error) setNote({ kind: 'error', text: fv.error });
        else {
            setBody((fv.lines || []).join('\n'));
            setNote({ kind: 'ok', text: `已读取 ${fv.lineCount} 行` });
        }
    };

    const writeFile = async () => {
        setNote(null);
        if (!path) { setNote({ kind: 'error', text: '先填文件路径' }); return; }
        const res = await submitRunOp(runId, 'write_file', { path, content: body });
        if (!res?.ok) setNote({ kind: 'error', text: res?.error ? friendlyWorkspaceError(res.error) : '提交失败' });
        else if (res.status === 'awaiting_approval') setNote({ kind: 'warn', text: '已提交审批 — 在上方审批卡批准并执行' });
        else if (res.status === 'executed') setNote({ kind: 'ok', text: '已写入工作树' });
    };

    const deleteFile = async () => {
        setNote(null);
        if (!path) { setNote({ kind: 'error', text: '先填文件路径' }); return; }
        const res = await submitRunOp(runId, 'delete_file', { path });
        if (!res?.ok) setNote({ kind: 'error', text: res?.error ? friendlyWorkspaceError(res.error) : '提交失败' });
        else if (res.status === 'awaiting_approval') setNote({ kind: 'warn', text: '删除已提交审批' });
        else if (res.status === 'executed') { setNote({ kind: 'ok', text: '文件已删除' }); setBody(''); }
    };

    const applyPatch = async () => {
        setNote(null);
        if (!path) { setNote({ kind: 'error', text: '先填文件路径' }); return; }
        if (!patch.trim()) { setNote({ kind: 'error', text: '先粘贴 unified diff' }); return; }
        const res = await submitRunOp(runId, 'apply_patch', { path, patch });
        if (!res?.ok) setNote({ kind: 'error', text: res?.error ? friendlyWorkspaceError(res.error) : '提交失败' });
        else if (res.status === 'awaiting_approval') setNote({ kind: 'warn', text: 'patch 已提交审批' });
        else if (res.status === 'executed') { setNote({ kind: 'ok', text: 'patch 已应用' }); setPatch(''); }
    };

    return (
        <div className="flex flex-col gap-1 rounded-lg border border-[var(--glass-border)] bg-[var(--panel-soft)] px-2 py-1.5">
            <div className="text-[0.66rem] text-[var(--text-muted)]">文件编辑（写工作树）</div>
            <div className="flex items-center gap-1.5">
                <input
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="相对路径，如 src/a.js"
                    className="w-full min-w-0 flex-1 rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-2 py-1 text-xs text-[var(--text-main)] outline-none"
                />
                <button type="button" disabled={!readEnabled || busy} onClick={readFile} className="rounded-md border border-[var(--glass-border)] px-2 py-1 text-[0.64rem] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-40">
                    读取
                </button>
            </div>
            <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="编辑内容（读取后可直接改，再写回）"
                rows={5}
                spellCheck={false}
                className="ws-code-block resize-y rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-2 py-1 font-mono text-[0.66rem] text-[var(--text-main)] outline-none"
            />
            <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" disabled={!writeEnabled || busy} onClick={writeFile} className="btn-gradient rounded-md px-2 py-1 text-[0.64rem] font-semibold disabled:opacity-50">
                    写回 write_file
                </button>
                <button type="button" disabled={!writeEnabled || busy} onClick={deleteFile} className="rounded-md border border-red-500/40 px-2 py-1 text-[0.64rem] text-red-400 hover:text-red-500 disabled:opacity-50">
                    删除文件
                </button>
            </div>
            <textarea
                value={patch}
                onChange={(e) => setPatch(e.target.value)}
                placeholder="可粘贴 unified diff 应用到该文件（apply_patch）"
                rows={3}
                spellCheck={false}
                className="ws-code-block resize-y rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-2 py-1 font-mono text-[0.66rem] text-[var(--text-main)] outline-none"
            />
            <button type="button" disabled={!writeEnabled || busy} onClick={applyPatch} className="self-start rounded-md border border-[var(--glass-border)] px-2 py-1 text-[0.64rem] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-50">
                应用 apply_patch
            </button>
            {note && (
                <div className={`text-[0.62rem] ${note.kind === 'error' ? 'text-red-500' : note.kind === 'warn' ? 'text-amber-400' : 'text-emerald-500'}`}>
                    {note.text}
                </div>
            )}
        </div>
    );
}

/** Command form: structured executable + args[] (+ cwd). */
function RunCommandOps({ runId, writeEnabled }) {
    const [executable, setExecutable] = useState('');
    const [argsText, setArgsText] = useState('');
    const [cwd, setCwd] = useState('');
    const [note, setNote] = useState(null);
    const runOpsBusy = useWorkspaceStore((s) => s.runOpsBusy);
    const capabilities = useWorkspaceStore((s) => s.capabilities);
    const submitRunOp = useWorkspaceStore((s) => s.submitRunOp);
    const lastCommandOutputs = useWorkspaceStore((s) => s.lastCommandOutputs);

    const busy = runOpsBusy;
    const cmdOk = canRunCommands(capabilities);
    const outputs = lastCommandOutputs.filter((o) => o.runId === runId).slice(0, 3);

    const run = async () => {
        setNote(null);
        if (!cmdOk) { setNote({ kind: 'error', text: '服务端未启用命令执行能力（commandTools=false）' }); return; }
        if (!executable.trim()) { setNote({ kind: 'error', text: '先填可执行文件名（如 node / git）' }); return; }
        const args = argsText.trim() ? argsText.trim().split(/\s+/).filter(Boolean) : [];
        const res = await submitRunOp(runId, 'run_command', {
            executable: executable.trim(),
            args,
            cwdRelative: cwd.trim() || '',
        });
        if (!res?.ok) setNote({ kind: 'error', text: res?.error ? friendlyWorkspaceError(res.error) : '提交失败' });
        else if (res.status === 'awaiting_approval') setNote({ kind: 'warn', text: '命令已提交审批 — 在上方审批卡批准并执行' });
        else if (res.status === 'executed') {
            const d = res.data || {};
            setNote({
                kind: d.code === 0 ? 'ok' : 'error',
                text: `exit ${d.code}${d.timedOut ? '（超时）' : ''}${d.cancelled ? '（已取消）' : ''}`,
            });
        }
    };

    return (
        <div className="flex flex-col gap-1 rounded-lg border border-[var(--glass-border)] bg-[var(--panel-soft)] px-2 py-1.5">
            <div className="text-[0.66rem] text-[var(--text-muted)]">
                运行命令（白名单内，owner 审批）{cmdOk ? '' : ' — 未启用，仅展示'}
            </div>
            {!cmdOk && <div className="text-[0.62rem] text-red-500">服务端未启用命令执行能力，无法提交命令。</div>}
            <div className="flex items-center gap-1.5">
                <input
                    value={executable}
                    onChange={(e) => setExecutable(e.target.value)}
                    placeholder="executable（如 node / git）"
                    className="w-1/3 min-w-0 rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-2 py-1 text-xs text-[var(--text-main)] outline-none"
                />
                <input
                    value={cwd}
                    onChange={(e) => setCwd(e.target.value)}
                    placeholder="cwd（可选，相对工作树根）"
                    className="w-1/4 min-w-0 rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-2 py-1 text-xs text-[var(--text-muted)] outline-none"
                />
                <button type="button" disabled={!writeEnabled || busy || !cmdOk} onClick={run} className="btn-gradient rounded-md px-2 py-1 text-[0.64rem] font-semibold disabled:opacity-50">
                    运行
                </button>
            </div>
            <input
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="参数（空格分隔），如 -e console.log(1+1)"
                className="rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-2 py-1 text-xs text-[var(--text-main)] outline-none"
            />
            {outputs.length > 0 && (
                <div className="flex flex-col gap-0.5 border-t border-[var(--glass-border)] pt-1">
                    <span className="text-[0.6rem] text-[var(--text-muted)]">最近命令（live 输出仅在本次会话保存）：</span>
                    {outputs.map((o, i) => (
                        <div key={i} className="flex flex-col text-[0.62rem] text-[var(--text-muted)]">
                            <span>
                                {o.executable}{o.stdout ? `（exit ${o.code}）：${o.stdout}` : ` exit ${o.code}`}{o.timedOut ? '（超时）' : ''}{o.truncated ? '（已截断）' : ''}
                            </span>
                            {o.stderr && <span className="text-red-400">stderr：{o.stderr}</span>}
                        </div>
                    ))}
                </div>
            )}
            {note && (
                <div className={`text-[0.62rem] ${note.kind === 'error' ? 'text-red-500' : note.kind === 'warn' ? 'text-amber-400' : 'text-emerald-500'}`}>
                    {note.text}
                </div>
            )}
        </div>
    );
}

/** Provision / start / cancel row for the selected run. */
function RunLifecycleBar({ run }) {
    const runOpsBusy = useWorkspaceStore((s) => s.runOpsBusy);
    const provisionRun = useWorkspaceStore((s) => s.provisionRun);
    const teardownRun = useWorkspaceStore((s) => s.teardownRun);
    const runStart = useWorkspaceStore((s) => s.runStart);
    const runCancel = useWorkspaceStore((s) => s.runCancel);
    const refreshRunDetail = useWorkspaceStore((s) => s.refreshRunDetail);
    const loadRuns = useWorkspaceStore((s) => s.loadRuns);

    const busy = runOpsBusy;
    const terminal = isRunTerminal(run.status);
    const active = isRunActive(run.status);
    const unsupported = run.worktreeStatus === 'unsupported';
    const ready = run.worktreeStatus === 'ready';

    const refreshAll = async () => {
        await refreshRunDetail(run.id);
        await loadRuns();
    };

    return (
        <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
                {!terminal && run.status === 'created' && (
                    <button type="button" disabled={busy} onClick={async () => { await runStart(run.id); await refreshAll(); }} className="btn-gradient rounded-md px-2 py-1 text-[0.64rem] font-semibold disabled:opacity-50">
                        启动 run
                    </button>
                )}
                {!terminal && !unsupported && !ready && (
                    <button type="button" disabled={busy} onClick={async () => { await provisionRun(run.id); await refreshAll(); }} className="btn-gradient rounded-md px-2 py-1 text-[0.64rem] font-semibold disabled:opacity-50">
                        准备工作树
                    </button>
                )}
                {!terminal && ready && (
                    <button type="button" disabled={busy} onClick={async () => { await teardownRun(run.id); await refreshAll(); }} className="rounded-md border border-[var(--glass-border)] px-2 py-1 text-[0.64rem] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-50">
                        拆除工作树
                    </button>
                )}
                {!terminal && (active || run.status === 'created') && (
                    <button type="button" disabled={busy} onClick={async () => { await runCancel(run.id); await refreshAll(); }} className="rounded-md border border-red-500/40 px-2 py-1 text-[0.64rem] text-red-400 hover:text-red-500 disabled:opacity-50">
                        取消 run
                    </button>
                )}
                {!terminal && (
                    <button type="button" disabled={busy} onClick={refreshAll} className="rounded-md border border-[var(--glass-border)] px-2 py-1 text-[0.64rem] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-50">
                        ⟳ 刷新（重连）
                    </button>
                )}
            </div>
            {unsupported && (
                <div className="rounded border border-red-500/30 bg-[var(--panel-soft)] px-1.5 py-1 text-[0.62rem] text-red-500">
                    该项目不是 Git 工作树顶层（worktreeStatus=unsupported）：保持只读，无法写入/执行。
                </div>
            )}
            {ready && (
                <div className="flex items-center gap-1.5 text-[0.62rem] text-[var(--text-muted)]">
                    <span className="rounded bg-[var(--panel-soft)] px-1 text-emerald-500">工作树就绪</span>
                    {run.worktreeBranch && <span>分支 {run.worktreeBranch}</span>}
                    {run.baseBranch && <span>· base {run.baseBranch}</span>}
                    {run.baseCommit && <span>@ {shortId(run.baseCommit)}</span>}
                </div>
            )}
        </div>
    );
}

/** Console for the selected write-run (mirrors server-authoritative run state). */
function RunWriteConsole() {
    const selectedRunId = useWorkspaceStore((s) => s.selectedRunId);
    const runDetail = useWorkspaceStore((s) => s.runDetail);
    const runDetailLoading = useWorkspaceStore((s) => s.runDetailLoading);
    const runDetailError = useWorkspaceStore((s) => s.runDetailError);
    const runOpsBusy = useWorkspaceStore((s) => s.runOpsBusy);
    const runs = useWorkspaceStore((s) => s.runs);
    const capabilities = useWorkspaceStore((s) => s.capabilities);
    const openRunDetail = useWorkspaceStore((s) => s.openRunDetail);

    const run = runDetail || runs.items.find((r) => r.id === selectedRunId) || null;
    if (!selectedRunId || (!run && !runDetailLoading)) {
        return (
            <div className="rounded border border-[var(--glass-border)] bg-[var(--panel-soft)] px-2 py-1.5 text-[0.64rem] text-[var(--text-muted)]">
                点上方某个写 run 打开控制台，或新建一个。写 run 在独立工作树里操作，不碰你的主 checkout。
            </div>
        );
    }
    if (!run && runDetailLoading) {
        return <div className="py-2 text-center text-xs text-[var(--text-muted)]">加载 run 详情...</div>;
    }
    if (!run) {
        return <div className="py-2 text-center text-xs text-red-500">{runDetailError || 'run 不存在或已被移除'}</div>;
    }

    const terminal = isRunTerminal(run.status);
    const writeMode = ['edit', 'trusted'].includes(String(run.mode || run.preset));
    const ready = run.worktreeStatus === 'ready';
    const unsupported = run.worktreeStatus === 'unsupported';
    const canWrite = canWriteToWorkspace(capabilities);
    const canCmd = canRunCommands(capabilities);
    const writeEnabled = Boolean(writeMode && canWrite && ready && !terminal && !unsupported);
    const readEnabled = Boolean(!terminal);
    const cmdEnabled = writeEnabled && canCmd;

    return (
        <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--glass-border-active)] bg-[var(--surface-elevated)] px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-xs">
                <span className="text-[var(--text-main)]">{shortId(run.id)}</span>
                <ToneChip tone="accent">{presetLabel(run.mode || run.preset)}</ToneChip>
                <ToneChip tone={run.status === 'waiting_approval' ? 'warn' : 'muted'}>{runStatusLabel(run.status)}</ToneChip>
                <span className="min-w-0 flex-1" />
                {!terminal && (
                    <button type="button" onClick={() => openRunDetail(run.id)} title="重新拉取该 run 全部状态" className="rounded-md border border-[var(--glass-border)] px-1.5 py-0.5 text-[0.6rem] text-[var(--text-muted)] hover:text-[var(--text-main)]">
                        ⟳ 重连刷新
                    </button>
                )}
            </div>

            <RunLifecycleBar run={run} />
            <RunApprovalQueue runId={run.id} />

            {!terminal && writeEnabled && (
                <RunFileEditOps key={run.id} runId={run.id} writeEnabled={writeEnabled} readEnabled={readEnabled} />
            )}
            {!terminal && cmdEnabled && (
                <RunCommandOps key={run.id} runId={run.id} writeEnabled={writeEnabled} />
            )}
            {!terminal && !writeEnabled && !unsupported && (
                <div className="text-[0.62rem] text-[var(--text-muted)]">
                    尚未就绪（工作树状态 {worktreeStatusLabel(run.worktreeStatus)}）：先在工作树就绪后即可编辑文件 / 执行命令。
                </div>
            )}

            {!terminal && (
                <>
                    <RunGitReadBlock runId={run.id} readEnabled={readEnabled} />
                    <RunArtifactsBlock runId={run.id} readEnabled={readEnabled} />
                    <RunActionsLedger runId={run.id} />
                </>
            )}

            {terminal && <RunSummaryCard run={run} />}
        </div>
    );
}

/** R2 write-run section: create (edit/trusted) + picker + console. */
function RunWriteSection() {
    const capabilities = useWorkspaceStore((s) => s.capabilities);
    const projects = useWorkspaceStore((s) => s.projects);
    const selectedProjectId = useWorkspaceStore((s) => s.selectedProjectId);
    const workspace = useWorkspaceStore((s) => s.workspace);
    const runs = useWorkspaceStore((s) => s.runs);
    const selectedRunId = useWorkspaceStore((s) => s.selectedRunId);
    const createWriteRun = useWorkspaceStore((s) => s.createWriteRun);
    const openRunDetail = useWorkspaceStore((s) => s.openRunDetail);
    const loadRuns = useWorkspaceStore((s) => s.loadRuns);

    const canWrite = canWriteToWorkspace(capabilities);
    const selected = projects.find((p) => p.id === selectedProjectId) || null;
    const writeRuns = runs.items.filter((r) => ['edit', 'trusted'].includes(String(r.mode || r.preset)));
    const canCreate = Boolean(canWrite && workspace && selected?.trusted);

    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 text-[0.68rem] font-semibold text-[var(--brand-start)]">
                <span>写 run 控制台</span>
                <span className="min-w-0 flex-1" />
                <button type="button" onClick={loadRuns} disabled={runs.loading} className="rounded-md border border-[var(--glass-border)] px-1.5 py-0.5 text-[0.6rem] font-normal text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-50">
                    刷新列表
                </button>
            </div>
            {!canWrite && (
                <div className="rounded border border-red-500/30 bg-[var(--panel-soft)] px-1.5 py-1 text-[0.62rem] text-red-500">
                    服务端未启用文件写入工具（CODING_WRITE_TOOLS_ENABLED=false）：无法创建写 run，本区仅读。
                </div>
            )}
            {canWrite && canCreate && (
                <div className="flex flex-wrap items-center gap-1.5">
                    <button
                        type="button"
                        disabled={runs.loading}
                        onClick={() => createWriteRun('edit')}
                        title={presetHint('edit')}
                        className="btn-gradient rounded-md px-2 py-1 text-[0.64rem] font-semibold disabled:opacity-50"
                    >
                        ＋ edit run（审批）
                    </button>
                    <button
                        type="button"
                        disabled={runs.loading}
                        onClick={() => createWriteRun('trusted')}
                        title={presetHint('trusted')}
                        className="rounded-md border border-[var(--brand-start)] px-2 py-1 text-[0.64rem] text-[var(--brand-start)] hover:bg-[var(--panel-soft)] disabled:opacity-50"
                    >
                        ＋ trusted run（自动）
                    </button>
                </div>
            )}
            {canWrite && !canCreate && (
                <div className="text-[0.62rem] text-[var(--text-muted)]">需先在上方“信任并打开”一个 Git 项目（observe 仅读；edit/trusted 写入独立工作树）。</div>
            )}
            {writeRuns.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {writeRuns.map((run) => {
                        const sel = run.id === selectedRunId;
                        return (
                            <button
                                type="button"
                                key={run.id}
                                onClick={() => openRunDetail(run.id)}
                                title={run.worktreeStatus === 'ready' ? `工作树 ${run.worktreeBranch || ''}` : `工作树状态 ${worktreeStatusLabel(run.worktreeStatus)}`}
                                className={`rounded-md border px-1.5 py-0.5 text-[0.62rem] ${sel ? 'border-[var(--brand-start)] bg-[var(--panel-soft)] text-[var(--brand-start)]' : 'border-[var(--glass-border)] text-[var(--text-muted)] hover:text-[var(--text-main)]'}`}
                            >
                                {shortId(run.id)}·{presetLabel(run.mode || run.preset)}·{runStatusLabel(run.status)}
                            </button>
                        );
                    })}
                </div>
            )}
            {writeRuns.length === 0 && !runs.loading && (
                <div className="text-[0.62rem] text-[var(--text-muted)]">还没有写 run，点上方按钮新建（会先进入审批态而非直接执行）。</div>
            )}
            <RunWriteConsole />
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
