/**
 * Bounded, server-built context for retrieval query rewriting.
 *
 * This module only accepts already-authorized request data. It does not know
 * how to find a user, session, tenant, or memory row; the chat service owns
 * those checks and passes the resulting history/working-memory snapshot in.
 */
import { estimateTokens } from '../services/chatUtils.js';
import { containsSensitiveContent } from '../services/memoryExtraction.js';
import { sanitizeWorkingText, workingStateFromRecords } from '../services/workingMemory.js';

const SUMMARY_MARKER = '[上下文压缩摘要';
const WORKING_KEYS = new Set([
    'working_current_goal',
    'working_constraints',
    'working_progress',
    'working_next_step',
]);
const CONTEXT_SOURCES = Object.freeze(['recent_turns', 'summary', 'working_memory']);

export const REWRITE_CONTEXT_LIMITS = Object.freeze({
    maxTokens: 600,
    minTokens: 120,
    maxTokensCeiling: 2000,
    maxRecentTurns: 3,
    maxRecentTurnsCeiling: 3,
    maxMessageChars: 480,
    maxSummaryChars: 720,
    maxGoalChars: 420,
    maxConstraintChars: 180,
    maxConstraints: 6,
    maxStepChars: 180,
    maxCompletedSteps: 6,
    maxNextStepChars: 260,
});

const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----/i;
const STACK_TRACE = /(?:Traceback \(most recent call last\)|(?:^|\n)\s*at\s+[^\n]+\([^\n]+\))/i;
const SECRET_VALUE = /(?:api[_ -]?key|access[_ -]?token|authorization|cookie|password|密码|令牌|bearer)\s*[:=]?\s*[^\s,;]+/gi;
const OPENAI_KEY = /\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/gi;

function boundedInt(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(number)));
}

export function rewriteContextConfig(overrides = {}) {
    return {
        maxTokens: boundedInt(
            overrides.maxTokens ?? process.env.RAG_QUERY_REWRITE_CONTEXT_MAX_TOKENS,
            REWRITE_CONTEXT_LIMITS.maxTokens,
            REWRITE_CONTEXT_LIMITS.minTokens,
            REWRITE_CONTEXT_LIMITS.maxTokensCeiling,
        ),
        maxRecentTurns: boundedInt(
            overrides.maxRecentTurns ?? process.env.RAG_QUERY_REWRITE_RECENT_TURNS,
            REWRITE_CONTEXT_LIMITS.maxRecentTurns,
            1,
            REWRITE_CONTEXT_LIMITS.maxRecentTurnsCeiling,
        ),
    };
}

function cleanText(value, maxChars) {
    const raw = String(value ?? '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw || PRIVATE_KEY.test(raw)) return '';

    // Reuse the existing memory sanitizer first, then redact the additional
    // transport-secret and stack patterns that are not memory candidates.
    let text = raw
        .replace(SECRET_VALUE, '[已过滤敏感字段]')
        .replace(OPENAI_KEY, '[已过滤密钥]')
        .replace(/Traceback \(most recent call last\)[\s\S]*/i, '[已过滤错误堆栈]')
        .replace(/(?:^|\s)at\s+[^\n]+\([^\n]+\)/gi, ' [已过滤错误堆栈]')
        .trim();
    if (containsSensitiveContent(text) || STACK_TRACE.test(text)) return '';

    const sanitized = sanitizeWorkingText(text, maxChars);
    return sanitized ? sanitized.slice(0, maxChars) : '';
}

function escapePromptText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function isContextSummaryMessage(message) {
    return message?.role === 'system' && String(message?.content ?? '').trim().startsWith(SUMMARY_MARKER);
}

function summaryBody(value) {
    return String(value ?? '').replace(/^\[上下文压缩摘要[^\]]*\]\s*/i, '').trim();
}

function normalizedWorkingState(records) {
    const list = (Array.isArray(records) ? records : [])
        .filter((record) => WORKING_KEYS.has(String(record?.memory_key ?? record?.memoryKey)))
        .filter((record) => String(record?.status || 'active') === 'active')
        .filter((record) => {
            const expiresAt = record?.expires_at ?? record?.expiresAt;
            if (!expiresAt) return true;
            const timestamp = Date.parse(String(expiresAt));
            return Number.isFinite(timestamp) && timestamp > Date.now();
        });
    if (list.length === 0) {
        return { currentGoal: '', constraints: [], completedSteps: [], nextStep: '' };
    }

    const state = workingStateFromRecords(list);
    return {
        currentGoal: cleanText(state.current_goal, REWRITE_CONTEXT_LIMITS.maxGoalChars),
        constraints: (Array.isArray(state.constraints) ? state.constraints : [])
            .map((item) => cleanText(item, REWRITE_CONTEXT_LIMITS.maxConstraintChars))
            .filter(Boolean)
            .slice(0, REWRITE_CONTEXT_LIMITS.maxConstraints),
        completedSteps: (Array.isArray(state.completed_steps) ? state.completed_steps : [])
            .map((step, index) => ({
                id: cleanText(step?.id ?? index + 1, 32) || String(index + 1),
                content: cleanText(step?.content ?? step, REWRITE_CONTEXT_LIMITS.maxStepChars),
            }))
            .filter((step) => step.content)
            .slice(0, REWRITE_CONTEXT_LIMITS.maxCompletedSteps),
        nextStep: cleanText(state.next_step, REWRITE_CONTEXT_LIMITS.maxNextStepChars),
    };
}

