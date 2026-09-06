/**
 * Phase 7 / R1 — pure helpers for the in-session Workspace panel.
 *
 * Kept DOM-free so the front-end suite (node env, no jsdom) can lock the
 * shape/formatting logic: capability gating, tree flattening, git porcelain
 * classification, friendly error text, and the repo_context shape sent to /chat.
 */

/** True only when the server reports the workspace capability enabled. */
export function canOpenWorkspace(capabilities) {
    return Boolean(capabilities && capabilities.workspace === true);
}

/**
 * Turn raw list_tree entries into display rows. Entries are project-root-
 * relative (`deep/a/b.txt`) and dirs-first. Indentation = number of path
 * separators so children sit under their parent dir.
 */
export function flattenTreeForDisplay(entries) {
    if (!Array.isArray(entries)) {
        return [];
    }
    return entries.map((entry) => {
        const rel = String(entry.rel || '');
        const segments = rel.split('/').filter(Boolean);
        return {
            rel,
            name: segments[segments.length - 1] || rel,
            type: entry.type || (entry.size == null ? 'dir' : 'file'),
            size: typeof entry.size === 'number' ? entry.size : null,
            depth: Math.max(0, segments.length - 1),
        };
    });
}

/** Human-readable porcelain classification for one git status entry. */
export function classifyGitEntry(entry) {
    const x = String(entry.x || '');
    const y = String(entry.y || '');
    const path = String(entry.path || '');
    if (x === '?' && y === '?') {
        return { mark: '?', kind: 'untracked', title: '未跟踪', path };
    }
    if (x === 'R') return { mark: 'R', kind: 'renamed', title: '重命名', path: `${path} → ${entry.renameTo || ''}` };
    if (x === 'C') return { mark: 'C', kind: 'copied', title: '复制', path };
    if (x === 'D' || y === 'D') return { mark: 'D', kind: 'deleted', title: '删除', path };
    if (x === 'M' && y === 'M') return { mark: 'M', kind: 'modified', title: '已暂存且未暂存修改', path };
    if (x === 'M') return { mark: 'M', kind: 'staged', title: '已暂存修改', path };
    if (y === 'M') return { mark: 'M', kind: 'modified', title: '工作区修改', path };
    if (x === 'A') return { mark: 'A', kind: 'added', title: '已暂存新增', path };
    if (y === '?') return { mark: '?', kind: 'untracked', title: '未跟踪', path };
    return { mark: (x || y || '·'), kind: 'other', title: '改动', path };
}

/** Aggregate status entries into readable counts for the panel header. */
export function summarizeGitStatus(status) {
    const entries = Array.isArray(status?.entries) ? status.entries : [];
    const counts = { modified: 0, added: 0, deleted: 0, untracked: 0, renamed: 0, other: 0 };
    for (const entry of entries) {
        const { kind } = classifyGitEntry(entry);
        if (counts[kind] != null) counts[kind] += 1;
        else counts.other += 1;
    }
    return {
        clean: status?.clean !== false && entries.length === 0,
        counts,
        total: entries.length,
        commit: status?.commit || null,
        branch: status?.branch || null,
    };
}

/** Backend error codes -> short human text shown inside the panel. */
const WORKSPACE_ERROR_TEXT = {
    CODING_FEATURE_DISABLED: '工作区能力未启用（服务端 CODING_WORKSPACE_ENABLED 默认关闭）',
    NOT_GIT_REPO: '该目录不是 Git 仓库顶层',
    FILE_IS_BINARY: '文件为二进制，无法按文本查看',
    WORKSPACE_PATH_NOT_FOUND: '路径不存在',
    PATH_TRAVERSAL: '路径越界（不允许 .. 父级访问）',
    ABSOLUTE_PATH_NOT_ALLOWED: '不支持绝对路径',
    UNC_PATH_NOT_ALLOWED: '不支持 UNC 路径',
    DEVICE_PATH_NOT_ALLOWED: '不支持盘符/设备路径',
    PATH_ESCAPE: '路径逃逸项目根目录（符号链接/junction）',
    PATH_NOT_DIRECTORY: '目标不是目录',
    PATH_NOT_FILE: '目标不是文件',
    ROOT_OUT_OF_BOUNDS: '项目根目录超出服务端允许的工作区范围',
    NO_ALLOWED_ROOTS: '服务端未配置允许的根目录',
    PROJECT_NOT_TRUSTED: '项目尚未被显式信任，无法访问',
    PROJECT_TERMINAL: '项目已归档/撤销，无法访问',
    PROJECT_ROOT_MISSING: '项目根目录已不存在（信任已失效）',
    PROJECT_ROOT_INVALID: '项目未配置根目录',
    INVALID_WORKSPACE_OP: '不支持的操作',
    INVALID_WORKSPACE_ARGS: '请求参数不合法',
    CONCURRENT_RUNTIME: '该 run 已有运行中的 runtime',
    RUN_TERMINAL: 'run 已处于终态，无法再启动',
    NOT_FOUND: '资源不存在或不属于当前用户',
    AUTH_REQUIRED: '需要登录',
};

export function friendlyWorkspaceError(error) {
    const code = String(error?.errorCode || error?.code || '');
    if (WORKSPACE_ERROR_TEXT[code]) {
        return WORKSPACE_ERROR_TEXT[code];
    }
    if (error?.status === 401) return '需要登录';
    if (error?.status === 404) return '资源不存在或不属于当前用户';
    return error?.message || '请求失败，请稍后重试';
}

/** Clamp a 1-based inclusive line range to sane bounds. */
export function normalizeLineRange(startLine, endLine) {
    const start = Math.max(1, Math.floor(Number(startLine) || 1));
    const end = Math.max(start, Math.floor(Number(endLine) || start));
    return { startLine: start, endLine: end };
}

/**
 * Shape sent to /chat as `repo_context`: which trusted project + which file
 * ranges the Graph should attach. Only the server can map this to content.
 */
export function buildRepoContextRef({ projectId, path, startLine, endLine }) {
    const { startLine: start, endLine: end } = normalizeLineRange(startLine, endLine);
    if (!projectId || !path) {
        return null;
    }
    return {
        projectId: String(projectId),
        refs: [{ path: String(path), startLine: start, endLine: end }],
    };
}

/** Short label like `src/a.js:12-40` for the attach chip. */
export function lineWindowLabel(path, startLine, endLine) {
    const { startLine: start, endLine: end } = normalizeLineRange(startLine, endLine);
    const file = String(path || '');
    return start === end ? `${file}:${start}` : `${file}:${start}-${end}`;
}

/** Map an opaque run status into a small label for the run list. */
export function runStatusLabel(status) {
    const map = {
        created: '已创建',
        running: '运行中',
        completed: '已完成',
        failed: '失败',
        cancelled: '已取消',
        cancelled_by_user: '已取消',
    };
    return map[String(status || '')] || String(status || 'created');
}
