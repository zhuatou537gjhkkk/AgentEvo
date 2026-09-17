import { useEffect, useState } from 'react';
import { fetchSkills, matchSkills, fetchSkill } from '../api/skills';

/**
 * Phase 7 / R5 — Skills Runtime viewer.
 *
 * Skills are declarative process knowledge (workflow / rules / scope), not tools:
 * selecting one never grants a capability. This panel only reads the canonical
 * manifest registry through the public-field surface of `/skills`, so nothing
 * here can widen a run's permissions.
 *
 * If the backend answers 403 SKILLS_DISABLED we render an enable-hint banner
 * (start the backend with SKILLS_ENABLED=true) instead of a hard error.
 */
const ENABLE_HINT = 'skills 功能未启用。启动后端时设置环境变量 SKILLS_ENABLED=true 后重启即可。';

const QUICK_QUERIES = [
    { label: '修复登录 bug', q: '修复登录bug' },
    { label: '熟悉项目结构', q: '熟悉项目结构' },
];

function Badge({ children }) {
    return (
        <span className="rounded border border-[var(--panel-border)] bg-[var(--panel-soft)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]">
            {children}
        </span>
    );
}

function ListTags({ items }) {
    if (!Array.isArray(items) || items.length === 0) {
        return null;
    }
    return (
        <div className="mt-2 flex flex-wrap gap-1">
            {items.slice(0, 12).map((tag) => (
                <Badge key={String(tag)}>{String(tag)}</Badge>
            ))}
        </div>
    );
}

