/**
 * Phase 7 / R5 (roadmap #1 + #2) — product Skills Runtime service.
 *
 * SkillsService is the runtime seam between the Router/Planner and the skill
 * registry. Two responsibilities:
 *
 *   1. resolvePlanning — when the SKILLS_ENABLED master flag is ON, match the
 *      user's request to a skill and return a Markdown process guide PLUS a
 *      planner packet. The guide is KNOWLEDGE ONLY: it never promises that a
 *      tool will be called, a file written, or extra permission granted (#2).
 *      When the flag is OFF resolvePlanning returns null so the legacy planning
 *      path is byte-for-byte untouched.
 *   2. auditActivation — best-effort, failure-swallowing recording of which
 *      skill was activated/denied for a coding run. The console line never
 *      carries user input or secrets; the durable coding event is only written
 *      when runId AND CODING_EVENT_LOG_ENABLED are both set.
 *
 * Flags are read at call time (never import time). The default singleton is
 * constructed with no deps and stays cheap while the feature is dark.
 */
import { createSkillRegistry } from "./registry.js";
// Static import of the pure extensibility flags module (no side effects). The
// getter itself reads process.env at every call, so tests can flip per call.
import { skillsEnabled } from "../extensibility/flags.js";

const DISCLAIMER =
    "本指引仅为流程/规则知识，不授予任何工具或额外权限；实际执行由服务端授权决定。";

/**
 * Render a canonical skill into pure-Markdown process guidance. Deliberately
 * phrased as instructions to follow ("read the X", "identify the Y") rather than
 * promises the runtime will perform them — a skill never executes anything.
 */
export function renderSkillGuidance(skill) {
    const wf = skill?.workflow || {};
    const steps = Array.isArray(wf.steps) ? wf.steps : [];
    const lines = [];
    lines.push(`# ${wf.title || skill?.name || "skill"}`);
    const description = String(skill?.description || "").trim();
    if (description) {
        lines.push("");
        lines.push(`**目标**：${description}`);
    }
    lines.push("");
    lines.push("**流程指引（仅流程/规则/知识）：**");
    steps.forEach((step, i) => {
        const label = String(step.step || `步骤 ${i + 1}`).trim();
        lines.push("");
        lines.push(`${i + 1}. **${label}**`);
        const goal = String(step.goal || "").trim();
        if (goal) lines.push(`   - 目标：${goal}`);
        const verify = String(step.verify || "").trim();
        if (verify) lines.push(`   - 验证：${verify}`);
    });
    lines.push("");
    lines.push(`> ${DISCLAIMER}`);
    return lines.join("\n");
}

export class SkillsService {
    constructor({ registry = createSkillRegistry(), now = () => new Date() } = {}) {
        this.registry = registry;
        // Clock kept for parity with sibling services / future time-based rules.
        this.now = now;
    }

    list() {
        return this.registry.list();
    }

    get(name) {
        return this.registry.get(name);
    }

    /**
     * Planning hook. Returns null when the Skills Runtime master switch is off
     * (legacy path untouched). When ON:
     *   - no match → { matched: [], guidance: null, packets: [] }
     *   - matched  → { matched: [{name,version,score}], guidance, packets }
     * `intents`/`agent` are accepted for caller parity but do not change the
     * deterministic registry match (the skill is chosen from the user's words).
     */
    resolvePlanning({ userInput, intents = [], agent = null } = {}) {
        if (!skillsEnabled()) return null;

        const matches = this.registry.match(String(userInput || ""), { limit: 5 });
        const top = matches[0];
        if (!top || top.score <= 0) {
            return { matched: [], guidance: null, packets: [] };
        }

        const skill = top.skill;
        const guidance = renderSkillGuidance(skill);
        return {
            matched: matches.map((m) => ({
                name: m.skill.name,
                version: m.skill.version,
                score: m.score,
            })),
            guidance,
            packets: [
                {
                    content: guidance,
                    metadata: {
                        type: "skill",
                        source: skill.name,
                        version: skill.version,
                    },
                },
            ],
        };
    }

    /**
     * Best-effort audit of a skill activation/denial. Never throws to the caller
     * and never prints user input/secrets. Returns { recorded } where recorded is
     * true only when a durable coding event was actually written.
     * @param {{userId:number, tenantId:string}} scope owner scope of the run
     */
    async auditActivation(scope, { runId = null, name = "", version = "", matched = false, reason = null } = {}) {
        const safeName = String(name || "").slice(0, 128);
        const safeVersion = String(version || "").slice(0, 32);
        // reason is deliberately NOT logged or stored: it may echo user input.
        console.log(`[skill] name=${safeName} version=${safeVersion} matched=${matched} run=${runId || "-"}`);

        if (!runId) return { recorded: false };
        try {
            // Lazy dynamic import: coding/events.js opens the DB on first append,
            // so a dark skills runtime must never pull it in. Gated behind runId
            // AND the event-log flag before the store is touched.
            const [{ codingEventLogEnabled }, eventsModule] = await Promise.all([
                import("../coding/flags.js"),
                import("../coding/events.js"),
            ]);
            if (!codingEventLogEnabled()) return { recorded: false };
            const eventStore = eventsModule.default || eventsModule.defaultEventStore;
            eventStore.appendEvent(scope, runId, {
                type: matched ? "skill.activated" : "skill.denied",
                payload: { skill: safeName, version: safeVersion },
            });
            return { recorded: true };
        } catch {
            // Audit failure must never break the main flow.
            return { recorded: false };
        }
    }
}

export const defaultSkillsService = new SkillsService();
export default defaultSkillsService;
