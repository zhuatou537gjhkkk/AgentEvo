import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(BACKEND_ROOT, "scripts", "migrate-db.mjs");

const tmpDirs = [];
function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-db-"));
    tmpDirs.push(dir);
    return dir;
}
function run({ dbPath, backupDir, args = [] }) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: BACKEND_ROOT,
        env: {
            ...process.env,
            DB_PATH: dbPath,
            MIGRATE_BACKUP_DIR: backupDir,
            NODE_ENV: "test",
        },
        encoding: "utf8",
        timeout: 60000,
    });
}
function parse(stdout) {
    try {
        return JSON.parse(stdout);
    } catch {
        return { parseError: true, raw: stdout.slice(0, 400) };
    }
}

afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe("migrate-db.mjs (W3.2-B migration runbook tooling)", () => {
    it("dry-run 为只读审计，不写库、不删数据", () => {
        const dir = tempDir();
        const dbPath = path.join(dir, "existing.db");
        const backupDir = path.join(dir, "backups");
        // 先建一个已存在的小库，再只读审计
        const boot = run({ dbPath, backupDir, args: ["--apply", "--force"] });
        expect(boot.status).toBe(0);
        const audit = run({ dbPath, backupDir });
        expect(audit.status).toBe(0);
        const result = parse(audit.stdout);
        expect(result.mode).toBe("dry-run");
        expect(result.destructiveActions).toBe(false);
        expect(result.integrity).toEqual(["ok"]);
        expect(Array.isArray(result.tables)).toBe(true);
    });

    it("全新库 --force 自举完整 schema 且幂等；ledger 每次 +1 行", () => {
        const dir = tempDir();
        const dbPath = path.join(dir, "fresh.db");
        const backupDir = path.join(dir, "backups");

        const first = parse(run({ dbPath, backupDir, args: ["--apply", "--force"] }).stdout);
        expect(first.ok).toBe(true);
        expect(first.mode).toBe("apply");
        expect(first.integrity).toEqual(["ok"]);
        expect(first.tableCount).toBeGreaterThanOrEqual(20);
        expect(first.destructiveActions).toBe(false);
        // 全新库无文件可备份
        expect(first.backupFiles).toEqual([]);

        const second = parse(run({ dbPath, backupDir, args: ["--apply", "--force"] }).stdout);
        expect(second.ok).toBe(true);
        expect(second.tableCount).toBe(first.tableCount);
        // ledger 各有一个 migrate-db:apply 条目（名称含唯一时间戳）
        const applyRows = second.ledger.filter((l) => l.migration.startsWith("migrate-db:apply:"));
        expect(applyRows.length).toBe(2);
    });

    it("已有库重放会先备份，再补齐被删除的表", () => {
        const dir = tempDir();
        const dbPath = path.join(dir, "reapply.db");
        const backupDir = path.join(dir, "backups");

        expect(run({ dbPath, backupDir, args: ["--apply", "--force"] }).status).toBe(0);
        // 模拟旧 schema：删掉两张表
        const drop = spawnSync(process.execPath, ["-e",
            "const D=require('better-sqlite3');const db=new D(process.env.DB_PATH);"
            + "db.exec('DROP TABLE IF EXISTS mcp_server_configs; DROP TABLE IF EXISTS chat_idempotency;');db.close();"],
            { cwd: BACKEND_ROOT, env: { ...process.env, DB_PATH: dbPath }, encoding: "utf8" });
        expect(drop.status).toBe(0);

        const result = parse(run({ dbPath, backupDir, args: ["--apply"] }).stdout);
        expect(result.ok).toBe(true);
        expect(result.tableCount).toBeGreaterThanOrEqual(21);
        // 已存在库：必须先产生备份文件
        expect(result.backupFiles.length).toBeGreaterThanOrEqual(1);
        expect(fs.existsSync(result.backupFiles[0])).toBe(true);
    });

    it("不存在的库无 --force 时拒绝执行（DB_NOT_FOUND）", () => {
        const dir = tempDir();
        const result = run({ dbPath: path.join(dir, "missing.db"), backupDir: path.join(dir, "backups") });
        expect(result.status).toBe(1);
        expect(parse(result.stdout).code).toBe("DB_NOT_FOUND");
    });
});
