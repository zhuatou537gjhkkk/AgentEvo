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
    RUN_TERMINAL: 'run 已处于终态，无法再执行该操作',
    RUN_TRANSITION: 'run 当前状态不允许该操作',
    RUN_NO_PROJECT: '该 run 未绑定项目，无法进行工作区操作',
    RUN_REQUIRES_PROJECT: '写模式 run 必须绑定一个项目',
    MODE_NOT_AVAILABLE: 'run 模式不可用（仅 observe/edit/trusted）',
    NOT_FOUND: '资源不存在或不属于当前用户',
    AUTH_REQUIRED: '需要登录',

    // ── R2 write / exec / approval error codes ──
    APPROVAL_DENIED: '审批被拒绝，操作未执行',
    APPROVAL_EXPIRED: '审批已过期，请重新提交该操作',
    APPROVAL_CANCELLED: '审批已取消',
    APPROVAL_DECIDED: '该审批已被处理过，无法重复决定',
    EXEC_NOT_ALLOWLISTED: '该命令不在服务端白名单内，无法执行',
    WRITE_NOT_PERMITTED: '当前 run 预设不允许文件写入',
    COMMAND_NOT_PERMITTED: '当前 run 预设不允许执行命令',
    WRITE_TOOLS_DISABLED: '服务端未启用文件写入能力（CODING_WRITE_TOOLS_ENABLED）',
    COMMAND_TOOLS_DISABLED: '服务端未启用命令执行能力（CODING_COMMAND_TOOLS_ENABLED）',
    CODING_COMMAND_TOOLS_DISABLED: '服务端未启用命令执行能力（CODING_COMMAND_TOOLS_ENABLED）',
    COMMAND_EXECUTION_DISABLED: '命令执行能力被禁用',
    WORKTREE_UNSUPPORTED: '该项目根目录不是 Git 工作树顶层，无法写入/执行',
    WORKTREE_NOT_READY: '工作树未就绪，请先 Provision',
    WORKTREE_PROVISION_FAILED: '工作树准备失败，无法执行写入/命令',
    ACTION_NOT_APPROVED: '该操作尚未被批准，无法执行',
    ACTION_NOT_EXECUTABLE: '该操作当前不可执行',
    ACTION_MISMATCH: '批准记录与本次请求不一致，无法执行',
    EXEC_TIMEOUT: '命令执行超时（进程树已终止）',
    EXEC_CANCELLED: '命令已被取消',
    EXECUTION_FAILED: '命令执行失败',
    PATCH_APPLY_FAILED: '补丁无法应用（内容不匹配）',
    WORKSPACE_STALE: '文件已变更，补丁过期，请重新生成',
    FILE_TOO_LARGE: '文件过大，无法写入',
    RESERVED_PATH: 'git 内部路径不允许通过工作区操作写入',
    PAYLOAD_TOO_LARGE: '请求内容过大',
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
        preparing: '准备中',
        planning: '规划中',
        running: '运行中',
        waiting_approval: '等待审批',
        verifying: '验证中',
        completed: '已完成',
        failed: '失败',
        cancelled: '已取消',
        cancelled_by_user: '已取消',
    };
    return map[String(status || '')] || String(status || 'created');
}

// ═══════════════════════════════════════════════════════════
// Phase 7 / R2 — write-run control helpers (DOM-free).
// The server is authoritative: capability flags + run.preset decide what a
// panel may offer. These functions only label/derive/summarize server facts.
// ═══════════════════════════════════════════════════════════

/** True only when the server reports write tools enabled. */
export function canWriteToWorkspace(capabilities) {
    return Boolean(capabilities && capabilities.writeTools === true);
}

/** True only when the server reports structured-command tools enabled. */
export function canRunCommands(capabilities) {
    return Boolean(capabilities && capabilities.commandTools === true);
}

/** Human label for a run preset (mirrors backend presets.js). */
export function presetLabel(preset) {
    const map = {
        observe: 'Observe 只读',
        edit: 'Edit 写需审批',
        trusted: 'Trusted 自动写入',
    };
    return map[String(preset || '')] || presetLabel('observe');
}

/** True when the preset is a write-enabled mode (edit/trusted). */
export function isWritePreset(preset) {
    return preset === 'edit' || preset === 'trusted';
}

