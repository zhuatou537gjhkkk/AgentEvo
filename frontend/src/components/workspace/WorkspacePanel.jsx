import { useEffect, useRef, useState } from 'react';
import { useWorkspaceStore } from '../../store/workspaceStore';
import DiffView from './DiffView';
import {
    canOpenWorkspace,
    canWriteToWorkspace,
    classifyGitEntry,
    flattenTreeForDisplay,
    friendlyWorkspaceError,
    runStatusLabel,
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

/** 真实仓库 git 状态条的 mark → 颜色（与 CodingAgent 状态徽标同源）。 */
const GIT_MARK_COLOR = {
    A: 'var(--brand-start)',
    M: '#eab308',
    D: '#ef4444',
    R: '#8b5cf6',
    C: '#8b5cf6',
    '?': '#94a3b8',
};

function gitMarkColor(mark) {
    return GIT_MARK_COLOR[String(mark || '')] || 'var(--text-muted)';
}

function ProjectControls() {
    const projects = useWorkspaceStore((s) => s.projects);
    const projectsLoading = useWorkspaceStore((s) => s.projectsLoading);
    const selectedProjectId = useWorkspaceStore((s) => s.selectedProjectId);
    const workspace = useWorkspaceStore((s) => s.workspace);
    const openingProject = useWorkspaceStore((s) => s.openingProject);
    const openError = useWorkspaceStore((s) => s.openError);
    const setSelectedProject = useWorkspaceStore((s) => s.setSelectedProject);
    const setTrusted = useWorkspaceStore((s) => s.setTrusted);
    const registerProject = useWorkspaceStore((s) => s.registerProject);
    const [showRegister, setShowRegister] = useState(false);
    const [name, setName] = useState('');
    const [root, setRoot] = useState('');
    const selected = projects.find((p) => String(p.id) === String(selectedProjectId));

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
        <section className="flex flex-col gap-2 border-b border-[var(--glass-border)] px-3 py-2">
            <div className="flex items-center gap-2">
                <select value={selectedProjectId || ''} onChange={(e) => setSelectedProject(e.target.value)} disabled={projectsLoading} aria-label="选择项目" className="w-full min-w-0 flex-1 rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-2 py-1.5 text-xs text-[var(--text-main)] outline-none">
                    {projects.length === 0 && <option value="">（还没有项目）</option>}
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.trusted ? ' ✓' : ''}</option>)}
                </select>
                <button type="button" onClick={() => setShowRegister((v) => !v)} className="rounded-lg border border-[var(--glass-border)] px-2 py-1.5 text-xs text-[var(--text-muted)]">＋</button>
            </div>
            {showRegister && (
                <form onSubmit={submitRegister} className="flex flex-col gap-1.5">
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="项目名" className="rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-2 py-1.5 text-xs text-[var(--text-main)] outline-none" />
                    <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="本机绝对路径" className="rounded-lg border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-2 py-1.5 text-xs text-[var(--text-main)] outline-none" />
                    <button type="submit" className="btn-gradient rounded-lg px-2 py-1.5 text-xs font-semibold">登记项目</button>
                </form>
            )}
            {selected && (
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]" title={selected.rootPath}>{selected.rootPath}</span>
                        <button type="button" onClick={() => setTrusted(selected.id, !selected.trusted)} className={`${selected.trusted ? 'border-[var(--glass-border)] text-[var(--text-muted)]' : 'btn-gradient font-semibold'} shrink-0 rounded-md border px-2 py-0.5 text-[0.68rem]`}>{selected.trusted ? '取消信任' : '信任并打开'}</button>
                    </div>
                    {openingProject && <span className="text-[0.68rem] text-[var(--text-muted)]">正在打开...</span>}
                    {openError && <span className="text-[0.68rem] text-red-500">{openError}</span>}
                    {workspace && <span className="text-[0.68rem] text-[var(--text-muted)]">{workspace.isRepo ? `Git ✓ ${workspace.branch ? `@ ${workspace.branch} ` : ''}${shortId(workspace.commit)}` : '非 Git 仓库（只读）'}</span>}
                </div>
            )}
        </section>
    );
}

