/**
 * Phase 7 / R1 — pure helpers for the in-session Workspace panel.
 *
 * DOM-free on purpose: these functions own the capability gate, the tree display
 * flattening, git porcelain classification, friendly error text and the exact
 * `repo_context` shape that gets POSTed to /chat — locking them here keeps the
 * React panel purely presentational.
 */
import { describe, it, expect } from 'vitest';
import {
    canOpenWorkspace,
    flattenTreeForDisplay,
    classifyGitEntry,
    summarizeGitStatus,
    friendlyWorkspaceError,
    normalizeLineRange,
    buildRepoContextRef,
    lineWindowLabel,
    runStatusLabel,
    canWriteToWorkspace,
    canRunCommands,
    presetLabel,
    isWritePreset,
    presetHint,
    worktreeStatusLabel,
    actionStatusMeta,
    approvalStatusMeta,
    isOpenApproval,
    actionToolLabel,
    isCommandAction,
    isFileAction,
    isFileArtifact,
    isCommandArtifact,
    artifactChangedFiles,
    gitStatusPaths,
    changedFilesForRun,
    commandArtifactSummary,
    commandOutputSummary,
    maskSensitiveArgs,
    approvalCommandArgs,
    frameGitDiff,
    buildRunSummary,
} from '../workspaceModel';

describe('canOpenWorkspace', () => {
    it('is true only when the server reports workspace:true', () => {
        expect(canOpenWorkspace({ workspace: true })).toBe(true);
        expect(canOpenWorkspace({ workspace: false })).toBe(false);
        expect(canOpenWorkspace(null)).toBe(false);
        expect(canOpenWorkspace({})).toBe(false);
        expect(canOpenWorkspace({ workspace: 'true' })).toBe(false);
    });
});

describe('flattenTreeForDisplay', () => {
    it('keeps project-root-relative rel and computes indentation depth', () => {
        const rows = flattenTreeForDisplay([
            { rel: 'deep', type: 'dir' },
            { rel: 'deep/a', type: 'dir' },
            { rel: 'deep/a/b.txt', type: 'file', size: 12 },
            { rel: 'deep/a/b/c', type: 'dir' },
        ]);
        expect(rows).toEqual([
            { rel: 'deep', name: 'deep', type: 'dir', size: null, depth: 0 },
            { rel: 'deep/a', name: 'a', type: 'dir', size: null, depth: 1 },
            { rel: 'deep/a/b.txt', name: 'b.txt', type: 'file', size: 12, depth: 2 },
            { rel: 'deep/a/b/c', name: 'c', type: 'dir', size: null, depth: 3 },
        ]);
    });

    it('tolerates non-array input', () => {
        expect(flattenTreeForDisplay(null)).toEqual([]);
        expect(flattenTreeForDisplay('nope')).toEqual([]);
    });
});

describe('classifyGitEntry', () => {
    it('distinguishes staged vs working-tree modifications', () => {
        expect(classifyGitEntry({ x: 'M', y: '', path: 'a' }).kind).toBe('staged');
        expect(classifyGitEntry({ x: '', y: 'M', path: 'a' }).kind).toBe('modified');
        expect(classifyGitEntry({ x: 'M', y: 'M', path: 'a' }).kind).toBe('modified');
    });
    it('recognizes untracked, added, deleted and renamed entries', () => {
        expect(classifyGitEntry({ x: '?', y: '?', path: 'u' })).toMatchObject({ kind: 'untracked', mark: '?' });
        expect(classifyGitEntry({ x: 'A', y: '', path: 'n' }).kind).toBe('added');
        expect(classifyGitEntry({ x: 'D', y: '', path: 'd' }).kind).toBe('deleted');
        const renamed = classifyGitEntry({ x: 'R', y: '', path: 'old', renameTo: 'new' });
        expect(renamed.kind).toBe('renamed');
        expect(renamed.path).toContain('→');
    });
});

describe('summarizeGitStatus', () => {
    it('reports clean when there are no entries', () => {
        const summary = summarizeGitStatus({ clean: true, entries: [], commit: null, branch: 'main' });
        expect(summary.clean).toBe(true);
        expect(summary.total).toBe(0);
    });
    it('counts by category', () => {
        const summary = summarizeGitStatus({
            entries: [
                { x: '', y: 'M', path: 'a' },
                { x: 'A', y: '', path: 'b' },
                { x: '?', y: '?', path: 'c' },
                { x: 'D', y: '', path: 'd' },
            ],
        });
        expect(summary.clean).toBe(false);
        expect(summary.total).toBe(4);
        expect(summary.counts).toMatchObject({ modified: 1, added: 1, deleted: 1, untracked: 1 });
    });
});

