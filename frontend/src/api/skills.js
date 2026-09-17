/**
 * Phase 7 / R5 — product Skills Runtime HTTP surface wrappers. Thin, read-only
 * clients over backend/src/routes/skillRoutes.js (`/skills`). Skills are process
 * knowledge — they never grant tools or permissions, so these calls only READ
 * the manifest registry. Reuses the shared `request()` transport from chat.js.
 *
 * NOTE: the whole tree answers 403 SKILLS_DISABLED while SKILLS_ENABLED is off;
 * callers surface that as an "enable the flag" hint instead of an error.
 */
import { request } from './chat.js';

/** Resolve the shared transport result to its JSON envelope. */
async function unwrap(promise) {
    const body = await promise;
    if (body && typeof body.json === 'function') {
        return body.json();
    }
    return body;
}

/** GET /skills — canonical manifests (public fields only). */
export function fetchSkills() {
    return unwrap(request('/skills'));
}

/** GET /skills/match?q= — deterministic matches [{ name, version, score }]. */
export function matchSkills(q) {
    return unwrap(request(`/skills/match?q=${encodeURIComponent(String(q || '').trim())}`));
}

/** GET /skills/:name — one manifest by exact name. */
export function fetchSkill(name) {
    return unwrap(request(`/skills/${encodeURIComponent(String(name || ''))}`));
}