/** One-line preset policy hint shown next to the mode picker / run header. */
export function presetHint(preset) {
    const map = {
        observe: '仅只读：不写入文件、不执行命令',
        edit: '文件写入需 owner 审批；不提供命令',
        trusted: '文件写入由服务端按 preset 自动批准；命令仍需 owner 审批',
    };
    return map[String(preset || '')] || map.observe;
}

/** Run-scoped worktree lifecycle status -> short label. */
export function worktreeStatusLabel(status) {
    const map = {
        none: '未准备',
        provisioning: '准备中',
        ready: '就绪',
        unsupported: '不支持',
        failed: '准备失败',
        removed: '已拆除',
    };
    return map[String(status || 'none')] || String(status || 'none');
}

const ACTION_STATUS_META = {
    pending: { label: '待提交', tone: 'muted' },
    requested: { label: '待审批', tone: 'warn' },
    approved: { label: '已批准', tone: 'accent' },
    executing: { label: '执行中', tone: 'accent' },
    executed: { label: '已执行', tone: 'ok' },
    failed: { label: '失败', tone: 'error' },
    denied: { label: '已拒绝', tone: 'error' },
};

/** Action status -> { label, tone } chip meta for the run panel. */
export function actionStatusMeta(status) {
    return ACTION_STATUS_META[String(status || '')] || { label: String(status || 'pending'), tone: 'muted' };
}

const APPROVAL_STATUS_META = {
    requested: { label: '待处理', tone: 'warn' },
    approved: { label: '已批准', tone: 'ok' },
    denied: { label: '已拒绝', tone: 'error' },
    expired: { label: '已过期', tone: 'muted' },
    cancelled: { label: '已取消', tone: 'muted' },
};

/** Approval status -> { label, tone } chip meta for the run panel. */
export function approvalStatusMeta(status) {
    return APPROVAL_STATUS_META[String(status || '')] || { label: String(status || 'requested'), tone: 'muted' };
}

/** True when the approval still needs an owner decision. */
export function isOpenApproval(approval) {
    return Boolean(approval && approval.status === 'requested');
}

/** Chinese label for a durable action tool name. */
export function actionToolLabel(tool) {
    const map = {
        run_command: '命令',
        write_file: '写文件',
        create_file: '建文件',
        delete_file: '删文件',
        apply_patch: '打补丁',
    };
    return map[String(tool || '')] || String(tool || '操作');
}

/** True when a run action row is a structured-command op. */
export function isCommandAction(action) {
    return String(action?.tool || '') === 'run_command';
}

/** True when a run action row is a file-mutation op. */
export function isFileAction(action) {
    return ['write_file', 'create_file', 'delete_file', 'apply_patch'].includes(String(action?.tool || ''));
}

const FILE_ARTIFACT_KINDS = new Set(['file.write', 'file.create', 'file.patch', 'file.delete']);

/** True when the artifact row records a file mutation (carries a rel path). */
export function isFileArtifact(artifact) {
    return FILE_ARTIFACT_KINDS.has(String(artifact?.kind || ''));
}

/** True when the artifact row records a structured-command output digest. */
export function isCommandArtifact(artifact) {
    return String(artifact?.kind || '') === 'command.output';
}

/**
 * Unique rel paths of the run's durable file-mutation artifacts, in first-seen
 * order. These are the "changed files" the ledger can prove without the worktree.
 */
export function artifactChangedFiles(artifacts) {
    const seen = new Set();
    const out = [];
    for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
        const p = String(artifact?.path || '');
        if (p && isFileArtifact(artifact) && !seen.has(p)) {
            seen.add(p);
            out.push(p);
        }
    }
    return out;
}

/** Unique paths from a git.status payload ({ entries: [{x,y,path,...}] }). */
export function gitStatusPaths(status) {
    const seen = new Set();
    const out = [];
    for (const entry of Array.isArray(status?.entries) ? status.entries : []) {
        const p = String(entry?.path || '');
        if (p && !seen.has(p)) {
            seen.add(p);
            out.push(p);
        }
    }
    return out;
}

/** Union of a run's changed-file paths from artifacts + live git status. */
export function changedFilesForRun({ artifacts = [], gitStatus = null } = {}) {
    const seen = new Set([...artifactChangedFiles(artifacts), ...gitStatusPaths(gitStatus)]);
    return Array.from(seen);
}

/**
 * Decorate a command.output artifact row into the small summary the panel shows
 * (digest only — output bytes never reach the client, only meta + sizes).
 */
