#!/usr/bin/env node
/**
 * AgentEvo 幂等 additive 迁移 runner + 数据库审计（W3.2-B / runbook）。
 *
 * 默认（只读）：完整性检查 + 表清单 + migration ledger + owner/tenant scope-null
 *              审计 + orphan 候选报告。不写入、不删除任何数据。
 * --apply      ：先 WAL checkpoint + 备份，再复用 src/db/index.js 的 initDB()
 *                （与 app 启动同一条幂等 additive 迁移路径）落地 schema/backfill，
 *                在 security_migration_audit 记一条 ledger，最后复检。
 *
 * 安全约束：
 *   - additive-only、幂等；未知 orphan 只报告/隔离，绝不自动删除。
 *   - --apply 前若 WAL checkpoint 显示有活动写入（busy>0）会拒绝执行，
 *     提示先停服；除非显式 --force（快照含 -wal/-shm，风险自担）。
 *   - 生产库请在停服维护窗口执行；默认备份到 backend/backups/。
 *
 * 用法（在 backend/ 目录下执行）：
 *   node scripts/migrate-db.mjs                 # 只读审计（dry-run）
 *   node scripts/migrate-db.mjs --apply          # 备份 + 落地迁移 + ledger + 复检
 *   DB_PATH=/x/agent_data.db node scripts/migrate-db.mjs --apply
 *   MIGRATE_BACKUP_DIR=/x/backups node scripts/migrate-db.mjs --apply
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(__dirname, "../agent_data.db"); // backend/agent_data.db
const DB_PATH = path.resolve(process.env.DB_PATH || DEFAULT_DB);
const BACKUP_DIR = path.resolve(process.env.MIGRATE_BACKUP_DIR || path.resolve(__dirname, "../backups"));
const CHUNK_ROOT = path.resolve(__dirname, "../tmp/chunks");
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

const out = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function audit(conn, { tables }) {
    const integrity = conn.prepare("PRAGMA integrity_check").all().map((r) => r.integrity_check);
    const list = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    const columnsOf = (t) => conn.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const scopeNulls = {};
    for (const t of ["eval_traces", "eval_feedback", "eval_test_cases", "optimization_log", "agent_config_versions"]) {
        if (!list.includes(t)) continue;
        const cols = columnsOf(t);
        const ownerCol = cols.includes("owner_user_id") ? "owner_user_id" : cols.includes("user_id") ? "user_id" : null;
        const tenantCol = cols.includes("tenant_id") ? "tenant_id" : null;
        scopeNulls[t] = {
            ownerNulls: ownerCol ? Number(conn.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE ${ownerCol} IS NULL`).get().c) : null,
            tenantNulls: tenantCol ? Number(conn.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE ${tenantCol} IS NULL`).get().c) : null,
        };
    }
    const ledger = list.includes("security_migration_audit")
        ? conn.prepare("SELECT id, migration, created_at FROM security_migration_audit ORDER BY id").all()
        : [];
    const orphanCandidates = fs.existsSync(CHUNK_ROOT)
        ? fs.readdirSync(CHUNK_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
        : [];
    return { integrity, tableCount: list.length, tables: tables ? list : undefined, scopeNulls, ledger, orphanCandidates };
}

function fail(code, message) {
    out({ ok: false, dbPath: DB_PATH, code, message });
    process.exitCode = 1;
    return null;
}

const hasDbFile = fs.existsSync(DB_PATH);

// ── dry-run：纯只读审计 ──
if (!APPLY) {
    if (!hasDbFile) {
        fail("DB_NOT_FOUND", `数据库不存在: ${DB_PATH}`);
        process.exit(1);
    }
    const conn = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    try {
        out({ ok: true, mode: "dry-run", dbPath: DB_PATH, destructiveActions: false, ...audit(conn, { tables: true }) });
    } finally {
        conn.close();
    }
    process.exit(0);
}

// ── apply：checkpoint + 备份 → 迁移 → ledger → 复检 ──
if (!hasDbFile && !FORCE) {
    fail("DB_NOT_FOUND", `数据库不存在: ${DB_PATH}。全新库请用 --force 让 initDB 自举完整 schema。`);
    process.exit(1);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });

// 1) WAL checkpoint：确认无活动写入方后再备份，避免不一致快照
let checkpoint = { busy: 0, log: 0, checkpointed: 0 };
if (hasDbFile) {
    const conn = new Database(DB_PATH);
    try {
        const rows = conn.pragma("wal_checkpoint(TRUNCATE)");
        checkpoint = Array.isArray(rows) && rows[0] ? rows[0] : { busy: 0, log: 0, checkpointed: 0 };
    } finally {
        conn.close();
    }
}
if (Number(checkpoint.busy) > 0 && !FORCE) {
    out({ ok: false, code: "WAL_BUSY", message: `WAL checkpoint 忙（busy=${checkpoint.busy}），可能仍有进程在写库。请停服后重试，或加 --force 连同 -wal/-shm 一起快照。` });
    process.exit(1);
}

// 2) 备份主文件 + 残留 -wal/-shm（如有）
const backupBase = path.join(BACKUP_DIR, `agent_data-${stamp()}`);
const backupFiles = [];
if (hasDbFile) {
    const dest = `${backupBase}.db`;
    fs.copyFileSync(DB_PATH, dest);
    backupFiles.push(dest);
}
for (const suffix of ["-wal", "-shm"]) {
    const src = `${DB_PATH}${suffix}`;
    if (fs.existsSync(src) && fs.statSync(src).size > 0) {
        const dest = `${backupBase}${suffix}`;
        fs.copyFileSync(src, dest);
        backupFiles.push(dest);
    }
}

// 3) 复用与 app 完全相同的 additive 迁移路径（单一事实来源）
process.env.DB_PATH = DB_PATH; // 让 db/index.js 指向目标库
const { initDB, getMigrationAuditSummary, closeDB, default: dbConn } = await import("../src/db/index.js");
initDB();
const summary = getMigrationAuditSummary();
// 4) ledger 记录（唯一名：时间戳）
const ledgerName = `migrate-db:apply:${stamp()}`;
try {
    dbConn.prepare("INSERT INTO security_migration_audit (migration, details) VALUES (?, ?)").run(
        ledgerName,
        JSON.stringify({ dbPath: DB_PATH, backup: backupFiles, tables: summary.tables.length, integrityPre: checkpoint })
    );
} catch (error) {
    out({ ok: false, code: "LEDGER_FAILED", message: error.message });
    process.exit(1);
} finally {
    closeDB();
}

// 5) 复检（只读）
const check = new Database(DB_PATH, { readonly: true, fileMustExist: true });
try {
    const post = audit(check, { tables: false });
    out({
        ok: true, mode: "apply", dbPath: DB_PATH, backupDir: BACKUP_DIR, backupFiles,
        ledgerEntry: ledgerName, ...post, destructiveActions: false,
    });
} finally {
    check.close();
}
process.exit(0);
