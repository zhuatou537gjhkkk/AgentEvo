/**
 * CodeJudge — 代码判定评估器
 *
 * Phase 6a G2：对标 AgentArts 40+ 内置评估器中的代码判定类。
 * 6 个确定性判定器，零 LLM 调用成本，100% 可复现。
 *
 * 用法：
 *   const judge = new CodeJudge();
 *   const results = judge.evaluate(capturedText, capturedToolCalls, testCase.codeChecks);
 *   // → [{check: "regex-match", pass: true, score: 1, reason: "匹配模式..."}]
 */

/**
 * @typedef {object} CodeCheck
 * @property {string} type — "regex-match" | "json-schema" | "keyword-include" | "keyword-exclude" | "tool-called" | "tool-not-called"
 * @property {string} [pattern] — 正则表达式字符串（regex-match 用）
 * @property {object} [schema] — JSON Schema 对象（json-schema 用）
 * @property {string[]} [keywords] — 关键词列表（keyword-include/exclude 用）
 * @property {string} [toolName] — 工具名称（tool-called/not-called 用）
 * @property {number} [score] — 此检查通过时的得分 (0-1，默认 1)
 * @property {string} [description] — 检查描述
 */

/**
 * @typedef {object} CodeCheckResult
 * @property {string} check — 检查类型
 * @property {boolean} pass — 是否通过
 * @property {number} score — 得分
 * @property {string} reason — 判定理由
 */

class CodeJudge {
    /**
     * 批量执行代码判定
     * @param {string} text — Agent 实际输出文本
     * @param {string[]} toolCallNames — 实际调用的工具名列表
     * @param {CodeCheck[]} checks — 判定规则列表
     * @returns {CodeCheckResult[]}
     */
    evaluate(text, toolCallNames, checks) {
        if (!Array.isArray(checks) || checks.length === 0) {
            return [];
        }

        const results = [];
        for (const check of checks) {
            try {
                const result = this._runSingle(text, toolCallNames, check);
                results.push(result);
            } catch (err) {
                results.push({
                    check: check.type || "unknown",
                    pass: false,
                    score: 0,
                    reason: `判定器异常: ${err.message}`,
                });
            }
        }
        return results;
    }

    /**
     * 汇总代码判定得分
     * @param {CodeCheckResult[]} results — evaluate() 的返回值
     * @returns {{ passed: number, total: number, avgScore: number }}
     */
    static summarize(results) {
        if (results.length === 0) {
            return { passed: 0, total: 0, avgScore: 0 };
        }
        const total = results.length;
        const passed = results.filter(r => r.pass).length;
        const totalScore = results.reduce((sum, r) => sum + (r.score || 0), 0);
        return {
            passed,
            total,
            avgScore: Math.round(totalScore / total * 100) / 100,
        };
    }

    /**
     * 将代码判定结果合并为 LLMJudge tool_usage 修正因子
     * @param {CodeCheckResult[]} results — evaluate() 的返回值
     * @returns {number} — -1 表示不修正，0-5 表示修正后的 tool_usage 建议值
     */
    static toToolUsageHint(results) {
        if (results.length === 0) return -1; // 无代码判定，不修正

        // 只有 tool-called / tool-not-called 类型的检查才影响 tool_usage
        const toolChecks = results.filter(
            r => r.check === "tool-called" || r.check === "tool-not-called"
        );
        if (toolChecks.length === 0) return -1;

        const allPassed = toolChecks.every(r => r.pass);
        if (allPassed) return 5; // 工具选择全对
        const somePassed = toolChecks.some(r => r.pass);
        if (somePassed) return 2.5; // 部分正确
        return 1; // 全错
    }

    // ── private ──

    _runSingle(text, toolCallNames, check) {
        switch (check.type) {
            case "regex-match":
                return this._regexMatch(text, check);
            case "json-schema":
                return this._jsonSchema(text, check);
            case "keyword-include":
                return this._keywordInclude(text, check);
            case "keyword-exclude":
                return this._keywordExclude(text, check);
            case "tool-called":
                return this._toolCalled(toolCallNames, check);
            case "tool-not-called":
                return this._toolNotCalled(toolCallNames, check);
            default:
                return {
                    check: check.type || "unknown",
                    pass: false,
                    score: 0,
                    reason: `未知判定器类型: ${check.type}`,
                };
        }
    }

    _regexMatch(text, check) {
        if (!check.pattern) {
            return { check: "regex-match", pass: false, score: 0, reason: "缺少 pattern 参数" };
        }
        try {
            const regex = new RegExp(check.pattern, "i");
            const pass = regex.test(text);
            return {
                check: "regex-match",
                pass,
                score: pass ? (check.score ?? 1) : 0,
                reason: pass
                    ? `输出匹配正则 /${check.pattern}/`
                    : `输出不匹配正则 /${check.pattern}/`,
            };
        } catch (err) {
            return {
                check: "regex-match",
                pass: false,
                score: 0,
                reason: `正则表达式无效: ${err.message}`,
            };
        }
    }