export function commandArtifactSummary(artifact) {
    const meta = (artifact && artifact.meta) || {};
    return {
        executable: meta.executable || null,
        exitCode: meta.exitCode == null ? null : Number(meta.exitCode),
        timedOut: meta.timedOut === true,
        cancelled: meta.cancelled === true,
        truncated: meta.truncated === true,
        durationMs: meta.durationMs == null ? null : Number(meta.durationMs),
        sizeBytes: artifact?.sizeBytes == null ? null : Number(artifact.sizeBytes),
    };
}

/**
 * Command output captured by the live caller (only after an approved action
 * executed): stdout/stderr are shown because the owner just approved the run.
 */
export function commandOutputSummary(output) {
    const o = output && typeof output === 'object' ? output : {};
    return {
        executable: o.executable || null,
        args: Array.isArray(o.args) ? o.args : [],
        code: o.code == null ? null : Number(o.code),
        stdout: String(o.stdout || ''),
        stderr: String(o.stderr || ''),
        timedOut: o.timedOut === true,
        cancelled: o.cancelled === true,
        truncated: o.truncated === true,
        durationMs: o.durationMs == null ? null : Number(o.durationMs),
    };
}

/**
 * Mask obvious secret-like command args for the approval card: an unbroken run
 * of 24+ non-space characters is very likely a token/key, so we hide it while
 * keeping its length visible. Short args (paths, flags) pass through verbatim.
 */
export function maskSensitiveArgs(args) {
    return (Array.isArray(args) ? args : []).map((arg) => {
        const text = String(arg ?? '');
        return /^[^\s]{24,}$/.test(text) ? `••••••（${text.length} 字符已隐藏）` : text;
    });
}

/**
 * A read/exec summary's command args shown on the approval card are the live
 * caller's own args — mask only secret-shaped values before rendering.
 */
export function approvalCommandArgs(action) {
    const input = (action && action.input) || {};
    const args = Array.isArray(input.args) ? input.args : [];
    return {
        executable: input.executable || null,
        cwdRelative: input.cwdRelative || null,
        args: maskSensitiveArgs(args),
        bytes: input.bytes == null ? null : Number(input.bytes),
        patchBytes: input.patchBytes == null ? null : Number(input.patchBytes),
        path: input.path || null,
    };
}

/**
 * Normalize a run-scoped git.diff data payload into the shape the panel renders
 * (defensive: the server already returns {diff, filesChanged, truncated,...}).
 */
export function frameGitDiff(data) {
    const d = data && typeof data === 'object' ? data : {};
    return {
        text: typeof d.diff === 'string' ? d.diff : '',
        filesChanged: Array.isArray(d.filesChanged) ? d.filesChanged : [],
        truncated: d.truncated === true,
        byteLength: d.byteLength == null ? null : Number(d.byteLength),
        commit: d.commit || null,
    };
}

/**
 * Client-side run summary card. All inputs are server facts already on hand:
 * run row, action/approval/artifact lists, plus the live caller's command
 * outputs (in-memory only). No extra fetch.
 */
export function buildRunSummary({ run = null, actions = [], approvals = [], artifacts = [], gitStatus = null, commandOutputs = [] } = {}) {
    const runActions = Array.isArray(actions) ? actions : [];
    const runApprovals = Array.isArray(approvals) ? approvals : [];
    const runArtifacts = Array.isArray(artifacts) ? artifacts : [];
    const outputs = (Array.isArray(commandOutputs) ? commandOutputs : []).filter((o) => o && o.executable);
    const changed = changedFilesForRun({ artifacts: runArtifacts, gitStatus });
    return {
        status: run?.status || null,
        preset: run?.preset || run?.mode || null,
        worktreeBranch: run?.worktreeBranch || null,
        baseBranch: run?.baseBranch || null,
        baseCommit: run?.baseCommit || null,
        counts: {
            executed: runActions.filter((a) => a.status === 'executed').length,
            failed: runActions.filter((a) => a.status === 'failed').length,
            approved: runApprovals.filter((a) => a.status === 'approved').length,
            denied: runApprovals.filter((a) => a.status === 'denied').length,
            changedFiles: changed.length,
        },
        changedFiles: changed,
        commandOutputs: outputs.slice(0, 5).map(commandOutputSummary),
    };
}
