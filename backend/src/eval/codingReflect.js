/**
 * Phase 7 / R3 — Coding verification reflection: deterministic critic → optional
 * LLM critic → bounded refine, accept only when validation is not worse.
 *
 * Roadmap R3 checklist #9: "复用 eval/reflection.js，先在 Coding verification 接
 * deterministic critic → optional LLM critic → bounded refine。" 本模块把 R2 里
 * “verify 一次，失败就 repeatedFailure halt”的编码验收，升级为有界的反思闭环：
 *
 *   baseline verify → deterministic critic
 *       ├─ accept（验证不变差）→ 结束
 *       └─ reject → (optional LLM critic 补充建议) → proposeFix → bounded refine
 *             → re-verify → 回到 critic（≤ maxFixRounds，每轮都计 action）
 *
 * 约束（DoD：Reflection 不越权限/预算，且只有验证不变差时接受）：
 *   - 本模块从不直接读/写文件或执行命令 —— 一切 IO 都是调用方注入的 `runVerify` /
 *     `applyFix`；权限因此留在 Coding runner（allowlist/worktree/preset）一侧。
 *   - 预算由 maxFixRounds / maxFixActions 硬上限；超限即 rejected，绝不无限反思。
 *   - 接受条件是 `not worse`：refine 后的验证分数必须 ≥ baseline，否则继续修或拒绝，
 *     不会把“更差”的候选当作成功。
 *
 * 纯/确定性部分（scoreTestOutput / deterministicCritic / shouldAcceptRefine）不依赖
 * 任何 LLM，可在无网络环境直接测试；可选 LLM critic 仅当调用方显式传入才启用。
 */

export const CODING_REFLECT_DEFAULTS = Object.freeze({
    maxFixRounds: 3,       // 同一验证失败最多反思轮数
    maxFixActions: 5,      // 反思期间累计允许的 fix action 数
    scorePerPassed: 10,
    scorePerFailure: 100,
});

/**
 * 确定性验证输出打分（越高越好；0 = 完全失败）。
 * 解析常见测试运行器输出：# tests / N passed / N failed / ok|not ok / Error|Traceback|FAILED。
 * @param {string} text 验证命令的 stdout+stderr
 * @returns {{ score: number, passed: number, failed: number, errorMarkers: string[] }}
 */
export function parseTestOutput(text) {
    const raw = String(text ?? "");
    const errorMarkers = [];
    if (/Traceback|AssertionError|\bFAILED\b|\bException\b|not ok|✗|×/.test(raw)) {
        errorMarkers.push("failure-markers");
    }
    if (/exit code [1-9]|exited with code [1-9]|Exit [1-9]/.test(raw)) {
        errorMarkers.push("nonzero-exit");
    }
    let passed = 0;
    let failed = 0;
    const passedMatch = raw.match(/(\d+)\s+passed/i);
    if (passedMatch) passed = Number(passedMatch[1]);
    const failedMatch = raw.match(/(\d+)\s+failed/i);
    if (failedMatch) failed = Number(failedMatch[1]);
    // TAP 风格："ok 1 - ..." / "not ok 2 - ..."
    if (passed === 0 && failed === 0) {
        passed = (raw.match(/^ok\b/gm) || []).length;
        failed = (raw.match(/^not ok\b/gm) || []).length;
    }
    const markers = errorMarkers.length + (failed > 0 ? 1 : 0);
    const score = passed * CODING_REFLECT_DEFAULTS.scorePerPassed
        - failed * CODING_REFLECT_DEFAULTS.scorePerFailure
        - markers * 5;
    return {
        score: Math.max(0, score),
        passed,
        failed,
        errorMarkers,
    };
}

/**
 * Deterministic critic：直接判定验证结果好坏。
 * @param {object|string} outcome {ok?, output?, errorCode?} 或纯文本
 * @returns {{ accept: boolean, reason: string, parsed: object, score: number }}
 */
export function deterministicCritic(outcome) {
    const output = typeof outcome === "string" ? outcome : String(outcome?.output ?? "");
    const explicitFail = typeof outcome === "object" && outcome.ok === false;
    const parsed = parseTestOutput(output);
    if (explicitFail || outcome?.errorCode || (parsed.failed > 0) || (parsed.errorMarkers.length > 0)) {
        return {
            accept: false,
            reason: parsed.errorMarkers.includes("nonzero-exit")
                ? "验证命令非零退出"
                : `验证失败（${parsed.failed} failed / ${parsed.errorMarkers.join(",")}）`,
            parsed,
            score: parsed.score,
        };
    }
    return { accept: true, reason: "验证通过，无失败标记", parsed, score: parsed.score };
}

