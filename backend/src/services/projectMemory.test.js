/**
 * Phase 7 / R4 — ProjectMemoryService unit tests（roadmap R4 checklist #1/#2）。
 *
 * 覆盖：additive schema、add/search 往返、layer 校验、working 缺 run、与既有用户级
 * agent_memory 的分离、失效（invalidate / invalidateBySource）、run working 清除、
 * 跨用户零泄漏、flag 默认关闭、相关性评分、packetsForContext 形状。
 *
 * 逐文件独立临时空库（vitest.setup.js）——绝不触碰真实开发库。
 * 运行: npx vitest run src/services/projectMemory.test.js
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import db, { addMemory as dbAddMemory, createUser, initDB } from "../db/index.js";
import { clearRagFlags, projectMemoryEnabled, RAG_FLAG_NAMES } from "../rag/flags.js";
import {
    PROJECT_MEMORY_LAYERS,
    ProjectMemoryService,
    assertProjectMemoryLayer,
    classifyMemoryLayer,
    countUserMemory,
    memoryProvenance,
    normalizeScope,
} from "./projectMemory.js";

const PROJECT = "proj_demo";

let ALICE;
let BOB;
let aliceScope;
let bobScope;
let aliceMem;
let bobMem;

beforeAll(() => {
    initDB();
    ALICE = { id: createUser("PM Alice", "hash-pma") };
    BOB = { id: createUser("PM Bob", "hash-pmb") };
    aliceScope = { userId: ALICE.id, tenantId: `user:${ALICE.id}` };
    bobScope = { userId: BOB.id, tenantId: `user:${BOB.id}` };
    aliceMem = new ProjectMemoryService({ scope: aliceScope });
    bobMem = new ProjectMemoryService({ scope: bobScope });
});

afterEach(() => {
    clearRagFlags();
});

// ═══════════════════════════════════════════════════════
// taxonomy — 纯函数
// ═══════════════════════════════════════════════════════

describe("taxonomy helpers", () => {
    it("PROJECT_MEMORY_LAYERS frozen three layers", () => {
        expect(PROJECT_MEMORY_LAYERS).toEqual({ WORKING: "working", EPISODIC: "episodic", SEMANTIC: "semantic" });
        expect(Object.isFrozen(PROJECT_MEMORY_LAYERS)).toBe(true);
    });

    it("normalizeScope accepts number and object scopes and derives tenant", () => {
        expect(normalizeScope(ALICE.id)).toEqual({ ownerUserId: ALICE.id, tenantId: `user:${ALICE.id}` });
        expect(normalizeScope({ userId: ALICE.id })).toEqual({ ownerUserId: ALICE.id, tenantId: `user:${ALICE.id}` });
        expect(normalizeScope({ userId: ALICE.id, tenantId: "acme" })).toEqual({ ownerUserId: ALICE.id, tenantId: "acme" });
        expect(normalizeScope({ id: ALICE.id })).toEqual({ ownerUserId: ALICE.id, tenantId: `user:${ALICE.id}` });
    });

    it("normalizeScope throws PROJECT_MEMORY_SCOPE_REQUIRED for missing owner", () => {
        for (const bad of [0, -1, null, undefined, {}, { userId: 0 }]) {
            let error = null;
            try { normalizeScope(bad); } catch (err) { error = err; }
            expect(error).not.toBeNull();
            expect(error.code).toBe("PROJECT_MEMORY_SCOPE_REQUIRED");
        }
    });

    it("assertProjectMemoryLayer lowercases + accepts the three layers only", () => {
        expect(assertProjectMemoryLayer("WORKING")).toBe("working");
        expect(assertProjectMemoryLayer(" Semantic ")).toBe("semantic");
        for (const bad of ["", "workingx", "longterm", null, undefined, 42]) {
            let error = null;
            try { assertProjectMemoryLayer(bad); } catch (err) { error = err; }
            expect(error).not.toBeNull();
            expect(error.code).toBe("PROJECT_MEMORY_INVALID_LAYER");
        }
    });

    it("classifyMemoryLayer splits run working vs episodic vs semantic", () => {
        expect(classifyMemoryLayer()).toBe("episodic");
        expect(classifyMemoryLayer({ runScoped: true })).toBe("working");
        expect(classifyMemoryLayer({ runScoped: true, semantic: false })).toBe("working");
        expect(classifyMemoryLayer({ semantic: true })).toBe("semantic");
        expect(classifyMemoryLayer({ runScoped: true, semantic: true })).toBe("semantic");
    });

    it("memoryProvenance normalizes sourceRunId/files/commitRef and clamps confidence", () => {
        const prov = memoryProvenance({
            sourceRunId: "run_9",
            files: ["z.txt", "a.js", "z.txt", "", "   "],
            commitRef: "abc123",
            confidence: 3.5,
        });
        expect(prov.sourceRunId).toBe("run_9");
        expect(prov.files).toEqual(["a.js", "z.txt"]);
        expect(prov.commitRef).toBe("abc123");
        expect(prov.confidence).toBe(1);

        expect(memoryProvenance({ confidence: -1 }).confidence).toBe(0);
        expect(memoryProvenance({}).confidence).toBe(0.5);
        expect(memoryProvenance({}).sourceRunId).toBeNull();
        expect(memoryProvenance({}).commitRef).toBeNull();
        expect(memoryProvenance({}).files).toEqual([]);
    });

    it("memoryProvenance caps files at 20 unique sorted paths", () => {
        const many = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, "0")}.md`);
        const prov = memoryProvenance({ files: many });
        expect(prov.files).toHaveLength(20);
        expect(prov.files[0]).toBe("f00.md");
        expect(prov.files[19]).toBe("f19.md");
    });
});

// ═══════════════════════════════════════════════════════
// schema
// ═══════════════════════════════════════════════════════

describe("additive schema", () => {
    it("initDB creates project_memory once with the documented columns and is idempotent", () => {
        initDB();
        initDB();
        const cols = db.prepare("PRAGMA table_info(project_memory)").all().map((c) => c.name);
        for (const col of ["id", "owner_user_id", "tenant_id", "project_id", "run_id", "layer", "content", "importance", "confidence", "source_run_id", "files_json", "commit_ref", "invalidated", "invalidated_at", "invalidate_reason", "meta", "created_at", "updated_at"]) {
            expect(cols).toContain(col);
        }
        expect(cols).toContain("owner_user_id");
        const count = () => db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='project_memory'").get().c;
        expect(count()).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════
// add + search roundtrip
// ═══════════════════════════════════════════════════════

describe("add() + search() roundtrip", () => {
    it("episodic row found by CJK keyword query", () => {
        const id = aliceMem.add({ projectId: PROJECT, content: "认证网关刷新令牌的鉴权链路存在超时缺陷", layer: "episodic", importance: 0.6 });
        expect(id).toBeGreaterThan(0);

        const hits = aliceMem.search({ projectId: PROJECT, query: "令牌鉴权 超时" });
        expect(hits.length).toBeGreaterThan(0);
        const top = hits[0];
        expect(top.id).toBe(id);
        expect(top.content).toContain("令牌");
        expect(top.relevanceScore).toBeGreaterThan(0.15);
    });

    it("metadata / files / commitRef / confidence persisted and returned", () => {
        const id = aliceMem.add({
            projectId: PROJECT,
            content: "数据库迁移脚本加入幂等重放保护",
            layer: "episodic",
            importance: 0.8,
            sourceRunId: "run_7",
            files: ["src/db/migrate.sql", "docs/runbook.md"],
            commitRef: "9f78b6e",
            confidence: 0.9,
            meta: { topic: "migration", task: "W3.2-B" },
        });
        expect(id).toBeGreaterThan(0);

        const [row] = aliceMem.search({ projectId: PROJECT, query: "迁移 幂等 重放" });
        expect(row).toBeDefined();
        expect(row.layer).toBe("episodic");
        expect(row.importance).toBe(0.8);
        expect(row.confidence).toBe(0.9);
        expect(row.sourceRunId).toBe("run_7");
        // files 归一化为排序去重数组（memoryProvenance 契约）
        expect(row.files).toEqual(["docs/runbook.md", "src/db/migrate.sql"]);
        expect(row.commitRef).toBe("9f78b6e");
        expect(row.projectId).toBe(PROJECT);
    });

    it("semantic + importance boost orders higher-importance match first", () => {
        const low = aliceMem.add({ projectId: PROJECT, content: "网关鉴权令牌刷新存在超时问题待修复", layer: "semantic", importance: 0.4 });
        const high = aliceMem.add({ projectId: PROJECT, content: "网关鉴权令牌刷新策略已确认采用滑动窗口", layer: "semantic", importance: 0.9 });
        const hits = aliceMem.search({ projectId: PROJECT, query: "网关鉴权令牌 刷新", layer: "semantic" });
        const ids = hits.map((h) => h.id);
        expect(ids).toContain(low);
        expect(ids).toContain(high);
        expect(ids[0]).toBe(high); // high importance wins ties in keyword match
        expect(hits[0].relevanceScore).toBeGreaterThanOrEqual(hits[1]?.relevanceScore || 0);
    });

    it("works with number scope too and tenant derived", () => {
        const svc = new ProjectMemoryService({ scope: ALICE.id });
        const id = svc.add({ projectId: "proj_n", content: "number-scope 归一化记忆" });
        expect(id).toBeGreaterThan(0);
        const rows = svc.search({ projectId: "proj_n", query: "归一化" });
        expect(rows.length).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════
// layer / content validation
// ═══════════════════════════════════════════════════════

describe("validation", () => {
    it("rejects missing projectId with PROJECT_MEMORY_PROJECT_REQUIRED", () => {
        let error = null;
        try { aliceMem.add({ content: "no project" }); } catch (err) { error = err; }
        expect(error).not.toBeNull();
        expect(error.code).toBe("PROJECT_MEMORY_PROJECT_REQUIRED");
    });

    it("rejects invalid layer with PROJECT_MEMORY_INVALID_LAYER", () => {
        let error = null;
        try { aliceMem.add({ projectId: PROJECT, content: "x", layer: "future" }); } catch (err) { error = err; }
        expect(error).not.toBeNull();
        expect(error.code).toBe("PROJECT_MEMORY_INVALID_LAYER");
    });

    it("rejects empty content", () => {
        let error = null;
        try { aliceMem.add({ projectId: PROJECT, content: "   " }); } catch (err) { error = err; }
        expect(error).not.toBeNull();
        expect(error.code).toBe("PROJECT_MEMORY_CONTENT_REQUIRED");
    });

    it("working layer without runId throws PROJECT_MEMORY_WORKING_NEEDS_RUN", () => {
        let error = null;
        try { aliceMem.add({ projectId: PROJECT, content: "wip note", layer: "working" }); } catch (err) { error = err; }
        expect(error).not.toBeNull();
        expect(error.code).toBe("PROJECT_MEMORY_WORKING_NEEDS_RUN");
    });

    it("working layer with runId is accepted and run_id is the runId", () => {
        const id = aliceMem.add({ projectId: PROJECT, content: "临时检索到 x 文件", layer: "working", runId: "run_w1" });
        expect(id).toBeGreaterThan(0);
        const rows = aliceMem.list({ projectId: PROJECT, layer: "working" });
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0].runId).toBe("run_w1");
    });
});

// ═══════════════════════════════════════════════════════
// separation from user memory
// ═══════════════════════════════════════════════════════

describe("separation from existing user-level agent_memory (roadmap #1)", () => {
    it("writing N project memories never changes agent_memory row count for that user", () => {
        const before = countUserMemory(aliceScope);
        aliceMem.add({ projectId: PROJECT, content: "项目甲：网关层统一做鉴权", layer: "semantic", importance: 0.9 });
        aliceMem.add({ projectId: PROJECT, content: "项目甲：完成了分片上传合并", layer: "episodic" });
        aliceMem.add({ projectId: PROJECT, content: "项目甲：run 途中 working 笔记", layer: "working", runId: "run_sep" });
        expect(countUserMemory(aliceScope)).toBe(before);
        // project_memory 自有行数独立增长（本测试新写 3 行；可能与同 PROJECT 其它行共存）
        const stats = aliceMem.stats({ projectId: PROJECT });
        expect(stats.total).toBeGreaterThanOrEqual(3);
    });

    it("db addMemory to agent_memory never appears in projectMemory search", () => {
        dbAddMemory(ALICE.id, null, "用户偏爱 Python 与简洁代码", "semantic", 0.9, {});
        const userCount = countUserMemory(aliceScope);
        expect(userCount).toBeGreaterThan(0);

        // 用户记忆在 agent_memory 可被 db searchMemory 检索
        const userHits = db.prepare(
            "SELECT COUNT(*) AS c FROM agent_memory WHERE user_id = ? AND content LIKE '%Python%'",
        ).get(ALICE.id).c;
        expect(userHits).toBeGreaterThan(0);

        // 但 project memory 检索看不到它（项目记忆层与用户层隔离）
        const projectHits = aliceMem.search({ projectId: PROJECT, query: "Python 简洁代码" });
        expect(projectHits.filter((r) => r.content.includes("Python"))).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════
// invalidation
// ═══════════════════════════════════════════════════════

describe("invalidation (roadmap #2)", () => {
    it("invalidate(id) hides from default search/list and reappears with includeInvalidated", () => {
        const id = aliceMem.add({ projectId: PROJECT, content: "过期结论：使用 JSONB 存储（已否决）", layer: "semantic" });
        expect(aliceMem.search({ projectId: PROJECT, query: "JSONB" }).length).toBe(1);
        expect(aliceMem.list({ projectId: PROJECT }).some((r) => r.id === id)).toBe(true);

        expect(aliceMem.invalidate(id, { reason: "superseded by decision log" })).toBe(true);
        expect(aliceMem.search({ projectId: PROJECT, query: "JSONB" }).length).toBe(0);
        expect(aliceMem.list({ projectId: PROJECT }).some((r) => r.id === id)).toBe(false);

        const hidden = aliceMem.search({ projectId: PROJECT, query: "JSONB", includeInvalidated: true });
        const found = hidden.find((r) => r.id === id);
        expect(found).toBeDefined();
        expect(found.invalidated).toBe(1);
        expect(found.invalidateReason).toBe("superseded by decision log");
        expect(found.invalidatedAt).not.toBeNull();
    });

    it("invalidateBySource flips commitRef-tagged rows for the project", () => {
        const c1 = "aaa111";
        const c2 = "bbb222";
        const a = aliceMem.add({ projectId: PROJECT, content: "commit aaa 引入的结论一", sourceRunId: "run_a", commitRef: c1 });
        const b = aliceMem.add({ projectId: PROJECT, content: "commit bbb 引入的结论二", sourceRunId: "run_b", commitRef: c2 });
        const untouched = aliceMem.add({ projectId: PROJECT, content: "无关行保留", layer: "semantic" });

        const flipped = aliceMem.invalidateBySource({ projectId: PROJECT, commitRef: c1 });
        expect(flipped).toBeGreaterThanOrEqual(1);

        const active = aliceMem.list({ projectId: PROJECT, includeInvalidated: true });
        const rowA = active.find((r) => r.id === a);
        const rowB = active.find((r) => r.id === b);
        const rowU = active.find((r) => r.id === untouched);
        expect(rowA.invalidated).toBe(1);
        expect(rowB.invalidated).toBe(0);
        expect(rowU.invalidated).toBe(0);

        // 默认检索隐藏被失效行
        expect(aliceMem.list({ projectId: PROJECT }).some((r) => r.id === a)).toBe(false);
    });

    it("invalidateBySource with neither sourceRunId nor commitRef is a no-op", () => {
        expect(aliceMem.invalidateBySource({ projectId: PROJECT })).toBe(0);
    });

    it("invalidate is owner-scoped: BOB cannot invalidate ALICE row", () => {
        const id = aliceMem.add({ projectId: PROJECT, content: "alice 专属待失效记忆" });
        expect(bobMem.invalidate(id)).toBe(false);
        const row = aliceMem.list({ projectId: PROJECT }).find((r) => r.id === id);
        expect(row.invalidated).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════
// purgeRunWorking
// ═══════════════════════════════════════════════════════

describe("purgeRunWorking", () => {
    it("deletes working rows for the run but keeps episodic/semantic for the same run", () => {
        const run = "run_purge_1";
        aliceMem.add({ projectId: PROJECT, content: "run 途中草稿笔记 w1", layer: "working", runId: run });
        aliceMem.add({ projectId: PROJECT, content: "run 途中草稿笔记 w2", layer: "working", runId: run });
        const epi = aliceMem.add({ projectId: PROJECT, content: "该 run 完成的里程碑事件", layer: "episodic", runId: run });
        const sem = aliceMem.add({ projectId: PROJECT, content: "该 run 验证出的项目结论", layer: "semantic", sourceRunId: run, commitRef: "c99" });

        expect(aliceMem.list({ projectId: PROJECT, layer: "working" }).length).toBeGreaterThanOrEqual(2);
        const purged = aliceMem.purgeRunWorking({ runId: run });
        expect(purged).toBe(2);

        // 该 run 的 working 全清（其它 run 的 working 行不受影响，见下）
        const remainingWorking = aliceMem.list({ projectId: PROJECT, layer: "working" });
        expect(remainingWorking.some((r) => r.runId === run)).toBe(false);
        // 同 run 的 episodic/semantic 幸存
        expect(aliceMem.list({ projectId: PROJECT, layer: "episodic" }).some((r) => r.id === epi)).toBe(true);
        expect(aliceMem.list({ projectId: PROJECT, layer: "semantic" }).some((r) => r.id === sem)).toBe(true);
    });

    it("returns 0 for null runId", () => {
        expect(aliceMem.purgeRunWorking({ runId: null })).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════
// cross-user zero-leak
// ═══════════════════════════════════════════════════════

describe("cross-user zero-leak", () => {
    it("ALICE rows are invisible to BOB searches / lists / stats on the same projectId", () => {
        const sharedProject = "proj_shared";
        aliceMem.add({ projectId: sharedProject, content: "ALICE 私有项目结论 secret-token-xyz", layer: "semantic", importance: 1 });
        aliceMem.add({ projectId: sharedProject, content: "ALICE 私有事件", layer: "episodic" });

        expect(aliceMem.search({ projectId: sharedProject, query: "secret-token-xyz" }).length).toBe(1);
        expect(bobMem.search({ projectId: sharedProject, query: "secret-token-xyz" }).length).toBe(0);
        expect(bobMem.list({ projectId: sharedProject }).length).toBe(0);
        expect(bobMem.stats({ projectId: sharedProject }).total).toBe(0);
    });

    it("BOB purgeRunWorking does not delete ALICE working rows", () => {
        const sharedRun = "run_shared_2";
        aliceMem.add({ projectId: PROJECT, content: "alice working w", layer: "working", runId: sharedRun });
        expect(bobMem.purgeRunWorking({ runId: sharedRun })).toBe(0);
        expect(aliceMem.list({ projectId: PROJECT, layer: "working" }).some((r) => r.runId === sharedRun)).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════
// flags — default OFF
// ═══════════════════════════════════════════════════════

describe("flags are default-off but the data layer works regardless", () => {
    it("projectMemoryEnabled() is false by default and clearRagFlags restores default", () => {
        expect(projectMemoryEnabled()).toBe(false);
        expect(RAG_FLAG_NAMES).toContain("PROJECT_MEMORY_ENABLED");
        process.env.PROJECT_MEMORY_ENABLED = "true";
        expect(projectMemoryEnabled()).toBe(true);
        clearRagFlags();
        expect(projectMemoryEnabled()).toBe(false);
        expect(process.env.PROJECT_MEMORY_ENABLED).toBeUndefined();
    });

    it("service add/search works while the flag is off (data layer is flag-agnostic)", () => {
        expect(projectMemoryEnabled()).toBe(false);
        const id = aliceMem.add({ projectId: PROJECT, content: "flag-off 也能落库", layer: "episodic" });
        expect(id).toBeGreaterThan(0);
        expect(aliceMem.search({ projectId: PROJECT, query: "flag-off" }).length).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════
// relevance scoring
// ═══════════════════════════════════════════════════════

describe("relevance scoring", () => {
    it("high-keyword match ranks above weak match", () => {
        const strongId = aliceMem.add({ projectId: PROJECT, content: "数据库连接池参数超时 调优 手册 v2", layer: "semantic", importance: 0.5 });
        const weakId = aliceMem.add({ projectId: PROJECT, content: "前端按钮点击日志收集", layer: "semantic", importance: 0.5 });
        const hits = aliceMem.search({ projectId: PROJECT, query: "数据库连接池 超时", layer: "semantic" });
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0].id).toBe(strongId);
        expect(hits[0].relevanceScore).toBeGreaterThan(0.15);
        // weak 行（零关键词命中）应被弱匹配阈值滤掉
        expect(hits.some((h) => h.id === weakId)).toBe(false);
    });

    it("query with no keyword overlap returns [] (weak filter drops zero-keyword rows)", () => {
        aliceMem.add({ projectId: PROJECT, content: "缓存失效机制讨论纪要", layer: "episodic" });
        const hits = aliceMem.search({ projectId: PROJECT, query: "图形渲染管线 光照模型" });
        expect(hits).toEqual([]);
    });

    it("minImportance high returns [] when rows fall below the importance floor", () => {
        aliceMem.add({ projectId: PROJECT, content: "低重要性琐碎记录", layer: "episodic", importance: 0.4 });
        const none = aliceMem.search({ projectId: PROJECT, query: "琐碎", minImportance: 0.9 });
        expect(none).toEqual([]);
        const some = aliceMem.search({ projectId: PROJECT, query: "琐碎", minImportance: 0.1 });
        expect(some.length).toBe(1);
    });

    it("partial token overlap survives while full miss is dropped", () => {
        aliceMem.add({ projectId: PROJECT, content: "kafka producer 消费组调优 记录", layer: "episodic" });
        const hits = aliceMem.search({ projectId: PROJECT, query: "kafka consumer 配置" });
        expect(hits.length).toBe(1); // kafka 命中，consumer/配置 未命中 → 部分重叠仍返回
        expect(hits[0].content).toContain("kafka");
    });
});

// ═══════════════════════════════════════════════════════
// list / stats / recent
// ═══════════════════════════════════════════════════════

describe("list / stats / recent", () => {
    it("list returns rows with relevanceScore 0 and honors layer filter", () => {
        const rows = aliceMem.list({ projectId: PROJECT, layer: "semantic" });
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
            expect(r.layer).toBe("semantic");
            expect(r.relevanceScore).toBe(0);
        }
    });

    it("stats reports total / byLayer / invalidated", () => {
        const s = aliceMem.stats({ projectId: PROJECT });
        expect(s.total).toBeGreaterThan(0);
        expect(s.byLayer).toEqual({ working: expect.any(Number), episodic: expect.any(Number), semantic: expect.any(Number) });
        expect(s.total).toBe(s.byLayer.working + s.byLayer.episodic + s.byLayer.semantic);
        expect(s.invalidated).toBeGreaterThanOrEqual(0);
    });

    it("recent returns newest active rows first", () => {
        const emptyProj = aliceMem.recent({ projectId: "proj_recent_empty" });
        expect(emptyProj).toEqual([]);
        const rows = aliceMem.recent({ projectId: PROJECT, limit: 5 });
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) expect(r.invalidated).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════
// packetsForContext
// ═══════════════════════════════════════════════════════

describe("packetsForContext", () => {
    it("returns ContextPacket-shaped objects for the default episodic/semantic layers", () => {
        const pid = "proj_pkt";
        aliceMem.add({ projectId: pid, content: "网关鉴权使用滑动窗口令牌", layer: "semantic", sourceRunId: "run_p", files: ["src/auth.js"], commitRef: "pkt1", confidence: 0.95, importance: 0.9 });
        aliceMem.add({ projectId: pid, content: "完成了文件 hash 增量索引", layer: "episodic" });
        // working 默认被排除在上下文注入层之外
        aliceMem.add({ projectId: pid, content: "网关鉴权临时笔记", layer: "working", runId: "run_p" });

        const packets = aliceMem.packetsForContext({ projectId: pid, query: "网关鉴权 令牌" });
        expect(packets.length).toBeGreaterThan(0);
        // 默认上下文层（episodic/semantic）不含 working
        expect(packets.filter((p) => p.metadata.layer === "working")).toHaveLength(0);

        for (const p of packets) {
            expect(typeof p.content).toBe("string");
            expect(p.content.startsWith("[项目记忆] ")).toBe(true);
            expect(typeof p.timestamp).toBe("string");
            expect(new Date(p.timestamp).getTime()).not.toBeNaN();
            expect(p.relevanceScore).toBeGreaterThanOrEqual(0);
            expect(p.relevanceScore).toBeLessThanOrEqual(1);
            expect(p.metadata.type).toBe("memory");
            expect(p.metadata.memory_type).toBe(p.metadata.layer);
            expect(p.metadata.projectMemory).toBe(true);
            expect(p.metadata.projectId).toBe(pid);
            expect(["episodic", "semantic"]).toContain(p.metadata.layer);
            expect(p.metadata.provenance).toBeDefined();
            expect(p.metadata.provenance).toHaveProperty("sourceRunId");
            expect(p.metadata.provenance).toHaveProperty("files");
            expect(p.metadata.provenance).toHaveProperty("commitRef");
            expect(p.metadata.provenance).toHaveProperty("confidence");
            expect(p.metadata.provenance).toHaveProperty("importance");
        }
    });

    it("includes working layer only when explicitly requested", () => {
        const pid = "proj_pkt_w";
        aliceMem.add({ projectId: pid, content: "滑动窗口令牌策略临时核查", layer: "working", runId: "run_w9" });
        aliceMem.add({ projectId: pid, content: "滑动窗口令牌策略已确认", layer: "semantic", confidence: 0.9 });

        const defaultPackets = aliceMem.packetsForContext({ projectId: pid, query: "滑动窗口令牌" });
        expect(defaultPackets.some((p) => p.metadata.layer === "working")).toBe(false);

        const withWorking = aliceMem.packetsForContext({ projectId: pid, query: "滑动窗口令牌", layers: ["working", "semantic"] });
        const workPkt = withWorking.find((p) => p.metadata.layer === "working");
        expect(workPkt).toBeDefined();
        // working 行可无 sourceRunId（provenance 来源 run 为空），内容层确认命中 working 行
        expect(workPkt.metadata.provenance.sourceRunId).toBeNull();
        expect(workPkt.content).toContain("临时核查");
        expect(withWorking.length).toBeGreaterThanOrEqual(1);
    });
});
