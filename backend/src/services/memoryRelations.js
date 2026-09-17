import { normalizeMemoryKey } from "./memoryExtraction.js";

export const MEMORY_CATEGORIES = Object.freeze([
    "fact",
    "preference",
    "constraint",
    "goal",
    "event",
    "uncategorized",
]);

export const MEMORY_RELATION_TYPES = Object.freeze([
    "independent",
    "duplicate",
    "supplement",
    "conflict",
    "expiration",
]);

const KEY_ALIASES = new Map([
    ["name", "user_name"],
    ["username", "user_name"],
    ["user_name", "user_name"],
    ["occupation", "job_role"],
    ["profession", "job_role"],
    ["role", "job_role"],
    ["job", "job_role"],
    ["job_role", "job_role"],
    ["theme", "ui_theme"],
    ["color_theme", "ui_theme"],
    ["ui_theme", "ui_theme"],
    ["answer_style", "response_style"],
    ["reply_style", "response_style"],
    ["response_style", "response_style"],
    ["reply_language", "response_language"],
    ["response_language", "response_language"],
    ["programming_language", "preferred_programming_language"],
    ["preferred_programming_language", "preferred_programming_language"],
    ["coding_language", "preferred_programming_language"],
    ["stack", "tech_stack"],
    ["technology_stack", "tech_stack"],
    ["tech_stack", "tech_stack"],
    ["project", "current_project"],
    ["current_project", "current_project"],
    ["goal", "long_term_goal"],
    ["user_goal", "long_term_goal"],
    ["long_term_goal", "long_term_goal"],
    ["code_style", "coding_style"],
    ["coding_style", "coding_style"],
]);

const SINGLE_VALUE_KEYS = new Set([
    "user_name",
    "job_role",
    "ui_theme",
    "response_style",
    "response_language",
    "preferred_programming_language",
    "coding_style",
]);

const ADDITIVE_KEYS = new Set([
    "tech_stack",
    "current_project",
    "long_term_goal",
    "interests",
]);

const VALUE_ANCHORS = [
    "typescript", "javascript", "python", "java", "go", "rust", "c++", "c#",
    "react", "vue", "angular", "node", "express", "langgraph",
    "dark", "light", "深色", "浅色", "暗色", "亮色",
    "中文", "英文", "english", "chinese",
    "简洁", "详细", "直接", "分步", "concise", "detailed",
    "前端", "后端", "全栈", "frontend", "backend", "fullstack",
];

function normalizeText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, "")
        .trim();
}