function FilesSection() {
    const treeEntries = useWorkspaceStore((s) => s.treeEntries);
    const treeCounts = useWorkspaceStore((s) => s.treeCounts);
    const treeBase = useWorkspaceStore((s) => s.treeBase);
    const treeDepth = useWorkspaceStore((s) => s.treeDepth);
    const treeLoading = useWorkspaceStore((s) => s.treeLoading);
    const treeError = useWorkspaceStore((s) => s.treeError);
    const workspace = useWorkspaceStore((s) => s.workspace);
    const loadTree = useWorkspaceStore((s) => s.loadTree);
    const goUpTree = useWorkspaceStore((s) => s.goUpTree);
    const openFile = useWorkspaceStore((s) => s.openFile);
    const attachWholeFile = useWorkspaceStore((s) => s.attachWholeFile);
    const git = useWorkspaceStore((s) => s.git);
    const loadGitStatus = useWorkspaceStore((s) => s.loadGitStatus);
    const rows = flattenTreeForDisplay(treeEntries);
    const gitEntries = Array.isArray(git?.status?.entries) ? git.status.entries : [];

    return (
        <section className="flex min-h-0 flex-1 flex-col p-2">
            <div className="flex items-center gap-1.5 text-[0.68rem] text-[var(--text-muted)]">
                <button type="button" onClick={() => loadTree('', 2)} className="rounded border border-[var(--glass-border)] px-1.5 py-0.5">根</button>
                {treeBase && <button type="button" onClick={goUpTree} className="rounded border border-[var(--glass-border)] px-1.5 py-0.5">上一级</button>}
                <span className="min-w-0 flex-1 truncate">/{treeBase}</span>
                <button type="button" onClick={() => loadTree(treeBase, Math.min(6, treeDepth + 2))} className="rounded border border-[var(--glass-border)] px-1.5 py-0.5">展开</button>
            </div>
            {gitEntries.length > 0 && <div className="mt-1 mb-1 flex flex-col gap-0.5 rounded border border-[var(--glass-border)] bg-[var(--glass-bg-strong)] px-1.5 py-1">
                <div className="flex items-center gap-1 text-[0.6rem] text-[var(--text-muted)]">
                    <span className="min-w-0 flex-1 truncate">工作区有改动 {gitEntries.length} 个文件 · 点击可直接打开</span>
                    {git.loading ? <span className="shrink-0">…</span> : <button type="button" onClick={() => loadGitStatus()} className="shrink-0 rounded px-0.5 hover:text-[var(--text-main)]" title="重新读取 git 状态">↻ 刷新</button>}
                </div>
                <div className="flex max-h-24 flex-wrap items-start gap-x-1 gap-y-0.5 overflow-auto">
                    {gitEntries.map((entry) => {
                        const c = classifyGitEntry(entry);
                        const deleted = c.kind === 'deleted';
                        const openPath = entry.renameTo || c.path;
                        const label = entry.renameTo ? `${entry.path} → ${entry.renameTo}` : c.path;
                        const inner = <>
                            <span className="ws-change-mark" style={{ color: gitMarkColor(c.mark) }}>{c.mark}</span>
                            <span className="ws-change-path">{label}</span>
                        </>;
                        return deleted
                            ? <div key={openPath} className="ws-change-chip" title={`${c.title}（已删除，无法打开）`}>{inner}</div>
                            : <button key={openPath} type="button" className="ws-change-chip text-left" title={`${c.title} · 点击在真实代码工作区打开`} onClick={() => openFile(openPath, 1)}>{inner}</button>;
                    })}
                </div>
            </div>}
            {treeLoading && <div className="py-3 text-center text-xs text-[var(--text-muted)]">加载目录...</div>}
            {treeError && <div className="py-2 text-xs text-red-500">{treeError}</div>}
            {!treeLoading && !treeError && <div className="min-h-0 flex-1 overflow-auto">
                {rows.map((row) => row.type === 'file' ? (
                    <div key={row.rel} className="flex items-center gap-1.5 rounded px-1.5 py-[0.19rem] text-xs" style={{ paddingLeft: `${8 + row.depth * 13}px` }}>
                        <button type="button" onClick={() => openFile(row.rel, 1)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[var(--text-main)]"><span>📄</span><span className="truncate">{row.name}</span></button>
                        <button type="button" onClick={() => attachWholeFile(row.rel)} title="允许代码 Agent 在下一条消息中按需分页读取整个文件" className="shrink-0 text-[0.62rem] text-[var(--text-muted)]">＋整文件</button>
                        {row.size != null && <span className="shrink-0 text-[0.62rem] text-[var(--text-muted)]">{formatBytes(row.size)}</span>}
                    </div>
                ) : <button key={row.rel} type="button" onClick={() => loadTree(row.rel, treeDepth)} className="flex w-full items-center gap-1.5 rounded px-1.5 py-[0.19rem] text-left text-xs text-[var(--text-main)]" style={{ paddingLeft: `${8 + row.depth * 13}px` }}><span>{row.type === 'link' ? '🔗' : '📁'}</span><span className="truncate">{row.name}</span></button>)}
                {rows.length === 0 && <div className="py-3 text-center text-xs text-[var(--text-muted)]">{workspace ? '（空目录）' : '请先信任项目'}</div>}
                {treeCounts && <div className="pt-1 text-[0.62rem] text-[var(--text-muted)]">{treeCounts.dirs} 目录 · {treeCounts.files} 文件</div>}
            </div>}
        </section>
    );
}

function ViewerPane() {
    const viewer = useWorkspaceStore((s) => s.viewer);
    const scrollViewer = useWorkspaceStore((s) => s.scrollViewer);
    const attachCurrentView = useWorkspaceStore((s) => s.attachCurrentView);
    const attach = useWorkspaceStore((s) => s.attach);
    if (!viewer.path) return null;
    const attached = attach?.refs?.[0]?.path === viewer.path;
    return <section className="flex max-h-[44%] min-h-0 flex-[0_0_44%] flex-col border-t border-[var(--glass-border)]">
        <div className="flex items-center gap-2 border-b border-[var(--glass-border)] px-2.5 py-1.5"><span className="min-w-0 flex-1 truncate text-xs">{viewer.path}:{viewer.startLine}-{viewer.endLine}</span><button type="button" onClick={() => scrollViewer(-1)} disabled={viewer.startLine <= 1} className="rounded border border-[var(--glass-border)] px-1.5 py-0.5 text-xs">←</button><button type="button" onClick={() => scrollViewer(1)} disabled={!viewer.truncated} className="rounded border border-[var(--glass-border)] px-1.5 py-0.5 text-xs">→</button><button type="button" onClick={attachCurrentView} className="btn-gradient rounded px-2 py-0.5 text-[0.64rem]">{attached ? '已引用 ✓' : '引用到对话'}</button></div>
        {viewer.error && <div className="p-2 text-xs text-red-500">{viewer.error}</div>}
        {viewer.loading && <div className="p-2 text-xs text-[var(--text-muted)]">加载文件...</div>}
        {!viewer.error && !viewer.loading && <div className="min-h-0 flex-1 overflow-auto bg-[var(--glass-bg-strong)]"><div className="ws-code-block min-w-max p-2 text-[var(--text-main)]">{viewer.lines.map((line, i) => <div key={viewer.startLine + i} className="flex"><span className="w-10 shrink-0 select-none pr-2 text-right text-[var(--text-muted)]">{viewer.startLine + i}</span><span className="break-all pr-4">{line || ' '}</span></div>)}</div></div>}
    </section>;
}

const TERMINAL_STATUS = ['completed', 'failed', 'cancelled'];
const CHANGE_STATUS_META = {
    A: { label: '新增', color: 'var(--brand-start)' },
    M: { label: '修改', color: '#eab308' },
    D: { label: '删除', color: '#ef4444' },
    R: { label: '重命名', color: '#8b5cf6' },
};

/** 状态→字母：runChanges 用 A/M/D/R，landToMain 返回用 added/modified/deleted… */
const STATUS_LETTER = {
    A: 'A', M: 'M', D: 'D', R: 'R', C: 'C',
    added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', created: 'A', new: 'A',
};

function statusLetterOf(status) {
    return STATUS_LETTER[String(status || '')] || 'M';
}

/**
 * 落地结果区展示用的文件行。
 * 优先取 runChanges 审查清单（有 diff body）；若它没出来（worktree ops 失败等），
 * 用 landToMain 服务端返回的 files 兜底——保证"落地了哪几个文件"始终有来源。
 */
function buildReviewRows({ changesMatch = false, changedFiles = [], landApplied = false, landState = null }) {
    if (changesMatch && changedFiles.length > 0) return changedFiles;
    if (!landApplied) return [];
    const files = Array.isArray(landState?.files) ? landState.files : [];
    return files
        .map((f) => ({
            path: String(f.path || ''),
            origPath: f.origPath || null,
            status: statusLetterOf(f.status),
            body: null,
            bodyIsDiff: true,
            truncated: false,
            bodyError: null,
            fromLandOnly: true,
        }))
        .filter((r) => r.path);
}

function CodingAgentSection() {
    const workspace = useWorkspaceStore((s) => s.workspace);
    const projects = useWorkspaceStore((s) => s.projects);
    const selectedProjectId = useWorkspaceStore((s) => s.selectedProjectId);
    const capabilities = useWorkspaceStore((s) => s.capabilities);
    const runs = useWorkspaceStore((s) => s.runs);
    const codingRunAttach = useWorkspaceStore((s) => s.codingRunAttach);
    const runDetail = useWorkspaceStore((s) => s.runDetail);
    const runApprovals = useWorkspaceStore((s) => s.runApprovals);
    const runArtifacts = useWorkspaceStore((s) => s.runArtifacts);
    const runOpsBusy = useWorkspaceStore((s) => s.runOpsBusy);
    const runChanges = useWorkspaceStore((s) => s.runChanges);
    const createWriteRun = useWorkspaceStore((s) => s.createWriteRun);
    const provisionRun = useWorkspaceStore((s) => s.provisionRun);
    const refreshRunDetail = useWorkspaceStore((s) => s.refreshRunDetail);
    const pollCodingRun = useWorkspaceStore((s) => s.pollCodingRun);
    const loadRunChanges = useWorkspaceStore((s) => s.loadRunChanges);
    const attachCodingRun = useWorkspaceStore((s) => s.attachCodingRun);
    const clearCodingRunAttach = useWorkspaceStore((s) => s.clearCodingRunAttach);
    const landToMain = useWorkspaceStore((s) => s.landToMain);
    const refreshAfterLand = useWorkspaceStore((s) => s.refreshAfterLand);
    const openFile = useWorkspaceStore((s) => s.openFile);
    const run = runDetail || (codingRunAttach?.runId ? runs.items.find((r) => r.id === codingRunAttach.runId) : null);
    const selected = projects.find((p) => String(p.id) === String(selectedProjectId));
    const canDelegate = Boolean(workspace && selected?.trusted && canWriteToWorkspace(capabilities));
    const [error, setError] = useState(null);
    const [landState, setLandState] = useState(null); // { busy, applied, counts }
    const [openChange, setOpenChange] = useState(null); // path of the expanded change row
    const [refreshing, setRefreshing] = useState(false);
    const landable = Boolean(run && run.status === 'completed' && run.worktreeStatus === 'ready' && canWriteToWorkspace(capabilities));
    const landApplied = Boolean(landState?.applied);
    const terminal = Boolean(run && TERMINAL_STATUS.includes(String(run.status)));
    const runLive = Boolean(run && !terminal && codingRunAttach?.runId);
    const changesMatch = Boolean(run && runChanges.runId === run.id);
    const changedFiles = changesMatch ? (runChanges.files || []) : [];
    const reviewRows = buildReviewRows({ changesMatch, changedFiles, landApplied, landState });
    const landCounts = (landState && landState.counts) || {};

    // ── live delegated-run tracking ──
    // While a run is delegated to the next chat message we poll its status (the
    // DB only turns terminal after the chat turn drives it), so the box flips to
    // terminal on its own. Once terminal, load the change list once. No polling
    // once the run is terminal or the attach chip is gone.
    // 健壮性修正：
    //   * attach 在、但 runDetail 仍是旧的非终态快照（面板在 run 期间被关、稍后重开）时，
    //     先立即 poll 一次再起定时器，避免永久停在旧快照、不翻终态；
    //   * 翻终态用 force 重拉 runChanges，避免命中终态前（文件还没写完）的过期缓存；
    //   * terminalSeenRef 记录已处理过的 (runId,status)，防 deps 抖动引发重复加载。
    const terminalSeenRef = useRef(null);
    useEffect(() => {
        if (!run || run.worktreeStatus !== 'ready') return undefined;
        if (terminal) {
            const key = `${run.id}:${run.status}`;
            if (terminalSeenRef.current !== key) {
                terminalSeenRef.current = key;
                loadRunChanges(run.id, { force: true });
            }
            return undefined;
        }
        if (!codingRunAttach?.runId) return undefined;
        pollCodingRun(run.id);
        const timer = setInterval(() => { pollCodingRun(run.id); }, 3000);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [run?.id, run?.status, run?.worktreeStatus, terminal]);

    const delegate = async () => {
        setError(null);
        const created = await createWriteRun('trusted');
        if (!created?.id) return;
        const ready = await provisionRun(created.id);
        if (ready?.worktreeStatus !== 'ready') {
            setError('工作树未就绪，无法委托 CodingAgent');
            return;
        }
        attachCodingRun(ready);
    };

    const refreshResult = async () => {
        if (!run) return;
        setError(null);
        setRefreshing(true);
        try {
            await refreshRunDetail(run.id);
            await loadRunChanges(run.id, { force: true });
        } finally {
            setRefreshing(false);
        }
    };

    const doLand = async () => {
        if (!run) return;
        setError(null);
        setLandState({ busy: true });
        const body = await landToMain(run.id);
        if (body?.applied) {
            // 落地成功：把服务端返回的文件清单留作兜底来源（worktree 不可读时仍有列表），
            // 再刷新真实工作区（重置根目录树 + git 状态）与审查清单（force 取回逐文件 diff）。
            setLandState({
                busy: false,
                applied: true,
                counts: body.counts || {},
                files: Array.isArray(body.files) ? body.files : [],
            });
            await refreshAfterLand();
            await loadRunChanges(run.id, { force: true });
        } else {
            setLandState({ busy: false, applied: false });
        }
    };

    const toggleChange = (path) => setOpenChange((prev) => (prev === path ? null : path));

    return <section className="border-t border-[var(--glass-border)] px-2 py-2">
        <div className="mb-1 flex items-center gap-2"><span className="text-xs font-semibold text-[var(--brand-start)]">CodingAgent</span><span className="min-w-0 flex-1 text-[0.62rem] text-[var(--text-muted)]">选择项目后，在聊天框描述修改要求</span>{runLive && <span className="shrink-0 text-[0.6rem] text-[var(--brand-start)]">运行中 · 自动刷新</span>}</div>
        {!canDelegate && <div className="text-[0.68rem] text-[var(--text-muted)]">请先信任并打开 Git 项目，并确认服务端已开启写入能力。</div>}
        {canDelegate && !codingRunAttach && <button type="button" disabled={runOpsBusy} onClick={delegate} className="btn-gradient w-full rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50">交给 CodingAgent</button>}
        {codingRunAttach && <div className="flex items-center gap-2 rounded-lg border border-[var(--brand-start)] bg-[var(--panel-soft)] px-2 py-1.5 text-xs"><span className="min-w-0 flex-1 truncate text-[var(--brand-start)]">已就绪：run_{shortId(codingRunAttach.runId)}，请在聊天框输入任务</span><button type="button" onClick={clearCodingRunAttach} className="text-[var(--text-muted)]">取消</button></div>}
        {error && <div className="mt-1 text-xs text-red-500">{error}</div>}
        {run && <div className="mt-2 flex flex-col gap-1 rounded-lg border border-[var(--glass-border)] bg-[var(--surface-elevated)] px-2 py-1.5 text-[0.68rem]">
            <div className="flex items-center gap-2"><span className="font-semibold">{runStatusLabel(run.status)}</span>{refreshing && <span className="text-[var(--text-muted)]">…</span>}<button type="button" disabled={refreshing || runOpsBusy} onClick={refreshResult} className="ml-auto rounded border border-[var(--glass-border)] px-1.5 py-0.5 disabled:opacity-50">刷新结果</button></div>
            {runApprovals.items.filter((a) => a.status === 'requested').length > 0 && <div className="text-amber-400">有待处理审批，请在服务端审批流程中处理。</div>}
            {runArtifacts.items.length > 0 && <div>已产生 {runArtifacts.items.length} 个变更记录</div>}
            {runChanges.loading && reviewRows.length === 0 && <div className="text-[var(--text-muted)]">正在读取改动清单...</div>}
            {!runChanges.loading && reviewRows.length === 0 && runChanges.error && !landApplied && <div className="text-red-500">{runChanges.error}</div>}
            {reviewRows.length > 0 && <div className="flex flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6rem]">
                    {landApplied
                        ? <span className="font-semibold text-[var(--brand-start)]">✓ 已应用到真实代码（未提交）· {landCounts.changed != null ? landCounts.changed : reviewRows.length} 个文件<span className="ml-2 font-normal text-[var(--text-muted)]">＋{landCounts.added || 0} 新增 · {landCounts.modified || 0} 修改 · −{landCounts.deleted || 0} 删除</span></span>
                        : <span className="text-[var(--text-muted)]">待应用改动 · {reviewRows.length} 个文件，展开可查看 diff</span>}
                    {runChanges.moreCount ? <span className="text-[var(--text-muted)]">（另有 {runChanges.moreCount} 个未展开内容）</span> : null}
                </div>
                <div className="max-h-40 overflow-auto rounded border border-[var(--glass-border)]">
                    {reviewRows.map((f) => {
                        const letter = statusLetterOf(f.status);
                        const meta = CHANGE_STATUS_META[letter] || CHANGE_STATUS_META.M;
                        const label = f.origPath ? `${f.origPath} → ${f.path}` : f.path;
                        const open = openChange === f.path;
                        const openable = landApplied && letter !== 'D' && !f.fromLandOnly;
                        return <div key={`${letter}:${f.path}`}>
                            <div className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[var(--glass-bg-strong)]">
                                <button type="button" onClick={() => toggleChange(f.path)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                                    <span className="w-4 shrink-0 text-center text-[0.62rem] font-bold" style={{ color: meta.color }}>{letter}</span>
                                    <span className="min-w-0 flex-1 truncate text-[0.64rem]" title={label}>{label}</span>
                                    <span className="shrink-0 text-[0.6rem] text-[var(--text-muted)]">{meta.label}</span>
                                    <span className="shrink-0 text-[0.62rem] text-[var(--text-muted)]">{open ? '−' : '＋'}</span>
                                </button>
                                {openable && <button type="button" title="在真实代码工作区打开该文件" onClick={() => openFile(f.path, 1)} className="shrink-0 rounded border border-[var(--glass-border)] px-1 py-0 text-[0.6rem] text-[var(--text-muted)] hover:text-[var(--text-main)]">查看</button>}
                            </div>
                            {open && <div className="px-1 pb-1">
                                {f.bodyError
                                    ? <div className="py-0.5 text-[0.62rem] text-red-500">{f.bodyError}</div>
                                    : f.body
                                        ? <div className="max-h-44 overflow-auto rounded border border-[var(--glass-border)] bg-[var(--glass-bg-strong)]">
                                            <DiffView diff={f.body} mode={f.bodyIsDiff === false ? 'new' : 'diff'} truncated={f.truncated === true} />
                                        </div>
                                        : f.fromLandOnly
                                            ? <div className="py-0.5 text-[0.6rem] text-[var(--text-muted)]">已应用，但未能从本机读取该文件 diff（可点右上"刷新结果"重试）</div>
                                            : <div className="py-0.5 text-[0.6rem] text-[var(--text-muted)]">（无文本内容）</div>}
                            </div>}
                        </div>;
                    })}
                </div>
            </div>}
            {!landApplied && !runChanges.loading && !runChanges.error && changesMatch && changedFiles.length === 0 && <div className="text-[0.6rem] text-[var(--text-muted)]">（未检测到工作区文件改动）</div>}
            {landApplied && landCounts.changed === 0 && <div className="text-[var(--brand-start)]">✓ 本次改动已应用到真实代码工作区（未提交）</div>}
            {run.status === 'failed' && <div className="text-red-500">{friendlyWorkspaceError(run.error || 'CodingAgent 执行失败')}</div>}
            {!landApplied && landable && <button type="button" disabled={runOpsBusy || landState?.busy} onClick={doLand} className="rounded border border-[var(--brand-start)] px-2 py-1 text-xs text-[var(--brand-start)] disabled:opacity-50">应用到真实代码（改工作区，不提交）</button>}
        </div>}
    </section>;
}

export default function WorkspacePanel({ onClose }) {
    const capabilities = useWorkspaceStore((s) => s.capabilities);
    const capabilitiesLoaded = useWorkspaceStore((s) => s.capabilitiesLoaded);
    const capabilitiesError = useWorkspaceStore((s) => s.capabilitiesError);
    const projectsLoading = useWorkspaceStore((s) => s.projectsLoading);
    const selectedProjectId = useWorkspaceStore((s) => s.selectedProjectId);
    const attach = useWorkspaceStore((s) => s.attach);
    const attachLabel = useWorkspaceStore((s) => s.attachLabel);
    const clearAttach = useWorkspaceStore((s) => s.clearAttach);
    const toastText = useWorkspaceStore((s) => s.toastText);
    const toastKind = useWorkspaceStore((s) => s.toastKind);
    const showGate = capabilitiesLoaded && !canOpenWorkspace(capabilities);
    const bodyVisible = canOpenWorkspace(capabilities) && (projectsLoading || selectedProjectId);
    return <aside className="workspace-panel relative z-[5] flex flex-col text-[var(--text-main)]">
        <header className="flex flex-none items-center gap-2 border-b border-[var(--glass-border)] px-3 py-2"><span className="text-sm font-semibold">工作区</span>{attach && attachLabel && <span className="min-w-0 flex-1 truncate rounded border border-[var(--brand-start)] px-1.5 py-0.5 text-[0.62rem] text-[var(--brand-start)]">已附加：{attachLabel}<button type="button" onClick={clearAttach} className="ml-1">✕</button></span>}<span className="min-w-0 flex-1" /><button type="button" onClick={onClose} aria-label="关闭工作区面板" className="rounded px-1.5 py-0.5 text-xs text-[var(--text-muted)]">✕</button></header>
        {!capabilitiesLoaded && <div className="p-4 text-center text-xs text-[var(--text-muted)]">正在检查工作区能力...</div>}
        {showGate && <div className="space-y-2 p-4 text-xs text-[var(--text-muted)]"><p className="text-red-500">{capabilitiesError || '工作区能力当前未启用。'}</p><p>请开启服务端工作区能力并配置允许根目录。</p></div>}
        {canOpenWorkspace(capabilities) && <ProjectControls />}
        {bodyVisible && <><div className="workspace-panel-scroll flex min-h-0 flex-1 flex-col"><FilesSection /><ViewerPane /></div><CodingAgentSection /></>}
        {toastText && <div className={`absolute inset-x-2 bottom-2 z-10 rounded-lg border px-2.5 py-1.5 text-xs ${toastKind === 'error' ? 'border-red-500/50 bg-red-500/10 text-red-500' : 'border-[var(--glass-border)] bg-[var(--surface-elevated)]'}`}>{toastText}</div>}
    </aside>;
}
