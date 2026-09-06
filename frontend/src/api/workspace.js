/**
 * Phase 7 / R1 — Workspace panel API. Thin typed wrappers over the coding
 * registrar endpoints (backend/src/routes/codingRoutes.js). Reuses the shared
 * `request()` transport (auth header, timeout, error envelope) from chat.js.
 */
import { request } from './chat.js';

const CODING_BASE = '/coding';

async function unwrap(promise) {
    const body = await promise;
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
