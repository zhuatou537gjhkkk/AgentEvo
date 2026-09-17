/**
 * Phase 7 / R1 — Workspace panel runtime store (not persisted).
 *
 * Holds the in-session project selector/trust state, the file tree/viewer,
 * Git status/diff, the observe-run list, and the "attach reference to next chat
 * message" chip. Runtime-only on purpose: AbortController-like live values and
 * per-panel loading flags are exactly what the persisted chatStore must not hold.
 */
import { create } from 'zustand';
import * as workspaceApi from '../api/workspace';
import {
    friendlyWorkspaceError,
    buildRepoContextRef,
    lineWindowLabel,
    frameGitDiff,
    worktreeStatusLabel,
} from '../utils/workspaceModel';
import { setPendingRepoContext, clearPendingRepoContext, setPendingCodingRunId } from './chatStore';

const EMPTY_VIEWER = {
    path: null,
    startLine: 1,
    endLine: 0,
    lineCount: 0,
    lines: [],
    truncated: false,
    byteLength: null,
    loading: false,
    error: null,
};

function viewerWith(base, patch) {
    return { ...EMPTY_VIEWER, ...base, ...patch };
}

/** Status letter for one porcelain entry (A 新增 / M 修改 / D 删除 / R 重命名). */
function runChangeFromEntry(entry) {
    const x = String((entry && entry.x) || '');
    const y = String((entry && entry.y) || '');
    const p = String((entry && entry.path) || '');
    if (!p) return null;
    const renameTo = String((entry && entry.renameTo) || '');
    if (x === '?' && y === '?') return { path: p, status: 'A', isNew: true };
    if (x === 'R' || renameTo) return { path: renameTo || p, status: 'R', isNew: false, origPath: renameTo ? p : null };
    const letter = y && y !== ' ' ? y : x;
    if (letter === 'D') return { path: p, status: 'D', isNew: false };
    if (letter === 'A') return { path: p, status: 'A', isNew: true };
    return { path: p, status: 'M', isNew: false };
}

const initial = {
    // capability gate
    capabilities: null,
    capabilitiesLoaded: false,
    capabilitiesError: null,

    // project registrar
    projects: [],
    projectsLoading: false,
    projectsError: null,
    selectedProjectId: null,

    // opened workspace facts (repo root, commit, isRepo...)
    workspace: null,
    openingProject: false,
    openError: null,

    // file tree
    treeBase: '',
    treeDepth: 2,
    treeEntries: [],
    treeCounts: null,
    treeTruncated: false,
    treeLoading: false,
    treeError: null,

    // file viewer
    viewer: { ...EMPTY_VIEWER },

    // search
    search: { query: '', results: [], filesScanned: 0, filesWithMatches: 0, truncated: false, running: false, error: null },

    // git
    git: { status: null, loading: false, error: null },
    diff: { text: '', path: null, staged: false, filesChanged: [], truncated: false, loading: false, error: null },

    // runs
    runs: { items: [], loading: false, error: null },
    runEvents: { runId: null, events: [], afterSeq: 0, loading: false, error: null },
    runActionId: null,

    // ── R2 write-run control (Phase 7 / R2, run-scoped ops) ──
    selectedRunId: null,
    runDetail: null,            // fresh run row (worktreeStatus/branch/baseCommit...)
    runDetailLoading: false,
    runDetailError: null,
    runOpsBusy: false,          // a run-scoped write/exec/execute call is in flight
    runActions: { items: [], loading: false, error: null },
    runApprovals: { items: [], loading: false, error: null },
    runArtifacts: { items: [], loading: false, error: null },
    runGit: { status: null, loading: false, error: null },
    runDiff: { text: '', filesChanged: [], truncated: false, byteLength: null, loading: false, error: null },
    runChanges: { runId: null, files: [], loading: false, error: null },
    runFileView: { path: null, lines: [], startLine: 1, lineCount: 0, truncated: false, loading: false, error: null },
    pendingRunOps: {},          // runId → { actionId, approvalId, op, args } live args for a paused action
    lastCommandOutputs: [],     // newest first, capped; live stdout/stderr after an approved exec

    // attach chip
    attach: null,
    attachLabel: null,

    // Phase 7 / R2 — coding-run delegated to the next chat message. Mirrors the
    // repo attach chip: sets the chat's pending coding_run_id + shows a removable
    // panel chip. Auto-cleared when the delegated run turns terminal.
    codingRunAttach: null,

    // toast
    toastKind: null,
    toastText: null,
};

let toastTimer = null;

/** Empty R2 run-control transient (used when switching project/run). */
const EMPTY_RUN_CONTROL = {
    selectedRunId: null,
    runDetail: null,
    runDetailLoading: false,
    runDetailError: null,
    runOpsBusy: false,
    runActions: { items: [], loading: false, error: null },
    runApprovals: { items: [], loading: false, error: null },
    runArtifacts: { items: [], loading: false, error: null },
    runGit: { status: null, loading: false, error: null },
    runDiff: { text: '', filesChanged: [], truncated: false, byteLength: null, loading: false, error: null },
    runChanges: { runId: null, files: [], loading: false, error: null },
    runFileView: { path: null, lines: [], startLine: 1, lineCount: 0, truncated: false, loading: false, error: null },
    pendingRunOps: {},
    lastCommandOutputs: [],
};