describe('friendlyWorkspaceError', () => {
    it('maps known backend codes to short user text', () => {
        expect(friendlyWorkspaceError({ errorCode: 'PATH_TRAVERSAL' })).toContain('越界');
        expect(friendlyWorkspaceError({ errorCode: 'PROJECT_NOT_TRUSTED' })).toContain('信任');
        expect(friendlyWorkspaceError({ errorCode: 'CODING_FEATURE_DISABLED' })).toContain('未启用');
        expect(friendlyWorkspaceError({ errorCode: 'ROOT_OUT_OF_BOUNDS' })).toContain('允许');
    });
    it('falls back to HTTP status / message', () => {
        expect(friendlyWorkspaceError({ status: 401 })).toContain('登录');
        expect(friendlyWorkspaceError({ status: 404 })).toContain('不存在');
        expect(friendlyWorkspaceError({ message: 'boom' })).toBe('boom');
        expect(friendlyWorkspaceError(null)).toContain('请稍后');
    });
});

describe('normalizeLineRange', () => {
    it('clamps to a sane 1-based inclusive window', () => {
        expect(normalizeLineRange(5, 9)).toEqual({ startLine: 5, endLine: 9 });
        expect(normalizeLineRange(9, 2)).toEqual({ startLine: 9, endLine: 9 });
        expect(normalizeLineRange(0, -3)).toEqual({ startLine: 1, endLine: 1 });
        expect(normalizeLineRange('3', '7')).toEqual({ startLine: 3, endLine: 7 });
    });
});

describe('buildRepoContextRef', () => {
    it('returns the {projectId, refs} shape /chat expects with clamped range', () => {
        const ref = buildRepoContextRef({ projectId: 'proj_1', path: 'src/a.js', startLine: 2, endLine: 40 });
        expect(ref).toEqual({ projectId: 'proj_1', refs: [{ path: 'src/a.js', startLine: 2, endLine: 40 }] });
    });
    it('returns null without a project or path', () => {
        expect(buildRepoContextRef({ path: 'a.js', startLine: 1, endLine: 1 })).toBeNull();
        expect(buildRepoContextRef({ projectId: 'proj_1', path: '', startLine: 1, endLine: 1 })).toBeNull();
    });
});

describe('whole-file repository attachment', () => {
    it('uses a scoped whole_file mode without a fake line range', () => {
        expect(buildRepoContextRef({ projectId: 'proj_1', path: 'src/chatGraph.js', mode: 'whole_file' })).toEqual({
            projectId: 'proj_1',
            refs: [{ path: 'src/chatGraph.js', mode: 'whole_file' }],
        });
    });
});

describe('lineWindowLabel', () => {
    it('renders single-line and range forms', () => {
        expect(lineWindowLabel('src/a.js', 5, 5)).toBe('src/a.js:5');
        expect(lineWindowLabel('src/a.js', 5, 9)).toBe('src/a.js:5-9');
    });
});

describe('runStatusLabel', () => {
    it('maps known statuses and falls back gracefully', () => {
        expect(runStatusLabel('running')).toBe('运行中');
        expect(runStatusLabel('completed')).toBe('已完成');
        expect(runStatusLabel('mystery')).toBe('mystery');
        expect(runStatusLabel(null)).toBe('created');
    });
    it('labels R2 statuses (waiting_approval etc.)', () => {
        expect(runStatusLabel('waiting_approval')).toBe('等待审批');
        expect(runStatusLabel('planning')).toBe('规划中');
        expect(runStatusLabel('preparing')).toBe('准备中');
        expect(runStatusLabel('verifying')).toBe('验证中');
    });
});

describe('R2 capability gates (server-authoritative)', () => {
    it('write tools is on only when capabilities.writeTools is exactly true', () => {
        expect(canWriteToWorkspace({ writeTools: true })).toBe(true);
        expect(canWriteToWorkspace({ writeTools: false })).toBe(false);
        expect(canWriteToWorkspace({})).toBe(false);
        expect(canWriteToWorkspace(null)).toBe(false);
        expect(canWriteToWorkspace({ writeTools: 'true' })).toBe(false);
    });
    it('command tools is on only when capabilities.commandTools is exactly true', () => {
        expect(canRunCommands({ commandTools: true })).toBe(true);
        expect(canRunCommands({ commandTools: false })).toBe(false);
        expect(canRunCommands(null)).toBe(false);
        expect(canRunCommands({})).toBe(false);
    });
});