function workingRecordsFrom(value) {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.records)) return value.records;
    return [];
}

function extractRecentTurns(history, query, maxRecentTurns) {
    const current = String(query ?? '').trim();
    const messages = (Array.isArray(history) ? history : [])
        .filter((message) => ['user', 'assistant'].includes(String(message?.role || '').toLowerCase()))
        .filter((message) => !isContextSummaryMessage(message))
        .map((message) => ({
            role: String(message.role).toLowerCase(),
            content: cleanText(message.content, REWRITE_CONTEXT_LIMITS.maxMessageChars),
        }))
        .filter((message) => message.content)
        // The current user message is often already persisted before the
        // graph starts. Remove every exact duplicate, not only the last row.
        .filter((message) => !(message.role === 'user' && message.content === current));
    return messages.slice(-maxRecentTurns * 2);
}

function latestSummary(history, explicitSummary) {
    if (explicitSummary != null) return cleanText(summaryBody(explicitSummary), REWRITE_CONTEXT_LIMITS.maxSummaryChars);
    const message = [...(Array.isArray(history) ? history : [])]
        .reverse()
        .find((item) => isContextSummaryMessage(item));
    return cleanText(summaryBody(message?.content), REWRITE_CONTEXT_LIMITS.maxSummaryChars);
}

function emptyContext() {
    return {
        version: 1,
        recentTurns: [],
        summary: '',
        workingState: {
            currentGoal: '',
            constraints: [],
            completedSteps: [],
            nextStep: '',
        },
    };
}

function contextTokenCount(context) {
    return estimateTokens(JSON.stringify(context));
}

function trimContext(context, maxTokens) {
    let current = contextTokenCount(context);
    while (current > maxTokens) {
        if (context.workingState.completedSteps.length > 0) {
            context.workingState.completedSteps.pop();
        } else if (context.summary) {
            context.summary = context.summary.slice(0, Math.max(0, Math.floor(context.summary.length * 0.65)));
        } else if (context.workingState.constraints.length > 0) {
            context.workingState.constraints.pop();
        } else if (context.recentTurns.length > 2) {
            context.recentTurns.shift();
        } else if (context.recentTurns.length > 0) {
            const oldest = context.recentTurns[0];
            if (oldest.content.length > 40) oldest.content = oldest.content.slice(0, Math.floor(oldest.content.length * 0.65));
            else context.recentTurns.shift();
        } else if (context.workingState.nextStep.length > 40) {
            context.workingState.nextStep = context.workingState.nextStep.slice(0, Math.floor(context.workingState.nextStep.length * 0.65));
        } else if (context.workingState.currentGoal.length > 40) {
            context.workingState.currentGoal = context.workingState.currentGoal.slice(0, Math.floor(context.workingState.currentGoal.length * 0.65));
        } else {
            context.workingState.nextStep = '';
            context.workingState.currentGoal = '';
        }
        current = contextTokenCount(context);
    }
    return context;
}

export function buildRewriteContext({ query = '', history = [], workingMemory = null, summary = null, config = {} } = {}) {
    const limits = rewriteContextConfig(config);
    const recentTurns = extractRecentTurns(history, query, limits.maxRecentTurns);
    const context = {
        version: 1,
        recentTurns,
        summary: latestSummary(history, summary),
        workingState: normalizedWorkingState(workingRecordsFrom(workingMemory)),
    };
    return trimContext(context, limits.maxTokens);
}

export function hasUsefulRewriteContext(context) {
    return Boolean(
        Array.isArray(context?.recentTurns) && context.recentTurns.length > 0
        || String(context?.summary || '').trim()
        || String(context?.workingState?.currentGoal || '').trim()
        || String(context?.workingState?.nextStep || '').trim()
        || (Array.isArray(context?.workingState?.constraints) && context.workingState.constraints.length > 0)
        || (Array.isArray(context?.workingState?.completedSteps) && context.workingState.completedSteps.length > 0),
    );
}