export const useWorkspaceStore = create((set, get) => {
    const showToast = (text, kind = 'info') => {
        set({ toastKind: kind, toastText: text });
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => set({ toastKind: null, toastText: null }), 4200);
    };

    const fail = (error) => friendlyWorkspaceError(error);

    const resetProjectState = () => {
        clearPendingRepoContext();
        return set({
        ...EMPTY_RUN_CONTROL,
        workspace: null,
        openError: null,
        treeBase: '',
        treeDepth: 2,
        treeEntries: [],
        treeCounts: null,
        treeTruncated: false,
        treeError: null,
        viewer: { ...EMPTY_VIEWER },
        search: { ...initial.search },
        git: { status: null, error: null },
        diff: { text: '', path: null, staged: false, filesChanged: [], truncated: false, error: null },
        });
    };

    const loadProjects = async () => {
        set({ projectsLoading: true, projectsError: null });
        try {
            const body = await workspaceApi.listProjects();
            set({ projects: body.projects || [], projectsLoading: false });
            const { selectedProjectId, projects } = get();
            if (!projects.some((p) => p.id === selectedProjectId)) {
                set({ selectedProjectId: projects[0]?.id || null });
            }
            return body.projects || [];
        } catch (error) {
            set({ projectsLoading: false, projectsError: fail(error) });
            return [];
        }
    };

    const openProjectFlow = async (projectId) => {
        const id = String(projectId || get().selectedProjectId || '');
        if (!id) return;
        set({ selectedProjectId: id, openingProject: true, openError: null });
        try {
            const body = await workspaceApi.openProject(id);
            const facts = body.workspace || null;
            set({ workspace: facts, openingProject: false });
            await get().loadTree('', 2);
            // 打开即拉一次真实仓库 git 状态，让 FilesSection 的"工作区改动"指示条常驻可用
            //（agent/其它进程在仓库里留下的改动无需等 land/手动刷新即可看到）。
            if (facts && facts.isRepo) await get().loadGitStatus();
        } catch (error) {
            set({ openingProject: false, openError: fail(error), workspace: null });
            resetProjectState();
        }
    };

    return {
        ...initial,

        // ── init / capabilities ──
        async init() {
            set({ capabilitiesLoaded: true });
            try {
                const body = await workspaceApi.fetchCapabilities();
                set({ capabilities: body.capabilities || null, capabilitiesError: null });
                if (body.capabilities?.workspace) {
                    await get().loadProjects();
                    // 刷新/重登后 workspaceStore 是运行态（不持久化），loadProjects 只会把
                    // 默认项目塞进 selectedProjectId 却不会打开它。若已有选中项目、项目是
                    // trusted 且工作区尚未打开，这里自动补一次 openProjectFlow，避免「顶部
                    // 显示已选中项目、文件树却停留在请先选择并信任项目」的矛盾空态（刷新后
                    // 死锁：下拉再点同一 id 会被 setSelectedProject 的相同 id 早退吞掉）。
                    // 未 trusted 的项目不自动打开，保留「信任并打开」按钮让用户显式信任。
                    const { selectedProjectId: autoId, workspace: currentWorkspace, projects: autoProjects } = get();
                    const autoProject = autoProjects.find((p) => p.id === autoId);
                    if (autoId && !currentWorkspace && autoProject?.trusted) {
                        await get().openProjectFlow(autoId);
                    }
                }
            } catch (error) {
                set({ capabilities: null, capabilitiesError: fail(error) });
            }
        },
        setSelectedProject(projectId) {
            if (String(projectId || '') === String(get().selectedProjectId || '')) return;
            resetProjectState();
            set({ selectedProjectId: String(projectId || '') });
            get().openProjectFlow(projectId);
        },
        openProjectFlow,
        loadProjects,
        async registerProject({ name, rootPath }) {
            try {
                const body = await workspaceApi.registerProject({ name, rootPath });
                const created = body.project;
                showToast(`项目「${created?.name || name}」已登记，请确认信任后再打开`, 'ok');
                await get().loadProjects();
                if (created?.id) get().openProjectFlow(created.id);
                return created;
            } catch (error) {
                showToast(fail(error), 'error');
                return null;
            }
        },
        async setTrusted(projectId, trusted) {
            const id = String(projectId || '');
            try {
                await workspaceApi.updateProject(id, { trusted: Boolean(trusted) });
                const isSelected = id === String(get().selectedProjectId || '');
                await get().loadProjects();
                if (isSelected) {
                    if (trusted) {
                        await get().openProjectFlow(id);
                    } else {
                        resetProjectState();
                        showToast('已取消信任，工作区访问已关闭', 'info');
                    }
                } else {
                    showToast(trusted ? '已信任该项目' : '已取消信任', 'ok');
                }
            } catch (error) {
                showToast(fail(error), 'error');
            }
        },
        async revokeProject(projectId) {
            const id = String(projectId || '');
            try {
                await workspaceApi.revokeProject(id);
                showToast('项目已撤销（不可再打开）', 'info');
                if (id === String(get().selectedProjectId || '')) resetProjectState();
                await get().loadProjects();
            } catch (error) {
                showToast(fail(error), 'error');
            }
        },

        // ── file tree ──
        async loadTree(base, depth) {
            const id = get().selectedProjectId;
            if (!id) return;
            const cleanDepth = Math.min(6, Math.max(1, Number(depth) || 2));
            const cleanBase = String(base || '');
            set({
                treeBase: cleanBase,
                treeDepth: cleanDepth,
                treeLoading: true,
                treeError: null,
            });
            try {
                const body = await workspaceApi.runWorkspaceOp(id, 'list_tree', { path: cleanBase, depth: cleanDepth });
                const data = body.data || {};
                set({
                    treeLoading: false,
                    treeEntries: data.entries || [],
                    treeCounts: data.counts || null,
                    treeTruncated: data.truncated === true,
                });
            } catch (error) {
                set({ treeLoading: false, treeError: fail(error), treeEntries: [] });
            }
        },
        goUpTree() {
            const base = get().treeBase;
            if (!base) return;
            const parts = base.split('/').filter(Boolean);
            parts.pop();
            get().loadTree(parts.join('/'), Math.max(2, get().treeDepth));
        },

        // ── file viewer ──
        async openFile(path, startLine) {
            const id = get().selectedProjectId;
            if (!id || !path) return;
            set({ viewer: viewerWith(get().viewer, { path, loading: true, error: null }) });
            try {
                const body = await workspaceApi.runWorkspaceOp(id, 'read_file', {
                    path,
                    start_line: Math.max(1, Number(startLine) || 1),
                    max_lines: 400,
                });
                const data = body.data || {};
                set({ viewer: viewerWith(get().viewer, {
                    path: data.path || path,
                    startLine: Number(data.startLine) || 1,
                    endLine: Number(data.endLine) || 0,
                    lineCount: Number(data.lineCount) || 0,
                    lines: Array.isArray(data.lines) ? data.lines : [],
                    truncated: data.truncated === true,
                    byteLength: data.byteLength == null ? null : Number(data.byteLength),
                    loading: false,
                    error: null,
                }) });
            } catch (error) {
                set({ viewer: viewerWith(get().viewer, { loading: false, error: fail(error) }) });
            }
        },
        async scrollViewer(deltaLines) {
            const v = get().viewer;
            if (!v.path) return;
            const nextStart = Math.max(1, v.startLine + (deltaLines > 0 ? v.lineCount : -v.lineCount));
            if (deltaLines < 0 && v.startLine <= 1) return;
            await get().openFile(v.path, nextStart);
        },
        setViewerSearch(line) {
            const v = get().viewer;
            if (!v.path || !line) return;
            get().openFile(v.path, Math.max(1, Number(line) || 1));
        },

        // ── search ──
        async runSearch(query) {
            const id = get().selectedProjectId;
            const text = String(query || '').trim();
            if (!id) return;
            if (!text) {
                set({ search: { ...get().search, results: [], running: false } });
                return;
            }
            set({ search: { ...get().search, query: text, running: true, error: null } });
            try {
                const body = await workspaceApi.runWorkspaceOp(id, 'search_text', { path: '', query: text, regex: false });
                const data = body.data || {};
                set({ search: {
                    query: text,
                    results: data.matches || [],
                    filesScanned: Number(data.filesScanned) || 0,
                    filesWithMatches: Number(data.filesWithMatches) || 0,
                    truncated: data.truncated === true || data.timedOut === true,
                    running: false,
                    error: null,
                } });
            } catch (error) {
                set({ search: { ...get().search, running: false, error: fail(error) } });
            }
        },

        // ── git status / diff ──
        async loadGitStatus() {
            const id = get().selectedProjectId;
            if (!id) return;
            set({ git: { ...get().git, loading: true, error: null } });
            try {
                const body = await workspaceApi.runWorkspaceOp(id, 'git.status', {});
                set({ git: { status: body.data || null, loading: false, error: null } });
            } catch (error) {
                set({ git: { status: null, loading: false, error: fail(error) } });
            }
        },
        async showDiff(staged, path) {
            const id = get().selectedProjectId;
            if (!id) return;
            set({ diff: { ...initial.diff, staged: Boolean(staged), path: path || null, loading: true } });
            try {
                const body = await workspaceApi.runWorkspaceOp(id, 'git.diff', {
                    staged: Boolean(staged),
                    ...(path ? { path } : {}),
                });
                const data = body.data || {};
                set({ diff: {
                    text: data.diff || '',
                    path: path || null,
                    staged: Boolean(staged),
                    filesChanged: data.filesChanged || [],
                    truncated: data.truncated === true,
                    byteLength: data.byteLength == null ? null : Number(data.byteLength),
                    loading: false,
                    error: null,
                } });
            } catch (error) {
                set({ diff: { ...initial.diff, staged: Boolean(staged), path: path || null, loading: false, error: fail(error) } });
            }
        },

        // ── runs ──
        async loadRuns() {
            const id = get().selectedProjectId;
            if (!id) return;
            set({ runs: { ...get().runs, loading: true, error: null } });
            try {
                const body = await workspaceApi.listRuns({ projectId: id });
                set({ runs: { items: body.runs || [], loading: false, error: null } });
                get().syncCodingRunAttach(body.runs || []);
            } catch (error) {
                set({ runs: { items: [], loading: false, error: fail(error) } });
            }
        },
        async createObserveRun(sessionId) {
            const id = get().selectedProjectId;
            if (!id) {
                showToast('请先选择并信任一个项目', 'error');
                return null;
            }
            try {
                const body = await workspaceApi.createRun({ projectId: id, sessionId: sessionId || null, mode: 'observe' });
                showToast('已创建 observe run（R0 仅记录快照，不做代码执行）', 'ok');
                await get().loadRuns();
                return body.run || null;
            } catch (error) {
                showToast(fail(error), 'error');
                return null;
            }
        },
        async toggleRunStart(run) {
            const runId = run?.id;
            if (!runId) return;
            set({ runActionId: runId });
            const terminal = ['completed', 'failed', 'cancelled'].includes(String(run?.status));
            try {
                if (terminal || run?.status === 'running') {
                    await workspaceApi.cancelRun(runId);
                    showToast('run 已取消', 'info');
                } else {
                    await workspaceApi.startRun(runId);
                    showToast('run 已启动', 'ok');
                }
            } catch (error) {
                showToast(fail(error), 'error');
            } finally {
                set({ runActionId: null });
            }
            await get().loadRuns();
            const ev = get().runEvents;
            if (ev.runId === runId) get().loadRunEvents(runId);
        },
        async loadRunEvents(runId) {
            const id = String(runId || '');
            if (!id) return;
            set({ runEvents: { ...get().runEvents, runId: id, loading: true, error: null } });
            try {
                const body = await workspaceApi.fetchRunEvents(id, 0);
                const events = Array.isArray(body.events) ? body.events : [];
                set({ runEvents: {
                    runId: id,
                    events,
                    afterSeq: events.length ? events[events.length - 1].seq : 0,
                    loading: false,
                    error: null,
                } });
            } catch (error) {
                set({ runEvents: { ...get().runEvents, loading: false, error: fail(error) } });
            }
        },

        // ═══════════════════════════════════════════════════════════
        // R2 write-run control (Phase 7 / R2) — run-scoped ops/approvals.
        // The server is authoritative for capability/preset; the panel only
        // mirrors run.preset and gates on /coding/capabilities. Live op args are
        // held in memory (pendingRunOps, keyed by run) so approve→execute can
        // re-supply the IDENTICAL op+args — never reconstructed from the row.
        // ═══════════════════════════════════════════════════════════

        resetRunControlState() {
            set({ ...EMPTY_RUN_CONTROL });
        },
        async openRunDetail(runId) {
            const id = String(runId || '');
            if (!id) return;
            set({ selectedRunId: id });
            await get().refreshRunDetail(id);
        },
        closeRunDetail() {
            set({ ...EMPTY_RUN_CONTROL });
        },
        /** Reconnect-safe re-pull: run + actions + approvals + artifacts + events. */
        async refreshRunDetail(runId) {
            const id = String(runId || get().selectedRunId || '');
            if (!id) return null;
            set({ runDetailLoading: true, runDetailError: null });
            try {
                const body = await workspaceApi.fetchRun(id);
                const run = body.run || null;
                set({ runDetail: run, runDetailLoading: false });
                get().syncCodingRunAttach(run);
            } catch (error) {
                set({ runDetailLoading: false, runDetailError: fail(error) });
            }
            await Promise.all([
                get().reloadRunActions(id),
                get().reloadRunApprovals(id),
                get().reloadRunArtifacts(id),
            ]);
            // Event replay is an optional capability. Do not request the endpoint
            // when the server has it disabled (the normal local setup), otherwise
            // every run refresh produces a noisy, expected 403 in the browser.
            if (get().capabilities?.eventLog === true) {
                get().loadRunEvents(id);
            }
            return get().runDetail;
        },
        async reloadRunActions(runId) {
            const id = String(runId || get().selectedRunId || '');
            if (!id) return [];
            set({ runActions: { ...get().runActions, loading: true, error: null } });
            try {
                const body = await workspaceApi.listRunActions(id);
                set({ runActions: { items: body.actions || [], loading: false, error: null } });
                return body.actions || [];
            } catch (error) {
                set({ runActions: { items: [], loading: false, error: fail(error) } });
                return [];
            }
        },
        async reloadRunApprovals(runId) {
            const id = String(runId || get().selectedRunId || '');
            if (!id) return [];
            set({ runApprovals: { ...get().runApprovals, loading: true, error: null } });
            try {
                const body = await workspaceApi.listRunApprovals(id);
                set({ runApprovals: { items: body.approvals || [], loading: false, error: null } });
                return body.approvals || [];
            } catch (error) {
                set({ runApprovals: { items: [], loading: false, error: fail(error) } });
                return [];
            }
        },
        async reloadRunArtifacts(runId) {
            const id = String(runId || get().selectedRunId || '');
            if (!id) return [];
            set({ runArtifacts: { ...get().runArtifacts, loading: true, error: null } });
            try {
                const body = await workspaceApi.listRunArtifacts(id);
                set({ runArtifacts: { items: body.artifacts || [], loading: false, error: null } });
                return body.artifacts || [];
            } catch (error) {
                set({ runArtifacts: { items: [], loading: false, error: fail(error) } });
                return [];
            }
        },

        /** Create a write-enabled run (edit/trusted). Server gates on writeTools. */
        async createWriteRun(mode) {
            const preset = ['edit', 'trusted'].includes(String(mode || '')) ? String(mode) : null;
            if (!preset) {
                showToast('请选择 edit 或 trusted 模式', 'error');
                return null;
            }
            const projectId = get().selectedProjectId;
            if (!projectId) {
                showToast('请先选择并信任一个项目', 'error');
                return null;
            }
            if ((get().capabilities || {}).writeTools !== true) {
                showToast('服务端未启用文件写入能力，无法创建写 run（CODING_WRITE_TOOLS_ENABLED）', 'error');
                return null;
            }
            try {
                const body = await workspaceApi.createRun({ projectId, sessionId: null, mode: preset });
                const run = body.run || null;
                showToast(
                    preset === 'trusted' ? '已创建 trusted write run（文件写入自动批准，命令仍需审批）' : '已创建 edit write run（文件写入需 owner 审批）',
                    'ok',
                );
                await get().loadRuns();
                if (run?.id) await get().openRunDetail(run.id);
                return run;
            } catch (error) {
                showToast(fail(error), 'error');
                return null;
            }
        },
        async provisionRun(runId) {
            const id = String(runId || '');
            if (!id) return null;
            set({ runOpsBusy: true });
            try {
                const body = await workspaceApi.provisionRun(id);
                const run = body.run || null;
                if (run) set({ runDetail: run });
                const ws = String(run?.worktreeStatus || '');
                if (ws === 'ready') {
                    showToast(`工作树已就绪：${run.worktreeBranch || '-'} @ base ${String(run.baseCommit || '').slice(0, 8)}`, 'ok');
                } else if (ws === 'unsupported') {
                    showToast('该项目不是 Git 工作树顶层：保持只读，无法写入/执行', 'info');
                } else {
                    showToast('工作树状态：' + worktreeStatusLabel(ws), 'info');
                }
                await get().loadRuns();
                return run;
            } catch (error) {
                showToast(fail(error), 'error');
                return null;
            } finally {
                set({ runOpsBusy: false });
            }
        },
        async teardownRun(runId) {
            const id = String(runId || '');
            if (!id) return null;
            set({ runOpsBusy: true });
            try {
                const body = await workspaceApi.teardownRun(id);
                const run = body.run || null;
                if (run) set({ runDetail: run });
                showToast('工作树已拆除（主 checkout 不受影响）', 'info');
                await get().loadRuns();
                return run;
            } catch (error) {
                showToast(fail(error), 'error');
                return null;
            } finally {
                set({ runOpsBusy: false });
            }
        },
        async runStart(runId) {
            const id = String(runId || '');
            if (!id) return null;
            set({ runOpsBusy: true });
            try {
                const body = await workspaceApi.startRun(id);
                const run = body.run || null;
                if (run) set({ runDetail: run });
                showToast('run 已启动', 'ok');
                return run;
            } catch (error) {
                showToast(fail(error), 'error');
                return null;
            } finally {
                set({ runOpsBusy: false });
            }
        },
        async runCancel(runId) {
            const id = String(runId || '');
            if (!id) return null;
            set({ runOpsBusy: true });
            try {
                const body = await workspaceApi.cancelRun(id);
                const run = body.run || null;
                if (run) set({ runDetail: run });
                showToast('run 已取消（进程树已终止）', 'info');
                return run;
            } catch (error) {
                showToast(fail(error), 'error');
                return null;
            } finally {
                set({ runOpsBusy: false });
            }
        },

        /**
         * Apply a COMPLETED run's disposable-worktree changes to the REAL project
         * checkout's working tree (no commit). Server re-checks trust/allowed
         * roots + applies a conflict-checked patch. Returns the landed summary or
         * null on failure (toast shows the error).
         */
        async landToMain(runId) {
            const id = String(runId || '');
            if (!id) return null;
            set({ runOpsBusy: true });
            try {
                const body = await workspaceApi.landRunToMain(id);
                const c = body?.counts || {};
                showToast(
                    `已应用到真实代码工作区（未提交）：新增 ${c.added || 0} · 修改 ${c.modified || 0} · 删除 ${c.deleted || 0}`,
                    'ok',
                );
                await get().loadRuns();
                return body;
            } catch (error) {
                showToast(fail(error), 'error');
                return null;
            } finally {
                set({ runOpsBusy: false });
            }
        },

        /**
         * Land 成功后的真实工作区刷新（由 CodingAgentSection 的 doLand 主动调用）：
         * 把文件树重置到根目录 depth 2 —— 等价于一次手动刷新能看到的范围。旧版在
         * landToMain 内部用「当前 treeBase/treeDepth」视口刷新，落在子树/深度之外的
         * 新文件永远不出现，是"必须手动刷新浏览器才看到文件"的根因。同时重拉真实仓库
         * git 状态，驱动 FilesSection 的"工作区改动"指示条。与 runChanges 的重拉解耦：
         * 那是 run 工作树的审查数据，这里只刷真实 checkout。
         */
        async refreshAfterLand() {
            if (!get().selectedProjectId) return;
            await get().loadTree('', 2);
            await get().loadGitStatus();
        },

        /** Lightweight delegated-run status poll (single run fetch; no heavy pulls). */
        async pollCodingRun(runId) {
            const id = String(runId || '');
            if (!id) return null;
            try {
                const body = await workspaceApi.fetchRun(id);
                const run = body?.run || null;
                if (run) {
                    set({ runDetail: run });
                    get().syncCodingRunAttach(run);
                }
                return run;
            } catch (error) {
                return null;
            }
        },

        /**
         * Build the run's reviewable change list from its disposable worktree:
         * git.status porcelain → A/M/D/R per file; modified/deleted/renamed files
         * get their per-file diff hunks, brand-new (untracked) files get their full
         * content. Uses only existing run-scoped read ops (git.status / git.diff /
         * read_file at the worktree root) — no new backend surface. Read-only and
         * independent of the runOpsBusy write gate. `force` bypasses the cached
         * result (the run finished → re-pull).
         */
        async loadRunChanges(runId, { force = false } = {}) {
            const id = String(runId || '');
            if (!id) return null;
            const prev = get().runChanges || {};
            if (!force && prev.loading) return prev;
            if (!force && prev.runId === id && (prev.files || []).length > 0) return prev;
            set({ runChanges: { runId: id, files: [], loading: true, error: null } });
            try {
                const statusBody = await workspaceApi.runRunOp(id, 'git.status', {});
                const entries = Array.isArray(statusBody?.data?.entries) ? statusBody.data.entries : [];
                const files = [];
                for (const entry of entries) {
                    const row = runChangeFromEntry(entry);
                    if (row) files.push(row);
                }
                const BODY_CAP = 15;
                const capped = files.slice(0, BODY_CAP);
                for (const f of capped) {
                    try {
                        if (f.status === 'A') {
                            const r = await workspaceApi.runRunOp(id, 'read_file', { path: f.path, start_line: 1, max_lines: 600 });
                            const d = r?.data || {};
                            f.body = (Array.isArray(d.lines) ? d.lines : []).join('\n');
                            f.truncated = d.truncated === true;
                            f.bodyIsDiff = false;
                        } else {
                            const r = await workspaceApi.runRunOp(id, 'git.diff', { path: f.path });
                            const d = r?.data || {};
                            f.body = String(d.diff || '');
                            f.truncated = d.truncated === true;
                            f.bodyIsDiff = true;
                            // An un-staged worktree rename can leave an empty plain
                            // diff even though the target file exists → show content.
                            if (!f.body && f.status === 'R') {
                                const rr = await workspaceApi.runRunOp(id, 'read_file', { path: f.path, start_line: 1, max_lines: 600 });
                                const dd = rr?.data || {};
                                f.body = (Array.isArray(dd.lines) ? dd.lines : []).join('\n');
                                f.truncated = dd.truncated === true;
                                f.bodyIsDiff = false;
                            }
                        }
                    } catch (e) {
                        f.bodyError = friendlyWorkspaceError(e);
                    }
                }
                const moreCount = files.length > BODY_CAP ? files.length - BODY_CAP : 0;
                set({ runChanges: { runId: id, files, loading: false, error: null, moreCount } });
                return files;
            } catch (error) {
                set({ runChanges: { runId: id, files: [], loading: false, error: friendlyWorkspaceError(error) } });
                return [];
            }
        },

        // ── R2 run-scoped reads (worktree root once provisioned) ──
        async refreshRunGit(runId) {
            const id = String(runId || '');
            if (!id) return;
            set({ runGit: { ...get().runGit, loading: true, error: null } });
            try {
                const body = await workspaceApi.runRunOp(id, 'git.status', {});
                set({ runGit: { status: body?.data || null, loading: false, error: null } });
            } catch (error) {
                set({ runGit: { status: null, loading: false, error: fail(error) } });
            }
            await get().showRunDiff(id, null);
        },
        async showRunDiff(runId, path) {
            const id = String(runId || '');
            if (!id) return;
            set({ runDiff: { text: '', filesChanged: [], truncated: false, byteLength: null, loading: true, error: null } });
            try {
                const body = await workspaceApi.runRunOp(id, 'git.diff', { ...(path ? { path } : {}) });
                const framed = frameGitDiff(body?.data || {});
                set({ runDiff: {
                    text: framed.text,
                    filesChanged: framed.filesChanged,
                    truncated: framed.truncated,
                    byteLength: framed.byteLength,
                    loading: false,
                    error: null,
                } });
            } catch (error) {
                set({ runDiff: { text: '', filesChanged: [], truncated: false, byteLength: null, loading: false, error: fail(error) } });
            }
        },
        async readRunFile(runId, path, startLine) {
            const id = String(runId || '');
            if (!id || !path) return;
            set({ runFileView: { path, lines: [], startLine: 1, lineCount: 0, truncated: false, loading: true, error: null } });
            try {
                const body = await workspaceApi.runRunOp(id, 'read_file', {
                    path,
                    start_line: Math.max(1, Number(startLine) || 1),
                    max_lines: 300,
                });
                const data = body?.data || {};
                set({ runFileView: {
                    path: data.path || path,
                    startLine: Number(data.startLine) || 1,
                    lineCount: Number(data.lineCount) || 0,
                    lines: Array.isArray(data.lines) ? data.lines : [],
                    truncated: data.truncated === true,
                    loading: false,
                    error: null,
                } });
            } catch (error) {
                set({ runFileView: { path, lines: [], startLine: 1, lineCount: 0, truncated: false, loading: false, error: fail(error) } });
            }
        },

        /** Remove the paused live args for a run/action (settled or denied). */
        _dropPendingForAction(runId, actionId) {
            const pending = { ...(get().pendingRunOps || {}) };
            const held = pending[runId];
            if (held && actionId && held.actionId === actionId) delete pending[runId];
            set({ pendingRunOps: pending });
        },
        _rememberRunCommand(runId, actionId, data = {}) {
            const entry = {
                runId: String(runId || ''),
                actionId: actionId || null,
                at: new Date().toISOString(),
                executable: data?.executable || null,
                code: data?.code == null ? null : Number(data.code),
                stdout: String(data?.stdout || ''),
                stderr: String(data?.stderr || ''),
                timedOut: data?.timedOut === true,
                cancelled: data?.cancelled === true,
                truncated: data?.truncated === true,
            };
            set({ lastCommandOutputs: [entry, ...(get().lastCommandOutputs || [])].slice(0, 6) });
        },

        /**
         * Run one run-scoped op. Read ops resolve immediately ({effect:'read'});
         * write/exec resolve executed (auto/approved) or awaiting_approval — the
         * latter stores the live op+args under pendingRunOps[runId] for resume.
         */
        async submitRunOp(runId, op, args = {}, opts = {}) {
            const id = String(runId || '');
            if (!id) return { ok: false };
            if (get().runOpsBusy) return { ok: false, busy: true };
            set({ runOpsBusy: true });
            try {
                const body = await workspaceApi.runRunOp(id, op, args, opts.wait === true);
                if (!body || body.ok === false) return { ok: false };
                if (body.effect === 'read') {
                    return { ok: true, effect: 'read', op: body.op || op, data: body.data || {} };
                }
                if (body.status === 'awaiting_approval') {
                    const action = body.action || {};
                    const approval = body.approval || {};
                    set({ pendingRunOps: { ...(get().pendingRunOps || {}), [id]: { actionId: action.id, approvalId: approval.id, op, args } } });
                    if (body.run) set({ runDetail: body.run });
                    await Promise.all([get().reloadRunActions(id), get().reloadRunApprovals(id)]);
                    return { ok: true, status: 'awaiting_approval', action, approval, body };
                }
                if (body.status === 'executed') {
                    if (body.run) set({ runDetail: body.run });
                    get()._dropPendingForAction(id, body.action?.id);
                    const data = body.data || {};
                    if (String(op) === 'run_command') get()._rememberRunCommand(id, body.action?.id, data);
                    await Promise.all([
                        get().reloadRunActions(id),
                        get().reloadRunApprovals(id),
                        get().reloadRunArtifacts(id),
                    ]);
                    return { ok: true, status: 'executed', data, action: body.action || null, artifact: body.artifact || null, body };
                }
                return { ok: true, body };
            } catch (error) {
                return { ok: false, error };
            } finally {
                set({ runOpsBusy: false });
            }
        },

        /** Owner decides one approval: approve records intent; deny clears live args. */
        async decideRunApproval(runId, approvalId, approve, reason = null) {
            const aId = String(approvalId || '');
            if (!aId) return { ok: false };
            set({ runOpsBusy: true });
            try {
                const body = await workspaceApi.decideApproval(aId, Boolean(approve), reason);
                const action = body?.action || null;
                if (!approve && action?.id) get()._dropPendingForAction(String(runId || ''), action.id);
                await Promise.all([
                    get().reloadRunApprovals(String(runId || '')),
                    get().reloadRunActions(String(runId || '')),
                ]);
                return { ok: true, approval: body?.approval || null, action, body };
            } catch (error) {
                return { ok: false, error };
            } finally {
                set({ runOpsBusy: false });
            }
        },

        /** 批准并执行：decide approve, then execute with the identical live op+args. */
        async approveAndExecuteRunOp(runId, actionId) {
            const id = String(runId || '');
            const held = (get().pendingRunOps || {})[id];
            if (!held || (actionId && held.actionId !== actionId)) {
                showToast('该审批的实时参数已丢失（重连后参数不落库），请重新发起该操作以执行', 'error');
                return { ok: false, reason: 'no_pending_args' };
            }
            const decided = await get().decideRunApproval(id, held.approvalId, true, null);
            if (!decided?.ok) {
                if (decided?.error) showToast(fail(decided.error), 'error');
                return { ok: false };
            }
            return get().executePendingRunOp(id, held.actionId);
        },

        /** Execute an approved-but-unexecuted action with its stored live args. */
        async executePendingRunOp(runId, actionId) {
            const id = String(runId || '');
            const held = (get().pendingRunOps || {})[id];
            if (!held || (actionId && held.actionId !== actionId)) {
                showToast('该操作的实时参数已丢失（重连后参数不落库），请重新发起以执行', 'error');
                return { ok: false, reason: 'no_pending_args' };
            }
            set({ runOpsBusy: true });
            try {
                const body = await workspaceApi.executeApprovedAction(id, held.actionId, held.op, held.args);
                const pending = { ...(get().pendingRunOps || {}) };
                delete pending[id];
                set({ pendingRunOps: pending });
                if (body?.run) set({ runDetail: body.run });
                const status = body?.status || 'executed';
                const data = body?.data || {};
                if (status === 'executed' && String(held.op) === 'run_command') get()._rememberRunCommand(id, held.actionId, data);
                await Promise.all([
                    get().reloadRunActions(id),
                    get().reloadRunApprovals(id),
                    get().reloadRunArtifacts(id),
                ]);
                return { ok: true, status, data, action: body?.action || null, artifact: body?.artifact || null, settled: data?.settled === true, body };
            } catch (error) {
                return { ok: false, error };
            } finally {
                set({ runOpsBusy: false });
            }
        },

        // ── attach reference to next chat message ──
        attachCurrentView() {
            const v = get().viewer;
            const id = get().selectedProjectId;
            if (!id || !v.path) {
                showToast('请先打开一个文件再引用', 'error');
                return;
            }
            const start = v.startLine;
            const end = Math.max(start, v.endLine || start);
            const ref = buildRepoContextRef({ projectId: id, path: v.path, startLine: start, endLine: end });
            if (!ref) {
                showToast('无法构造引用', 'error');
                return;
            }
            setPendingRepoContext(ref);
            set({ attach: ref, attachLabel: lineWindowLabel(v.path, start, end) });
            console.log('[diag:attach] attachCurrentView → setPendingRepoContext:', JSON.stringify(ref).slice(0, 200));
            showToast(`已附加引用 ${lineWindowLabel(v.path, start, end)}，将在下一条消息中作为仓库上下文发送`, 'ok');
        },
        attachWholeFile(path) {
            const id = get().selectedProjectId;
            if (!id || !path) return;
            const ref = buildRepoContextRef({ projectId: id, path, mode: 'whole_file' });
            if (!ref) return;
            setPendingRepoContext(ref);
            set({ attach: ref, attachLabel: `${path}（整文件，Agent 可按需读取）` });
            showToast(`已附加整文件 ${path}，Agent 将在下一条消息中按需分页读取`, 'ok');
        },
        clearAttach() {
            setPendingRepoContext(null);
            set({ attach: null, attachLabel: null });
        },

        // ── Phase 7 / R2: delegate a trusted coding run to the next chat message ──
        // The chat turn drives the run's auto-decider (server-authorized, reads +
        // writes into the run's disposable worktree, no commands). Only trusted +
        // ready + non-terminal runs qualify — mirroring resolveCodingRunTask.
        attachCodingRun(run) {
            const id = String(run?.id || '');
            const preset = String(run?.mode || run?.preset || '');
            const terminal = ['completed', 'failed', 'cancelled'].includes(String(run?.status));
            if (!id || preset !== 'trusted' || terminal || run?.worktreeStatus !== 'ready') {
                showToast('仅 trusted 且工作树就绪、非终态的 run 可委托给对话', 'error');
                return;
            }
            setPendingCodingRunId(id);
            set({ codingRunAttach: { runId: id } });
            console.log('[diag:attach] attachCodingRun → setPendingCodingRunId:', id);
            showToast('已委托给对话：下一条聊天消息将驱动该 run 自动改代码（trusted 写入工作树，不跑命令）', 'ok');
        },
        clearCodingRunAttach() {
            setPendingCodingRunId(null);
            set({ codingRunAttach: null });
        },
        /** Clear the delegated-run chip when its run turns terminal (idempotent). */
        syncCodingRunAttach(runsOrRun) {
            const attach = get().codingRunAttach;
            if (!attach?.runId) return;
            const list = Array.isArray(runsOrRun) ? runsOrRun : (runsOrRun ? [runsOrRun] : []);
            const hit = list.find((r) => r && String(r?.id) === String(attach.runId));
            if (hit && ['completed', 'failed', 'cancelled'].includes(String(hit.status))) {
                setPendingCodingRunId(null);
                set({ codingRunAttach: null });
            }
        },
        clearToast() {
            set({ toastKind: null, toastText: null });
        },
    };
});
