# AgentEvo 数据库迁移 Runbook（W3.2-B）

> 目的：为"安全地在生产 SQLite 库上做 additive schema 变更"提供可重复的操作流程、工具与审计留痕。
> 记录日期：2026-09-05。
> 相关：`2026-09-production-hardening-roadmap.md`（DoD §4）、`2026-09-production-hardening.md`（主日志）、`backend/scripts/migrate-db.mjs`（工具）、`backend/scripts/audit-db.mjs`（只读审计）。

## 1. 迁移策略（必须遵守）

- **只做 additive 变更**：`CREATE TABLE IF NOT EXISTS`、`ALTER TABLE ... ADD COLUMN`（幂等包装）、`CREATE INDEX IF NOT EXISTS`、backfill 用 `UPDATE ... WHERE 空值`。禁止破坏性 DDL（DROP/RENAME/改列型/删列）走自动路径。
- **幂等**：同一迁移可重复执行；重复启动不报错、不重复副作用。
- **单一事实来源**：schema 的权威落地路径是 `backend/src/db/index.js` 的 `initDB()`（→ `ensureScopedSchema()`）。`migrate-db.mjs --apply` 复用的正是这条路径，与 app 启动时行为完全一致。
- **未知 orphan 默认只报告/隔离，绝不自动删除**。报告见 `audit-db.mjs` 与 `migrate-db.mjs` 的 `orphanCandidates`。
- **不写密钥/用户内容到 ledger 或日志**。

## 2. 工具

| 工具 | 默认 | 说明 |
|------|------|------|
| `node scripts/migrate-db.mjs` | 只读 | 完整性 + 表清单 + `security_migration_audit` ledger + owner/tenant scope-null 审计 + orphan 候选。不写库。 |
| `node scripts/migrate-db.mjs --apply` | 备份后落地 | WAL checkpoint → 备份 → 复用 `initDB()` 落地迁移 → ledger 记 `migrate-db:apply:<ts>` → 只读复检。 |
| `node scripts/audit-db.mjs` | 只读 | 精简版审计报告（表 schema、active reservations、orphan）。 |

环境变量：`DB_PATH`（库路径，默认 `backend/agent_data.db`）、`MIGRATE_BACKUP_DIR`（默认 `backend/backups/`）。

## 3. 操作流程

### 3.1 发布含 schema 变更的新版本（例行）

1. **停服维护窗口**（多写方时尤其需要；WAL 下 cp 快照不一致风险自担）。
2. **变更前备份**：
   ```bash
   cd backend
   node scripts/migrate-db.mjs                 # 只读预检：integrity、ledger、scope-null、orphan
   node scripts/migrate-db.mjs --apply         # checkpoint + 备份到 backups/ + 落地 + ledger + 复检
   ```
   `--apply` 在 checkpoint 显示有活动写入（`busy>0`）时会拒绝，提示先停服；确需带 `-wal/-shm` 快照可加 `--force`（风险自担）。
3. **确认输出**：`ok=true`、`integrity=["ok"]`、`tableCount` 符合预期、`ledgerEntry` 已生成、`backupFiles` 非空（已有库时）。
4. 启动新版本。app 启动再次跑 `initDB()` 幂等路径，重复执行无副作用。
5. 如需要，把备份文件归档到异地（`backups/*.db` 已被 `.gitignore` 的 `*.db` 覆盖，不会误提交）。

### 3.2 首次启用 durable quota / 其它表组

同上执行一次 `--apply`；随后对照 `upload_quota_usage`、`upload_reservations`、`upload_reservation_chunks` 等表确认存在。

### 3.3 事故排查

```bash
node scripts/audit-db.mjs                 # integrity_check + orphan + reservations 快照
node scripts/migrate-db.mjs               # ledger 全量 + scope-null 审计
```
仅报告，不做破坏性清理；`security_migration_audit` 提供已执行迁移的持久留痕。

## 4. 如何新增一条 additive 迁移（代码约定）