describe('preset labels / hints', () => {
    it('labels every preset and falls back to observe', () => {
        expect(presetLabel('observe')).toContain('Observe');
        expect(presetLabel('edit')).toContain('审批');
        expect(presetLabel('trusted')).toContain('自动');
        expect(presetLabel('garbage')).toContain('Observe');
        expect(presetLabel(null)).toContain('Observe');
    });
    it('flags only write-enabled presets', () => {
        expect(isWritePreset('edit')).toBe(true);
        expect(isWritePreset('trusted')).toBe(true);
        expect(isWritePreset('observe')).toBe(false);
        expect(isWritePreset(null)).toBe(false);
    });
    it('hints describe the preset policy', () => {
        expect(presetHint('edit')).toContain('审批');
        expect(presetHint('trusted')).toContain('自动批准');
        expect(presetHint('observe')).toContain('只读');
    });
    it('worktree status labels are stable', () => {
        expect(worktreeStatusLabel('ready')).toBe('就绪');
        expect(worktreeStatusLabel('unsupported')).toBe('不支持');
        expect(worktreeStatusLabel('removed')).toBe('已拆除');
        expect(worktreeStatusLabel(undefined)).toBe('未准备');
    });
});

describe('action/approval chip meta', () => {
    it('action statuses map to labels and tones', () => {
        expect(actionStatusMeta('executed')).toEqual({ label: '已执行', tone: 'ok' });
        expect(actionStatusMeta('requested')).toEqual({ label: '待审批', tone: 'warn' });
        expect(actionStatusMeta('approved')).toEqual({ label: '已批准', tone: 'accent' });
        expect(actionStatusMeta('failed')).toEqual({ label: '失败', tone: 'error' });
        expect(actionStatusMeta('mystery').label).toBe('mystery');
    });
    it('approval statuses map to labels and tones', () => {
        expect(approvalStatusMeta('requested')).toEqual({ label: '待处理', tone: 'warn' });
        expect(approvalStatusMeta('approved')).toEqual({ label: '已批准', tone: 'ok' });
        expect(approvalStatusMeta('denied')).toEqual({ label: '已拒绝', tone: 'error' });
    });
    it('only requested approvals are open', () => {
        expect(isOpenApproval({ status: 'requested' })).toBe(true);
        expect(isOpenApproval({ status: 'approved' })).toBe(false);
        expect(isOpenApproval(null)).toBe(false);
    });
    it('action tool labels and classifications', () => {
        expect(actionToolLabel('run_command')).toBe('命令');
        expect(actionToolLabel('write_file')).toBe('写文件');
        expect(isCommandAction({ tool: 'run_command' })).toBe(true);
        expect(isCommandAction({ tool: 'write_file' })).toBe(false);
        expect(isFileAction({ tool: 'apply_patch' })).toBe(true);
        expect(isFileAction({ tool: 'run_command' })).toBe(false);
    });
});

describe('changed-files derivation (R2)', () => {
    const artifacts = [
        { kind: 'file.write', path: 'src/a.js' },
        { kind: 'file.create', path: 'new/README.md' },
        { kind: 'command.output', path: null },
        { kind: 'file.write', path: 'src/a.js' }, // duplicate collapsed
        { kind: 'file.delete', path: 'old.js' },
    ];
    it('collects unique file-artifact paths in first-seen order', () => {
        expect(artifactChangedFiles(artifacts)).toEqual(['src/a.js', 'new/README.md', 'old.js']);
        expect(isFileArtifact({ kind: 'command.output' })).toBe(false);
        expect(isCommandArtifact({ kind: 'command.output' })).toBe(true);
    });
    it('gitStatusPaths reads porcelain entries', () => {
        const status = { entries: [{ x: 'M', y: '', path: 'a.js' }, { x: '?', y: '?', path: 'u.txt' }, { x: 'M', path: 'a.js' }] };
        expect(gitStatusPaths(status)).toEqual(['a.js', 'u.txt']);
        expect(gitStatusPaths(null)).toEqual([]);
    });
    it('changedFilesForRun unions artifacts and git status', () => {
        const status = { entries: [{ x: '', y: 'M', path: 'src/b.js' }] };
        expect(changedFilesForRun({ artifacts, gitStatus: status })).toEqual([
            'src/a.js', 'new/README.md', 'old.js', 'src/b.js',
        ]);
    });
});

