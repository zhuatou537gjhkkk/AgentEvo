/**
 * Phase 7 / R2 — Permission presets for coding runs.
 *
 * Only three presets exist (roadmap R2): `observe` (reads only), `edit`
 * (file mutations require owner approval; commands not offered), and `trusted`
 * (file mutations auto-approved by server policy; commands STILL require
 * approval). Presets are a server-side fact derived from the run record — a
 * client/model can never select their own policy.
 *
 * Capability is computed at call time: the preset's effect is intersected with
 * the current feature flags (CODING_WRITE_TOOLS_ENABLED / CODING_COMMAND_TOOLS_ENABLED).
 * A run created earlier as `edit`/`trusted` degrades to read-only the moment the
 * corresponding flag is off — never silently auto-approved.
 */
import { codingError } from "./util.js";
import { codingCommandToolsEnabled, codingWriteToolsEnabled } from "./flags.js";

export const PRESET_LABELS = Object.freeze({
    observe: "Observe",
    edit: "Edit with approval",
    trusted: "Trusted project",
});

// writeEffect / execEffect ∈ "allow" | "approve" | "auto" | "deny"
export const PRESETS = Object.freeze({
    observe: { write: "deny", exec: "deny" },
    edit: { write: "approve", exec: "deny" },
    trusted: { write: "auto", exec: "approve" },
});

export const ALLOWED_PRESETS = Object.freeze(Object.keys(PRESETS));

/** Normalize a run's preset string; unknown → observe (never trust a bad value). */
export function normalizePreset(value) {
    const raw = String(value || "observe").trim().toLowerCase();
    return PRESETS[raw] ? raw : "observe";
}

/** The raw preset effect table for a run (before feature-flag intersection). */
export function presetPolicy(preset) {
    const key = normalizePreset(preset);
    return { preset: key, ...PRESETS[key] };
}

/**
 * The effect that applies RIGHT NOW to a run's op — flags read at call time.
 *
 * @returns {{ preset, write: "deny"|"approve"|"auto", exec: "deny"|"approve",
 *             writeDisabledReason?: string, execDisabledReason?: string }}
 */
export function effectivePolicy(preset, { flags = null } = {}) {
    const key = normalizePreset(preset);
    const policy = { ...PRESETS[key] };
    const f = flags || { write: codingWriteToolsEnabled(), exec: codingCommandToolsEnabled() };
    const out = { preset: key, write: policy.write, exec: policy.exec, writeDisabledReason: null, execDisabledReason: null };
    if (!f.write) {
        out.write = "deny";
        out.writeDisabledReason = "CODING_WRITE_TOOLS_DISABLED";
    }
    if (!f.exec) {
        out.exec = "deny";
        out.execDisabledReason = "CODING_COMMAND_TOOLS_DISABLED";
    }
    return out;
}

/** True when a run whose preset normally allows a write can still be approved. */
export function writePolicyError(policy, effect) {
    if (effect !== "write") return null;
    if (policy.writeDisabledReason) {
        return codingError(policy.writeDisabledReason, "file write tools are disabled", 403);
    }
    if (policy.write === "deny") {
        return codingError("WRITE_NOT_PERMITTED", "this run preset does not allow file changes", 403);
    }
    return null;
}

export function execPolicyError(policy, effect) {
    if (effect !== "exec") return null;
    if (policy.execDisabledReason) {
        return codingError(policy.execDisabledReason, "command execution is disabled", 403);
    }
    if (policy.exec === "deny") {
        return codingError("COMMAND_NOT_PERMITTED", "this run preset does not allow commands", 403);
    }
    return null;
}
