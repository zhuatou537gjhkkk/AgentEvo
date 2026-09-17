import crypto from 'node:crypto';
import { containsSensitiveContent } from './memoryExtraction.js';

export const WORKING_MEMORY_KEYS = Object.freeze([
    'working_current_goal',
    'working_constraints',
    'working_progress',
    'working_next_step',
]);

export const WORKING_MEMORY_KEY_LABELS = Object.freeze({
    working_current_goal: '当前目标',
    working_constraints: '临时约束',
    working_progress: '执行进度',
    working_next_step: '下一步计划',
});

export const WORKING_MEMORY_LIMITS = Object.freeze({
    maxGoalChars: 600,
    maxConstraintChars: 240,
    maxConstraints: 8,
    maxStepChars: 240,
    maxCompletedSteps: 20,
    maxNextStepChars: 300,
    maxSourceChars: 48,
});

const TASK_STATUSES = new Set(['active', 'completed', 'cancelled', 'failed', 'waiting_approval', 'paused']);
const NOISY_CONTENT = /(?:BEGIN\s+(?:RSA|OPENSSH|EC|DSA)?\s*PRIVATE KEY|Traceback \(most recent call last\)|(?:^|\n)\s*at\s+[^\n]+\([^\n]+\))/i;

function boundedInt(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(number)));
}

export function sanitizeWorkingText(value, maxChars = 300) {
    const text = String(value ?? '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text || containsSensitiveContent(text) || NOISY_CONTENT.test(text)) return '';
    return text.slice(0, Math.max(1, Number(maxChars) || 300));
}

function listValue(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(/[\n；;]+/g);
    return [];
}

export function normalizeWorkingConstraints(value) {
    const result = [];
    for (const item of listValue(value)) {
        const text = sanitizeWorkingText(
            typeof item === 'object' && item !== null
                ? item.content ?? item.text ?? item.constraint ?? item.description
                : item,
            WORKING_MEMORY_LIMITS.maxConstraintChars,
        );
        if (text && !result.includes(text)) result.push(text);
        if (result.length >= WORKING_MEMORY_LIMITS.maxConstraints) break;
    }
    return result;
}

export function normalizeCompletedSteps(value) {
    const result = [];
    for (const item of listValue(value)) {
        const raw = item && typeof item === 'object' ? item : { content: item };
        const content = sanitizeWorkingText(raw.content ?? raw.goal ?? raw.title ?? raw.text, WORKING_MEMORY_LIMITS.maxStepChars);
        if (!content) continue;
        const step = {
            id: sanitizeWorkingText(raw.id ?? '', 64) || String(result.length + 1),
            content,
        };
        const agent = sanitizeWorkingText(raw.agent ?? '', 32);
        if (agent) step.agent = agent;
        if (!result.some((existing) => existing.id === step.id || existing.content === step.content)) result.push(step);
        if (result.length >= WORKING_MEMORY_LIMITS.maxCompletedSteps) break;
    }
    return result;
}

export function normalizeWorkingState(value = {}, { defaultGoal = '' } = {}) {
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const progress = raw.progress && typeof raw.progress === 'object' ? raw.progress : {};
    const currentGoal = sanitizeWorkingText(
        raw.current_goal ?? raw.currentGoal ?? raw.goal ?? defaultGoal,
        WORKING_MEMORY_LIMITS.maxGoalChars,
    ) || '当前任务';
    const constraints = normalizeWorkingConstraints(
        raw.constraints ?? raw.temporary_constraints ?? raw.temporaryConstraints ?? progress.constraints,
    );
    const completedSteps = normalizeCompletedSteps(
        raw.completed_steps ?? raw.completedSteps ?? progress.completed_steps ?? progress.completedSteps,
    );
    const nextStep = sanitizeWorkingText(
        raw.next_step ?? raw.nextStep ?? progress.next_step ?? progress.nextStep,
        WORKING_MEMORY_LIMITS.maxNextStepChars,
    );
    const taskStatus = String(raw.task_status ?? raw.taskStatus ?? 'active').trim().toLowerCase();
    return {
        current_goal: currentGoal,
        constraints,
        completed_steps: completedSteps,
        next_step: nextStep,
        task_status: TASK_STATUSES.has(taskStatus) ? taskStatus : 'active',
    };
}

export function extractWorkingConstraints(value) {
    const text = String(value || '');
    const sentences = text.split(/[。！？!?；;\n]+/g).map((item) => item.trim()).filter(Boolean);
    return normalizeWorkingConstraints(sentences.filter((item) => (
        /(?:必须|需要|请|不要|避免|只能|一律|始终|限制|约束|要求|不得|不能|优先|保持|禁止)/.test(item)
        || /\b(?:must|need to|please|do not|avoid|only|always|never|required|constraint)\b/i.test(item)
    )));
}

export function workingStateFromGraph(state = {}) {
    const subTasks = Array.isArray(state.subTasks) ? state.subTasks : [];
    const completedSteps = subTasks
        .filter((task) => task?.status === 'completed')
        .map((task) => ({ id: task.id, content: task.content ?? task.goal, agent: task.agent }));
    const nextTask = subTasks.find((task) => ['pending', 'in_progress', 'waiting_approval'].includes(task?.status));
    return {
        current_goal: state.userInput,
        constraints: extractWorkingConstraints(state.userInput),
        completed_steps: completedSteps,
        next_step: nextTask?.content ?? nextTask?.goal ?? '',
        task_status: 'active',
    };
}

export function deriveFinalWorkingStatus(state = {}) {
    const subTasks = Array.isArray(state.subTasks) ? state.subTasks : [];
    if (state.plan_control?.action === 'terminal_error') return 'failed';
    if (subTasks.some((task) => task?.status === 'waiting_approval')) return 'active';
    if (subTasks.some((task) => task?.type !== 'reasoning' && ['pending', 'in_progress'].includes(task?.status))) return 'active';
    if (subTasks.some((task) => task?.status === 'cancelled') && subTasks.every((task) => ['completed', 'failed', 'error', 'blocked', 'skipped', 'cancelled', 'interrupted', 'waiting_approval'].includes(task?.status))) {
        return 'cancelled';
    }
    if (subTasks.length > 0 && subTasks.some((task) => ['failed', 'error', 'blocked', 'skipped', 'interrupted'].includes(task?.status))) return 'failed';
    const executable = subTasks.filter((task) => task?.type !== 'reasoning');
    if (executable.length > 0 && executable.every((task) => task?.status === 'completed')) return 'completed';
    return 'active';
}

function snapshotHash(state) {
    return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 32);
}