1. 在 `backend/src/db/index.js` 的 `initDB()` 或 `ensureScopedSchema()` 内，用幂等原语：
   - 新表：`CREATE TABLE IF NOT EXISTS ...`
   - 新列：`ensureColumn(table, column, definition)`（内部 `ALTER TABLE ... ADD COLUMN`，带存在性检查）
   - 索引：`CREATE INDEX IF NOT EXISTS ...`
   - backfill：`UPDATE ... WHERE 该列 IS NULL / 空串`（只回填可确定归属的数据）
2. 在 `security_migration_audit` 记一条唯一命名（如 `W3.x-Sn`），用 `INSERT OR IGNORE` 保持幂等。
3. 迁移只做 additive；**不要**在请求路径自动备份或改写生产数据。
4. 附带测试：temporary SQLite 覆盖重复执行、restart、数据回填幂等；HTTP/并发契约按 DoD。
5. 执行顺序必须先备份 → integrity/orphan audit → 落地 → 再 integrity/orphan 复检（3.1）。

## 5. Ledger 语义

- 表：`security_migration_audit(id, migration UNIQUE, details, created_at)`。
- 命名约定：波次名（`W3.1-S1` 等）由代码在 `initDB()` 时 `INSERT OR IGNORE`；运维执行的 `--apply` 用唯一时间戳名 `migrate-db:apply:<ts>` 由工具写入。
- `details` 只存元数据（库路径、备份文件、表数、checkpoint 状态），**禁止**写入密钥与用户内容。

## 6. 验收门槛（对应 roadmap DoD）

- [x] 只读 pre-check / 复检均跑 `PRAGMA integrity_check`。
- [x] `--apply` 前自动备份；已有库时 `backupFiles` 非空。
- [x] 重复 `--apply` 幂等（表数不变，ledger 每次 +1 行唯一条目）。
- [x] 未知 orphan 只报告，不删除（`destructiveActions:false` 恒真）。
- [x] 不存在的库无 `--force` 时拒绝（`DB_NOT_FOUND`）。
- [x] 测试：`backend/src/db/migrateDb.test.js`（隔离临时库，CI 可跑）。

## 7. 首次真实生产 `--apply` 执行记录（2026-09-05）

在真实 dev 库 `backend/agent_data.db` 上执行本 runbook §3.1 的例行流程（此前仅在隔离临时库演练）。执行前确认无 3000/5173 写进程（`WAL busy>0` 拒写是第二道闸）。

1. **只读 pre-check**（`node scripts/migrate-db.mjs`）：`ok:true`、`integrity:["ok"]`、`tableCount:21`、`ledger:[W3.1-S1]`、scope-null 全 0、`orphanCandidates:[]`。文件基线：主库 5,324,800 B、`-wal` 4,128,272 B、`-shm` 32,768 B；`backups/` 不存在。
2. **`--apply`**（`node scripts/migrate-db.mjs --apply`）：`ok:true`、`integrity:["ok"]`、`tableCount:21`、`destructiveActions:false`、
   - `backupFiles:["D:\\AgentEvo\\backend\\backups\\agent_data-2026-09-05T15-56-52-057Z.db"]`（5,337,088 B）
   - `ledgerEntry:"migrate-db:apply:2026-09-05T15-56-52-073Z"`
3. **复检**：dry-run ledger 现 2 行（W3.1-S1 + apply 条目）；`-wal` 折叠为 0、主库 5,337,088 B（checkpoint 收尾写入很小——大部分 WAL 帧此前已自动 checkpoint）；`audit-db` `activeReservations:[]`、integrity ok。
4. `git status --short` 无 `backups/` 条目（`*.db*` 已被根 `.gitignore` 覆盖），备份留档不污染工作树。流程即 §3.1 第 2-3 步的实证。

> 备注：本次 `security_migration_audit` 新行 id=3516（该表 AUTOINCREMENT 序列存在更早历史），ledger 内容行数仍为 2 —— 语义按 `migration UNIQUE` 条目计数，不依赖自增 id 连续。
