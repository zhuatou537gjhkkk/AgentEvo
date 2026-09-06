/**
 * Phase 7 / R5 (roadmap #1 + #2) — product Skills Runtime manifest.
 *
 * A skill is a declarative manifest of PROCESS/RULES/KNOWLEDGE ONLY. It never
 * grants a Tool and never introduces a new agent type (#2). The vocabulary here
 * deliberately reuses the same five EFFECTS and four agent-kind words as the
 * canonical AgentCard (protocol/agentCard.js), so an operator reading a skill
 * and a card compares like for like — but a skill's `capability` is a *claim*,
 * never an authorization: `effects` states what the guided flow would need if
 * the server later decided to run it, and `agents` (SKILL_AGENT_HINTS) is only a
 * routing hint for which existing graph node the guidance is relevant to.
 *
 * normalize → validate is the sole gate. normalize is forgiving (cleans,
 * intersects to known vocab, keeps unknown fields under `extra`); validate is
 * strict and is what a skill must pass before it is loadable.
 *
 * Everything here is pure and deterministic: no DB, no network, no LLM.
 */

export const SKILL_SCHEMA_VERSION = "1.0";

// Same five effects as protocol/agentCard EFFECT_TYPES. Order is preserved when
// re-emitting normalized capability.effects.
export const SKILL_EFFECTS = Object.freeze(["read", "write", "exec", "network", "external"]);

// Same four agent kinds as protocol/agentCard KNOWN_AGENTS. In a skill these are
// FLOW HINTS ONLY — they pick which existing graph node (search/knowledge/code/
// general_chat) a step's guidance is aimed at. A skill cannot mint an agent.
export const SKILL_AGENT_HINTS = Object.freeze(["search", "knowledge", "code", "general"]);

// Minimum coding-run preset the flow assumes (write steps need at least `edit`;
// read-only flows run under `observe`). `null` = no preset requirement.
export const SKILL_PRESETS = Object.freeze(["observe", "edit", "trusted"]);

// Where the skill applies. Runs in the coding control plane are `run`-scoped,
// but a skill manifest is product knowledge, so owner is the honest default.
export const SKILL_SCOPES = Object.freeze(["owner", "project", "run"]);

// Existing chatGraph nodes a skill's guidance may hint at. Never extended here.
export const SKILL_GRAPH_NODES = Object.freeze([
    "search_agent", "knowledge_agent", "code_agent", "general_chat",
]);

// Skill kind vocabulary. First product batch are coding skills (#3).
export const SKILL_TYPES = Object.freeze(["coding", "research", "utility"]);

const CONTROL_KEEP = new Set([9, 10, 13]); // tab / lf / cr kept, like coding/util.js

/**
 * Keep tab/lf/cr, drop NUL + other control chars, cap length and trim.
 * Mirrors the coding-domain cleanText/stripControl approach so manifest strings
 * (user or file controlled) can never smuggle control bytes downstream.
 */
export function cleanSkillString(value, max = 4000) {
    let out = "";
    for (const ch of String(value ?? "")) {
        const code = ch.charCodeAt(0);
        if (CONTROL_KEEP.has(code)) { out += ch; continue; }
        if (code < 32 || code === 127) continue;
        out += ch;
    }
    return out.slice(0, max).trim();
}

function asArray(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
}

/** Intersect a raw value with an ordered known-vocabulary array, de-duped. */
function intersectKnown(value, known) {
    const seen = new Set();
    for (const item of asArray(value)) {
        const token = cleanSkillString(item, 64).toLowerCase();
        if (known.includes(token) && !seen.has(token)) seen.add(token);
    }
    return known.filter((k) => seen.has(k));
}

/** Generic value cleaner for unknown fields parked under `extra` (deep, capped). */
function cleanExtra(value, depth = 0) {
    if (depth > 5) return undefined;
    if (value == null) return null;
    const type = typeof value;
    if (type === "boolean" || type === "number") return value;
    if (type === "string") return cleanSkillString(value, 1000);
    if (type === "bigint" || type === "symbol" || type === "function") return undefined;
    if (Array.isArray(value)) {
        const out = [];
        for (const item of value) {
            const clean = cleanExtra(item, depth + 1);
            if (clean !== undefined) out.push(clean);
        }
        return out.slice(0, 32);
    }
    if (type === "object") {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            // Mirrors coding/util.js: credential-like keys never survive even in
            // `extra` (manifest authors get no path to persist secrets).
            if (/(secret|token|passwd|password|authorization|auth|cookie|api[_-]?key|credential|private[_-]?key|bearer)/i.test(key)) continue;
            const clean = cleanExtra(item, depth + 1);
            if (clean !== undefined) out[key] = clean;
        }
        return out;
    }
    return undefined;
}

