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
} from '../utils/workspaceModel';
import { setPendingRepoContext } from './chatStore';

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

    // attach chip
    attach: null,
    attachLabel: null,

    // toast
    toastKind: null,
    toastText: null,
};

let toastTimer = null;

export const useWorkspaceStore = create((set, get) => {
    const showToast = (text, kind = 'info') => {
        set({ toastKind: kind, toastText: text });
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => set({ toastKind: null, toastText: null }), 4200);
    };

    const fail = (error) => friendlyWorkspaceError(error);

    const resetProjectState = () => set({
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
            showToast(`已附加引用 ${lineWindowLabel(v.path, start, end)}，将在下一条消息中作为仓库上下文发送`, 'ok');
        },
        attachWholeFile(path) {
            const id = get().selectedProjectId;
            if (!id || !path) return;
            const ref = buildRepoContextRef({ projectId: id, path, startLine: 1, endLine: 2000 });
            if (!ref) return;
            setPendingRepoContext(ref);
            set({ attach: ref, attachLabel: lineWindowLabel(path, 1, 2000) });
            showToast(`已附加引用 ${lineWindowLabel(path, 1, 2000)}`, 'ok');
        },
        clearAttach() {
            setPendingRepoContext(null);
            set({ attach: null, attachLabel: null });
        },
        clearToast() {
            set({ toastKind: null, toastText: null });
        },
    };
});