describe('command summaries (digest-only)', () => {
    it('artifact summary reads meta only, never output bytes', () => {
        const artifact = {
            kind: 'command.output',
            path: null,
            digest: 'abc123',
            sizeBytes: 42,
            meta: { executable: 'node', args: ['x'], cwdRelative: 'src', exitCode: 1, timedOut: false, cancelled: false, truncated: true, durationMs: 9 },
        };
        expect(commandArtifactSummary(artifact)).toEqual({
            executable: 'node', exitCode: 1, timedOut: false, cancelled: false, truncated: true,
            durationMs: 9, sizeBytes: 42,
        });
    });
    it('live command output summary keeps stdout/stderr text', () => {
        const out = commandOutputSummary({ executable: 'git', code: 0, stdout: 'clean', stderr: '', truncated: false });
        expect(out.stdout).toBe('clean');
        expect(out.code).toBe(0);
        expect(commandOutputSummary(null).stdout).toBe('');
    });
    it('maskSensitiveArgs hides long unbroken secret-shaped args only', () => {
        expect(maskSensitiveArgs(['README.md', '--token', '01234567890123456789012345678901'])).toEqual([
            'README.md', '--token', '••••••（32 字符已隐藏）',
        ]);
        expect(maskSensitiveArgs('nope')).toEqual([]);
    });
    it('approvalCommandArgs surfaces the durable redacted summary', () => {
        const action = { tool: 'run_command', input: { op: 'run_command', executable: 'node', args: ['--key', '01234567890123456789012345678901'], cwdRelative: 'src' } };
        expect(approvalCommandArgs(action).executable).toBe('node');
        expect(approvalCommandArgs(action).args[0]).toBe('--key');
        expect(approvalCommandArgs(action).args[1]).toContain('已隐藏');
    });
});

describe('frameGitDiff', () => {
    it('normalizes a run-scoped git.diff data payload', () => {
        const framed = frameGitDiff({ diff: 'diff --git a/x b/x', filesChanged: ['x'], truncated: false, byteLength: 100, commit: 'c1' });
        expect(framed).toEqual({ text: 'diff --git a/x b/x', filesChanged: ['x'], truncated: false, byteLength: 100, commit: 'c1' });
        expect(frameGitDiff(null).text).toBe('');
        expect(frameGitDiff({}).filesChanged).toEqual([]);
    });
});

describe('buildRunSummary (client-side summary card)', () => {
    const run = {
        status: 'completed', preset: 'trusted', mode: 'trusted',
        worktreeBranch: 'coding/run-r1', baseBranch: 'main', baseCommit: 'aabbcc',
    };
    const actions = [
        { status: 'executed' }, { status: 'executed' }, { status: 'failed' },
    ];
    const approvals = [{ status: 'approved' }, { status: 'denied' }, { status: 'approved' }];
    const artifacts = [{ kind: 'file.write', path: 'a.js' }];
    const gitStatus = { entries: [{ path: 'b.js' }] };
    const outputs = [{ executable: 'node', code: 0, stdout: 'ok' }, { executable: 'git', code: 1, stderr: 'x' }];
    it('aggregates status/counts/changed files/last command outputs', () => {
        const s = buildRunSummary({ run, actions, approvals, artifacts, gitStatus, commandOutputs: outputs });
        expect(s.status).toBe('completed');
        expect(s.preset).toBe('trusted');
        expect(s.worktreeBranch).toBe('coding/run-r1');
        expect(s.baseCommit).toBe('aabbcc');
        expect(s.counts).toMatchObject({ executed: 2, failed: 1, approved: 2, denied: 1, changedFiles: 2 });
        expect(s.changedFiles).toEqual(['a.js', 'b.js']);
        expect(s.commandOutputs).toHaveLength(2);
        expect(s.commandOutputs[0].executable).toBe('node');
    });
    it('tolerates missing inputs', () => {
        const s = buildRunSummary({ run: null });
        expect(s.status).toBeNull();
        expect(s.counts.executed).toBe(0);
        expect(s.changedFiles).toEqual([]);
        expect(s.commandOutputs).toEqual([]);
    });
});