    _jsonSchema(text, check) {
        if (!check.schema) {
            return { check: "json-schema", pass: false, score: 0, reason: "缺少 schema 参数" };
        }

        // 尝试从文本中提取 JSON
        let parsed = null;
        const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (jsonMatch) {
            try {
                parsed = JSON.parse(jsonMatch[0]);
            } catch {
                return {
                    check: "json-schema",
                    pass: false,
                    score: 0,
                    reason: "输出中未找到合法 JSON",
                };
            }
        } else {
            return {
                check: "json-schema",
                pass: false,
                score: 0,
                reason: "输出中未找到 JSON 结构",
            };
        }

        // 简易 schema 校验（仅校验 type 和 required 字段）
        const pass = this._validateJsonSchema(parsed, check.schema);
        const score = pass ? (check.score ?? 1) : 0;
        return {
            check: "json-schema",
            pass,
            score,
            reason: pass ? "JSON 符合 schema" : "JSON 不符合 schema",
        };
    }

    _keywordInclude(text, check) {
        if (!Array.isArray(check.keywords) || check.keywords.length === 0) {
            return { check: "keyword-include", pass: false, score: 0, reason: "缺少 keywords 参数" };
        }
        const lowerText = text.toLowerCase();
        const matchMode = check.matchMode || "all"; // "all" (默认) | "any"
        const hits = check.keywords.filter(kw => lowerText.includes(kw.toLowerCase()));
        const missing = check.keywords.filter(kw => !lowerText.includes(kw.toLowerCase()));

        let pass, reason;
        if (matchMode === "any") {
            pass = hits.length > 0;
            reason = pass
                ? `输出包含关键词 [${hits.join(", ")}]（${hits.length}/${check.keywords.length}，要求≥1）`
                : `输出缺少所有关键词: ${check.keywords.join(", ")}`;
        } else {
            pass = missing.length === 0;
            reason = pass
                ? `输出包含所有关键词: ${check.keywords.join(", ")}`
                : `输出缺少关键词: ${missing.join(", ")}`;
        }

        return {
            check: "keyword-include",
            pass,
            score: pass ? (check.score ?? 1) : 0,
            reason,
        };
    }

    _keywordExclude(text, check) {
        if (!Array.isArray(check.keywords) || check.keywords.length === 0) {
            return { check: "keyword-exclude", pass: false, score: 0, reason: "缺少 keywords 参数" };
        }
        const lowerText = text.toLowerCase();
        const found = check.keywords.filter(kw => lowerText.includes(kw.toLowerCase()));
        const pass = found.length === 0;
        return {
            check: "keyword-exclude",
            pass,
            score: pass ? (check.score ?? 1) : 0,
            reason: pass
                ? `输出不包含禁止关键词: ${check.keywords.join(", ")}`
                : `输出包含禁止关键词: ${found.join(", ")}`,
        };
    }

    _toolCalled(toolCallNames, check) {
        if (!check.toolName) {
            return { check: "tool-called", pass: false, score: 0, reason: "缺少 toolName 参数" };
        }
        const pass = toolCallNames.includes(check.toolName);
        return {
            check: "tool-called",
            pass,
            score: pass ? (check.score ?? 1) : 0,
            reason: pass
                ? `已调用工具: ${check.toolName}`
                : `未调用工具: ${check.toolName}（实际调用: ${toolCallNames.join(", ") || "无"}）`,
        };
    }

    _toolNotCalled(toolCallNames, check) {
        if (!check.toolName) {
            return { check: "tool-not-called", pass: false, score: 0, reason: "缺少 toolName 参数" };
        }
        const pass = !toolCallNames.includes(check.toolName);
        return {
            check: "tool-not-called",
            pass,
            score: pass ? (check.score ?? 1) : 0,
            reason: pass
                ? `未滥用工具: ${check.toolName}`
                : `不应调用却调用了工具: ${check.toolName}`,
        };
    }

    /**
     * 简易 JSON Schema 校验
     * 仅校验 type、required 字段，不实现完整 JSON Schema 规范
     */
    _validateJsonSchema(data, schema) {
        if (!schema) return true;

        // type 校验
        if (schema.type) {
            const expectedType = schema.type;
            const actualType = Array.isArray(data) ? "array" : typeof data;
            if (actualType !== expectedType) return false;
        }

        // required 校验（仅对 object 类型）
        if (schema.required && Array.isArray(schema.required) && typeof data === "object" && !Array.isArray(data)) {
            for (const key of schema.required) {
                if (!(key in data)) return false;
            }
        }

        // properties type 校验
        if (schema.properties && typeof schema.properties === "object" && typeof data === "object" && !Array.isArray(data)) {
            for (const [key, propSchema] of Object.entries(schema.properties)) {
                if (key in data && propSchema.type) {
                    const actualType = Array.isArray(data[key]) ? "array" : typeof data[key];
                    if (actualType !== propSchema.type) return false;
                }
            }
        }

        return true;
    }
}

export { CodeJudge };