/**
 * 接受门：refine 后的验证必须“不变差”（>= baseline）才接受。
 * @param {{score:number}} before
 * @param {{score:number}} after
 */
export function shouldAcceptRefine(before, after) {
    return Number(after?.score ?? 0) >= Number(before?.score ?? 0) && after?.accept !== false;
}

/**
 * Optional LLM critic：仅当显式传入 `llmCritic` 才调用，输出更丰富的修复建议；
 * 否则返回确定性 critic 的 reason（零网络、零成本）。
 * @param {object} ctx { output, parsed, deterministicReason }
 * @param {{ llmCritic?: (ctx) => Promise<{suggestion?:string, severity?:string}> }} deps
 * @returns {Promise<{suggestion: string, severity: string, source: 'llm'|'deterministic'}>}
 */
export async function optionalLlmCritic(ctx, { llmCritic = null } = {}) {
    if (typeof llmCritic === "function") {
        try {
            const llm = await llmCritic(ctx);
            if (llm && llm.suggestion) {
                return { suggestion: llm.suggestion, severity: llm.severity || "medium", source: "llm" };
            }
        } catch (e) {
            // LLM 失败时降级到确定性建议 —— 反思不因可选模型故障而中断
        }
    }
    return { suggestion: ctx.deterministicReason, severity: "medium", source: "deterministic" };
}

/**
 * 有界反思循环。IO 全部由调用方注入：runVerify() → {ok?, output}；applyFix({suggestion})
 * → 返回新的 runVerify 结果候选。循环由 maxFixRounds / maxFixActions 硬上限约束。
 * @param {object} opts
 * @param {Function} opts.runVerify () => Promise<{ok?:boolean, output?:string}>
 * @param {Function} opts.applyFix ({suggestion, round}) => Promise<{ok?:boolean, output?:string}>
 * @param {Function} [opts.critic=deterministicCritic]
 * @param {object} [opts.llmCriticDeps] { llmCritic } 可选 LLM critic
 * @param {object} [opts.budget] { maxFixRounds, maxFixActions }
 * @returns {Promise<{accepted:boolean, rounds:number, actions:number,
 *                     baseline:{score,accept}, final:{score,accept}, reasons:string[]}>}
 */
export async function boundedRefine({ runVerify, applyFix, critic = deterministicCritic, llmCriticDeps = null, budget = {} } = {}) {
    if (typeof runVerify !== "function") throw new TypeError("boundedRefine requires runVerify()");
    const b = { ...CODING_REFLECT_DEFAULTS, ...budget };
    const maxRounds = Math.max(1, Number(b.maxFixRounds) || 1);
    const maxActions = Math.max(1, Number(b.maxFixActions) || 1);

    let actions = 0;
    const reasons = [];
    const baselineVerdict = critic(await runVerify());
    reasons.push(`baseline ${baselineVerdict.accept ? "accepted" : "rejected"}: ${baselineVerdict.reason}`);
    if (baselineVerdict.accept) {
        return {
            accepted: true,
            rounds: 0,
            actions,
            baseline: baselineVerdict,
            final: baselineVerdict,
            reasons,
        };
    }

    if (typeof applyFix !== "function") throw new TypeError("boundedRefine requires applyFix() when the baseline fails");

    let before = baselineVerdict;
    let finalVerdict = baselineVerdict;
    for (let round = 1; round <= maxRounds; round += 1) {
        if (actions >= maxActions) {
            reasons.push(`budget halt: maxFixActions=${maxActions}`);
            break;
        }
        const advice = await optionalLlmCritic(
            { output: "", parsed: before.parsed, deterministicReason: before.reason },
            llmCriticDeps || {},
        );
        actions += 1; // applyFix 是一次 fix action
        const candidate = await applyFix({ suggestion: advice.suggestion, round });
        const verdict = critic(candidate);
        reasons.push(`round ${round}: ${verdict.accept ? "accepted" : "rejected"} — ${verdict.reason}`);
        if (verdict.accept && shouldAcceptRefine(before, verdict)) {
            finalVerdict = verdict;
            return { accepted: true, rounds: round, actions, baseline: baselineVerdict, final: finalVerdict, reasons };
        }
        // 不变差但还没绿 → 继续修；变差（score 下降且 accept=false）→ 记录后继续直至预算
        before = verdict;
        finalVerdict = verdict;
    }
    reasons.push(`no accepted refinement within maxFixRounds=${maxRounds} / maxFixActions=${maxActions}`);
    return { accepted: false, rounds: Math.min(maxRounds, actions), actions, baseline: baselineVerdict, final: finalVerdict, reasons };
}

export default { CODING_REFLECT_DEFAULTS, parseTestOutput, deterministicCritic, optionalLlmCritic, shouldAcceptRefine, boundedRefine };