function displayValue(key, state) {
    switch (key) {
        case 'working_current_goal':
            return state.current_goal;
        case 'working_constraints':
            return state.constraints.length > 0
                ? state.constraints.map((item, index) => `${index + 1}. ${item}`).join('\n')
                : '无临时约束';
        case 'working_progress':
            return state.completed_steps.length > 0
                ? state.completed_steps.map((step) => `步骤${step.id}: ${step.content}`).join('\n')
                : '尚未完成步骤';
        case 'working_next_step':
            return state.next_step || '暂无下一步计划';
        default:
            return '';
    }
}

/** Build four server-owned records. LLM-provided owner/session/source/status are ignored. */
export function buildWorkingMemoryRecords(value = {}, {
    defaultGoal = '',
    source = 'graph',
    taskStatus = 'active',
    planGeneration = 0,
    expiresAt = null,
} = {}) {
    const normalized = normalizeWorkingState(value, { defaultGoal });
    const serverStatus = TASK_STATUSES.has(String(taskStatus)) ? String(taskStatus) : 'active';
    const state = { ...normalized, task_status: serverStatus };
    const generation = boundedInt(planGeneration, 0, 0, 1000000);
    const safeSource = sanitizeWorkingText(source, WORKING_MEMORY_LIMITS.maxSourceChars) || 'graph';
    const hash = snapshotHash({ ...state, plan_generation: generation });
    const metadataState = {
        ...state,
        plan_generation: generation,
    };
    return WORKING_MEMORY_KEYS.map((memoryKey) => ({
        memoryKey,
        memory_key: memoryKey,
        content: displayValue(memoryKey, state),
        importance: 0.9,
        confidence: 1,
        source: 'working_memory',
        category: 'goal',
        relationType: 'independent',
        expiresAt,
        expires_at: expiresAt,
        snapshotHash: hash,
        snapshot_hash: hash,
        metadata: {
            working_memory_version: 1,
            working_state: metadataState,
            snapshot_hash: hash,
            trigger_source: safeSource,
            plan_generation: generation,
        },
    }));
}

export function workingStateFromRecords(records = []) {
    const first = records.find((record) => record?.metadata?.working_state);
    const state = first?.metadata?.working_state;
    if (state) return normalizeWorkingState(state);
    return normalizeWorkingState({
        current_goal: records.find((record) => record.memory_key === 'working_current_goal')?.content,
        next_step: records.find((record) => record.memory_key === 'working_next_step')?.content,
    });
}

function findJsonObject(value) {
    const text = String(value || '').replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
    for (let start = 0; start < text.length; start += 1) {
        if (text[start] !== '{') continue;
        let depth = 0;
        let quoted = false;
        let escaped = false;
        for (let index = start; index < text.length; index += 1) {
            const char = text[index];
            if (quoted) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') quoted = false;
                continue;
            }
            if (char === '"') quoted = true;
            else if (char === '{') depth += 1;
            else if (char === '}') {
                depth -= 1;
                if (depth === 0) return text.slice(start, index + 1);
            }
        }
    }
    return null;
}

/** Accept structured compaction output while preserving old plain-string mocks. */
export function parseCompactionResult(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const summary = String(value.summary ?? value.content ?? '').trim();
        const taskState = value.task_state && typeof value.task_state === 'object'
            ? normalizeWorkingState(value.task_state)
            : null;
        return { summary, taskState };
    }
    const raw = String(value || '').trim();
    const json = findJsonObject(raw);
    if (json) {
        try {
            const parsed = JSON.parse(json);
            if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') {
                return {
                    summary: parsed.summary.trim(),
                    taskState: parsed.task_state && typeof parsed.task_state === 'object'
                        ? normalizeWorkingState(parsed.task_state)
                        : null,
                };
            }
        } catch {
            // A malformed structured suffix is treated as a legacy summary.
        }
    }
    return { summary: raw, taskState: null };
}

export default {
    WORKING_MEMORY_KEYS,
    WORKING_MEMORY_KEY_LABELS,
    WORKING_MEMORY_LIMITS,
    sanitizeWorkingText,
    normalizeWorkingState,
    extractWorkingConstraints,
    workingStateFromGraph,
    deriveFinalWorkingStatus,
    buildWorkingMemoryRecords,
    workingStateFromRecords,
    parseCompactionResult,
};