export function rewriteContextSources(context) {
    const sources = [];
    if (Array.isArray(context?.recentTurns) && context.recentTurns.length > 0) sources.push(CONTEXT_SOURCES[0]);
    if (String(context?.summary || '').trim()) sources.push(CONTEXT_SOURCES[1]);
    if (hasUsefulRewriteContext({ workingState: context?.workingState })) sources.push(CONTEXT_SOURCES[2]);
    return sources;
}

export function rewriteContextDiagnostics(context) {
    const working = context?.workingState || {};
    return {
        contextUsed: rewriteContextSources(context),
        recentTurnCount: Math.ceil((Array.isArray(context?.recentTurns) ? context.recentTurns.length : 0) / 2),
        summaryPresent: Boolean(String(context?.summary || '').trim()),
        workingMemoryPresent: Boolean(
            String(working.currentGoal || '').trim()
            || String(working.nextStep || '').trim()
            || (Array.isArray(working.constraints) && working.constraints.length > 0)
            || (Array.isArray(working.completedSteps) && working.completedSteps.length > 0),
        ),
        contextTokens: contextTokenCount(context || emptyContext()),
    };
}

/** Render only the allow-listed structure; never render owner/session fields. */
export function renderRewriteContext(context) {
    if (!context || typeof context !== 'object') return '';
    const safe = buildRewriteContext({
        query: '',
        history: Array.isArray(context.recentTurns) ? context.recentTurns : [],
        workingMemory: context.workingState ? { records: [] } : null,
        summary: context.summary,
        config: { maxTokens: REWRITE_CONTEXT_LIMITS.maxTokens },
    });
    // The rebuild above intentionally sanitizes recent turns and summary. The
    // working state is copied through the same field-level sanitizer below.
    const working = context.workingState || {};
    const currentGoal = cleanText(working.currentGoal, REWRITE_CONTEXT_LIMITS.maxGoalChars);
    const constraints = (Array.isArray(working.constraints) ? working.constraints : [])
        .map((item) => cleanText(item, REWRITE_CONTEXT_LIMITS.maxConstraintChars))
        .filter(Boolean)
        .slice(0, REWRITE_CONTEXT_LIMITS.maxConstraints);
    const completedSteps = (Array.isArray(working.completedSteps) ? working.completedSteps : [])
        .map((step, index) => ({ id: cleanText(step?.id ?? index + 1, 32) || String(index + 1), content: cleanText(step?.content ?? step, REWRITE_CONTEXT_LIMITS.maxStepChars) }))
        .filter((step) => step.content)
        .slice(0, REWRITE_CONTEXT_LIMITS.maxCompletedSteps);
    const nextStep = cleanText(working.nextStep, REWRITE_CONTEXT_LIMITS.maxNextStepChars);
    const recent = safe.recentTurns;
    const summaryText = safe.summary;
    const lines = [
        '<recent_turns>',
        ...recent.map((item) => `${item.role}: ${escapePromptText(item.content)}`),
        '</recent_turns>',
        '<history_summary>',
        escapePromptText(summaryText),
        '</history_summary>',
        '<working_memory>',
        `current_goal: ${escapePromptText(currentGoal)}`,
        `constraints: ${escapePromptText(constraints.join(' | '))}`,
        `completed_steps: ${escapePromptText(completedSteps.map((step) => `${step.id}:${step.content}`).join(' | '))}`,
        `next_step: ${escapePromptText(nextStep)}`,
        '</working_memory>',
    ];
    return lines.join('\n').slice(0, 7000);
}

export default {
    REWRITE_CONTEXT_LIMITS,
    rewriteContextConfig,
    isContextSummaryMessage,
    shouldUseContextualRewrite,
    buildRewriteContext,
    hasUsefulRewriteContext,
    rewriteContextSources,
    rewriteContextDiagnostics,
    renderRewriteContext,
};

export function shouldUseContextualRewrite(query) {
    const text = String(query ?? '').trim();
    if (!text) return false;
    if (/(?:这个|那个|它们?|上述|上面|前面|刚才|之前|继续|同样|还是这个|这里|这种|这样|那[^。！？!?]{0,12}(?:呢|吧)?|然后呢)/.test(text)) return true;
    if (/\b(?:this|that|it|they|above|previous|earlier|continue|same\s+one|what\s+about\s+that)\b/i.test(text)) return true;

    // Short follow-ups that contain an action but no concrete technical
    // identifier are context-dependent. A short file/function/version query
    // remains independent by design.
    const hasTechnicalIdentifier = /(?:[A-Za-z][A-Za-z0-9_.:/\\-]{2,}|\b\d+(?:\.\d+)+\b|`[^`]+`)/.test(text);
    const actionOnly = /(?:怎么|如何|在哪|哪个|哪里|什么时候|是否|能否|怎么做|修改|配置|更新|调用|继续|然后|为什么)|\b(?:how|where|which|when|configure|update|call|why)\b/i.test(text);
    return text.length <= 24 && actionOnly && !hasTechnicalIdentifier;
}