const NORMALIZE_FIELDS = new Set([
    "id", "name", "description", "version", "schema", "workflow", "capability",
    "preset", "graph", "scope", "audit", "tags", "enabledByDefault", "module", "extra",
]);

function cleanWorkflowStep(raw) {
    if (typeof raw === "string") {
        const text = cleanSkillString(raw, 1000);
        if (!text) return null;
        return { step: text, goal: "" };
    }
    if (raw == null || typeof raw !== "object") return null;
    const stepText = cleanSkillString(raw.step ?? raw.title ?? raw.goal ?? "", 1000);
    if (!stepText) return null;
    const step = {
        step: stepText,
        goal: cleanSkillString(raw.goal, 1000),
    };
    // `agent` is a flow hint and may ONLY name an existing hint word; anything
    // else is dropped rather than invented.
    const agent = cleanSkillString(raw.agent, 64).toLowerCase();
    if (SKILL_AGENT_HINTS.includes(agent)) step.agent = agent;
    // `tool` is a hint object `{ tool: <string> }` at most — the skill never
    // calls it, so only its name survives as a string.
    const rawTool = typeof raw.tool === "object" && raw.tool !== null
        ? (raw.tool.tool ?? raw.tool.name)
        : raw.tool;
    const tool = cleanSkillString(rawTool, 64);
    if (tool) step.tool = tool;
    const verify = cleanSkillString(raw.verify, 1000);
    if (verify) step.verify = verify;
    return step;
}

function cleanAuditEvents(value) {
    const out = [];
    for (const item of asArray(value)) {
        if (typeof item === "string") {
            const type = cleanSkillString(item, 128).toLowerCase();
            if (type) out.push(type);
        } else if (item && typeof item === "object") {
            const type = cleanSkillString(item.type, 128).toLowerCase();
            const on = cleanSkillString(item.on, 128);
            if (type) out.push({ type, on });
        }
        if (out.length >= 64) break;
    }
    return out;
}

/** Non-negative bounded retention day count; 90 is the product default. */
function cleanRetentionDays(value) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.min(36500, Math.floor(n));
    return 90;
}

/**
 * Normalize any manifest-like object into the canonical shape. Forgiving: strips
 * control chars, truncates, de-dupes, intersects effects/agents/types/graph.nodes
 * to known vocab (never invented), normalizes workflow steps, and parks unknown
 * top-level fields under `extra`. Missing `version`/`schema` default to the
 * current schema version. Does NOT validate — run validateSkillManifest on the
 * result (or on a hand-written canonical object) before trusting it.
 */
export function normalizeSkillManifest(input = {}) {
    const raw = input && typeof input === "object" ? input : {};

    // Gather unknown top-level fields into `extra` before building the body so
    // no caller metadata is silently lost. Credential-like keys never survive
    // even here (mirrors coding/util.js FORBIDDEN_KEY).
    const extra = {};
    if (raw.extra && typeof raw.extra === "object") {
        Object.assign(extra, cleanExtra(raw.extra));
    }
    for (const [key, value] of Object.entries(raw)) {
        if (!NORMALIZE_FIELDS.has(key) && !/(secret|token|passwd|password|authorization|auth|cookie|api[_-]?key|credential|private[_-]?key|bearer)/i.test(key)) {
            const cleaned = cleanExtra(value);
            if (cleaned !== undefined) extra[key] = cleaned;
        }
    }

    const name = cleanSkillString(raw.name, 128);
    const id = cleanSkillString(raw.id, 128) || name;

    const workflowRaw = raw.workflow && typeof raw.workflow === "object" ? raw.workflow : {};
    const steps = asArray(workflowRaw.steps)
        .map(cleanWorkflowStep)
        .filter((step) => step !== null);

    const capabilityRaw = raw.capability && typeof raw.capability === "object" ? raw.capability : {};
    const graphRaw = raw.graph && typeof raw.graph === "object" ? raw.graph : {};
    const auditRaw = raw.audit && typeof raw.audit === "object" ? raw.audit : {};

    const presetValue = cleanSkillString(raw.preset, 32).toLowerCase();
    const preset = SKILL_PRESETS.includes(presetValue) ? presetValue : null;

    const scopeValue = cleanSkillString(raw.scope, 32).toLowerCase();
    const scope = SKILL_SCOPES.includes(scopeValue) ? scopeValue : "owner";

    const manifest = {
        id,
        name,
        description: cleanSkillString(raw.description, 2000),
        version: cleanSkillString(raw.version, 32) || SKILL_SCHEMA_VERSION,
        schema: cleanSkillString(raw.schema, 32) || SKILL_SCHEMA_VERSION,
        workflow: {
            title: cleanSkillString(workflowRaw.title, 200) || name,
            steps,
        },
        capability: {
            // Flat fallbacks (input.effects/agents/types) are accepted so a
            // terse manifest can skip the capability object entirely.
            effects: intersectKnown(
                capabilityRaw.effects ?? raw.effects,
                SKILL_EFFECTS,
            ),
            agents: intersectKnown(
                capabilityRaw.agents ?? raw.agents,
                SKILL_AGENT_HINTS,
            ),
            types: intersectKnown(
                capabilityRaw.types ?? raw.types,
                SKILL_TYPES,
            ),
        },
        preset,
        graph: {
            nodes: intersectKnown(graphRaw.nodes ?? raw.graphNodes, SKILL_GRAPH_NODES),
            send: cleanSkillString(graphRaw.send, 64) || "",
        },
        scope,
        audit: {
            events: cleanAuditEvents(auditRaw.events),
            retentionDays: cleanRetentionDays(auditRaw.retentionDays),
        },
        tags: intersectDedupTags(raw.tags),
        enabledByDefault: raw.enabledByDefault === true,
    };
    const moduleName = cleanSkillString(raw.module, 200);
    if (moduleName) manifest.module = moduleName;
    if (Object.keys(extra).length) manifest.extra = extra;
    return manifest;
}