function textTokens(value) {
    const text = String(value || "").toLowerCase();
    const tokens = new Set(text.match(/[a-z][a-z0-9+#.-]{1,}/g) || []);
    const cjk = [...text].filter((char) => /[一-鿿㐀-䶿豈-﫿]/.test(char));
    for (let index = 0; index < cjk.length - 1; index += 1) {
        tokens.add(cjk[index] + cjk[index + 1]);
    }
    return tokens;
}

export function memoryTextSimilarity(left, right) {
    if (normalizeText(left) === normalizeText(right)) return 1;
    const leftTokens = textTokens(left);
    const rightTokens = textTokens(right);
    if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
    let intersection = 0;
    for (const token of leftTokens) {
        if (rightTokens.has(token)) intersection += 1;
    }
    return intersection / (leftTokens.size + rightTokens.size - intersection);
}

export function normalizeMemoryCategory(value, memoryType = "semantic", content = "") {
    const category = String(value || "").trim().toLowerCase();
    if (MEMORY_CATEGORIES.includes(category) && category !== "uncategorized") return category;
    const text = String(content || "");
    if (memoryType === "episodic") return "event";
    if (/我(?:个人)?(?:喜欢|偏好|习惯|常用|一直|从不|不喜欢|讨厌|倾向于|更希望)|\b(?:i prefer|i like|i dislike)\b/i.test(text)) return "preference";
    if (/(?:以后|今后|从现在起|每次|始终|一律|默认)|\bfrom now on\b/i.test(text)) return "constraint";
    if (/我(?:的)?(?:目标|计划)(?:是|为)|\bmy goal is\b/i.test(text)) return "goal";
    if (/我(?:今天|刚刚|已经|最近)(?:完成|决定|开始|加入|离开|迁移|发布)/.test(text)) return "event";
    return "fact";
}

function inferredKey(content, category) {
    const text = String(content || "").toLowerCase();
    if (/(?:深色|浅色|暗色|亮色|dark|light).{0,8}(?:主题|界面|theme)|(?:主题|界面|theme).{0,8}(?:深色|浅色|暗色|亮色|dark|light)/i.test(text)) return "ui_theme";
    if (/(?:回答|回复|response|reply).{0,10}(?:中文|英文|english|chinese)|(?:中文|英文|english|chinese).{0,10}(?:回答|回复|response|reply)/i.test(text)) return "response_language";
    if (/(?:回答|回复|表达|response|reply).{0,10}(?:简洁|详细|直接|分步|concise|detailed)|(?:简洁|详细|直接|分步|concise|detailed).{0,10}(?:回答|回复|表达|response|reply)/i.test(text)) return "response_style";
    if (/\b(?:typescript|javascript|python|java|golang|go|rust|c\+\+|c#)\b/i.test(text) && category === "preference") return "preferred_programming_language";
    if (/(?:名字|姓名|my name)/i.test(text)) return "user_name";
    if (/(?:职业|岗位|角色|job|occupation|work as)/i.test(text)) return "job_role";
    if (/(?:技术栈|tech stack|technology stack|\breact\b|\bvue\b|\bnode(?:\.js)?\b)/i.test(text)) return "tech_stack";
    if (/(?:代码风格|编码风格|coding style|code style)/i.test(text)) return "coding_style";
    if (category === "goal") return "long_term_goal";
    if (/(?:项目|project)/i.test(text)) return "current_project";
    return null;
}

export function canonicalMemoryKey(rawKey, { content = "", category = "fact" } = {}) {
    const inferred = inferredKey(content, category);
    const normalized = normalizeMemoryKey(rawKey);
    if (!normalized) return inferred;
    if (["language", "preferred_language"].includes(normalized)) {
        if (/\b(?:typescript|javascript|python|java|golang|go|rust|c\+\+|c#)\b/i.test(content)) {
            return "preferred_programming_language";
        }
        if (/(?:回答|回复|中文|英文|english|chinese)/i.test(content)) return "response_language";
    }
    return inferred || KEY_ALIASES.get(normalized) || normalized;
}

function valueAnchors(value) {
    const text = String(value || "").toLowerCase();
    return new Set(VALUE_ANCHORS.filter((anchor) => text.includes(anchor)));
}

function sharesAnchor(left, right) {
    const leftAnchors = valueAnchors(left);
    const rightAnchors = valueAnchors(right);
    if (leftAnchors.size === 0 || rightAnchors.size === 0) return false;
    return [...leftAnchors].some((anchor) => rightAnchors.has(anchor));
}

function hasExpirationCue(value) {
    return /(?:不再|已停止|已经不用|取消了|过期了|废弃|改为|换成|从.+改成|no longer|stopped using|switched to|instead of)/i.test(String(value || ""));
}

function hasConflictCue(value) {
    return /(?:而不是|不要再|相反|改用|改成|现在更|instead|rather than|now prefer)/i.test(String(value || ""));
}

/** Deterministic relation classification; authorization and state changes stay server-owned. */
export function classifyMemoryRelation(candidate, existing = null) {
    if (!existing) return { type: "independent", reason: "no_related_memory", similarity: 0 };
    const similarity = memoryTextSimilarity(candidate.content, existing.content);
    if (normalizeText(candidate.content) === normalizeText(existing.content) || similarity >= 0.88) {
        return { type: "duplicate", reason: "content_equivalent", similarity };
    }

    const key = candidate.memoryKey || null;
    if (!key || key !== existing.memory_key) {
        return { type: "independent", reason: "different_topic", similarity };
    }
    if (hasExpirationCue(candidate.content)) {
        return { type: "expiration", reason: "explicit_expiration_cue", similarity };
    }
    if (sharesAnchor(candidate.content, existing.content) && !hasConflictCue(candidate.content)) {
        return { type: "duplicate", reason: "same_topic_value", similarity };
    }
    if (SINGLE_VALUE_KEYS.has(key)) {
        return { type: "conflict", reason: "single_value_changed", similarity };
    }
    if (ADDITIVE_KEYS.has(key)) {
        return { type: "supplement", reason: "multi_value_topic", similarity };
    }
    if (hasConflictCue(candidate.content)) {
        return { type: "conflict", reason: "explicit_conflict_cue", similarity };
    }
    return { type: "supplement", reason: "same_topic_addition", similarity };
}

export default {
    MEMORY_CATEGORIES,
    MEMORY_RELATION_TYPES,
    normalizeMemoryCategory,
    canonicalMemoryKey,
    classifyMemoryRelation,
    memoryTextSimilarity,
};