function WorkflowSection({ workflow }) {
    if (!workflow || typeof workflow !== 'object') {
        return null;
    }
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    return (
        <div className="mt-3 rounded-xl border border-[var(--panel-border)] bg-[var(--panel-soft)] p-3">
            <p className="text-xs font-semibold text-[var(--text-main)]">
                流程：{String(workflow.title || 'workflow')}
            </p>
            {steps.length === 0 ? (
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">（无显式步骤）</p>
            ) : (
                <ol className="mt-2 space-y-1.5">
                    {steps.map((step, index) => (
                        <li key={index} className="text-[11px] text-[var(--text-muted)]">
                            <span className="font-mono text-[var(--text-main)]">{index + 1}.</span>
                            <span className="ml-1 font-medium text-[var(--text-main)]">
                                {String(step.step || step.goal || 'step')}
                            </span>
                            {step.agent ? <span className="ml-1 opacity-80">→ {String(step.agent)}</span> : null}
                            {step.goal ? (
                                <p className="mt-0.5 pl-3">{String(step.goal)}</p>
                            ) : null}
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}

function DetailBlock({ title, children }) {
    if (children === null || children === undefined || children === false) {
        return null;
    }
    return (
        <div className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{title}</span>
            <div className="text-[11px] text-[var(--text-main)]">{children}</div>
        </div>
    );
}

function toText(value) {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    try {
        return JSON.stringify(value, null, 0);
    } catch {
        return '';
    }
}

function SkillCard({ skill, selected, onOpen }) {
    const isSelected = selected === skill.name;
    return (
        <div className={`rounded-2xl border bg-[var(--panel-bg)] p-3 transition ${
            isSelected ? 'border-[var(--brand-mid)]' : 'border-[var(--panel-border)]'
        }`}>
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <button
                        type="button"
                        onClick={() => onOpen(skill.name)}
                        className="text-left text-sm font-semibold text-[var(--text-main)] transition hover:text-[var(--brand-start)]"
                    >
                        {String(skill.name)}
                        {skill.version ? <span className="ml-1 font-mono text-[10px] text-[var(--text-muted)]">v{String(skill.version)}</span> : null}
                    </button>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {skill.enabledByDefault ? <Badge>默认启用</Badge> : null}
                    {skill.preset ? <Badge>{String(skill.preset)}</Badge> : null}
                </div>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
                {String(skill.description || '')}
            </p>
            <ListTags items={skill.tags} />
            {isSelected ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <DetailBlock title="scope">{toText(skill.scope)}</DetailBlock>
                    <DetailBlock title="capability">
                        {skill.capability && typeof skill.capability === 'object'
                            ? `effects: ${(skill.capability.effects || []).join(', ')}`
                            : toText(skill.capability)}
                    </DetailBlock>
                    <DetailBlock title="graph">{toText(skill.graph)}</DetailBlock>
                    <DetailBlock title="module">{toText(skill.module)}</DetailBlock>
                    <DetailBlock title="audit">
                        {skill.audit && typeof skill.audit === 'object'
                            ? `events: ${(skill.audit.events || []).join(', ')}`
                            : toText(skill.audit)}
                    </DetailBlock>
                </div>
            ) : null}
            {isSelected ? <WorkflowSection workflow={skill.workflow} /> : null}
            {!isSelected ? (
                <button
                    type="button"
                    onClick={() => onOpen(skill.name)}
                    className="mt-2 text-[11px] font-medium text-[var(--brand-start)] transition hover:opacity-80"
                >
                    展开详情 ▾
                </button>
            ) : null}
        </div>
    );
}

export default function SkillsPanel() {
    const [skills, setSkills] = useState([]);
    const [detail, setDetail] = useState(null);
    const [selected, setSelected] = useState(null);
    const [query, setQuery] = useState('');
    const [matches, setMatches] = useState(null); // null = 尚未搜索
    const [loading, setLoading] = useState(false);
    const [disabled, setDisabled] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetchSkills()
            .then((data) => {
                if (cancelled) {
                    return;
                }
                if (data?.errorCode === 'SKILLS_DISABLED') {
                    setDisabled(true);
                } else {
                    setSkills(Array.isArray(data?.skills) ? data.skills : []);
                }
            })
            .catch((err) => {
                if (cancelled) {
                    return;
                }
                if (err?.errorCode === 'SKILLS_DISABLED') {
                    setDisabled(true);
                } else {
                    setError(err?.message || '加载技能列表失败');
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const runMatch = async (q) => {
        const text = String(q || '').trim();
        setQuery(text);
        if (!text) {
            setMatches([]);
            return;
        }
        setLoading(true);
        setError('');
        try {
            const data = await matchSkills(text);
            if (data?.errorCode === 'SKILLS_DISABLED') {
                setDisabled(true);
                setMatches([]);
                return;
            }
            setMatches(Array.isArray(data?.matches) ? data.matches : []);
        } catch (err) {
            if (err?.errorCode === 'SKILLS_DISABLED') {
                setDisabled(true);
            } else {
                setError(err?.message || '匹配失败');
            }
            setMatches([]);
        } finally {
            setLoading(false);
        }
    };

    const openSkill = async (name) => {
        setSelected(name);
        setDetail(null);
        try {
            const data = await fetchSkill(name);
            if (data?.ok && data.skill) {
                setDetail(data.skill);
            } else if (data?.skill) {
                setDetail(data.skill);
            }
        } catch (err) {
            setError(err?.message || '加载技能详情失败');
        }
    };

    const activeList = detail ? [detail] : skills;

    return (
        <div className="tool-workspace">
            <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
                <header>
                    <h1 className="text-xl font-semibold text-[var(--text-main)]">技能库 Skills</h1>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                        Skills 是声明式流程知识（步骤 / 规则 / 范围），不是工具——加载或匹配技能不会授予任何读写或命令权限。
                    </p>
                </header>

                {disabled && (
                    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">
                        {ENABLE_HINT}
                    </div>
                )}
                {error && (
                    <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-400">{error}</div>
                )}

                {/* 搜索 / 匹配 */}
                <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-bg)] p-3">
                    <form
                        className="flex gap-2"
                        onSubmit={(event) => {
                            event.preventDefault();
                            runMatch(query);
                        }}
                    >
                        <input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="输入意图，例如「修复登录bug」…"
                            className="ui-input w-full rounded-lg px-3 py-2 text-sm"
                        />
                        <button
                            type="submit"
                            disabled={loading}
                            className="rounded-lg bg-[var(--brand-start)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[var(--brand-mid)] disabled:opacity-40"
                        >
                            {loading ? '…' : '匹配'}
                        </button>
                    </form>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-[var(--text-muted)]">快速试例：</span>
                        {QUICK_QUERIES.map((item) => (
                            <button
                                key={item.q}
                                type="button"
                                onClick={() => runMatch(item.q)}
                                className="rounded-full border border-[var(--panel-border)] bg-[var(--panel-soft)] px-2.5 py-1 text-[11px] text-[var(--text-main)] transition hover:border-[var(--brand-mid)]"
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>

                    {matches !== null && (
                        <div className="mt-3 border-t border-[var(--panel-border)] pt-3">
                            <p className="text-[11px] font-medium text-[var(--text-muted)]">
                                {matches.length === 0 ? '无匹配' : `匹配结果（${matches.length}）`}
                            </p>
                            {matches.length > 0 && (
                                <div className="mt-1.5 flex flex-wrap gap-2">
                                    {matches.map((m) => (
                                        <button
                                            key={m.name}
                                            type="button"
                                            onClick={() => openSkill(m.name)}
                                            className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-soft)] px-2.5 py-1 text-[11px] text-[var(--text-main)] transition hover:border-[var(--brand-mid)]"
                                        >
                                            <span className="font-semibold">{String(m.name)}</span>
                                            <span className="ml-1 font-mono text-[10px] text-[var(--text-muted)]">score {Number(m.score).toFixed(3)}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* 列表 */}
                {loading && !skills.length && (
                    <p className="text-xs text-[var(--text-muted)]">加载中…</p>
                )}
                {!loading && !disabled && activeList.length === 0 && (
                    <p className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-bg)] px-4 py-3 text-xs text-[var(--text-muted)]">
                        暂无技能。若后端已启用 SKILLS_ENABLED，请刷新。
                    </p>
                )}
                {activeList.length > 0 && (
                    <div className="space-y-2">
                        {activeList.map((skill) => (
                            <SkillCard
                                key={skill.name}
                                skill={skill}
                                selected={selected}
                                onOpen={openSkill}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