/** Tag cleaning with de-dupe + cap; unlike vocab arrays tags are free text. */
function intersectDedupTags(value) {
    const seen = new Set();
    const out = [];
    for (const item of asArray(value)) {
        const tag = cleanSkillString(item, 64);
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        out.push(tag);
        if (out.length >= 16) break;
    }
    return out;
}

const EVENT_TYPE_RE = /^[a-z][a-z0-9_.]*$/;

/**
 * Validate a canonical manifest. Returns { ok: true, errors: [] } or
 * { ok: false, errors: [...] }. The strict rules gate whether a skill is
 * loadable — name/description/version shape, non-empty workflow, audit event
 * grammar (elements are strings or {type,on} where type is lowercase dotted —
 * the same shape as skill.* / action.* / run.* / approval.* event words), and
 * capability.effects staying inside the known vocabulary.
 */
export function validateSkillManifest(m) {
    if (!m || typeof m !== "object") {
        return { ok: false, errors: ["manifest must be an object"] };
    }
    const errors = [];

    if (typeof m.name !== "string" || !m.name) {
        errors.push("name is required");
    } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(m.name)) {
        errors.push("name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$");
    }

    if (typeof m.description !== "string" || !String(m.description).trim()) {
        errors.push("description must be a non-empty string");
    }

    if (typeof m.version !== "string" || !/^\d+\.\d+(\.\d+)?$/.test(m.version)) {
        errors.push("version must be of the form N.N or N.N.N");
    }

    const steps = m?.workflow?.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
        errors.push("workflow.steps must be a non-empty array");
    } else {
        steps.forEach((step, i) => {
            if (!step || typeof step !== "object") {
                errors.push(`workflow.steps[${i}] must be an object`);
                return;
            }
            if (!String(step.step ?? "").trim()) {
                errors.push(`workflow.steps[${i}] must have a non-empty step`);
            }
            const agent = step.agent;
            if (agent !== undefined && !SKILL_AGENT_HINTS.includes(String(agent).toLowerCase())) {
                errors.push(`workflow.steps[${i}].agent is not a known agent hint`);
            }
            if (step.tool !== undefined && (typeof step.tool !== "string" || !step.tool)) {
                errors.push(`workflow.steps[${i}].tool must be a non-empty string`);
            }
        });
    }

    const audit = m?.audit;
    if (!audit || typeof audit !== "object") {
        errors.push("audit must be an object");
    } else if (!Array.isArray(audit.events)) {
        errors.push("audit.events must be an array");
    } else {
        audit.events.forEach((entry, i) => {
            const type = typeof entry === "string" ? entry : entry?.type;
            if (typeof type !== "string" || !EVENT_TYPE_RE.test(type)) {
                errors.push(`audit.events[${i}] must be a string or {type,on} with a lowercase dotted type`);
            }
            if (entry && typeof entry === "object" && !("type" in entry)) {
                errors.push(`audit.events[${i}] object form requires a type field`);
            }
        });
    }

    const capability = m?.capability;
    if (!capability || typeof capability !== "object") {
        errors.push("capability must be an object");
    } else {
        const effects = capability.effects;
        if (!Array.isArray(effects)) {
            errors.push("capability.effects must be an array");
        } else {
            for (const effect of effects) {
                if (!SKILL_EFFECTS.includes(effect)) {
                    errors.push(`capability.effects contains unknown effect "${effect}"`);
                }
            }
        }
    }

    return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

export default {
    SKILL_SCHEMA_VERSION, SKILL_EFFECTS, SKILL_AGENT_HINTS, SKILL_PRESETS,
    SKILL_SCOPES, SKILL_GRAPH_NODES, SKILL_TYPES,
    cleanSkillString, normalizeSkillManifest, validateSkillManifest,
};
