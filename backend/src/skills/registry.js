/**
 * Phase 7 / R5 (roadmap #1) — deterministic skill registry.
 *
 * A skill registry owns an ordered set of canonical skill manifests and answers
 * three read-only questions: list, get-by-name, and match. `match` is a pure,
 * deterministic scorer over tags + name + description (Latin words and Chinese
 * character bigrams), so the same query always yields the same order and tests
 * stay stable. No LLM, no network, no fuzzy library — a plain lexical overlap
 * scorer with a strong weight on tag hits.
 */
import { builtinSkills as defaultBuiltins } from "./builtin/index.js";

export { builtinSkills } from "./builtin/index.js";

const CJK_RUN_RE = /[一-鿿]+/g;
const LATIN_RE = /[a-z0-9]+/g;

// Common English stop-words that add signal-free noise to Latin scoring.
const STOP_WORDS = new Set([
    "a", "an", "and", "are", "at", "be", "by", "do", "for", "from", "how",
    "i", "in", "into", "is", "it", "me", "my", "of", "on", "or", "that",
    "the", "this", "to", "was", "we", "what", "when", "where", "which",
    "who", "why", "with", "you", "your",
]);

function lowerTokens(text) {
    return String(text || "").toLowerCase().match(LATIN_RE) || [];
}

/** Adjacent CJK char pairs inside each Chinese run; single chars kept too. */
function cjkBigrams(text) {
    const bigrams = [];
    const runs = String(text || "").match(CJK_RUN_RE) || [];
    for (const run of runs) {
        const chars = Array.from(run);
        if (chars.length === 1) bigrams.push(chars[0]);
        for (let i = 0; i < chars.length - 1; i += 1) {
            bigrams.push(chars[i] + chars[i + 1]);
        }
    }
    return bigrams;
}

function tokenSet(items, bigram = false) {
    const set = new Set();
    for (const item of items) {
        for (const token of bigram ? cjkBigrams(item) : lowerTokens(item)) {
            if (token) set.add(token);
        }
    }
    return set;
}

/** Query features: Latin words (stop-words removed) + Chinese bigrams. */
function queryFeatures(text) {
    const latin = lowerTokens(text).filter((token) => token.length > 1 && !STOP_WORDS.has(token));
    return { latin: new Set(latin), cjk: new Set(cjkBigrams(text)) };
}

export function createSkillRegistry({ builtins = defaultBuiltins } = {}) {
    // Keep canonical copies in insertion order (builtins = product order).
    const skills = Array.isArray(builtins) ? builtins.slice() : [];

    /** Public list (shallow copies so callers can't mutate the registry). */
    function list() {
        return skills.map((skill) => ({ ...skill }));
    }

    /** Get one skill by exact name, or undefined. */
    function get(name) {
        const wanted = String(name || "");
        const found = skills.find((skill) => skill.name === wanted);
        return found ? { ...found } : undefined;
    }

    /**
     * Score a query against every skill and return entries with a positive
     * score, descending. Deterministic: ties keep registry order. Each entry is
     * { skill, score, matchedTags }. Returns [] when nothing matches.
     *
     * Scorer (all deterministic, no external signal):
     *   +3 per query feature that lands on a skill TAG (weighted strongest —
     *     tags are the author's own match intent),
     *   +2 per query feature found in the skill NAME but no tag,
     *   +1 per query feature found only in the DESCRIPTION.
     * Latin words and Chinese character bigrams are scored with the same rule.
     */
    function match(text, { limit = 5 } = {}) {
        const query = queryFeatures(String(text || ""));
        if (query.latin.size === 0 && query.cjk.size === 0) return [];

        const scored = [];
        skills.forEach((skill, order) => {
            const tags = Array.isArray(skill.tags) ? skill.tags : [];
            const tagLatin = tokenSet(tags);
            const tagCjk = tokenSet(tags, true);
            const nameLatin = new Set(lowerTokens(skill.name || ""));
            const descLatin = tokenSet([skill.description || ""]);
            const descCjk = tokenSet([skill.description || ""], true);

            const hitTags = new Set();
            const noteTagHit = (feature, cjk) => {
                for (const tag of tags) {
                    const tagSet = cjk ? tokenSet([tag], true) : tokenSet([tag]);
                    if (tagSet.has(feature)) hitTags.add(tag);
                }
            };

            let score = 0;
            for (const word of query.latin) {
                if (tagLatin.has(word)) {
                    score += 3;
                    noteTagHit(word, false);
                } else if (nameLatin.has(word)) {
                    score += 2;
                } else if (descLatin.has(word)) {
                    score += 1;
                }
            }
            for (const bigram of query.cjk) {
                if (tagCjk.has(bigram)) {
                    score += 3;
                    noteTagHit(bigram, true);
                } else if (descCjk.has(bigram)) {
                    score += 1;
                }
            }

            if (score > 0) {
                scored.push({
                    skill: { ...skill },
                    score,
                    matchedTags: [...hitTags],
                    _order: order,
                });
            }
        });

        scored.sort((a, b) => (b.score - a.score) || (a._order - b._order));
        const safeLimit = Math.max(1, Math.min(100, Number(limit) || 5));
        return scored.slice(0, safeLimit).map(({ skill, score, matchedTags }) => ({
            skill,
            score,
            matchedTags,
        }));
    }

    return { list, get, match };
}

export default createSkillRegistry;
