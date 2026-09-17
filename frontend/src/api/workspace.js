/**
 * Phase 7 / R1 — Workspace panel API. Thin typed wrappers over the coding
 * registrar endpoints (backend/src/routes/codingRoutes.js). Reuses the shared
 * `request()` transport (auth header, timeout, error envelope) from chat.js.
 */
import { request } from './chat.js';

const CODING_BASE = '/coding';

/**
 * Resolve the shared transport result to its JSON envelope. `request()` returns
 * the raw `Response` on success; parse `.json()` when present so every wrapper
 * resolves the `{ ok, ... }` body its consumers read fields off directly.
 */
async function unwrap(promise) {
    const body = await promise;
    if (body && typeof body.json === 'function') {
        return body.json();
    }
    return body;
}

/** GET /coding/capabilities — which coding capabilities the server enabled. */
export function fetchCapabilities() {
    return unwrap(request(`${CODING_BASE}/capabilities`));
}

// ── projects / trust ──
export function listProjects({ status } = {}) {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    return unwrap(request(`${CODING_BASE}/projects${query}`));
}

export function registerProject({ name, rootPath }) {
    return unwrap(request(`${CODING_BASE}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, root_path: rootPath }),
    }));
}

export function updateProject(projectId, patch) {
    return unwrap(request(`${CODING_BASE}/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    }));
}

export function revokeProject(projectId) {
    return unwrap(request(`${CODING_BASE}/projects/${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
    }));
}

// ── workspace (R1 read-only ops through the runner boundary) ──
export function openProject(projectId) {
    return unwrap(request(`${CODING_BASE}/projects/${encodeURIComponent(projectId)}/open`, {
        method: 'POST',
    }));
}

export function runWorkspaceOp(projectId, op, args = {}) {
    return unwrap(request(`${CODING_BASE}/projects/${encodeURIComponent(projectId)}/ops`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, args }),
    }));
}

// ── runs / events (R0 observe snapshots) ──
export function listRuns({ projectId } = {}) {
    const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    return unwrap(request(`${CODING_BASE}/runs${query}`));
}

export function createRun({ projectId, sessionId, mode = 'observe' }) {
    return unwrap(request(`${CODING_BASE}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId || null, session_id: sessionId || null, mode }),
    }));
}

export function startRun(runId) {
    return unwrap(request(`${CODING_BASE}/runs/${encodeURIComponent(runId)}/start`, {
        method: 'POST',
    }));
}

export function cancelRun(runId) {
    return unwrap(request(`${CODING_BASE}/runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
    }));
}

export function fetchRunEvents(runId, afterSeq = 0) {
    return unwrap(request(`${CODING_BASE}/runs/${encodeURIComponent(runId)}/events?after_seq=${Number(afterSeq) || 0}`));
}

// ── R2 run-scoped write/exec: provision / teardown / ops / approvals / artifacts ──
// Writes + commands land ONLY in the run's disposable worktree through the action
// executor; reads target the run's resolved root (worktree when provisioned).

/** POST /coding/runs/:id/provision — create the run's disposable worktree. */
export function provisionRun(runId) {
    return unwrap(request(`${CODING_BASE}/runs/${encodeURIComponent(runId)}/provision`, {
        method: 'POST',
    }));
}

/**
 * POST /coding/runs/:id/land — apply a COMPLETED run's disposable-worktree
 * changes onto the REAL project checkout's working tree. No commit, no staging:
 * the real files change and the owner reviews/commits themselves. Server re-checks
 * trust + allowed roots + conflicts before touching anything.
 */
export function landRunToMain(runId) {
    return unwrap(request(`${CODING_BASE}/runs/${encodeURIComponent(runId)}/land`, {
        method: 'POST',
    }));
}

/** POST /coding/runs/:id/teardown — remove the run's disposable worktree. */
export function teardownRun(runId) {
    return unwrap(request(`${CODING_BASE}/runs/${encodeURIComponent(runId)}/teardown`, {
        method: 'POST',
    }));
}

/**
 * POST /coding/runs/:id/ops — one run-scoped op.
 * Read ops → { effect:'read', op, data }. Write/exec → { status:'executed' |
 * 'awaiting_approval', run, action, approval, artifact?, data? }. `wait` omitted/
 * false never blocks: approve-mode ops return awaiting_approval immediately.
 */
export function runRunOp(runId, op, args = {}, wait = false) {
    return unwrap(request(`${CODING_BASE}/runs/${encodeURIComponent(runId)}/ops`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, args, wait: Boolean(wait) }),
    }));
}

/**
 * POST /coding/runs/:id/actions/:actionId/execute — resume an owner-approved
 * action with the IDENTICAL live op+args the caller originally submitted
 * (args are never reconstructed server-side; the atomic claim runs at most once).
 */
export function executeApprovedAction(runId, actionId, op, args = {}) {
    return unwrap(request(
        `${CODING_BASE}/runs/${encodeURIComponent(runId)}/actions/${encodeURIComponent(actionId)}/execute`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op, args }),
        },
    ));
}

/** GET /coding/runs/:id/actions → { actions, count }. */
export function listRunActions(runId) {
    return unwrap(request(`${CODING_BASE}/runs/${encodeURIComponent(runId)}/actions`));
}

/** GET /coding/runs/:id/approvals?status= → { approvals, count }. */
export function listRunApprovals(runId, { status } = {}) {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    return unwrap(request(`${CODING_BASE}/runs/${encodeURIComponent(runId)}/approvals${query}`));
}

/** POST /coding/approvals/:approvalId/decision — owner approves or denies. */
export function decideApproval(approvalId, approve, reason = null) {
    return unwrap(request(`${CODING_BASE}/approvals/${encodeURIComponent(approvalId)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve: Boolean(approve), reason: reason || null }),
    }));
}

/** GET /coding/runs/:id/artifacts → { artifacts, count }. */
export function listRunArtifacts(runId) {
    return unwrap(request(`${CODING_BASE}/runs/${encodeURIComponent(runId)}/artifacts`));
}

/** GET /coding/runs/:id — fresh run row (reconnect re-pull). */
export function fetchRun(runId) {
    return unwrap(request(`${CODING_BASE}/runs/${encodeURIComponent(runId)}`));
}
