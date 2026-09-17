/**
 * Phase 7 / R1 — RepoContextService: turn attached repo references into
 * untrusted, provenance-carrying context packets for the main Graph.
 *
 * The model never chooses the project, root, trust, or the file content — the
 * owner-scoped request carries `{ projectId, refs:[{path,startLine,endLine}] }`,
 * this service resolves the project through the registrar (owner scope), then
 * reads the referenced lines through the SAME read-only runner boundary as every
 * other workspace op (trust/terminal/allowed-root/containment re-checked per op).
 * Each packet carries `path:line-endline @ <commit>` provenance and an
 * independent token budget, so repo code can never crowd out the rest of the
 * conversation window. When the workspace capability is dark (default) this
 * service resolves to empty without touching the filesystem.
 */
import { estimateTokens } from "../services/chatUtils.js";
import { codingWorkspaceEnabled } from "./flags.js";
import { defaultProjectService } from "./projects.js";
import { defaultWorkspaceRunner } from "./runner/readRunner.js";

export const REPO_CONTEXT_LIMITS = Object.freeze({
    maxRefs: 8,
    // 精确行范围的静态引用上限。整文件引用不是扩大该范围，而是授予本轮
    // `read_attached_file` 的受限分页能力，源码不在这里预读进 prompt。
    maxLinesPerRef: 2000,
    budgetTokens: 1500, // independent repo budget (tokens)
    wholeFileMaxRefs: 4,
});

/** `whole_file` descriptor only — the graph turns it into a scoped read tool. */
export const WHOLE_FILE_REF_MODE = "whole_file";

function positiveInt(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function shortCommit(commit) {
    const value = String(commit || "").trim();
    return value ? value.slice(0, 12) : "unknown";
}

export class RepoContextService {
    constructor({ projects = null, runner = null, budgetTokens = REPO_CONTEXT_LIMITS.budgetTokens } = {}) {
        this.projects = projects;
        this.runner = runner;
        this.budgetTokens = Math.max(200, Number(budgetTokens) || REPO_CONTEXT_LIMITS.budgetTokens);
    }

    /**
     * @param {{userId:number, tenantId?:string}} scope owner scope (from the auth request)
     * @param {{projectId:string, refs:Array}} repoContext request surface (never trusted)
     * @returns {{packets: Array, wholeFiles: Array, omitted: number, enabled: boolean, commit: string|null}}
     */
    async resolve(scope, repoContext = {}) {
        const empty = { packets: [], omitted: 0, enabled: false, commit: null };
        // Default-dark: never read a file while the workspace capability is off.
        if (!codingWorkspaceEnabled()) return empty;
        const { projects, runner } = this;
        if (!projects || !runner) return empty;

        const projectId = repoContext?.projectId;
        const refs = repoContext?.refs;
        if (!projectId || !Array.isArray(refs) || refs.length === 0) return empty;

        // Owner-scoped registrar fetch: cross-owner / unknown -> empty (no leak).
        let project;
        try {
            project = projects.get(scope, String(projectId));
        } catch {
            return empty;
        }
        if (!project) return empty;

        // Runner open re-validates trust / terminal / allowed-roots / existence.
        let opened;
        try {
            opened = await runner.open(project);
        } catch (error) {
            console.log(`[repoContext] skip project ${projectId}: ${error?.message}`);
            return { ...empty, enabled: true };
        }
        const commit = opened.commit || null;
        const commitShort = shortCommit(commit);

        const packets = [];
        const wholeFiles = [];
        let omitted = 0;
        let usedTokens = 0;
        const budget = this.budgetTokens;

        for (const raw of refs.slice(0, REPO_CONTEXT_LIMITS.maxRefs)) {
            const path = typeof raw?.path === "string" && raw.path.trim() ? raw.path.trim() : null;
            const mode = raw?.mode == null ? "range" : String(raw.mode);
            if (mode === WHOLE_FILE_REF_MODE) {
                if (!path || wholeFiles.length >= REPO_CONTEXT_LIMITS.wholeFileMaxRefs) {
                    omitted += 1;
                    continue;
                }
                // The descriptor is intentionally metadata-only. The code agent
                // receives a scoped reader later; no whole file is read here.
                wholeFiles.push({
                    projectId: String(projectId),
                    path,
                    commit,
                    metadata: { type: "repo_capability", untrusted: true, selection: WHOLE_FILE_REF_MODE },
                    // This closure retains the already owner/trust-gated project
                    // and runner. Graph code never receives a root path or a
                    // general workspace reader it could expand into other files.
                    read: async ({ startLine, maxLines }) => runner.invoke(project, "read_file", {
                        path,
                        start_line: startLine,
                        max_lines: maxLines,
                    }),
                });
                continue;
            }
            if (mode !== "range") {
                omitted += 1;
                continue;
            }
            if (usedTokens >= budget) break;
            const startLine = positiveInt(raw?.startLine ?? raw?.start_line);
            const endLine = positiveInt(raw?.endLine ?? raw?.end_line);
            if (!path || startLine == null || endLine == null || endLine < startLine) {
                omitted += 1;
                continue;
            }
            const requested = endLine - startLine + 1;
            if (requested > REPO_CONTEXT_LIMITS.maxLinesPerRef) {
                omitted += 1;
                continue;
            }

            let lines = [];
            try {
                const outcome = await runner.invoke(project, "read_file", {
                    path,
                    start_line: startLine,
                    max_lines: requested,
                });
                lines = Array.isArray(outcome?.data?.lines) ? outcome.data.lines : [];
            } catch (error) {
                omitted += 1;
                console.log(`[repoContext] skip ref ${path}:${startLine}-${endLine}: ${error?.message}`);
                continue;
            }
            if (lines.length === 0) {
                omitted += 1;
                continue;
            }

            const actualEnd = startLine + lines.length - 1;
            const header = `[repo ${path}:${startLine}-${actualEnd} @ ${commitShort}]`;
            const headerTokens = estimateTokens(header);
            const accLines = [];
            let accTokens = headerTokens;
            for (const line of lines) {
                const cost = estimateTokens(line) + 1;
                if (accTokens + cost > budget - usedTokens) break;
                accTokens += cost;
                accLines.push(line);
            }
            if (accLines.length === 0) {
                omitted += 1;
                continue;
            }
            const selectedEnd = startLine + accLines.length - 1;
            const content = `${header.replace(`-${actualEnd} `, `-${selectedEnd} `)}\n${accLines.join("\n")}`;
            packets.push({
                content,
                timestamp: new Date(),
                tokenCount: accTokens,
                relevanceScore: 0.9,
                metadata: {
                    type: "repo",
                    untrusted: true,
                    projectId: String(projectId),
                    commit,
                    truncated: selectedEnd < actualEnd,
                    provenance: { path, startLine, endLine: selectedEnd, commit },
                },
            });
            usedTokens += accTokens;
        }

        if (omitted > 0 || wholeFiles.length > 0) {
            console.log(`[repoContext] project=${projectId} refs=${refs.length} packets=${packets.length} wholeFiles=${wholeFiles.length} omitted=${omitted} usedTokens=${usedTokens}/${budget}`);
        }
        const result = { packets, omitted, enabled: true, commit };
        if (wholeFiles.length > 0) result.wholeFiles = wholeFiles;
        return result;
    }
}

export const defaultRepoContextService = new RepoContextService({
    projects: defaultProjectService,
    runner: defaultWorkspaceRunner,
});
export default defaultRepoContextService;
