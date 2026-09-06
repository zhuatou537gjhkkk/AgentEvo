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
});
