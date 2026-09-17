import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { evaluateMemoryRetention } from "../services/memoryRetention.js";
import { memoryContractEnabled } from "../services/memoryFlags.js";
import { buildUserMemoryProvenance } from "../services/memoryContract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(process.env.DB_PATH || path.resolve(__dirname, "../../agent_data.db"));

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

let insertUserStmt = null;
let selectUserByUsernameStmt = null;
let selectUserByIdStmt = null;
let insertMessageStmt = null;
let selectHistoryStmt = null;
let selectMessageStatsStmt = null;
let insertSessionStmt = null;
let selectSessionsStmt = null;
let updateSessionTitleStmt = null;
let updateSessionPinStmt = null;
let deleteSessionStmt = null;
let deleteSessionMessagesStmt = null;
let deleteSessionMetricsStmt = null;
let deleteSessionEvalScoresStmt = null;
let deleteSessionEvalFeedbackStmt = null;
let deleteSessionEvalTracesStmt = null;
let deleteSessionMemoryStmt = null;
let touchSessionStmt = null;
let selectSessionOwnerStmt = null;
let insertMessageMetricStmt = null;
let selectSessionByIdStmt = null;
let selectMessageInSessionStmt = null;
let insertBranchMessagesStmt = null;
let updateLegacySessionUserStmt = null;
let selectRecentMetricsStmt = null;
let selectMessageByIdStmt = null;
let deleteMessageByIdStmt = null;
let deleteMessageMetricByMessageIdStmt = null;

// ── Phase 5: 评估系统 prepared statements ──
let insertTraceStmt = null;
let selectTraceByTraceIdStmt = null;
let selectTraceByOwnerStmt = null;
let selectRecentTracesStmt = null;
let insertEvalScoreStmt = null;
let selectScoresByRunIdStmt = null;
let selectScoreTrendsStmt = null;
let selectScoreTrendsByRunStmt = null;
let selectRunIdsStmt = null;
let insertFeedbackStmt = null;
let deleteFeedbackStmt = null;
let selectFeedbackByMessageStmt = null;
let selectFeedbackSummaryStmt = null;

// ── Phase 6: Agent 配置系统 ──
let selectAgentConfigStmt = null;
let selectAllAgentConfigStmt = null;
let upsertAgentConfigStmt = null;
// G5: 版本管理
let insertConfigVersionStmt = null;
let selectConfigVersionsStmt = null;
let selectConfigVersionByIdStmt = null;
let updateConfigVersionLabelStmt = null;
let deleteConfigVersionStmt = null;

// ── Phase 6c G10: 优化闭环流水线 ──
let insertOptimizationLogStmt = null;
let selectOptimizationLogsStmt = null;
let selectOptimizationLogByIdStmt = null;
let updateOptimizationLogStmt = null;

// ── Phase 6b G7: 评测集自动生成 ──
let insertGeneratedTestCaseStmt = null;
let selectGeneratedTestCasesStmt = null;
let selectGeneratedTestCaseByIdStmt = null;
let updateGeneratedTestCaseStmt = null;
let deleteGeneratedTestCaseStmt = null;
let selectGeneratedTestCaseIdsStmt = null;

// W3.1-S1 scoped resource statements
let selectUserTenantStmt = null;
let insertEvalRunStmt = null;
let selectEvalRunStmt = null;
let completeEvalRunStmt = null;
let insertConfigOverrideStmt = null;
let selectConfigOverridesStmt = null;
let selectConfigOverrideStmt = null;
let deleteConfigOverrideStmt = null;
let selectScopedConfigVersionsStmt = null;
let selectScopedConfigVersionByIdStmt = null;
let insertMCPConfigStmt = null;
let selectMCPConfigsStmt = null;
let selectMCPConfigStmt = null;
let deleteMCPConfigStmt = null;
let updateMCPConfigStatusStmt = null;

// W3.3 chat idempotency records
let insertChatIdempotencyStmt = null;
let selectChatIdempotencyStmt = null;
let updateChatIdempotencyStmt = null;
let updateChatIdempotencyResultStmt = null;
let updateChatIdempotencyUserMessageStmt = null;

let defaultUserId = null;

function normalizeScope(scope) {
    if (!scope) return null;
    const userId = Number(scope.userId ?? scope.ownerUserId ?? scope.id);
    const tenantId = String(scope.tenantId || `user:${userId}`);
    if (!Number.isInteger(userId) || userId <= 0 || !tenantId) return null;
    return { userId, tenantId };
}

function requireScope(scope, label = "resource") {
    const normalized = normalizeScope(scope);
    if (!normalized) throw new Error(`${label} ownership is required`);
    return normalized;
}

export function getDatabaseHealth() {
    try {
        const result = db.prepare("PRAGMA quick_check").get();
        return { ok: String(result?.quick_check || "").toLowerCase() === "ok" };
    } catch (error) {
        return { ok: false, errorCode: "DATABASE_UNAVAILABLE" };
    }
}

export function closeDB() {
    if (db.open) db.close();
}

function scopeParams(scope) {
    const normalized = normalizeScope(scope);
    return normalized ? [normalized.userId, normalized.tenantId] : [];
}

function ensureColumn(tableName, columnName, definition) {
    if (!getTableColumns(tableName).some((column) => column.name === columnName)) {
        db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
    }
}

function hasTable(tableName) {
    const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(tableName);
    return Boolean(row);
}

function ensureScopedSchema(defaultUserId) {
    const addColumn = (table, column, definition) => ensureColumn(table, column, definition);
    addColumn("eval_traces", "tenant_id", "TEXT");
    addColumn("eval_scores", "owner_user_id", "INTEGER");
    addColumn("eval_scores", "tenant_id", "TEXT");
    addColumn("eval_feedback", "tenant_id", "TEXT");
    addColumn("eval_test_cases", "owner_user_id", "INTEGER");
    addColumn("eval_test_cases", "tenant_id", "TEXT");
    addColumn("optimization_log", "owner_user_id", "INTEGER");
    addColumn("optimization_log", "tenant_id", "TEXT");
    addColumn("agent_config_versions", "owner_user_id", "INTEGER");
    addColumn("agent_config_versions", "tenant_id", "TEXT");
    addColumn("agent_config_versions", "scope_type", "TEXT NOT NULL DEFAULT 'user'");

    db.prepare("CREATE INDEX IF NOT EXISTS idx_eval_traces_scope ON eval_traces(user_id, tenant_id, created_at)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_eval_scores_scope_run ON eval_scores(owner_user_id, tenant_id, run_id)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_eval_feedback_scope_msg ON eval_feedback(user_id, tenant_id, message_id)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_eval_cases_scope ON eval_test_cases(owner_user_id, tenant_id, category)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_optimization_scope ON optimization_log(owner_user_id, tenant_id, source_run_id)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_config_versions_scope ON agent_config_versions(owner_user_id, tenant_id, created_at)").run();

    db.prepare(`CREATE TABLE IF NOT EXISTS eval_runs (
        run_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        config_version_id INTEGER, status TEXT NOT NULL DEFAULT 'running',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME,
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_eval_runs_scope ON eval_runs(owner_user_id, tenant_id, created_at)").run();

    db.prepare(`CREATE TABLE IF NOT EXISTS agent_config_overrides (
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL, key TEXT NOT NULL,
        value TEXT NOT NULL, description TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_user_id, tenant_id, key), FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_config_overrides_scope ON agent_config_overrides(owner_user_id, tenant_id)").run();

    // M14: content-free, owner-scoped experiment snapshots and manual release
    // decisions. Reports are append-only observations; approvals never mutate
    // AgentConfig and are kept as an audit trail for a later manual change.
    db.prepare(`CREATE TABLE IF NOT EXISTS cross_source_experiment_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        report_key TEXT NOT NULL,
        period_start DATETIME,
        period_end DATETIME,
        experiment_key TEXT,
        config_version_id INTEGER,
        report_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_cross_source_reports_scope ON cross_source_experiment_reports(owner_user_id, tenant_id, created_at)").run();
    db.prepare(`CREATE TABLE IF NOT EXISTS cross_source_experiment_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id INTEGER,
        owner_user_id INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        action TEXT NOT NULL,
        from_config_version_id INTEGER,
        target_config_version_id INTEGER,
        note TEXT,
        actor_user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id),
        FOREIGN KEY (actor_user_id) REFERENCES users(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_cross_source_approvals_scope ON cross_source_experiment_approvals(owner_user_id, tenant_id, created_at)").run();
    db.prepare(`CREATE TABLE IF NOT EXISTS cross_source_experiment_jobs (
        owner_user_id INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        job_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        holder_token TEXT,
        lease_expires_at DATETIME,
        next_run_at DATETIME,
        last_run_at DATETIME,
        last_report_id INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_user_id, tenant_id, job_name),
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_cross_source_jobs_due ON cross_source_experiment_jobs(status, next_run_at, lease_expires_at)").run();

    db.prepare(`CREATE TABLE IF NOT EXISTS mcp_server_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        scope_type TEXT NOT NULL DEFAULT 'user', owner_user_id INTEGER, tenant_id TEXT,
        type TEXT NOT NULL DEFAULT 'user', command TEXT, args TEXT NOT NULL DEFAULT '[]',
        cwd TEXT, env_refs TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
        connection_status TEXT NOT NULL DEFAULT 'disconnected', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_configs_scope_name ON mcp_server_configs(scope_type, owner_user_id, tenant_id, name)").run();

    // MCP observability/evaluation — additive and owner-scoped. These tables
    // intentionally stay separate from eval_scores: protocol availability,
    // tool-call quality, and end-to-end answer quality are different layers.
    db.prepare(`CREATE TABLE IF NOT EXISTS mcp_operation_observations (
        operation_id TEXT PRIMARY KEY,
        owner_user_id INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        request_id TEXT,
        trace_id TEXT,
        span_id TEXT,
        server_name TEXT NOT NULL,
        tool_name TEXT,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        schema_status TEXT NOT NULL DEFAULT 'not_checked',
        subtask_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_mcp_obs_scope_time ON mcp_operation_observations(owner_user_id, tenant_id, created_at)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_mcp_obs_server_tool ON mcp_operation_observations(owner_user_id, tenant_id, server_name, tool_name, created_at)").run();
    db.prepare(`CREATE TABLE IF NOT EXISTS mcp_eval_runs (
        run_id TEXT PRIMARY KEY,
        owner_user_id INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        dataset_version TEXT NOT NULL,
        case_ids_json TEXT NOT NULL DEFAULT '[]',
        config_id TEXT,
        variant TEXT NOT NULL DEFAULT 'fixture',
        status TEXT NOT NULL DEFAULT 'running',
        summary_json TEXT NOT NULL DEFAULT '{}',
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        baseline_run_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_mcp_eval_runs_scope ON mcp_eval_runs(owner_user_id, tenant_id, created_at)").run();
    db.prepare(`CREATE TABLE IF NOT EXISTS mcp_eval_case_results (
        run_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        owner_user_id INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        layer TEXT NOT NULL,
        status TEXT NOT NULL,
        checks_json TEXT NOT NULL DEFAULT '[]',
        failure_class TEXT,
        observation_ids_json TEXT NOT NULL DEFAULT '[]',
        trace_ids_json TEXT NOT NULL DEFAULT '[]',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        sample_json TEXT NOT NULL DEFAULT '{}',
        evidence_summary TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (run_id, case_id),
        FOREIGN KEY (run_id) REFERENCES mcp_eval_runs(run_id),
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_mcp_eval_cases_scope ON mcp_eval_case_results(owner_user_id, tenant_id, created_at)").run();

    db.prepare(`CREATE TABLE IF NOT EXISTS chat_idempotency (
        owner_user_id INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'reserved',
        stream_started INTEGER NOT NULL DEFAULT 0,
        response_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_user_id, tenant_id, idempotency_key),
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    addColumn("chat_idempotency", "attempt_count", "INTEGER NOT NULL DEFAULT 1");
    addColumn("chat_idempotency", "expires_at", "DATETIME");
    addColumn("chat_idempotency", "user_message_id", "INTEGER");
    addColumn("chat_idempotency", "assistant_message_id", "INTEGER");
    addColumn("chat_idempotency", "failure_code", "TEXT");
    addColumn("chat_idempotency", "attempt_token", "TEXT");
    addColumn("chat_idempotency", "lease_expires_at", "DATETIME");
    db.prepare("UPDATE chat_idempotency SET attempt_token = lower(hex(randomblob(16))), lease_expires_at = COALESCE(lease_expires_at, datetime('now', '+15 minutes')) WHERE attempt_token IS NULL AND status IN ('reserved', 'started')").run();
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_idempotency_attempt_token ON chat_idempotency(attempt_token) WHERE attempt_token IS NOT NULL").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_chat_idempotency_updated ON chat_idempotency(owner_user_id, tenant_id, updated_at)").run();

    db.prepare(`CREATE TABLE IF NOT EXISTS upload_quota_usage (
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL, usage_day TEXT NOT NULL,
        committed_bytes INTEGER NOT NULL DEFAULT 0, reserved_bytes INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_user_id, tenant_id, usage_day),
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    db.prepare(`CREATE TABLE IF NOT EXISTS upload_reservations (
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL, upload_key TEXT NOT NULL,
        file_hash TEXT, file_name TEXT, total_chunks INTEGER, status TEXT NOT NULL DEFAULT 'active',
        reserved_bytes INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL, usage_day TEXT NOT NULL DEFAULT '', updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_user_id, tenant_id, upload_key),
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    ensureColumn("upload_reservations", "usage_day", "TEXT NOT NULL DEFAULT ''");
    db.prepare("UPDATE upload_reservations SET usage_day = substr(created_at, 1, 10) WHERE usage_day = '' OR usage_day IS NULL").run();
    db.prepare(`CREATE TABLE IF NOT EXISTS upload_reservation_chunks (
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL, upload_key TEXT NOT NULL,
        chunk_index INTEGER NOT NULL, byte_length INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_user_id, tenant_id, upload_key, chunk_index),
        FOREIGN KEY (owner_user_id, tenant_id, upload_key)
            REFERENCES upload_reservations(owner_user_id, tenant_id, upload_key) ON DELETE CASCADE
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_upload_reservations_expiry ON upload_reservations(status, expires_at)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_upload_reservations_scope ON upload_reservations(owner_user_id, tenant_id, status)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_upload_quota_usage_scope ON upload_quota_usage(owner_user_id, tenant_id, usage_day)").run();

    // W4-R5-S1 — durable same-key cross-process advisory lock (lease table).
    // SQLite serializes short write transactions but the upload merge critical
    // section (chunk assembly + FAISS embed/index + quota settle) is long-running
    // file work, so a single transaction cannot hold mutual exclusion across
    // processes/instances. This table materializes an explicit lease in the same
    // DB the accounting lives in (no external lock service): acquire is an
    // INSERT OR IGNORE on the (owner,tenant,key) PK plus an atomic reclaim of an
    // expired lease; the holder renews while its critical section runs and
    // releases by holder_token on exit. A crashed holder never wedges the key —
    // its lease simply expires and the next acquire reclaims the row.
    db.prepare(`CREATE TABLE IF NOT EXISTS upload_key_locks (
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL, upload_key TEXT NOT NULL,
        holder_token TEXT NOT NULL, acquired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        PRIMARY KEY (owner_user_id, tenant_id, upload_key),
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();

    // ── Phase 7 / R0 — Coding Run 基座：owner-scoped durable records ──
    // 只存服务端判定后的可序列化事实；secret/raw env/provider 原始错/用户全文
    // 一律不入库（入库载荷在 coding/* 写入边界再经 sanitize 白名单剥离）。
    db.prepare(`CREATE TABLE IF NOT EXISTS coding_projects (
        id TEXT PRIMARY KEY,
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'registered',
        trusted INTEGER NOT NULL DEFAULT 0,
        trusted_at DATETIME,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_coding_projects_scope_path ON coding_projects(owner_user_id, tenant_id, root_path)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_coding_projects_scope_status ON coding_projects(owner_user_id, tenant_id, status)").run();

    db.prepare(`CREATE TABLE IF NOT EXISTS coding_runs (
        id TEXT PRIMARY KEY,
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        session_id INTEGER,
        project_id TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        mode TEXT NOT NULL DEFAULT 'observe',
        snapshot_json TEXT NOT NULL DEFAULT '{}',
        event_seq INTEGER NOT NULL DEFAULT 0,
        cancelled INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        completed_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id),
        FOREIGN KEY (project_id) REFERENCES coding_projects(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_coding_runs_scope_created ON coding_runs(owner_user_id, tenant_id, created_at)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_coding_runs_project ON coding_runs(owner_user_id, tenant_id, project_id)").run();

    db.prepare(`CREATE TABLE IF NOT EXISTS coding_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'system',
        action_id TEXT,
        sub_task_id TEXT,
        causation_id TEXT,
        request_id TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (run_id, seq),
        FOREIGN KEY (owner_user_id) REFERENCES users(id),
        FOREIGN KEY (run_id) REFERENCES coding_runs(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_coding_events_run ON coding_events(run_id, seq)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_coding_events_scope_at ON coding_events(owner_user_id, tenant_id, created_at)").run();

    db.prepare(`CREATE TABLE IF NOT EXISTS coding_actions (
        id TEXT PRIMARY KEY,
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        tool TEXT NOT NULL,
        input_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        timeout_ms INTEGER,
        approval_id TEXT,
        output_json TEXT,
        error_code TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (run_id, seq),
        FOREIGN KEY (owner_user_id) REFERENCES users(id),
        FOREIGN KEY (run_id) REFERENCES coding_runs(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_coding_actions_run ON coding_actions(run_id, seq)").run();

    db.prepare(`CREATE TABLE IF NOT EXISTS coding_approvals (
        id TEXT PRIMARY KEY,
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'requested',
        policy TEXT NOT NULL DEFAULT '{}',
        requested_by INTEGER,
        decided_by INTEGER,
        reason TEXT,
        requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        decided_at DATETIME,
        expires_at DATETIME,
        FOREIGN KEY (owner_user_id) REFERENCES users(id),
        FOREIGN KEY (run_id) REFERENCES coding_runs(id),
        FOREIGN KEY (action_id) REFERENCES coding_actions(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_coding_approvals_run ON coding_approvals(run_id, status)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_coding_approvals_scope_at ON coding_approvals(owner_user_id, tenant_id, requested_at)").run();

    db.prepare(`CREATE TABLE IF NOT EXISTS coding_artifacts (
        id TEXT PRIMARY KEY,
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        run_id TEXT,
        action_id TEXT,
        kind TEXT NOT NULL,
        path TEXT,
        digest TEXT,
        size_bytes INTEGER,
        storage_ref TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id),
        FOREIGN KEY (run_id) REFERENCES coding_runs(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_coding_artifacts_scope_run ON coding_artifacts(owner_user_id, tenant_id, run_id)").run();

    // ── Phase 7 / R2 — write-enabled run: preset + worktree identity ──
    // Additive columns on coding_runs. Server-decided facts only: preset is the
    // locked permission level (observe|edit|trusted), base_commit/base_branch
    // identify the point the run's disposable worktree was created from, and
    // worktree_path/branch/status track its lifecycle. `none` = never provisioned,
    // `ready` = git worktree live, `unsupported` = non-git (read-only MVP),
    // `failed`/`removed` = provisioning failed / torn down. All default-off so an
    // un-migrated older binary never reads a wrong shape (NULLs → `none`).
    addColumn("coding_runs", "preset", "TEXT NOT NULL DEFAULT 'observe'");
    addColumn("coding_runs", "worktree_path", "TEXT");
    addColumn("coding_runs", "worktree_branch", "TEXT");
    addColumn("coding_runs", "base_branch", "TEXT");
    addColumn("coding_runs", "base_commit", "TEXT");
    addColumn("coding_runs", "worktree_status", "TEXT NOT NULL DEFAULT 'none'");
    addColumn("coding_runs", "provisioned_at", "DATETIME");

    // ── Phase 7 / R4 — durable knowledge + project memory (additive) ──
    // Durable project code RAG: document rows carry file-hash + revision so a
    // changed file supersedes (marks stale) its prior revision's chunks; chunk
    // rows persist text + symbols + embedding (JSON float array) so the vector
    // index is rebuilt lazily from this same DB after a restart. project_memory
    // separates run working / project episodic / project semantic from the
    // existing user-level agent_memory. knowledge_query_log is append-only
    // telemetry for hit/no-match/groundedness/latency. All rows owner/tenant/
    // project scoped; no secret/provider-raw data crosses the write boundary.
    db.prepare(`CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY,
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        doc_type TEXT NOT NULL DEFAULT 'project_file',
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        revision INTEGER NOT NULL DEFAULT 1,
        revision_of TEXT,
        source_run_id TEXT,
        source_session_id INTEGER,
        source_commit TEXT,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (owner_user_id, tenant_id, project_id, file_path, revision),
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_knowledge_docs_scope_project ON knowledge_documents(owner_user_id, tenant_id, project_id, status)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_knowledge_docs_scope_path ON knowledge_documents(owner_user_id, tenant_id, project_id, file_path, status)").run();

    db.prepare(`CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        content TEXT NOT NULL,
        content_hash TEXT,
        symbols TEXT NOT NULL DEFAULT '',
        token_count INTEGER NOT NULL DEFAULT 0,
        stale INTEGER NOT NULL DEFAULT 0,
        embedding TEXT,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id),
        FOREIGN KEY (document_id) REFERENCES knowledge_documents(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_scope_project ON knowledge_chunks(owner_user_id, tenant_id, project_id, stale)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(document_id, chunk_index)").run();
    // K4 structure-aware document chunks. Existing project-code rows default to
    // leaf/null-compatible values and remain searchable without a rewrite.
    ensureColumn("knowledge_chunks", "chunk_level", "TEXT NOT NULL DEFAULT 'leaf'");
    ensureColumn("knowledge_chunks", "parent_chunk_id", "INTEGER");
    ensureColumn("knowledge_chunks", "page_start", "INTEGER");
    ensureColumn("knowledge_chunks", "page_end", "INTEGER");
    ensureColumn("knowledge_chunks", "heading_path", "TEXT NOT NULL DEFAULT '[]'");
    db.prepare("CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_parent ON knowledge_chunks(document_id, parent_chunk_id, chunk_level)").run();

    // K13 — one durable generation per owner/tenant/project. Readers in other
    // backend processes use this small row to detect an activated revision and
    // rebuild their local vector cache without an in-process notification.
    db.prepare(`CREATE TABLE IF NOT EXISTS knowledge_index_generations (
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_user_id, tenant_id, project_id),
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_knowledge_index_generations_updated ON knowledge_index_generations(updated_at)").run();

    db.prepare(`CREATE TABLE IF NOT EXISTS project_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        run_id TEXT,
        layer TEXT NOT NULL DEFAULT 'episodic',
        content TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.5,
        source_run_id TEXT,
        files_json TEXT NOT NULL DEFAULT '[]',
        commit_ref TEXT,
        invalidated INTEGER NOT NULL DEFAULT 0,
        invalidated_at DATETIME,
        invalidate_reason TEXT,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_project_memory_scope_layer ON project_memory(owner_user_id, tenant_id, project_id, layer, invalidated)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_project_memory_run ON project_memory(owner_user_id, tenant_id, run_id)").run();

    db.prepare(`CREATE TABLE IF NOT EXISTS knowledge_query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        project_id TEXT,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT,
        items INTEGER NOT NULL DEFAULT 0,
        latency_ms REAL NOT NULL DEFAULT 0,
        groundedness REAL,
        lexical_count INTEGER NOT NULL DEFAULT 0,
        embedding_count INTEGER NOT NULL DEFAULT 0,
        fusion_count INTEGER NOT NULL DEFAULT 0,
        rerank_count INTEGER NOT NULL DEFAULT 0,
        rerank_latency_ms REAL NOT NULL DEFAULT 0,
        compression_ratio REAL,
        embedding_calls INTEGER NOT NULL DEFAULT 0,
        embedding_latency_ms REAL NOT NULL DEFAULT 0,
        embedding_error_code TEXT,
        rewrite_applied INTEGER NOT NULL DEFAULT 0,
        rewrite_latency_ms REAL NOT NULL DEFAULT 0,
        rewrite_model TEXT,
        rewrite_calls INTEGER NOT NULL DEFAULT 0,
        rewrite_fallback INTEGER NOT NULL DEFAULT 0,
        rewrite_fallback_code TEXT,
        rewrite_contextual INTEGER NOT NULL DEFAULT 0,
        rewrite_context_used TEXT NOT NULL DEFAULT '[]',
        rewrite_recent_turn_count INTEGER NOT NULL DEFAULT 0,
        rewrite_summary_present INTEGER NOT NULL DEFAULT 0,
        rewrite_working_memory_present INTEGER NOT NULL DEFAULT 0,
        rewrite_context_tokens INTEGER NOT NULL DEFAULT 0,
        rerank_applied INTEGER NOT NULL DEFAULT 0,
        rerank_fallback INTEGER NOT NULL DEFAULT 0,
        rerank_model TEXT,
        rerank_calls INTEGER NOT NULL DEFAULT 0,
        llm_calls INTEGER NOT NULL DEFAULT 0,
        llm_input_tokens INTEGER NOT NULL DEFAULT 0,
        llm_output_tokens INTEGER NOT NULL DEFAULT 0,
        served_mode TEXT,
        fallback_code TEXT,
        vector_backend TEXT,
        vector_search_latency_ms REAL NOT NULL DEFAULT 0,
        vector_index_load_ms REAL NOT NULL DEFAULT 0,
        vector_index_build_ms REAL NOT NULL DEFAULT 0,
        vector_index_generation INTEGER,
        vector_index_chunk_count INTEGER NOT NULL DEFAULT 0,
        faiss_fallback_code TEXT,
        faiss_compare_overlap REAL,
        faiss_compare_score_delta REAL,
        faiss_compare_linear_latency_ms REAL NOT NULL DEFAULT 0,
        faiss_compare_search_latency_ms REAL NOT NULL DEFAULT 0,
        selected_chunk_ids TEXT NOT NULL DEFAULT '[]',
        selected_document_ids TEXT NOT NULL DEFAULT '[]',
        query_preview TEXT NOT NULL DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    addColumn("knowledge_query_log", "lexical_count", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "embedding_count", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "fusion_count", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "rerank_count", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "rerank_latency_ms", "REAL NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "compression_ratio", "REAL");
    addColumn("knowledge_query_log", "embedding_calls", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "embedding_latency_ms", "REAL NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "embedding_error_code", "TEXT");
    addColumn("knowledge_query_log", "rewrite_applied", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "rewrite_latency_ms", "REAL NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "rewrite_model", "TEXT");
    addColumn("knowledge_query_log", "rewrite_calls", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "rewrite_fallback", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "rewrite_fallback_code", "TEXT");
    addColumn("knowledge_query_log", "rewrite_contextual", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "rewrite_context_used", "TEXT NOT NULL DEFAULT '[]'");
    addColumn("knowledge_query_log", "rewrite_recent_turn_count", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "rewrite_summary_present", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "rewrite_working_memory_present", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "rewrite_context_tokens", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "rerank_applied", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "rerank_fallback", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "rerank_model", "TEXT");
    addColumn("knowledge_query_log", "rerank_calls", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "llm_calls", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "llm_input_tokens", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "llm_output_tokens", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "served_mode", "TEXT");
    addColumn("knowledge_query_log", "fallback_code", "TEXT");
    addColumn("knowledge_query_log", "vector_backend", "TEXT");
    addColumn("knowledge_query_log", "vector_search_latency_ms", "REAL NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "vector_index_load_ms", "REAL NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "vector_index_build_ms", "REAL NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "vector_index_generation", "INTEGER");
    addColumn("knowledge_query_log", "vector_index_chunk_count", "INTEGER NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "faiss_fallback_code", "TEXT");
    addColumn("knowledge_query_log", "faiss_compare_overlap", "REAL");
    addColumn("knowledge_query_log", "faiss_compare_score_delta", "REAL");
    addColumn("knowledge_query_log", "faiss_compare_linear_latency_ms", "REAL NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "faiss_compare_search_latency_ms", "REAL NOT NULL DEFAULT 0");
    addColumn("knowledge_query_log", "selected_chunk_ids", "TEXT NOT NULL DEFAULT '[]'");
    addColumn("knowledge_query_log", "selected_document_ids", "TEXT NOT NULL DEFAULT '[]'");
    db.prepare("CREATE INDEX IF NOT EXISTS idx_knowledge_query_log_scope_at ON knowledge_query_log(owner_user_id, tenant_id, created_at)").run();

    // Phase 7 / K2 — asynchronous knowledge ingest jobs. The row stores only
    // lifecycle facts and relative storage keys; provider credentials, signed
    // URLs, raw provider messages, and document正文 never cross this boundary.
    db.prepare(`CREATE TABLE IF NOT EXISTS knowledge_ingest_jobs (
        id TEXT PRIMARY KEY,
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        source_session_id INTEGER,
        project_id TEXT NOT NULL DEFAULT 'uploaded-documents',
        file_name TEXT NOT NULL, storage_key TEXT NOT NULL,
        mime_type TEXT NOT NULL, file_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        parser TEXT NOT NULL DEFAULT 'native', parser_version TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        provider_batch_id TEXT, provider_task_id TEXT, provider_trace_id TEXT,
        progress_current INTEGER NOT NULL DEFAULT 0,
        progress_total INTEGER NOT NULL DEFAULT 0,
        progress_unit TEXT NOT NULL DEFAULT 'stage',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_attempt_at DATETIME,
        lease_token TEXT, lease_expires_at DATETIME,
        document_id TEXT, error_code TEXT, retryable INTEGER NOT NULL DEFAULT 0,
        options_json TEXT NOT NULL DEFAULT '{}',
        result_meta_json TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME, finished_at DATETIME,
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    ensureColumn("knowledge_ingest_jobs", "heartbeat_at", "DATETIME");
    ensureColumn("knowledge_ingest_jobs", "failure_count", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("knowledge_ingest_jobs", "reclaim_count", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("knowledge_ingest_jobs", "last_backoff_seconds", "INTEGER NOT NULL DEFAULT 0");
    db.prepare("CREATE INDEX IF NOT EXISTS idx_ingest_jobs_scope_status ON knowledge_ingest_jobs(owner_user_id, tenant_id, status, created_at)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_ingest_jobs_due ON knowledge_ingest_jobs(status, next_attempt_at, lease_expires_at)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_ingest_jobs_hash ON knowledge_ingest_jobs(owner_user_id, tenant_id, file_hash, parser, status)").run();

    // ── Phase 7 / R6 — offline coding benchmark runs (additive) ──
    // One row per benchmark execution of a fixed-revision scenario. It records the
    // scenario + repo HEAD (deterministic seed revision), the driver kind
    // (scripted | real), the coding-run/project/config linkage, and server-derived
    // metrics/reward summaries. Payload JSON is sanitized at the boundary; consent
    // (owner opt-in) gates trajectory/dataset export. No data rewrite, no legacy
    // table touched.
    db.prepare(`CREATE TABLE IF NOT EXISTS bench_runs (
        id TEXT PRIMARY KEY,
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        category TEXT NOT NULL,
        driver TEXT NOT NULL DEFAULT 'scripted',
        mode TEXT NOT NULL DEFAULT 'observe',
        status TEXT NOT NULL DEFAULT 'running',
        repo_head_sha TEXT,
        project_id TEXT,
        coding_run_id TEXT,
        config_version_id TEXT,
        seed_revision TEXT NOT NULL DEFAULT '1',
        consent INTEGER NOT NULL DEFAULT 0,
        metrics_json TEXT NOT NULL DEFAULT '{}',
        reward_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        error_code TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_bench_runs_scope_created ON bench_runs(owner_user_id, tenant_id, created_at)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_bench_runs_scope_scenario ON bench_runs(owner_user_id, tenant_id, scenario_id, status)").run();

    // One raw (sanitized) canonical record per completed bench run — the owner-
    // consented source for trajectory/dataset export. Kept separate from bench_runs
    // so listing stays light; export is gated by bench_runs.consent.
    db.prepare(`CREATE TABLE IF NOT EXISTS bench_run_raws (
        run_id TEXT PRIMARY KEY,
        owner_user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )`).run();

    const seedPath = path.resolve(__dirname, "../mcp/servers.json");
    try {
        const seeds = JSON.parse(fs.readFileSync(seedPath, "utf8")).servers || [];
        const insertSeed = db.prepare(`INSERT OR IGNORE INTO mcp_server_configs
            (name, scope_type, type, command, args, cwd, env_refs, enabled, connection_status)
            VALUES (?, 'system', ?, ?, ?, ?, ?, ?, 'disconnected')`);
        for (const seed of seeds) {
            insertSeed.run(
                String(seed.name || ""), String(seed.type || "mcp"),
                seed.command ? String(seed.command) : null,
                JSON.stringify(Array.isArray(seed.args) ? seed.args : []),
                seed.cwd ? String(seed.cwd) : null,
                JSON.stringify(seed.env && typeof seed.env === "object" ? seed.env : {}),
                seed.enabled === false ? 0 : 1
            );
        }
    } catch { /* optional system seed file */ }

    // Import system seeds without exposing or persisting resolved secrets.
    // Existing records are left untouched so repeated startup is idempotent.
    const migrationAudit = db.prepare(`CREATE TABLE IF NOT EXISTS security_migration_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        migration TEXT NOT NULL UNIQUE,
        details TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    migrationAudit.run();
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("W3.1-S1", JSON.stringify({ defaultUserId, policy: "unattributed legacy rows are not exposed by scoped queries" }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("W4-R5-S1", JSON.stringify({ policy: "additive advisory-lock table upload_key_locks (durable same-key cross-process upload lock); no data rewrite" }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("R0-CODING-1", JSON.stringify({ policy: "additive owner-scoped coding_projects/runs/events/actions/approvals/artifacts; no legacy rewrite; secrets/provider errors never persisted", tables: 6 }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("R2-CODING-1", JSON.stringify({ policy: "additive coding_runs preset + worktree identity columns; no data rewrite", columns: ["preset", "worktree_path", "worktree_branch", "base_branch", "base_commit", "worktree_status", "provisioned_at"] }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("R4-KNOWLEDGE-1", JSON.stringify({ policy: "additive owner/tenant/project-scoped knowledge_documents/knowledge_chunks/project_memory/knowledge_query_log; file-hash revisions supersede old chunks (stale); durable vectors persisted as chunk embedding JSON in the same DB for restart rebuild; no legacy rewrite", tables: 4 }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("RAG-KB-V2-1", JSON.stringify({ policy: "additive owner/tenant-scoped asynchronous knowledge ingest jobs; SQLite lease reclaim after expiry; no provider secrets, signed URLs, raw provider messages, or document正文 in rows", table: "knowledge_ingest_jobs" }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("RAG-KB-V2-2", JSON.stringify({ policy: "additive structure-aware parent/leaf chunk metadata; staged document revision activation keeps prior active revision readable until indexing completes", columns: ["chunk_level", "parent_chunk_id", "page_start", "page_end", "heading_path"] }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("RAG-KB-V2-3", JSON.stringify({ policy: "additive owner-scoped retrieval quality telemetry; IDs/counts/latency only, never正文/token/provider raw errors", table: "knowledge_query_log", columns: ["lexical_count", "embedding_count", "fusion_count", "rerank_count", "rerank_latency_ms", "compression_ratio", "embedding_calls", "served_mode", "fallback_code", "selected_chunk_ids", "selected_document_ids"] }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("RAG-KB-V2-4", JSON.stringify({ policy: "additive owner-scoped LLM retrieval telemetry; aliases/counts/latency/token counts only, never prompt/body/provider raw", table: "knowledge_query_log", columns: ["rewrite_applied", "rewrite_latency_ms", "rewrite_model", "rerank_applied", "rerank_fallback", "rerank_model", "llm_calls", "llm_input_tokens", "llm_output_tokens"] }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("RAG-KB-V2-5", JSON.stringify({ policy: "additive per-stage retrieval telemetry; statuses/call counts/latencies/fallback codes only, never prompt/body/provider raw", table: "knowledge_query_log", columns: ["embedding_latency_ms", "embedding_error_code", "rewrite_calls", "rewrite_fallback", "rewrite_fallback_code", "rerank_calls"] }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("RAG-KB-CONTEXT-REWRITE-1", JSON.stringify({ policy: "additive contextual rewrite diagnostics; source names/counts/token budgets only, never history/summary/working-memory content", table: "knowledge_query_log", columns: ["rewrite_contextual", "rewrite_context_used", "rewrite_recent_turn_count", "rewrite_summary_present", "rewrite_working_memory_present", "rewrite_context_tokens"] }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("RAG-KB-K13-1", JSON.stringify({ policy: "additive owner/tenant/project index generation plus ingest heartbeat/failure/reclaim/backoff counters; SQLite is single-host multi-process candidate only", tables: ["knowledge_index_generations"], columns: ["heartbeat_at", "failure_count", "reclaim_count", "last_backoff_seconds"] }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("RAG-KB-FAISS-1", JSON.stringify({ policy: "additive owner/tenant/project FAISS telemetry only; SQLite embeddings remain the source of truth; IndexFlatIP derived files are rebuildable and never contain document text/query/token/provider/path data", table: "knowledge_query_log", columns: ["vector_backend", "vector_search_latency_ms", "vector_index_load_ms", "vector_index_build_ms", "vector_index_generation", "vector_index_chunk_count", "faiss_fallback_code", "faiss_compare_overlap", "faiss_compare_score_delta", "faiss_compare_linear_latency_ms", "faiss_compare_search_latency_ms"] }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("R6-BENCH-1", JSON.stringify({ policy: "additive owner-scoped bench_runs (offline coding benchmark results: scenario/head/driver/linkage + sanitized metrics/reward/result); consent gates export; no legacy rewrite", table: "bench_runs" }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("R6-BENCH-2", JSON.stringify({ policy: "additive bench_run_raws (sanitized canonical raw per bench run, owner-consented source for trajectory/dataset export); no legacy rewrite", table: "bench_run_raws" }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("MEMORY-M3-1", JSON.stringify({ policy: "additive trusted-memory category and relation provenance; no legacy rewrite", columns: ["category", "relation_type", "related_memory_id"] }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("MEMORY-M14-1", JSON.stringify({ policy: "additive owner-scoped cross-source experiment reports and manual approval audit; content-free aggregates only; no legacy rewrite", tables: ["cross_source_experiment_reports", "cross_source_experiment_approvals"] }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("MEMORY-M15-1", JSON.stringify({ policy: "additive owner-scoped cross-source sampler lease; expired leases are reclaimable; no legacy rewrite", table: "cross_source_experiment_jobs" }));
    db.prepare(`INSERT OR IGNORE INTO security_migration_audit (migration, details) VALUES (?, ?)`)
        .run("MEMORY-WORKING-1", JSON.stringify({ policy: "additive session-scoped working-memory expiry; fixed-key upsert and soft invalidation; no legacy rewrite", column: "agent_memory.expires_at" }));

}

function getTableColumns(tableName) {
    if (!hasTable(tableName)) {
        return [];
    }

    return db.prepare(`PRAGMA table_info(${tableName})`).all();
}

function ensureSessionColumns() {
    const columns = getTableColumns("sessions");
    const hasUpdatedAt = columns.some((column) => column.name === "updated_at");
    const hasPinned = columns.some((column) => column.name === "pinned");
    const hasPinnedAt = columns.some((column) => column.name === "pinned_at");
    const hasUserId = columns.some((column) => column.name === "user_id");

    if (!hasUpdatedAt) {
        db.prepare("ALTER TABLE sessions ADD COLUMN updated_at DATETIME").run();
    }

    if (!hasPinned) {
        db.prepare("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0").run();
    }

    if (!hasPinnedAt) {
        db.prepare("ALTER TABLE sessions ADD COLUMN pinned_at DATETIME").run();
    }

    if (!hasUserId) {
        db.prepare("ALTER TABLE sessions ADD COLUMN user_id INTEGER").run();
    }

    db.prepare(
        "UPDATE sessions SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)"
    ).run();

    db.prepare("UPDATE sessions SET pinned = COALESCE(pinned, 0)").run();
}

function ensureMessageColumns(fallbackUserId) {
    const columns = getTableColumns("messages");
    const hasSessionId = columns.some((column) => column.name === "session_id");

    if (hasSessionId) {
        return;
    }

    const defaultSession = db
        .prepare("SELECT id FROM sessions ORDER BY id ASC LIMIT 1")
        .get();

    let fallbackSessionId = defaultSession?.id;
    if (!fallbackSessionId) {
        const insertResult = db
            .prepare("INSERT INTO sessions (title, updated_at) VALUES (?, CURRENT_TIMESTAMP)")
            .run("历史会话");
        fallbackSessionId = Number(insertResult.lastInsertRowid);
    }

    db.prepare("ALTER TABLE messages ADD COLUMN session_id INTEGER").run();
    db.prepare("UPDATE messages SET session_id = ? WHERE session_id IS NULL").run(fallbackSessionId);

    if (fallbackUserId) {
        db.prepare("UPDATE sessions SET user_id = ? WHERE user_id IS NULL").run(fallbackUserId);
    }
}

function ensureDefaultUser() {
    const defaultUsername = String(process.env.DEMO_USER || "demo").trim() || "demo";
    const defaultPasswordHash = String(process.env.DEMO_PASSWORD_HASH || "demo:change-me");

    const existing = db
        .prepare("SELECT id FROM users WHERE username = ?")
        .get(defaultUsername);

    if (existing?.id) {
        defaultUserId = Number(existing.id);
        return defaultUserId;
    }

    const insertResult = db
        .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
        .run(defaultUsername, defaultPasswordHash);

    defaultUserId = Number(insertResult.lastInsertRowid);
    return defaultUserId;
}

export function initDB() {
    db.prepare(
        `
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
    ).run();

    db.prepare(
        `
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        title TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                pinned INTEGER NOT NULL DEFAULT 0,
                pinned_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `
    ).run();

    ensureSessionColumns();

    const ensuredDefaultUserId = ensureDefaultUser();
    ensureColumn("users", "tenant_id", "TEXT");
    db.prepare("UPDATE users SET tenant_id = ? || id WHERE tenant_id IS NULL OR TRIM(tenant_id) = ''").run("user:");

    updateLegacySessionUserStmt = db.prepare(
        "UPDATE sessions SET user_id = ? WHERE user_id IS NULL"
    );
    updateLegacySessionUserStmt.run(ensuredDefaultUserId);

    db.prepare(
        `
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )
    `
    ).run();

    ensureMessageColumns(ensuredDefaultUserId);

    db.prepare(
        `
            CREATE TABLE IF NOT EXISTS message_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER NOT NULL UNIQUE,
                latency_ms INTEGER,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                total_tokens INTEGER,
                model TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (message_id) REFERENCES messages(id)
            )
        `
    ).run();

    db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)`
    ).run();

    // ── Phase 4: 记忆系统 ──
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS agent_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            session_id INTEGER,
            content TEXT NOT NULL,
            memory_type TEXT NOT NULL DEFAULT 'working',
            importance REAL NOT NULL DEFAULT 0.5,
            metadata TEXT DEFAULT '{}',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        )
        `
    ).run();

    // Phase 4 / trusted memory lifecycle — additive migration. Existing rows
    // are active by default so enabling the new reader does not erase the
    // behavior users already rely on.
    ensureColumn("agent_memory", "status", "TEXT NOT NULL DEFAULT 'active'");
    ensureColumn("agent_memory", "source", "TEXT NOT NULL DEFAULT 'manual'");
    ensureColumn("agent_memory", "confidence", "REAL NOT NULL DEFAULT 1.0");
    ensureColumn("agent_memory", "memory_key", "TEXT");
    ensureColumn("agent_memory", "supersedes_id", "INTEGER");
    ensureColumn("agent_memory", "superseded_by", "INTEGER");
    ensureColumn("agent_memory", "invalidated_at", "DATETIME");
    ensureColumn("agent_memory", "invalidate_reason", "TEXT");
    ensureColumn("agent_memory", "pinned", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("agent_memory", "last_recalled_at", "DATETIME");
    ensureColumn("agent_memory", "recall_count", "INTEGER NOT NULL DEFAULT 0");
    // Trusted memory M3 — relation semantics remain additive. Old rows are
    // independent/uncategorized until they are edited or re-observed.
    ensureColumn("agent_memory", "category", "TEXT NOT NULL DEFAULT 'uncategorized'");
    ensureColumn("agent_memory", "relation_type", "TEXT NOT NULL DEFAULT 'independent'");
    ensureColumn("agent_memory", "related_memory_id", "INTEGER");
    // Optional user-memory vector recall. Vectors remain physically isolated
    // from project knowledge_chunks and are only used for active user memory.
    ensureColumn("agent_memory", "embedding", "TEXT");
    ensureColumn("agent_memory", "embedding_model", "TEXT");
    ensureColumn("agent_memory", "embedding_source_hash", "TEXT");
    ensureColumn("agent_memory", "embedding_updated_at", "DATETIME");
    // Working-memory V1 uses the existing agent_memory table. The expiry is
    // additive so active working snapshots can be filtered without trusting a
    // JSON metadata field or physically deleting history.
    ensureColumn("agent_memory", "expires_at", "DATETIME");
    db.prepare("UPDATE agent_memory SET status = 'active' WHERE status IS NULL OR TRIM(status) = ''").run();
    db.prepare("UPDATE agent_memory SET source = 'manual' WHERE source IS NULL OR TRIM(source) = ''").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_memory_lifecycle ON agent_memory(user_id, status, memory_type)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_memory_key ON agent_memory(user_id, memory_key, status)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_memory_relation ON agent_memory(user_id, related_memory_id, relation_type)").run();
    db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_agent_memory_user_id ON agent_memory(user_id)`
    ).run();
    db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_agent_memory_type ON agent_memory(memory_type)`
    ).run();
    db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_agent_memory_session ON agent_memory(session_id)`
    ).run();
    db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_agent_memory_working_scope
         ON agent_memory(user_id, session_id, memory_type, memory_key, status, expires_at)`
    ).run();

    // ── Phase 5: 评估系统 ──

    // 1. 结构化 Trace 存储
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS eval_traces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            session_id INTEGER NOT NULL,
            message_id INTEGER,
            trace_id TEXT NOT NULL UNIQUE,
            parent_trace_id TEXT,
            trace_type TEXT NOT NULL DEFAULT 'chat',
            root_span TEXT NOT NULL DEFAULT '{}',
            agent_traversal_path TEXT DEFAULT '[]',
            tool_call_count INTEGER DEFAULT 0,
            error_count INTEGER DEFAULT 0,
            total_latency_ms INTEGER,
            model TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (session_id) REFERENCES sessions(id),
            FOREIGN KEY (message_id) REFERENCES messages(id)
        )
        `
    ).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_eval_traces_user ON eval_traces(user_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_eval_traces_session ON eval_traces(session_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_eval_traces_type ON eval_traces(trace_type)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_eval_traces_created ON eval_traces(created_at)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_eval_traces_msg ON eval_traces(message_id)`).run();

    // 2. 评估分数存储
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS eval_scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trace_id TEXT,
            message_id INTEGER,
            test_case_id TEXT,
            run_id TEXT,
            dimension TEXT NOT NULL,
            score REAL NOT NULL,
            judge_rationale TEXT,
            judge_model TEXT,
            score_type TEXT NOT NULL DEFAULT 'offline',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (trace_id) REFERENCES eval_traces(trace_id),
            FOREIGN KEY (message_id) REFERENCES messages(id)
        )
        `
    ).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_eval_scores_run ON eval_scores(run_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_eval_scores_msg ON eval_scores(message_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_eval_scores_type ON eval_scores(score_type)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_eval_scores_dim ON eval_scores(dimension)`).run();

    // 3. 用户反馈
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS eval_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            message_id INTEGER NOT NULL,
            rating TEXT NOT NULL,
            comment TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (message_id) REFERENCES messages(id),
            UNIQUE(user_id, message_id)
        )
        `
    ).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_eval_feedback_msg ON eval_feedback(message_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_eval_feedback_user ON eval_feedback(user_id)`).run();

    // ── Phase 6: Agent 配置存储 ──
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS agent_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            default_value TEXT,
            description TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        `
    ).run();

    // ── Phase 6b G5: Agent 配置版本历史 ──
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS agent_config_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            label TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        `
    ).run();

    // 迁移：为已有表补加 label 列（G5 版本重命名功能）
    try {
        db.prepare(`ALTER TABLE agent_config_versions ADD COLUMN label TEXT`).run();
    } catch {
        // 列已存在，忽略
    }

    // ── Phase 6b G7: 评测集自动生成 ──
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS eval_test_cases (
            id TEXT PRIMARY KEY,
            category TEXT NOT NULL,
            difficulty TEXT NOT NULL DEFAULT 'medium',
            description TEXT,
            input TEXT NOT NULL,
            expected_behavior TEXT,
            expected_tools TEXT DEFAULT '[]',
            enable_web_search INTEGER DEFAULT 0,
            code_checks TEXT,
            generated INTEGER DEFAULT 1,
            reviewed INTEGER DEFAULT 0,
            source_seeds TEXT DEFAULT '[]',
            gen_batch_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        `
    ).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_eval_test_cases_cat ON eval_test_cases(category)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_eval_test_cases_reviewed ON eval_test_cases(reviewed)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_eval_test_cases_batch ON eval_test_cases(gen_batch_id)`).run();

    // ── Phase 6c G10: 优化闭环日志 ──
    db.prepare(
        `
        CREATE TABLE IF NOT EXISTS optimization_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_run_id TEXT NOT NULL,
            target_run_id TEXT,
            config_version_id INTEGER,
            label TEXT,
            bad_case_ids TEXT NOT NULL DEFAULT '[]',
            changes TEXT NOT NULL DEFAULT '[]',
            suggestions TEXT NOT NULL DEFAULT '[]',
            score_before TEXT,
            score_after TEXT,
            status TEXT NOT NULL DEFAULT 'applied',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        `
    ).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_optimization_log_run ON optimization_log(source_run_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_optimization_log_status ON optimization_log(status)`).run();

    // Backfill scope columns after all legacy tables exist.
    ensureScopedSchema(ensuredDefaultUserId);
    // Legacy rows remain quarantined (NULL owner/tenant) until an explicit audit.

    // G10: optimization_log prepared statements
    if (!insertOptimizationLogStmt) {
        insertOptimizationLogStmt = db.prepare(
            `INSERT INTO optimization_log
                (source_run_id, target_run_id, config_version_id, label, bad_case_ids,
                 changes, suggestions, score_before, score_after, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
    }

    if (!insertMessageStmt) {
        insertMessageStmt = db.prepare(
            "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)"
        );
    }

    if (!insertUserStmt) {
        insertUserStmt = db.prepare(
            "INSERT INTO users (username, password_hash) VALUES (?, ?)"
        );
    }

    if (!selectUserByUsernameStmt) {
        selectUserByUsernameStmt = db.prepare(
            "SELECT id, username, password_hash, tenant_id, created_at FROM users WHERE username = ?"
        );
    }

    if (!selectUserByIdStmt) {
        selectUserByIdStmt = db.prepare(
            "SELECT id, username, tenant_id, created_at FROM users WHERE id = ?"
        );
    }

    if (!selectUserTenantStmt) {
        selectUserTenantStmt = db.prepare("SELECT id, tenant_id FROM users WHERE id = ?");
    }
    if (!insertEvalRunStmt) {
        insertEvalRunStmt = db.prepare(`INSERT INTO eval_runs (run_id, owner_user_id, tenant_id, config_version_id, status) VALUES (?, ?, ?, ?, ?)`);
    }
    if (!selectEvalRunStmt) {
        selectEvalRunStmt = db.prepare("SELECT * FROM eval_runs WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ?");
    }
    if (!completeEvalRunStmt) {
        completeEvalRunStmt = db.prepare("UPDATE eval_runs SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ?");
    }
    if (!insertConfigOverrideStmt) {
        insertConfigOverrideStmt = db.prepare(`INSERT INTO agent_config_overrides (owner_user_id, tenant_id, key, value, description, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(owner_user_id, tenant_id, key) DO UPDATE SET value = excluded.value, description = COALESCE(excluded.description, agent_config_overrides.description), updated_at = CURRENT_TIMESTAMP`);
    }
    if (!selectConfigOverridesStmt) {
        selectConfigOverridesStmt = db.prepare("SELECT key, value, description, updated_at FROM agent_config_overrides WHERE owner_user_id = ? AND tenant_id = ? ORDER BY key");
    }
    if (!selectConfigOverrideStmt) {
        selectConfigOverrideStmt = db.prepare("SELECT key, value, description, updated_at FROM agent_config_overrides WHERE owner_user_id = ? AND tenant_id = ? AND key = ?");
    }
    if (!deleteConfigOverrideStmt) {
        deleteConfigOverrideStmt = db.prepare("DELETE FROM agent_config_overrides WHERE owner_user_id = ? AND tenant_id = ? AND key = ?");
    }
    if (!selectScopedConfigVersionsStmt) {
        selectScopedConfigVersionsStmt = db.prepare("SELECT id, source, label, created_at FROM agent_config_versions WHERE owner_user_id = ? AND tenant_id = ? ORDER BY id DESC LIMIT ?");
    }
    if (!selectScopedConfigVersionByIdStmt) {
        selectScopedConfigVersionByIdStmt = db.prepare("SELECT id, snapshot, source, label, created_at FROM agent_config_versions WHERE id = ? AND owner_user_id = ? AND tenant_id = ?");
    }
    if (!insertMCPConfigStmt) {
        insertMCPConfigStmt = db.prepare(`INSERT INTO mcp_server_configs (name, scope_type, owner_user_id, tenant_id, type, command, args, cwd, env_refs, enabled, connection_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    }
    if (!selectMCPConfigsStmt) {
        selectMCPConfigsStmt = db.prepare("SELECT * FROM mcp_server_configs WHERE (scope_type = 'system' OR (owner_user_id = ? AND tenant_id = ?)) ORDER BY scope_type, name");
    }
    if (!selectMCPConfigStmt) {
        selectMCPConfigStmt = db.prepare("SELECT * FROM mcp_server_configs WHERE name = ? AND ((scope_type = 'system') OR (owner_user_id = ? AND tenant_id = ?)) LIMIT 1");
    }
    if (!deleteMCPConfigStmt) {
        deleteMCPConfigStmt = db.prepare("DELETE FROM mcp_server_configs WHERE id = ? AND scope_type = 'user' AND owner_user_id = ? AND tenant_id = ?");
    }
    if (!updateMCPConfigStatusStmt) {
        updateMCPConfigStatusStmt = db.prepare("UPDATE mcp_server_configs SET enabled = ?, connection_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND ((scope_type = 'system') OR (owner_user_id = ? AND tenant_id = ?))");
    }
    if (!insertChatIdempotencyStmt) {
        insertChatIdempotencyStmt = db.prepare(`INSERT INTO chat_idempotency
            (owner_user_id, tenant_id, idempotency_key, request_hash, status, attempt_token, lease_expires_at)
            VALUES (?, ?, ?, ?, 'reserved', ?, datetime('now', '+15 minutes'))`);
    }
    if (!selectChatIdempotencyStmt) {
        selectChatIdempotencyStmt = db.prepare(`SELECT * FROM chat_idempotency
            WHERE owner_user_id = ? AND tenant_id = ? AND idempotency_key = ?`);
    }
    if (!updateChatIdempotencyStmt) {
        updateChatIdempotencyStmt = db.prepare(`UPDATE chat_idempotency SET
            status = ?, stream_started = ?, response_json = ?, updated_at = CURRENT_TIMESTAMP
            WHERE owner_user_id = ? AND tenant_id = ? AND idempotency_key = ? AND attempt_token = ?`);
    }
    if (!updateChatIdempotencyResultStmt) {
        updateChatIdempotencyResultStmt = db.prepare(`UPDATE chat_idempotency SET
            status = ?, stream_started = ?, response_json = ?, assistant_message_id = ?, failure_code = ?, expires_at = datetime('now', '+15 minutes'), updated_at = CURRENT_TIMESTAMP
            WHERE owner_user_id = ? AND tenant_id = ? AND idempotency_key = ? AND attempt_token = ? AND status = 'started'`);
    }
    if (!updateChatIdempotencyUserMessageStmt) {
        updateChatIdempotencyUserMessageStmt = db.prepare(`UPDATE chat_idempotency SET
            user_message_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE owner_user_id = ? AND tenant_id = ? AND idempotency_key = ?
              AND (? IS NULL OR attempt_token = ?)`);
    }

    if (!touchSessionStmt) {
        touchSessionStmt = db.prepare(
            "UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        );
    }

    if (!selectHistoryStmt) {
        selectHistoryStmt = db.prepare(
            `
            SELECT
                m.id,
                m.role,
                m.content,
                m.created_at,
                mm.latency_ms,
                mm.prompt_tokens,
                mm.completion_tokens,
                mm.total_tokens,
                mm.model,
                mm.created_at AS metric_created_at
            FROM messages m
            JOIN sessions s ON s.id = m.session_id
            LEFT JOIN message_metrics mm ON mm.message_id = m.id
            WHERE m.session_id = ? AND s.user_id = ?
            ORDER BY m.id DESC
            LIMIT ?
            `
        );
    }

    if (!insertSessionStmt) {
        insertSessionStmt = db.prepare(
            "INSERT INTO sessions (user_id, title) VALUES (?, ?)"
        );
    }

    if (!selectSessionsStmt) {
        selectSessionsStmt = db.prepare(
            "SELECT id, user_id, title, created_at, updated_at, pinned, pinned_at FROM sessions WHERE user_id = ? ORDER BY pinned DESC, pinned_at DESC, updated_at DESC, id DESC"
        );
    }

    if (!selectSessionByIdStmt) {
        selectSessionByIdStmt = db.prepare(
            "SELECT id, user_id, title, created_at, updated_at, pinned, pinned_at FROM sessions WHERE id = ? AND user_id = ?"
        );
    }

    if (!updateSessionTitleStmt) {
        updateSessionTitleStmt = db.prepare(
            "UPDATE sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
        );
    }

    if (!updateSessionPinStmt) {
        updateSessionPinStmt = db.prepare(
            "UPDATE sessions SET pinned = ?, pinned_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
        );
    }

    if (!deleteSessionMessagesStmt) {
        deleteSessionMessagesStmt = db.prepare(
            "DELETE FROM messages WHERE session_id = ?"
        );
    }

    if (!deleteSessionMetricsStmt) {
        deleteSessionMetricsStmt = db.prepare(
            `
            DELETE FROM message_metrics
            WHERE message_id IN (
                SELECT id FROM messages WHERE session_id = ?
            )
            `
        );
    }

    if (!deleteSessionStmt) {
        deleteSessionStmt = db.prepare(
            "DELETE FROM sessions WHERE id = ? AND user_id = ?"
        );
    }

    // Phase 5: cascade cleanup for session deletion (FK dependencies)
    if (!deleteSessionEvalScoresStmt) {
        deleteSessionEvalScoresStmt = db.prepare(
            `DELETE FROM eval_scores
            WHERE message_id IN (
                SELECT id FROM messages WHERE session_id = ?
            )`
        );
    }

    if (!deleteSessionEvalFeedbackStmt) {
        deleteSessionEvalFeedbackStmt = db.prepare(
            `DELETE FROM eval_feedback
            WHERE message_id IN (
                SELECT id FROM messages WHERE session_id = ?
            )`
        );
    }

    if (!deleteSessionEvalTracesStmt) {
        deleteSessionEvalTracesStmt = db.prepare(
            "DELETE FROM eval_traces WHERE session_id = ?"
        );
    }

    if (!deleteSessionMemoryStmt) {
        deleteSessionMemoryStmt = db.prepare(
            "DELETE FROM agent_memory WHERE session_id = ?"
        );
    }

    if (!selectSessionOwnerStmt) {
        selectSessionOwnerStmt = db.prepare(
            "SELECT id, user_id FROM sessions WHERE id = ?"
        );
    }

    if (!selectMessageInSessionStmt) {
        selectMessageInSessionStmt = db.prepare(
            "SELECT id, session_id, role, content FROM messages WHERE id = ? AND session_id = ?"
        );
    }

    if (!selectMessageByIdStmt) {
        selectMessageByIdStmt = db.prepare(
            "SELECT id, session_id, role, content FROM messages WHERE id = ?"
        );
    }

    if (!deleteMessageByIdStmt) {
        deleteMessageByIdStmt = db.prepare(
            "DELETE FROM messages WHERE id = ?"
        );
    }

    if (!deleteMessageMetricByMessageIdStmt) {
        deleteMessageMetricByMessageIdStmt = db.prepare(
            "DELETE FROM message_metrics WHERE message_id = ?"
        );
    }

    if (!insertBranchMessagesStmt) {
        insertBranchMessagesStmt = db.prepare(
            `
            INSERT INTO messages (session_id, role, content, created_at)
            SELECT
                ?,
                role,
                CASE
                    WHEN id = ? AND role = 'user' AND ? IS NOT NULL AND TRIM(?) <> '' THEN ?
                    ELSE content
                END,
                created_at
            FROM messages
            WHERE session_id = ? AND id <= ?
            ORDER BY id ASC
            `
        );
    }

    if (!insertMessageMetricStmt) {
        insertMessageMetricStmt = db.prepare(
            `
            INSERT INTO message_metrics (message_id, latency_ms, prompt_tokens, completion_tokens, total_tokens, model)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(message_id) DO UPDATE SET
                latency_ms = excluded.latency_ms,
                prompt_tokens = excluded.prompt_tokens,
                completion_tokens = excluded.completion_tokens,
                total_tokens = excluded.total_tokens,
                model = excluded.model
            `
        );
    }

    if (!selectMessageStatsStmt) {
        selectMessageStatsStmt = db.prepare(
            `
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_count,
                SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistant_count
            FROM messages m
            JOIN sessions s ON s.id = m.session_id
            WHERE s.user_id = ?
            `
        );
    }

    if (!selectRecentMetricsStmt) {
        selectRecentMetricsStmt = db.prepare(
            `
            SELECT
                mm.message_id,
                mm.latency_ms,
                mm.prompt_tokens,
                mm.completion_tokens,
                mm.total_tokens,
                mm.model,
                mm.created_at,
                m.session_id,
                m.content
            FROM message_metrics mm
            JOIN messages m ON m.id = mm.message_id
            JOIN sessions s ON s.id = m.session_id
            WHERE s.user_id = ?
            ORDER BY mm.id DESC
            LIMIT ?
            `
        );
    }
}

function normalizeHistoryRows(rows) {
    return rows.map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        created_at: row.created_at,
        metrics: row.total_tokens != null
            ? {
                latency_ms: row.latency_ms,
                prompt_tokens: row.prompt_tokens,
                completion_tokens: row.completion_tokens,
                total_tokens: row.total_tokens,
                model: row.model,
                created_at: row.metric_created_at,
            }
            : null,
    }));
}

export function createUser(username, passwordHash) {
    if (!insertUserStmt) {
        initDB();
    }

    const safeUsername = String(username || "").trim();
    const safePasswordHash = String(passwordHash || "").trim();
    if (!safeUsername || !safePasswordHash) {
        throw new Error("username and password hash are required");
    }

    const result = insertUserStmt.run(safeUsername, safePasswordHash);
    const userId = Number(result.lastInsertRowid);
    db.prepare("UPDATE users SET tenant_id = ? WHERE id = ?").run(`user:${userId}`, userId);
    return userId;
}

export function getUserByUsername(username) {
    if (!selectUserByUsernameStmt) {
        initDB();
    }

    return selectUserByUsernameStmt.get(String(username || "").trim()) || null;
}

export function getUserById(userId) {
    if (!selectUserByIdStmt) {
        initDB();
    }

    return selectUserByIdStmt.get(Number(userId)) || null;
}

export function getUserScope(userId) {
    if (!selectUserTenantStmt) initDB();
    const row = selectUserTenantStmt.get(Number(userId));
    if (!row) return null;
    return { userId: Number(row.id), tenantId: String(row.tenant_id || `user:${row.id}`) };
}

export function createSession(userId, title) {
    if (!insertSessionStmt) {
        initDB();
    }

    const safeUserId = Number(userId) || defaultUserId;
    if (!safeUserId) {
        throw new Error("user id is required");
    }

    const safeTitle = String(title || "新对话").trim() || "新对话";
    const result = insertSessionStmt.run(safeUserId, safeTitle);
    return Number(result.lastInsertRowid);
}

export function getSessions(userId) {
    if (!selectSessionsStmt) {
        initDB();
    }

    const safeUserId = Number(userId) || defaultUserId;
    return selectSessionsStmt.all(safeUserId);
}

export function getSessionById(userId, sessionId) {
    if (!selectSessionByIdStmt) {
        initDB();
    }

    const safeUserId = Number(userId) || defaultUserId;
    return selectSessionByIdStmt.get(Number(sessionId), safeUserId) || null;
}

function assertSessionOwnership(userId, sessionId) {
    if (!selectSessionOwnerStmt) {
        initDB();
    }

    const safeUserId = Number(userId) || defaultUserId;
    const row = selectSessionOwnerStmt.get(Number(sessionId));
    if (!row || Number(row.user_id) !== safeUserId) {
        throw new Error("session not found");
    }
}

export function saveMessage(userId, session_id, role, content) {
    if (!insertMessageStmt) {
        initDB();
    }

    assertSessionOwnership(userId, session_id);

    const result = insertMessageStmt.run(session_id, role, content);
    touchSessionStmt.run(session_id);
    return Number(result.lastInsertRowid);
}

export function renameSession(userId, session_id, title) {
    if (!updateSessionTitleStmt) {
        initDB();
    }

    const safeTitle = String(title || "").trim();
    if (!safeTitle) {
        return { changes: 0 };
    }

    const safeUserId = Number(userId) || defaultUserId;
    return updateSessionTitleStmt.run(safeTitle, session_id, safeUserId);
}

export function removeSession(userId, session_id) {
    if (!deleteSessionStmt || !deleteSessionMessagesStmt || !deleteSessionMetricsStmt
        || !deleteSessionEvalScoresStmt || !deleteSessionEvalFeedbackStmt
        || !deleteSessionEvalTracesStmt || !deleteSessionMemoryStmt) {
        initDB();
    }

    const safeUserId = Number(userId) || defaultUserId;

    const tx = db.transaction((id, ownerId) => {
        const session = getSessionById(ownerId, id);
        if (!session) {
            return { changes: 0 };
        }

        // Cascade: delete children before parents to satisfy FK constraints
        // 1. Eval scores (FK → messages)
        deleteSessionEvalScoresStmt.run(id);
        // 2. Eval feedback (FK → messages)
        deleteSessionEvalFeedbackStmt.run(id);
        // 3. Eval traces (FK → sessions + messages)
        deleteSessionEvalTracesStmt.run(id);
        // 4. Agent memory (FK → sessions)
        deleteSessionMemoryStmt.run(id);
        // 5. Message metrics (FK → messages)
        deleteSessionMetricsStmt.run(id);
        // 6. Messages (FK → sessions)
        deleteSessionMessagesStmt.run(id);
        // 7. Session itself
        return deleteSessionStmt.run(id, ownerId);
    });

    return tx(session_id, safeUserId);
}

export function toggleSessionPin(userId, session_id, pinned) {
    if (!updateSessionPinStmt) {
        initDB();
    }

    const safeUserId = Number(userId) || defaultUserId;
    const pinnedValue = pinned ? 1 : 0;
    return updateSessionPinStmt.run(pinnedValue, pinnedValue, session_id, safeUserId);
}

export function getHistoryMessages(userId, session_id, limit = 20) {
    if (!selectHistoryStmt) {
        initDB();
    }

    const safeUserId = Number(userId) || defaultUserId;
    const rows = selectHistoryStmt.all(session_id, safeUserId, limit);
    return normalizeHistoryRows(rows.reverse());
}

export function saveMessageMetric(messageId, metrics = {}) {
    if (!insertMessageMetricStmt) {
        initDB();
    }

    insertMessageMetricStmt.run(
        Number(messageId),
        Number(metrics.latency_ms) || 0,
        Number(metrics.prompt_tokens) || 0,
        Number(metrics.completion_tokens) || 0,
        Number(metrics.total_tokens) || 0,
        String(metrics.model || "")
    );
}

/** Return one message only when it belongs to the requested user. */
export function getMessageById(userId, messageId) {
    if (!selectMessageByIdStmt) initDB();
    const row = selectMessageByIdStmt.get(Number(messageId));
    if (!row) return null;
    const session = getSessionById(userId, row.session_id);
    return session ? row : null;
}

export function createBranchSession(userId, sourceSessionId, fromMessageId, title, editedContent = "") {
    if (!insertBranchMessagesStmt || !insertSessionStmt || !selectMessageInSessionStmt) {
        initDB();
    }

    const safeUserId = Number(userId) || defaultUserId;
    const safeSourceSessionId = Number(sourceSessionId);
    const safeFromMessageId = Number(fromMessageId);
    const safeTitle = String(title || "新分支").trim() || "新分支";
    const safeEditedContent = String(editedContent || "");

    const tx = db.transaction(() => {
        const sourceSession = getSessionById(safeUserId, safeSourceSessionId);
        if (!sourceSession) {
            throw new Error("source session not found");
        }

        const branchId = createSession(safeUserId, safeTitle);

        if (Number.isInteger(safeFromMessageId) && safeFromMessageId > 0) {
            const targetMessage = selectMessageInSessionStmt.get(safeFromMessageId, safeSourceSessionId);
            if (!targetMessage) {
                throw new Error("message not found in source session");
            }

            insertBranchMessagesStmt.run(
                branchId,
                safeFromMessageId,
                safeEditedContent,
                safeEditedContent,
                safeEditedContent,
                safeSourceSessionId,
                safeFromMessageId
            );
            touchSessionStmt.run(branchId);
        }

        return branchId;
    });

    return tx();
}

export function removeMessagePair(userId, sessionId, userMessageId) {
    if (!selectMessageByIdStmt || !deleteMessageByIdStmt || !deleteMessageMetricByMessageIdStmt) {
        initDB();
    }

    const safeUserId = Number(userId) || defaultUserId;
    const safeSessionId = Number(sessionId);
    const safeUserMessageId = Number(userMessageId);

    const tx = db.transaction(() => {
        const session = getSessionById(safeUserId, safeSessionId);
        if (!session) {
            throw new Error("session not found");
        }

        const userMessage = selectMessageInSessionStmt.get(safeUserMessageId, safeSessionId);
        if (!userMessage || userMessage.role !== "user") {
            throw new Error("user message not found");
        }

        const maybeAssistant = selectMessageByIdStmt.get(safeUserMessageId + 1);
        const shouldDeleteAssistant =
            maybeAssistant &&
            Number(maybeAssistant.session_id) === safeSessionId &&
            maybeAssistant.role === "assistant";

        deleteMessageMetricByMessageIdStmt.run(safeUserMessageId);
        deleteMessageByIdStmt.run(safeUserMessageId);

        if (shouldDeleteAssistant) {
            deleteMessageMetricByMessageIdStmt.run(Number(maybeAssistant.id));
            deleteMessageByIdStmt.run(Number(maybeAssistant.id));
        }

        touchSessionStmt.run(safeSessionId);

        return {
            deletedUserMessageId: safeUserMessageId,
            deletedAssistantMessageId: shouldDeleteAssistant ? Number(maybeAssistant.id) : null,
        };
    });

    return tx();
}

export function getMessageStats(userId) {
    if (!selectMessageStatsStmt) {
        initDB();
    }

    const safeUserId = Number(userId) || defaultUserId;
    const row = selectMessageStatsStmt.get(safeUserId);
    return {
        total: row?.total ?? 0,
        user_count: row?.user_count ?? 0,
        assistant_count: row?.assistant_count ?? 0,
        at: new Date().toISOString()
    };
}

// ── Phase 4: 记忆系统数据操作 ──

let insertMemoryStmt = null;
let searchMemoriesStmt = null;
let consolidateFromTypeStmt = null;
let insertConsolidatedStmt = null;
let deleteLowImportanceStmt = null;
let deleteOldMemoriesStmt = null;
let selectMemoryStatsStmt = null;
let selectMemorySummaryStmt = null;
let updateMemoryStmt = null;
let deleteMemoryByIdStmt = null;
let clearAllMemoriesStmt = null;
let touchMemoryRecallStmt = null;

function ensureMemoryStatements() {
    if (!insertMemoryStmt) {
        insertMemoryStmt = db.prepare(
            `INSERT INTO agent_memory
             (user_id, session_id, content, memory_type, importance, metadata,
             status, source, confidence, memory_key, supersedes_id, pinned,
              category, relation_type, related_memory_id, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
    }
    if (!searchMemoriesStmt) {
        searchMemoriesStmt = db.prepare(
            `SELECT * FROM agent_memory
             WHERE user_id = ?
               AND (memory_type = ? OR ? IS NULL)
               AND importance >= ?
               AND status = ?
             ORDER BY created_at DESC
             LIMIT ?`
        );
    }
    if (!consolidateFromTypeStmt) {
        consolidateFromTypeStmt = db.prepare(
            `SELECT * FROM agent_memory
             WHERE user_id = ? AND memory_type = ? AND importance >= ? AND status = 'active'
             ORDER BY importance DESC`
        );
    }
    if (!insertConsolidatedStmt) {
        insertConsolidatedStmt = db.prepare(
            `INSERT INTO agent_memory
             (user_id, session_id, content, memory_type, importance, metadata,
              status, source, confidence, memory_key, supersedes_id, pinned)
             VALUES (?, ?, ?, ?, ?, ?, 'active', 'consolidated', ?, ?, NULL, ?)`
        );
    }
    if (!deleteLowImportanceStmt) {
        deleteLowImportanceStmt = db.prepare(
            `DELETE FROM agent_memory
             WHERE user_id = ? AND memory_type = ? AND importance < ?`
        );
    }
    if (!deleteOldMemoriesStmt) {
        deleteOldMemoriesStmt = db.prepare(
            `DELETE FROM agent_memory
             WHERE user_id = ? AND memory_type = ? AND created_at < ?`
        );
    }
    if (!selectMemoryStatsStmt) {
        selectMemoryStatsStmt = db.prepare(
            `SELECT memory_type, COUNT(*) as count
             FROM agent_memory
             WHERE user_id = ?
             GROUP BY memory_type`
        );
    }
    if (!selectMemorySummaryStmt) {
        selectMemorySummaryStmt = db.prepare(
            `SELECT id, content, memory_type, importance, created_at
             FROM agent_memory
             WHERE user_id = ?
             ORDER BY importance DESC, created_at DESC
             LIMIT ?`
        );
    }
    if (!updateMemoryStmt) {
        updateMemoryStmt = db.prepare(
            `UPDATE agent_memory
             SET content = ?, importance = ?, memory_type = ?, metadata = ?,
                 source = ?, confidence = ?, memory_key = ?, pinned = ?,
                 category = ?, relation_type = ?, related_memory_id = ?,
                 supersedes_id = ?, expires_at = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND user_id = ?`
        );
    }
    if (!deleteMemoryByIdStmt) {
        deleteMemoryByIdStmt = db.prepare(
            `DELETE FROM agent_memory WHERE id = ? AND user_id = ?`
        );
    }
    if (!clearAllMemoriesStmt) {
        clearAllMemoriesStmt = db.prepare(
            `DELETE FROM agent_memory WHERE user_id = ?`
        );
    }
    if (!touchMemoryRecallStmt) {
        touchMemoryRecallStmt = db.prepare(
            `UPDATE agent_memory
             SET recall_count = COALESCE(recall_count, 0) + 1,
                 last_recalled_at = CURRENT_TIMESTAMP
             WHERE id = ? AND user_id = ? AND status = 'active'`
        );
    }
}

// ── Phase 5: ensureEvalStatements ──

function ensureEvalStatements() {
    if (!insertTraceStmt) {
        insertTraceStmt = db.prepare(
            `INSERT INTO eval_traces (user_id, session_id, message_id, trace_id, parent_trace_id, trace_type, root_span, agent_traversal_path, tool_call_count, error_count, total_latency_ms, model)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
    }
    if (!selectTraceByTraceIdStmt) {
        selectTraceByTraceIdStmt = db.prepare(
            `SELECT * FROM eval_traces WHERE trace_id = ?`
        );
    }
    if (!selectTraceByOwnerStmt) {
        selectTraceByOwnerStmt = db.prepare(
            `SELECT * FROM eval_traces WHERE trace_id = ? AND user_id = ?`
        );
    }
    if (!selectRecentTracesStmt) {
        selectRecentTracesStmt = db.prepare(
            `SELECT et.trace_id, et.trace_type, et.agent_traversal_path, et.tool_call_count,
                    et.error_count, et.total_latency_ms, et.model, et.created_at
             FROM eval_traces et
             WHERE et.user_id = ?
             ORDER BY et.id DESC
             LIMIT ?`
        );
    }
    if (!insertEvalScoreStmt) {
        insertEvalScoreStmt = db.prepare(
            `INSERT INTO eval_scores (trace_id, message_id, test_case_id, run_id, dimension, score, judge_rationale, judge_model, score_type, owner_user_id, tenant_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
    }
    if (!selectScoresByRunIdStmt) {
        selectScoresByRunIdStmt = db.prepare(
            `SELECT * FROM eval_scores WHERE run_id = ? ORDER BY test_case_id, dimension`
        );
    }
    if (!selectScoreTrendsStmt) {
        selectScoreTrendsStmt = db.prepare(
            `SELECT DATE(created_at) as date, dimension, ROUND(AVG(score), 2) as avg_score
             FROM eval_scores
             WHERE score_type = 'offline'
             GROUP BY DATE(created_at), dimension
             ORDER BY date DESC
             LIMIT ?`
        );
    }
    if (!selectScoreTrendsByRunStmt) {
        selectScoreTrendsByRunStmt = db.prepare(
            `SELECT DATE(created_at) as date, dimension, ROUND(AVG(score), 2) as avg_score
             FROM eval_scores
             WHERE score_type = 'offline' AND run_id = ?
             GROUP BY DATE(created_at), dimension
             ORDER BY date DESC
             LIMIT ?`
        );
    }
    if (!selectRunIdsStmt) {
        selectRunIdsStmt = db.prepare(
            `SELECT DISTINCT run_id, MIN(created_at) as created_at
             FROM eval_scores
             WHERE score_type = 'offline'
             GROUP BY run_id
             ORDER BY created_at DESC
             LIMIT 50`
        );
    }
    if (!insertFeedbackStmt) {
        insertFeedbackStmt = db.prepare(
            `INSERT INTO eval_feedback (user_id, message_id, rating, comment)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, message_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment`
        );
    }
    if (!selectFeedbackByMessageStmt) {
        selectFeedbackByMessageStmt = db.prepare(
            `SELECT rating, comment FROM eval_feedback WHERE user_id = ? AND message_id = ?`
        );
    }
    if (!selectFeedbackSummaryStmt) {
        selectFeedbackSummaryStmt = db.prepare(
            `SELECT rating, COUNT(*) as count
             FROM eval_feedback
             WHERE user_id = ?
             GROUP BY rating`
        );
    }
    if (!deleteFeedbackStmt) {
        deleteFeedbackStmt = db.prepare(
            `DELETE FROM eval_feedback WHERE user_id = ? AND message_id = ?`
        );
    }
}

// ── Phase 6: Agent 配置 prepared statements ──

function ensureAgentConfigStatements() {
    if (!selectAgentConfigStmt) {
        selectAgentConfigStmt = db.prepare(
            `SELECT key, value, default_value, description, updated_at FROM agent_config WHERE key = ?`
        );
    }
    if (!selectAllAgentConfigStmt) {
        selectAllAgentConfigStmt = db.prepare(
            `SELECT key, value, default_value, description, updated_at FROM agent_config ORDER BY key`
        );
    }
    if (!upsertAgentConfigStmt) {
        upsertAgentConfigStmt = db.prepare(
            `INSERT INTO agent_config (key, value, default_value, description, updated_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value,
               default_value = COALESCE(excluded.default_value, agent_config.default_value),
               description = COALESCE(excluded.description, agent_config.description),
               updated_at = CURRENT_TIMESTAMP`
        );
    }
    // G5: 版本管理 statements
    if (!insertConfigVersionStmt) {
        insertConfigVersionStmt = db.prepare(
            `INSERT INTO agent_config_versions (snapshot, source) VALUES (?, ?)`
        );
    }
    if (!selectConfigVersionsStmt) {
        selectConfigVersionsStmt = db.prepare(
            `SELECT id, source, label, created_at FROM agent_config_versions ORDER BY id DESC LIMIT ?`
        );
    }
    if (!selectConfigVersionByIdStmt) {
        selectConfigVersionByIdStmt = db.prepare(
            `SELECT id, snapshot, source, label, created_at FROM agent_config_versions WHERE id = ?`
        );
    }
    if (!updateConfigVersionLabelStmt) {
        updateConfigVersionLabelStmt = db.prepare(
            `UPDATE agent_config_versions SET label = ? WHERE id = ?`
        );
    }
    if (!deleteConfigVersionStmt) {
        deleteConfigVersionStmt = db.prepare(
            `DELETE FROM agent_config_versions WHERE id = ?`
        );
    }
}

/**
 * 获取单个 Agent 配置项
 * @param {string} key — 配置键名
 * @returns {{key: string, value: string, default_value: string|null, description: string|null}|null}
 */
export function getAgentConfigValue(key) {
    ensureAgentConfigStatements();
    const row = selectAgentConfigStmt.get(String(key));
    return row || null;
}

/**
 * 获取所有 Agent 配置项
 * @returns {Array<{key: string, value: string, default_value: string|null, description: string|null}>}
 */
export function getAllAgentConfigValues() {
    ensureAgentConfigStatements();
    return selectAllAgentConfigStmt.all();
}

/**
 * 设置（插入或更新）一个 Agent 配置项
 * @param {string} key
 * @param {string} value
 * @param {string} [defaultValue]
 * @param {string} [description]
 * @returns {boolean} 是否成功
 */
export function setAgentConfigValue(key, value, defaultValue = null, description = null, scope = null) {
    ensureAgentConfigStatements();
    const normalized = requireScope(scope, "configuration");
    const result = insertConfigOverrideStmt.run(
        normalized.userId,
        normalized.tenantId,
        String(key),
        String(value),
        description ? String(description) : null
    );
    return result.changes > 0;
}

export function getAgentConfigOverride(key, scope) {
    ensureAgentConfigStatements();
    const normalized = requireScope(scope, "scoped resource");
    return selectConfigOverrideStmt.get(normalized.userId, normalized.tenantId, String(key)) || null;
}

export function getAgentConfigOverrides(scope) {
    ensureAgentConfigStatements();
    const normalized = requireScope(scope, "scoped resource");
    return selectConfigOverridesStmt.all(normalized.userId, normalized.tenantId);
}

export function deleteAgentConfigOverride(key, scope) {
    ensureAgentConfigStatements();
    const normalized = requireScope(scope, "scoped resource");
    return deleteConfigOverrideStmt.run(normalized.userId, normalized.tenantId, String(key)).changes > 0;
}

// ── Phase 6b G5: 配置版本管理 ──

/**
 * 保存当前全量配置快照
 * @param {object} snapshot — { key: value, ... }
 * @param {string} source — "manual" | "rollback"
 * @returns {number} version id
 */
export function saveConfigSnapshot(snapshot, source = "manual", scope = null) {
    ensureAgentConfigStatements();
    const normalized = requireScope(scope, "configuration");
    const json = JSON.stringify(snapshot);
    db.prepare("INSERT INTO agent_config_versions (snapshot, source, owner_user_id, tenant_id, scope_type) VALUES (?, ?, ?, ?, 'user')").run(json, source, normalized.userId, normalized.tenantId);
    return Number(db.prepare("SELECT last_insert_rowid() AS id").get().id);
}

/**
 * 列出最近的配置版本（不含 snapshot 内容，仅元信息）
 * @param {number} limit — 最多返回条数
 * @returns {Array<{id: number, source: string, created_at: string}>}
 */
export function listConfigVersions(limit = 20, scope = null) {
    ensureAgentConfigStatements();
    const normalized = requireScope(scope, "scoped resource");
    return selectScopedConfigVersionsStmt.all(normalized.userId, normalized.tenantId, limit);
}

/**
 * 获取某个版本的完整快照
 * @param {number} id — version id
 * @returns {{id: number, snapshot: object, source: string, created_at: string}|null}
 */
export function getConfigVersion(id, scope = null) {
    ensureAgentConfigStatements();
    const normalized = requireScope(scope, "scoped resource");
    const row = selectScopedConfigVersionByIdStmt.get(id, normalized.userId, normalized.tenantId);
    if (!row) return null;
    try {
        row.snapshot = JSON.parse(row.snapshot);
    } catch {
        row.snapshot = {};
    }
    return row;
}

/**
 * 更新版本标签（重命名）
 * @param {number} id — version id
 * @param {string} label — 新标签名
 * @returns {boolean}
 */
export function updateConfigVersionLabel(id, label, scope = null) {
    ensureAgentConfigStatements();
    const normalized = requireScope(scope, "scoped resource");
    const result = db.prepare("UPDATE agent_config_versions SET label = ? WHERE id = ? AND owner_user_id = ? AND tenant_id = ?").run(label || null, id, normalized.userId, normalized.tenantId);
    return result.changes > 0;
}

/**
 * 删除某个版本
 * @param {number} id — version id
 * @returns {boolean}
 */
export function deleteConfigVersion(id, scope = null) {
    ensureAgentConfigStatements();
    const normalized = requireScope(scope, "scoped resource");
    const result = db.prepare("DELETE FROM agent_config_versions WHERE id = ? AND owner_user_id = ? AND tenant_id = ?").run(id, normalized.userId, normalized.tenantId);
    return result.changes > 0;
}

const MEMORY_STATUSES = new Set(["pending", "active", "rejected", "superseded", "invalidated"]);
const MEMORY_CATEGORIES = new Set(["fact", "preference", "constraint", "goal", "event", "uncategorized"]);
const MEMORY_RELATIONS = new Set(["independent", "duplicate", "supplement", "conflict", "expiration"]);
const WORKING_MEMORY_KEYS = [
    "working_current_goal",
    "working_constraints",
    "working_progress",
    "working_next_step",
];

function normalizeMemoryStatus(status, fallback = "active") {
    const value = String(status ?? fallback).trim().toLowerCase();
    return MEMORY_STATUSES.has(value) ? value : fallback;
}

function clampMemoryConfidence(value, fallback = 0.5) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

function normalizeMemoryCategory(value, fallback = "uncategorized") {
    const category = String(value || "").trim().toLowerCase();
    return MEMORY_CATEGORIES.has(category) ? category : fallback;
}

function normalizeMemoryRelation(value, fallback = "independent") {
    const relation = String(value || "").trim().toLowerCase();
    return MEMORY_RELATIONS.has(relation) ? relation : fallback;
}

function relatedMemoryPreview(userId, relatedMemoryId) {
    if (!relatedMemoryId) return null;
    const row = db.prepare(
        `SELECT id, content, status, memory_key, category, relation_type, created_at
         FROM agent_memory WHERE id = ? AND user_id = ?`
    ).get(Number(relatedMemoryId), Number(userId));
    return row ? {
        id: row.id,
        content: row.content,
        status: row.status || "active",
        memory_key: row.memory_key || null,
        category: row.category || "uncategorized",
        relation_type: row.relation_type || "independent",
        created_at: row.created_at,
    } : null;
}

function serializeMemoryRow(row, userId, extras = {}) {
    const serialized = {
        id: row.id,
        session_id: row.session_id || null,
        content: row.content,
        memory_type: row.memory_type,
        importance: row.importance,
        status: row.status || "active",
        source: row.source || "manual",
        confidence: row.confidence == null ? 1 : row.confidence,
        memory_key: row.memory_key || null,
        category: row.category || "uncategorized",
        relation_type: row.relation_type || "independent",
        related_memory_id: row.related_memory_id || null,
        related_memory: relatedMemoryPreview(userId, row.related_memory_id || row.supersedes_id || row.superseded_by),
        supersedes_id: row.supersedes_id || null,
        superseded_by: row.superseded_by || null,
        pinned: Boolean(row.pinned),
        invalidated_at: row.invalidated_at || null,
        invalidate_reason: row.invalidate_reason || null,
        expires_at: row.expires_at || null,
        recall_count: row.recall_count ?? 0,
        last_recalled_at: row.last_recalled_at || null,
        updated_at: row.updated_at || row.created_at,
        created_at: row.created_at,
        metadata: safeParseJSON(row.metadata),
        ...extras,
    };
    if (memoryContractEnabled()) {
        serialized.contractVersion = "memory-context-v2";
        serialized.provenance = buildUserMemoryProvenance({
            memoryId: row.id,
            ownerUserId: userId,
            sessionId: row.session_id || null,
            source: row.source || "manual",
            metadata: serialized.metadata,
            confidence: serialized.confidence,
            createdAt: row.created_at,
            invalidatedAt: row.invalidated_at,
            invalidationReason: row.invalidate_reason,
        });
    }
    return serialized;
}

/**
 * 添加一条记忆
 * @param {number} userId
 * @param {number|null} sessionId
 * @param {string} content
 * @param {string} memoryType - "working" | "episodic" | "semantic"
 * @param {number} importance - 0.0 ~ 1.0
 * @param {object} metadata - 额外的结构化元数据
 * @param {object} lifecycle - status/source/confidence/memoryKey/supersedesId/pinned/category/relationType/relatedMemoryId
 * @returns {number} memoryId
 */
export function addMemory(userId, sessionId, content, memoryType = "working", importance = 0.5, metadata = {}, lifecycle = {}) {
    ensureMemoryStatements();
    const safeImportance = Math.max(0, Math.min(1, Number(importance) || 0.5));
    const meta = metadata && typeof metadata === "object" ? metadata : {};
    const result = insertMemoryStmt.run(
        Number(userId),
        sessionId ? Number(sessionId) : null,
        String(content),
        String(memoryType),
        safeImportance,
        JSON.stringify(meta),
        normalizeMemoryStatus(lifecycle.status),
        String(lifecycle.source || meta.source || "manual"),
        clampMemoryConfidence(lifecycle.confidence ?? meta.confidence, 1),
        lifecycle.memoryKey == null ? (meta.memory_key == null ? null : String(meta.memory_key)) : String(lifecycle.memoryKey),
        lifecycle.supersedesId == null ? null : Number(lifecycle.supersedesId),
        lifecycle.pinned ? 1 : 0,
        normalizeMemoryCategory(lifecycle.category ?? meta.category),
        normalizeMemoryRelation(lifecycle.relationType ?? meta.relation_type),
        lifecycle.relatedMemoryId == null
            ? (meta.related_memory_id == null ? null : Number(meta.related_memory_id))
            : Number(lifecycle.relatedMemoryId),
        lifecycle.expiresAt == null
            ? (meta.expires_at == null ? null : String(meta.expires_at))
            : String(lifecycle.expiresAt),
    );
    return Number(result.lastInsertRowid);
}

/**
 * 搜索记忆 — 混合检索（关键词匹配 + 时间衰减 + 重要性权重）
 * @param {number} userId
 * @param {string} query
 * @param {string[]} memoryTypes - 限制搜索的记忆类型，null 表示全部
 * @param {number} limit
 * @param {number} minImportance
 * @param {string|string[]} statuses - 默认只召回 active 记忆
 * @returns {Array} 带 relevanceScore 的记忆列表
 */
export function searchMemory(userId, query, memoryTypes = null, limit = 10, minImportance = 0.1, statuses = "active", options = {}) {
    ensureMemoryStatements();
    const safeUserId = Number(userId);
    const allowedStatuses = (Array.isArray(statuses) ? statuses : [statuses])
        .map((status) => normalizeMemoryStatus(status, "active"));
    const statusSet = new Set(allowedStatuses.length > 0 ? allowedStatuses : ["active"]);
    const statusPlaceholders = [...statusSet].map(() => "?").join(", ");

    // 批量获取候选集 — 对每种记忆类型分别查询
    const typesToSearch = (Array.isArray(memoryTypes) && memoryTypes.length > 0)
        ? memoryTypes
        : ["working", "episodic", "semantic"];
    const typeSet = new Set(typesToSearch);

    const allCandidates = [];
    for (const memType of typeSet) {
        // 每种类型取 3x limit 做候选池，后续混合排序
        const rows = db.prepare(
            `SELECT * FROM agent_memory
             WHERE user_id = ?
               AND (memory_type = ? OR ? IS NULL)
               AND importance >= ?
               AND status IN (${statusPlaceholders})
               AND (status <> 'active' OR expires_at IS NULL OR julianday(expires_at) > julianday('now'))
             ORDER BY pinned DESC, created_at DESC
             LIMIT ?`
        ).all(safeUserId, memType, memType, minImportance, ...statusSet, limit * 3);
        for (const row of rows) {
            allCandidates.push(row);
        }
    }

    if (allCandidates.length === 0) return [];

    // ── 混合检索评分 ──
    const queryLower = String(query || "").toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(Boolean);
    const now = Date.now();

    // CJK 字符 bigram 辅助函数 — 解决中文无空格分词问题
    const cjkBigrams = (text) => {
        const chars = [];
        for (const ch of text) {
            if (/[一-鿿㐀-䶿豈-﫿]/.test(ch)) {
                chars.push(ch);
            }
        }
        const bigrams = [];
        for (let i = 0; i < chars.length - 1; i++) {
            bigrams.push(chars[i] + chars[i + 1]);
        }
        return bigrams;
    };

    const queryBigrams = cjkBigrams(queryLower);

    const scored = allCandidates.map((row) => {
        const contentLower = String(row.content || "").toLowerCase();

        // 1. 关键词匹配得分（支持中文 bigram + 空格分词双通道）
        let keywordScore = 0;
        if (queryLower.length > 0) {
            // 通道 A: CJK bigram 匹配（解决中文无空格问题）
            let bigramScore = 0;
            if (queryBigrams.length > 0) {
                const contentBigrams = cjkBigrams(contentLower);
                if (contentBigrams.length > 0) {
                    const matchCount = queryBigrams.filter(bg => contentBigrams.includes(bg)).length;
                    bigramScore = matchCount / queryBigrams.length;
                }
            }

            // 通道 B: 空格分词 + 子串匹配（英文等空格分隔语言）
            let tokenScore = 0;
            if (queryWords.length > 0) {
                const matchCount = queryWords.filter(w => contentLower.includes(w)).length;
                tokenScore = matchCount / queryWords.length;
            }

            // 取两通道中较高者
            keywordScore = Math.max(bigramScore, tokenScore);
        }

        // 2. 时间衰减因子
        const ageHours = (now - new Date(row.created_at).getTime()) / (1000 * 3600);
        const recencyScore = Math.max(0.1, Math.exp(-0.1 * ageHours / 24));

        // 3. 重要性权重
        const importanceWeight = 0.8 + (row.importance || 0.5) * 0.4;

        // 4. 综合评分
        const relevanceScore = (keywordScore * 0.7 + recencyScore * 0.1) * importanceWeight;

        return serializeMemoryRow(row, safeUserId, { relevanceScore });
    });

    // 5. 有搜索词时，过滤掉完全不匹配的结果（所有查询词都不命中内容 → 排除）
    const filtered = queryWords.length > 0
        ? scored.filter(item => item.relevanceScore > 0.15)
        : scored;

    // 按综合评分降序排序
    filtered.sort((a, b) => (b.pinned - a.pinned) || (b.relevanceScore - a.relevanceScore));
    const result = filtered.slice(0, limit);
    if (options.touchRecall !== false) {
        for (const item of result) {
            touchMemoryRecallStmt.run(item.id, safeUserId);
        }
    }
    return result;
}

/** Record recall only after the context layer has accepted an item. */
export function recordMemoryRecall(userId, memoryIds = []) {
    ensureMemoryStatements();
    const safeUserId = Number(userId);
    const ids = [...new Set((Array.isArray(memoryIds) ? memoryIds : []).map(Number))]
        .filter((id) => Number.isInteger(id) && id > 0);
    for (const id of ids) touchMemoryRecallStmt.run(id, safeUserId);
    return ids.length;
}

/**
 * 记忆巩固：将高重要性的短期记忆提升为长期记忆
 * @param {number} userId
 * @param {string} fromType - 来源记忆类型
 * @param {string} toType - 目标记忆类型
 * @param {number} importanceThreshold - 重要性阈值
 * @returns {{ consolidated: number, total: number }}
 */
export function consolidateMemory(userId, fromType = "working", toType = "episodic", importanceThreshold = 0.7) {
    ensureMemoryStatements();
    const safeUserId = Number(userId);

    const tx = db.transaction(() => {
        const candidates = consolidateFromTypeStmt.all(safeUserId, fromType, importanceThreshold);

        let consolidated = 0;
        for (const row of candidates) {
            // 记忆巩固保留原始 id 与 provenance，只改变用途层级。
            const boostedImportance = Math.min(1, (row.importance || 0.5) * 1.1);
            const metadata = {
                ...safeParseJSON(row.metadata),
                consolidated_from: row.id,
                consolidated_from_type: fromType,
                consolidated_at: new Date().toISOString(),
            };

            db.prepare(
                `UPDATE agent_memory
                 SET memory_type = ?, importance = ?, metadata = ?,
                     source = 'consolidated', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND user_id = ? AND status = 'active'`
            ).run(toType, boostedImportance, JSON.stringify(metadata), row.id, safeUserId);
            consolidated++;
        }

        return { consolidated, total: candidates.length };
    });

    return tx();
}

/**
 * 遗忘记忆 — 支持三种策略
 * @param {number} userId
 * @param {string} strategy - "importance" | "time" | "all"
 * @param {string} memoryType - 目标记忆类型
 * @param {number} threshold - importance 阈值（strategy=importance 时）或天数（strategy=time 时）
 * @returns {number} 删除的记忆数量
 */
export function forgetMemory(userId, strategy = "importance", memoryType = "working", threshold = 0.3) {
    ensureMemoryStatements();
    const safeUserId = Number(userId);

    let result;
    if (strategy === "importance") {
        result = db.prepare(
            `UPDATE agent_memory
             SET status = 'invalidated', invalidated_at = CURRENT_TIMESTAMP,
                 invalidate_reason = 'importance_decay', updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND memory_type = ? AND importance < ? AND status = 'active'`
        ).run(safeUserId, memoryType, threshold);
    } else if (strategy === "time") {
        const cutoffDate = new Date(Date.now() - Number(threshold) * 24 * 3600 * 1000).toISOString();
        result = db.prepare(
            `UPDATE agent_memory
             SET status = 'invalidated', invalidated_at = CURRENT_TIMESTAMP,
                 invalidate_reason = 'time_decay', updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND memory_type = ? AND created_at < ? AND status = 'active'`
        ).run(safeUserId, memoryType, cutoffDate);
    } else if (strategy === "all") {
        result = clearAllMemoriesStmt.run(safeUserId);
    } else {
        return 0;
    }

    return result.changes;
}

/**
 * 获取记忆统计
 * @param {number} userId
 * @returns {object} { total, byType: { working: n, episodic: n, semantic: n } }
 */
export function getMemoryStats(userId) {
    ensureMemoryStatements();
    const safeUserId = Number(userId);
    const rows = db.prepare(
        `SELECT memory_type, status, COUNT(*) as count
         FROM agent_memory
         WHERE user_id = ?
         GROUP BY memory_type, status`
    ).all(safeUserId);

    const byType = { working: 0, episodic: 0, semantic: 0 };
    const byStatus = { pending: 0, active: 0, rejected: 0, superseded: 0, invalidated: 0 };
    let total = 0;
    for (const row of rows) {
        if (row.status === "active" && row.memory_type in byType) byType[row.memory_type] += Number(row.count) || 0;
        if (row.status in byStatus) byStatus[row.status] += Number(row.count) || 0;
        total += Number(row.count) || 0;
    }

    return { total, byType, byStatus };
}

/**
 * 获取记忆摘要
 * @param {number} userId
 * @param {number} limit
 * @param {string|string[]|null} statuses - null 表示全部生命周期状态
 * @returns {Array}
 */
export function getMemorySummary(userId, limit = 20, statuses = null) {
    ensureMemoryStatements();
    const safeUserId = Number(userId);
    const normalizedStatuses = statuses == null
        ? null
        : (Array.isArray(statuses) ? statuses : [statuses]).map((status) => normalizeMemoryStatus(status));
    const statusClause = normalizedStatuses?.length
        ? ` AND status IN (${normalizedStatuses.map(() => "?").join(", ")})`
        : "";
    const rows = db.prepare(
        `SELECT * FROM agent_memory
         WHERE user_id = ?${statusClause}
           AND (status <> 'active' OR expires_at IS NULL OR julianday(expires_at) > julianday('now'))
         ORDER BY pinned DESC, importance DESC, created_at DESC
         LIMIT ?`
    ).all(safeUserId, ...(normalizedStatuses || []), limit);

    return rows.map((row) => serializeMemoryRow(row, safeUserId));
}

function assertWorkingSessionOwnership(userId, sessionId) {
    const safeUserId = Number(userId);
    const safeSessionId = Number(sessionId);
    if (!Number.isInteger(safeUserId) || safeUserId <= 0 || !Number.isInteger(safeSessionId) || safeSessionId <= 0) {
        const error = new Error("session not found");
        error.code = "SESSION_NOT_FOUND";
        throw error;
    }
    const row = db.prepare(
        "SELECT id FROM sessions WHERE id = ? AND user_id = ?"
    ).get(safeSessionId, safeUserId);
    if (!row) {
        const error = new Error("session not found");
        error.code = "SESSION_NOT_FOUND";
        throw error;
    }
    return { userId: safeUserId, sessionId: safeSessionId };
}

function workingMemoryMetadata(row) {
    return safeParseJSON(row?.metadata);
}

function workingMemoryActiveRows(userId, sessionId) {
    const keyPlaceholders = WORKING_MEMORY_KEYS.map(() => "?").join(", ");
    return db.prepare(
        `SELECT * FROM agent_memory
         WHERE user_id = ? AND session_id = ? AND memory_type = 'working'
           AND memory_key IN (${keyPlaceholders}) AND status = 'active'
           AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))
         ORDER BY id ASC`
    ).all(userId, sessionId, ...WORKING_MEMORY_KEYS);
}

/**
 * Idempotently replace the four server-generated working-memory slots for a
 * session. This is deliberately separate from generic add/update semantics:
 * memory_key is an exact protocol key and active rows are never duplicated.
 */
export function upsertSessionWorkingMemory(userId, sessionId, records = []) {
    ensureMemoryStatements();
    const scope = assertWorkingSessionOwnership(userId, sessionId);
    const safeRecords = Array.isArray(records)
        ? records
            .map((record) => ({ ...record, memory_key: record?.memory_key ?? record?.memoryKey, expires_at: record?.expires_at ?? record?.expiresAt }))
            .filter((record) => WORKING_MEMORY_KEYS.includes(String(record?.memory_key)))
        : [];
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
        const expired = db.prepare(
            `UPDATE agent_memory
             SET status = 'invalidated', invalidated_at = CURRENT_TIMESTAMP,
                 invalidate_reason = 'working_memory_ttl', updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND session_id = ? AND memory_type = 'working'
               AND memory_key IN (${WORKING_MEMORY_KEYS.map(() => "?").join(", ")})
               AND status = 'active' AND expires_at IS NOT NULL
               AND julianday(expires_at) <= julianday(?)`
        ).run(scope.userId, scope.sessionId, ...WORKING_MEMORY_KEYS, now);

        let created = 0;
        let updated = 0;
        let unchanged = 0;
        const ids = [];
        for (const record of safeRecords) {
            const key = String(record.memory_key);
            const candidates = db.prepare(
                `SELECT * FROM agent_memory
                 WHERE user_id = ? AND session_id = ? AND memory_type = 'working'
                   AND memory_key = ? AND status = 'active'
                   AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))
                 ORDER BY updated_at DESC, id DESC`
            ).all(scope.userId, scope.sessionId, key);
            const current = candidates[0] || null;
            for (const duplicate of candidates.slice(1)) {
                db.prepare(
                    `UPDATE agent_memory
                     SET status = 'invalidated', invalidated_at = CURRENT_TIMESTAMP,
                         invalidate_reason = 'working_memory_duplicate', updated_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND user_id = ? AND status = 'active'`
                ).run(duplicate.id, scope.userId);
            }

            const metadata = record.metadata && typeof record.metadata === "object" ? record.metadata : {};
            const snapshotHash = String(metadata.snapshot_hash || "");
            const currentHash = String(workingMemoryMetadata(current).snapshot_hash || "");
            if (current && snapshotHash && snapshotHash === currentHash) {
                unchanged++;
                ids.push(Number(current.id));
                continue;
            }

            const values = [
                String(record.content || ""),
                0.9,
                JSON.stringify(metadata),
                "working_memory",
                1,
                key,
                record.expires_at == null ? null : String(record.expires_at),
            ];
            if (current) {
                const changed = db.prepare(
                    `UPDATE agent_memory
                     SET content = ?, importance = ?, metadata = ?, status = 'active',
                         source = ?, confidence = ?, memory_key = ?, category = 'goal',
                         relation_type = 'independent', related_memory_id = NULL,
                         supersedes_id = NULL, invalidated_at = NULL, invalidate_reason = NULL,
                         expires_at = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND user_id = ?`
                ).run(...values, current.id, scope.userId);
                updated += changed.changes;
                ids.push(Number(current.id));
            } else {
                const result = insertMemoryStmt.run(
                    scope.userId,
                    scope.sessionId,
                    values[0],
                    "working",
                    values[1],
                    values[2],
                    "active",
                    values[3],
                    values[4],
                    key,
                    null,
                    0,
                    "goal",
                    "independent",
                    null,
                    values[6],
                );
                created++;
                ids.push(Number(result.lastInsertRowid));
            }
        }
        return { created, updated, unchanged, expired: expired.changes, ids, changed: created + updated > 0 };
    });

    return tx();
}

/** Return only active, unexpired fixed-key working state for one owned session. */
export function getSessionWorkingMemory(userId, sessionId) {
    ensureMemoryStatements();
    const scope = assertWorkingSessionOwnership(userId, sessionId);
    const now = new Date().toISOString();
    db.prepare(
        `UPDATE agent_memory
         SET status = 'invalidated', invalidated_at = CURRENT_TIMESTAMP,
             invalidate_reason = 'working_memory_ttl', updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND session_id = ? AND memory_type = 'working'
           AND memory_key IN (${WORKING_MEMORY_KEYS.map(() => "?").join(", ")})
           AND status = 'active' AND expires_at IS NOT NULL
           AND julianday(expires_at) <= julianday(?)`
    ).run(scope.userId, scope.sessionId, ...WORKING_MEMORY_KEYS, now);
    return workingMemoryActiveRows(scope.userId, scope.sessionId)
        .map((row) => serializeMemoryRow(row, scope.userId));
}

/** Soft-invalidate current working state while retaining its audit trail. */
export function invalidateSessionWorkingMemory(userId, sessionId, reason = "task_terminal") {
    ensureMemoryStatements();
    const scope = assertWorkingSessionOwnership(userId, sessionId);
    const safeReason = String(reason || "task_terminal").replace(/[\r\n]/g, " ").slice(0, 120);
    const tx = db.transaction(() => {
        const rows = workingMemoryActiveRows(scope.userId, scope.sessionId);
        const update = db.prepare(
            `UPDATE agent_memory
             SET status = 'invalidated', invalidated_at = CURRENT_TIMESTAMP,
                 invalidate_reason = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND user_id = ? AND status = 'active'`
        );
        const ids = [];
        for (const row of rows) {
            const metadata = {
                ...workingMemoryMetadata(row),
                invalidation_source: "working_memory",
                invalidation_reason: safeReason,
                invalidation_at: new Date().toISOString(),
            };
            const changed = update.run(safeReason, JSON.stringify(metadata), row.id, scope.userId);
            if (changed.changes > 0) ids.push(Number(row.id));
        }
        return { invalidated: ids.length, ids, reason: safeReason };
    });
    return tx();
}

/**
 * Owner-scoped rows used by optional user-memory vector recall.
 * Do not expose embeddings through the normal MemoryPanel/API serializers.
 */
export function getMemoryVectorRows(userId, memoryTypes = ["episodic", "semantic"]) {
    ensureMemoryStatements();
    const safeUserId = Number(userId);
    const types = Array.isArray(memoryTypes) && memoryTypes.length > 0
        ? [...new Set(memoryTypes.map((type) => String(type)))]
        : ["episodic", "semantic"];
    const placeholders = types.map(() => "?").join(", ");
    return db.prepare(
        `SELECT id, content, memory_type, importance, confidence, status,
                updated_at, embedding, embedding_model, embedding_source_hash,
                embedding_updated_at
         FROM agent_memory
         WHERE user_id = ? AND status = 'active' AND memory_type IN (${placeholders})
         ORDER BY updated_at DESC, id DESC`
    ).all(safeUserId, ...types);
}

/** Persist one owner-scoped memory embedding after successful inference. */
export function updateMemoryEmbedding(userId, memoryId, embedding, model = null, sourceHash = null) {
    ensureMemoryStatements();
    if (!Array.isArray(embedding) || embedding.length === 0) return false;
    const result = db.prepare(
        `UPDATE agent_memory
         SET embedding = ?, embedding_model = ?, embedding_source_hash = ?,
             embedding_updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`
    ).run(JSON.stringify(embedding), model ? String(model) : null, sourceHash ? String(sourceHash) : null, Number(memoryId), Number(userId));
    return result.changes > 0;
}

/** Return every owner-scoped memory for an explicit privacy export. */
export function exportMemory(userId) {
    ensureMemoryStatements();
    const safeUserId = Number(userId);
    const rows = db.prepare(
        `SELECT * FROM agent_memory WHERE user_id = ? ORDER BY created_at ASC, id ASC`
    ).all(safeUserId);
    return rows.map((row) => serializeMemoryRow(row, safeUserId));
}

/**
 * Evaluate and, unless dryRun is requested, soft-invalidate owner-scoped
 * retention candidates in one transaction. No retention path hard-deletes.
 */
export function applyMemoryRetention(userId, policy, { dryRun = false } = {}) {
    ensureMemoryStatements();
    const safeUserId = Number(userId);
    const rows = db.prepare(
        `SELECT * FROM agent_memory
         WHERE user_id = ? AND status IN ('pending', 'active')`
    ).all(safeUserId);
    const evaluation = evaluateMemoryRetention(rows, policy, Date.now());
    const result = {
        enabled: true,
        dryRun: Boolean(dryRun),
        scanned: evaluation.scanned,
        invalidated: 0,
        protectedSkipped: evaluation.protectedSkipped,
        byReason: evaluation.byReason,
        candidates: evaluation.decisions.map((item) => ({ ...item })),
    };
    if (dryRun || evaluation.decisions.length === 0) return result;

    const tx = db.transaction(() => {
        for (const decision of evaluation.decisions) {
            const changed = db.prepare(
                `UPDATE agent_memory
                 SET status = 'invalidated', invalidated_at = CURRENT_TIMESTAMP,
                     invalidate_reason = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND user_id = ? AND status = ?`
            ).run(decision.reason, decision.id, safeUserId, decision.status);
            result.invalidated += changed.changes;
        }
    });
    tx();
    return result;
}

/**
 * 更新一条记忆
 * @param {number} userId
 * @param {number} memoryId
 * @param {object} updates - { content, importance, memory_type, metadata, source, confidence, memory_key, pinned, category, relation_type, related_memory_id, supersedes_id }
 */
export function updateMemory(userId, memoryId, updates = {}) {
    ensureMemoryStatements();
    const safeUserId = Number(userId);
    const row = db.prepare("SELECT * FROM agent_memory WHERE id = ? AND user_id = ?").get(memoryId, safeUserId);
    if (!row) return false;

    updateMemoryStmt.run(
        String(updates.content ?? row.content),
        Math.max(0, Math.min(1, Number(updates.importance ?? row.importance) || 0.5)),
        String(updates.memory_type ?? row.memory_type),
        JSON.stringify(updates.metadata ?? safeParseJSON(row.metadata)),
        String(updates.source ?? row.source ?? "manual"),
        clampMemoryConfidence(updates.confidence ?? row.confidence, 1),
        updates.memory_key === undefined ? (row.memory_key || null) : (updates.memory_key ? String(updates.memory_key) : null),
        updates.pinned === undefined ? (row.pinned ? 1 : 0) : (updates.pinned ? 1 : 0),
        normalizeMemoryCategory(updates.category ?? row.category),
        normalizeMemoryRelation(updates.relation_type ?? row.relation_type),
        updates.related_memory_id === undefined
            ? (row.related_memory_id || null)
            : (updates.related_memory_id ? Number(updates.related_memory_id) : null),
        updates.supersedes_id === undefined
            ? (row.supersedes_id || null)
            : (updates.supersedes_id ? Number(updates.supersedes_id) : null),
        updates.expires_at === undefined
            ? (row.expires_at || null)
            : (updates.expires_at ? String(updates.expires_at) : null),
        memoryId,
        safeUserId
    );
    return true;
}

/**
 * 将候选记忆推进到 active，或标记为 rejected/invalidated。
 * approve 会在同一事务内处理 supersedes_id，保证冲突替代关系不会出现半状态。
 */
export function transitionMemory(userId, memoryId, status, reason = null) {
    ensureMemoryStatements();
    const safeUserId = Number(userId);
    const nextStatus = normalizeMemoryStatus(status, "active");
    const tx = db.transaction(() => {
        const row = db.prepare("SELECT * FROM agent_memory WHERE id = ? AND user_id = ?").get(memoryId, safeUserId);
        if (!row) return false;

        let supersededTargetId = row.supersedes_id || null;
        const replacesTopic = ["conflict", "expiration"].includes(row.relation_type);
        if (nextStatus === "active" && replacesTopic && row.memory_key) {
            const current = db.prepare(
                `SELECT id FROM agent_memory
                 WHERE user_id = ? AND memory_key = ? AND status = 'active' AND id != ?
                 ORDER BY updated_at DESC, id DESC LIMIT 1`
            ).get(safeUserId, row.memory_key, row.id);
            if (current?.id) supersededTargetId = current.id;
        }

        if (nextStatus === "active" && supersededTargetId) {
            db.prepare(
                `UPDATE agent_memory
                 SET status = 'superseded', superseded_by = ?,
                     invalidated_at = CURRENT_TIMESTAMP,
                     invalidate_reason = 'superseded_by_new_memory', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND user_id = ? AND status IN ('active', 'pending')`
            ).run(row.id, supersededTargetId, safeUserId);
        }

        db.prepare(
            `UPDATE agent_memory
             SET status = ?,
                 invalidated_at = CASE WHEN ? IN ('invalidated', 'rejected') THEN CURRENT_TIMESTAMP ELSE NULL END,
                 invalidate_reason = CASE WHEN ? IN ('invalidated', 'rejected') THEN ? ELSE NULL END,
                 supersedes_id = CASE WHEN ? = 'active' AND ? IS NOT NULL THEN ? ELSE supersedes_id END,
                 related_memory_id = CASE WHEN ? = 'active' AND ? IS NOT NULL THEN ? ELSE related_memory_id END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND user_id = ?`
        ).run(
            nextStatus,
            nextStatus,
            nextStatus,
            reason ? String(reason) : nextStatus,
            nextStatus,
            supersededTargetId,
            supersededTargetId,
            nextStatus,
            supersededTargetId,
            supersededTargetId,
            memoryId,
            safeUserId,
        );
        return true;
    });
    return tx();
}

export function proposeMemory(userId, sessionId, content, memoryType = "semantic", importance = 0.5, metadata = {}, lifecycle = {}) {
    return addMemory(userId, sessionId, content, memoryType, importance, metadata, {
        ...lifecycle,
        status: "pending",
        source: lifecycle.source || metadata?.source || "llm_extract",
    });
}

/** Return the owner-scoped topic/version chain without affecting recall metrics. */
export function getMemoryLineage(userId, memoryId) {
    ensureMemoryStatements();
    const safeUserId = Number(userId);
    const seed = db.prepare("SELECT * FROM agent_memory WHERE id = ? AND user_id = ?").get(Number(memoryId), safeUserId);
    if (!seed) return null;

    let rows;
    if (seed.memory_key) {
        rows = db.prepare(
            `SELECT * FROM agent_memory
             WHERE user_id = ? AND memory_key = ?
             ORDER BY created_at ASC, id ASC LIMIT 100`
        ).all(safeUserId, seed.memory_key);
    } else {
        rows = db.prepare(
            `SELECT * FROM agent_memory
             WHERE user_id = ? AND (id = ? OR supersedes_id = ? OR superseded_by = ? OR related_memory_id = ?)
             ORDER BY created_at ASC, id ASC LIMIT 100`
        ).all(safeUserId, seed.id, seed.id, seed.id, seed.id);
    }
    const chain = rows.map((row) => serializeMemoryRow(row, safeUserId));
    const currentActive = [...rows].reverse().find((row) => row.status === "active" && row.id !== seed.id) || null;
    const relationType = seed.relation_type || "independent";
    const impact = ["conflict", "expiration"].includes(relationType)
        ? {
            action: "supersede",
            target: currentActive ? relatedMemoryPreview(safeUserId, currentActive.id) : relatedMemoryPreview(safeUserId, seed.supersedes_id),
        }
        : relationType === "supplement"
            ? { action: "keep_both", target: relatedMemoryPreview(safeUserId, seed.related_memory_id) }
            : { action: "none", target: null };
    return { memory: serializeMemoryRow(seed, safeUserId), chain, impact };
}

/**
 * 删除单条记忆
 * @param {number} userId
 * @param {number} memoryId
 */
export function removeMemory(userId, memoryId) {
    ensureMemoryStatements();
    return deleteMemoryByIdStmt.run(memoryId, Number(userId)).changes > 0;
}

function safeParseJSON(str) {
    try { return JSON.parse(str); } catch { return {}; }
}

export function getRecentObservability(userId, limit = 30) {
    if (!selectRecentMetricsStmt) {
        initDB();
    }

    const safeUserId = Number(userId) || defaultUserId;
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 30));
    const records = selectRecentMetricsStmt.all(safeUserId, safeLimit);

    // Phase 5: 扩展 — LEFT JOIN eval_traces 获取 trace 字段
    ensureEvalStatements();
    return records.map((r) => {
        // 通过 message_id 查找最近的 trace（一个 message 可能对应多个 trace）
        const trace = db.prepare(
            `SELECT tool_call_count, error_count, agent_traversal_path, trace_id
             FROM eval_traces
             WHERE message_id = ?
             ORDER BY id DESC
             LIMIT 1`
        ).get(r.message_id);

        return {
            message_id: r.message_id,
            latency_ms: r.latency_ms,
            prompt_tokens: r.prompt_tokens,
            completion_tokens: r.completion_tokens,
            total_tokens: r.total_tokens,
            model: r.model,
            session_id: r.session_id,
            content: r.content ? r.content.slice(0, 100) : "",
            created_at: r.created_at,
            tool_call_count: trace?.tool_call_count ?? 0,
            error_count: trace?.error_count ?? 0,
            agent_traversal_path: trace?.agent_traversal_path
                ? JSON.parse(trace.agent_traversal_path)
                : [],
            trace_id: trace?.trace_id ?? null,
        };
    });
}

// ── Phase 5: Trace 存储 ──

/**
 * 保存 Trace 到 eval_traces 表
 * @param {object} trace
 * @returns {number} id
 */
export function saveTrace(trace = {}) {
    ensureEvalStatements();
    const scope = normalizeScope(trace.scope || { userId: trace.userId, tenantId: trace.tenantId });
    const userId = scope?.userId || Number(trace.userId);
    const sessionId = Number(trace.sessionId);
    if (!scope || !Number.isInteger(sessionId) || !getSessionById(userId, sessionId)) {
        throw new Error("trace ownership is required");
    }
    const result = insertTraceStmt.run(
        userId,
        sessionId,
        trace.messageId ? Number(trace.messageId) : null,
        String(trace.traceId || ""),
        trace.parentTraceId ? String(trace.parentTraceId) : null,
        String(trace.traceType || "chat"),
        JSON.stringify(trace.rootSpan || {}),
        JSON.stringify(trace.agentTraversalPath || []),
        Number(trace.toolCallCount) || 0,
        Number(trace.errorCount) || 0,
        trace.totalLatencyMs ? Number(trace.totalLatencyMs) : null,
        String(trace.model || "")
    );
    db.prepare("UPDATE eval_traces SET tenant_id = ? WHERE trace_id = ? AND user_id = ?").run(scope.tenantId, String(trace.traceId || ""), userId);
    return result.lastInsertRowid;
}

/**
 * 获取最近的 Trace 列表
 * @param {number} userId
 * @param {number} limit
 * @returns {Array}
 */
export function getRecentTraces(userId, limit = 30, scope = null) {
    ensureEvalStatements();
    const normalized = normalizeScope(scope || { userId });
    if (!normalized) return [];
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 30));
    return db.prepare(`SELECT et.trace_id, et.trace_type, et.agent_traversal_path, et.tool_call_count, et.error_count, et.total_latency_ms, et.model, et.created_at FROM eval_traces et WHERE et.user_id = ? AND et.tenant_id = ? ORDER BY et.id DESC LIMIT ?`).all(normalized.userId, normalized.tenantId, safeLimit);
}

/**
 * 按 trace_id 查询 Trace
 * @param {string} traceId
 * @returns {object|null}
 */
export function getTraceById(traceId, userId = null, scope = null) {
    ensureEvalStatements();
    const normalized = normalizeScope(scope || (userId != null ? { userId } : null));
    if (!normalized) return null;
    return db.prepare("SELECT * FROM eval_traces WHERE trace_id = ? AND user_id = ? AND tenant_id = ?").get(String(traceId), normalized.userId, normalized.tenantId) || null;
}

// ── Phase 5: 评估分数 ──

/**
 * 保存评估分数
 * @param {object} score
 * @returns {number} id
 */
export function saveEvalScore(score = {}) {
    ensureEvalStatements();
    const scope = requireScope(score.scope || { userId: score.userId, tenantId: score.tenantId }, "evaluation");
    const result = insertEvalScoreStmt.run(
        score.traceId ? String(score.traceId) : null,
        score.messageId ? Number(score.messageId) : null,
        score.testCaseId ? String(score.testCaseId) : null,
        score.runId ? String(score.runId) : null,
        String(score.dimension || ""),
        Number(score.score) || 0,
        score.judgeRationale ? String(score.judgeRationale) : null,
        score.judgeModel ? String(score.judgeModel) : null,
        String(score.scoreType || "offline"),
        scope.userId,
        scope.tenantId
    );
    return result.lastInsertRowid;
}

/**
 * 按 run_id 查询评估分数
 * @param {string} runId
 * @returns {Array}
 */
export function getScoresByRun(runId, scope = null) {
    ensureEvalStatements();
    const normalized = requireScope(scope, "scoped resource");
    return db.prepare(`SELECT * FROM eval_scores WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ? ORDER BY test_case_id, dimension`).all(String(runId), normalized.userId, normalized.tenantId);
}

/**
 * 获取评分趋势
 * @param {number} limit
 * @returns {Array}
 */
export function getScoreTrends(limit = 30, scope = null) {
    ensureEvalStatements();
    const normalized = requireScope(scope, "scoped resource");
    const rows = db.prepare(`SELECT DATE(created_at) as date, dimension, ROUND(AVG(score), 2) as avg_score FROM eval_scores WHERE score_type = 'offline' AND owner_user_id = ? AND tenant_id = ? GROUP BY DATE(created_at), dimension ORDER BY date DESC LIMIT ?`).all(normalized.userId, normalized.tenantId, limit);

    // 按日期 pivot: {date, correctness, tool_usage, conciseness, safety}
    const byDate = new Map();
    for (const row of rows) {
        if (!byDate.has(row.date)) {
            byDate.set(row.date, { date: row.date });
        }
        byDate.get(row.date)[row.dimension] = row.avg_score;
    }
    return Array.from(byDate.values());
}

/**
 * 获取指定 run 的评分趋势
 * @param {string} runId
 * @param {number} limit
 * @returns {Array}
 */
export function getScoreTrendsByRun(runId, limit = 30, scope = null) {
    ensureEvalStatements();
    const normalized = requireScope(scope, "scoped resource");
    const rows = db.prepare(`SELECT DATE(created_at) as date, dimension, ROUND(AVG(score), 2) as avg_score FROM eval_scores WHERE score_type = 'offline' AND run_id = ? AND owner_user_id = ? AND tenant_id = ? GROUP BY DATE(created_at), dimension ORDER BY date DESC LIMIT ?`).all(String(runId), normalized.userId, normalized.tenantId, limit);

    const byDate = new Map();
    for (const row of rows) {
        if (!byDate.has(row.date)) {
            byDate.set(row.date, { date: row.date });
        }
        byDate.get(row.date)[row.dimension] = row.avg_score;
    }
    return Array.from(byDate.values());
}

/**
 * 获取所有历史 run ID 列表
 * @returns {Array<{run_id: string, created_at: string}>}
 */
export function getRunIds(scope = null) {
    ensureEvalStatements();
    const normalized = requireScope(scope, "scoped resource");
    return db.prepare(`SELECT run_id, MIN(created_at) as created_at FROM eval_scores WHERE score_type = 'offline' AND owner_user_id = ? AND tenant_id = ? GROUP BY run_id ORDER BY created_at DESC LIMIT 50`).all(normalized.userId, normalized.tenantId);
}

// ── Phase 5: 用户反馈 ──

/**
 * 保存用户反馈（upsert）
 * @param {number} userId
 * @param {number} messageId
 * @param {string} rating - "thumbs_up" | "thumbs_down"
 * @param {string} comment
 * @returns {boolean}
 */
export function saveFeedback(userId, messageId, rating, comment = null, scope = null) {
    ensureEvalStatements();
    const normalized = requireScope(scope || { userId }, "feedback");
    const ownedMessage = db.prepare(
        `SELECT m.id FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id = ? AND s.user_id = ?`
    ).get(Number(messageId), Number(userId));
    if (!ownedMessage) return false;
    const result = insertFeedbackStmt.run(
        Number(userId),
        Number(messageId),
        String(rating),
        comment ? String(comment) : null
    );
    db.prepare("UPDATE eval_feedback SET tenant_id = ? WHERE user_id = ? AND message_id = ?").run(normalized.tenantId, normalized.userId, Number(messageId));
    return result.changes > 0;
}

/**
 * 删除用户对某条消息的反馈（切换取消）
 * @param {number} userId
 * @param {number} messageId
 * @returns {boolean}
 */
export function deleteFeedback(userId, messageId) {
    ensureEvalStatements();
    const result = deleteFeedbackStmt.run(Number(userId), Number(messageId));
    return result.changes > 0;
}

/**
 * 获取用户对某条消息的反馈
 * @param {number} userId
 * @param {number} messageId
 * @returns {object|null}
 */
export function getFeedbackByMessage(userId, messageId, scope = null) {
    ensureEvalStatements();
    const normalized = normalizeScope(scope || { userId });
    if (!normalized) return null;
    return db.prepare("SELECT rating, comment FROM eval_feedback WHERE user_id = ? AND tenant_id = ? AND message_id = ?").get(normalized.userId, normalized.tenantId, Number(messageId)) || null;
}

/**
 * 获取用户的反馈汇总
 * @param {number} userId
 * @returns {{ thumbs_up: number, thumbs_down: number, total: number }}
 */
export function getFeedbackSummary(userId, scope = null) {
    ensureEvalStatements();
    const normalized = normalizeScope(scope || { userId });
    if (!normalized) return { thumbs_up: 0, thumbs_down: 0, total: 0 };
    const rows = db.prepare("SELECT rating, COUNT(*) as count FROM eval_feedback WHERE user_id = ? AND tenant_id = ? GROUP BY rating").all(normalized.userId, normalized.tenantId);
    const result = { thumbs_up: 0, thumbs_down: 0, total: 0 };
    for (const row of rows) {
        if (row.rating === "thumbs_up") result.thumbs_up = row.count;
        else if (row.rating === "thumbs_down") result.thumbs_down = row.count;
        result.total += row.count;
    }
    return result;
}

/**
 * Owner-scoped, content-free evidence for M12 cross-source impact reports.
 * Only feedback labels and the linked Trace root span are returned; the eval
 * layer strips the span down to cross_source_recall metadata before output.
 */
export function getCrossSourceFeedbackEvidence(scope, limit = 200) {
    ensureEvalStatements();
    const normalized = normalizeScope(scope);
    if (!normalized) return [];
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
    return db.prepare(`
        SELECT f.user_id, f.message_id, f.rating, f.created_at AS feedback_created_at,
               et.trace_id, et.root_span
        FROM eval_feedback f
        LEFT JOIN eval_traces et ON et.id = (
            SELECT latest.id
            FROM eval_traces latest
            WHERE latest.message_id = f.message_id
              AND latest.user_id = f.user_id
              AND latest.tenant_id = f.tenant_id
            ORDER BY latest.id DESC
            LIMIT 1
        )
        WHERE f.user_id = ? AND f.tenant_id = ?
        ORDER BY f.id DESC
        LIMIT ?
    `).all(normalized.userId, normalized.tenantId, safeLimit);
}

/**
 * List scopes that have feedback or experiment traces. Used only by the
 * opt-in background sampler; the returned values contain no message content.
 */
export function getCrossSourceExperimentScopes(limit = 100) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    return db.prepare(`
        SELECT user_id AS userId, tenant_id AS tenantId
        FROM eval_feedback
        WHERE tenant_id IS NOT NULL
        GROUP BY user_id, tenant_id
        UNION
        SELECT user_id AS userId, tenant_id AS tenantId
        FROM eval_traces
        WHERE tenant_id IS NOT NULL AND root_span LIKE '%cross_source_experiment%'
        GROUP BY user_id, tenant_id
        LIMIT ?
    `).all(safeLimit);
}

/** Persist a sanitized aggregate experiment report for an owner scope. */
export function saveCrossSourceExperimentReport(scope, {
    reportKey,
    periodStart = null,
    periodEnd = null,
    experimentKey = null,
    configVersionId = null,
    report,
} = {}) {
    const normalized = requireScope(scope, "cross-source experiment report");
    if (!report || typeof report !== "object") throw new Error("experiment report is required");
    const result = db.prepare(`
        INSERT INTO cross_source_experiment_reports
            (owner_user_id, tenant_id, report_key, period_start, period_end, experiment_key, config_version_id, report_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        normalized.userId,
        normalized.tenantId,
        String(reportKey || "cross-source-experiment"),
        periodStart,
        periodEnd,
        experimentKey == null ? null : String(experimentKey),
        configVersionId == null ? null : Number(configVersionId) || null,
        JSON.stringify(report),
    );
    return Number(result.lastInsertRowid);
}

/** Read recent aggregate reports without exposing raw trace or feedback data. */
export function listCrossSourceExperimentReports(scope, limit = 50) {
    const normalized = requireScope(scope, "cross-source experiment report");
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    return db.prepare(`
        SELECT id, report_key, period_start, period_end, experiment_key,
               config_version_id, report_json, created_at
        FROM cross_source_experiment_reports
        WHERE owner_user_id = ? AND tenant_id = ?
        ORDER BY id DESC
        LIMIT ?
    `).all(normalized.userId, normalized.tenantId, safeLimit).map((row) => {
        let report = {};
        try { report = JSON.parse(row.report_json || "{}"); } catch { /* corrupt report remains inspectable as metadata */ }
        return { ...row, report_json: undefined, report };
    });
}

export function getCrossSourceExperimentReport(scope, reportId) {
    const normalized = requireScope(scope, "cross-source experiment report");
    const id = Number(reportId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const row = db.prepare(`
        SELECT id, report_key, period_start, period_end, experiment_key,
               config_version_id, report_json, created_at
        FROM cross_source_experiment_reports
        WHERE id = ? AND owner_user_id = ? AND tenant_id = ?
    `).get(id, normalized.userId, normalized.tenantId);
    if (!row) return null;
    let report = {};
    try { report = JSON.parse(row.report_json || "{}"); } catch { /* keep metadata readable */ }
    return { ...row, report_json: undefined, report };
}

/**
 * Claim one owner-scoped sampler job. SQLite serializes the short write
 * transaction, while holder_token prevents a stale worker from completing a
 * lease it no longer owns.
 */
export function claimCrossSourceExperimentJob(scope, {
    jobName = "cross-source-daily-report",
    holderToken,
    leaseSeconds = 120,
} = {}) {
    const normalized = requireScope(scope, "cross-source experiment job");
    const token = String(holderToken || "");
    if (!token) throw new Error("job holder token is required");
    const safeLease = Math.max(30, Math.min(3600, Number(leaseSeconds) || 120));
    const name = String(jobName || "cross-source-daily-report");
    const result = db.transaction(() => {
        db.prepare(`
            INSERT OR IGNORE INTO cross_source_experiment_jobs
                (owner_user_id, tenant_id, job_name, next_run_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `).run(normalized.userId, normalized.tenantId, name);
        return db.prepare(`
            UPDATE cross_source_experiment_jobs
            SET status = 'running', holder_token = ?,
                lease_expires_at = datetime('now', '+' || ? || ' seconds'),
                attempt_count = attempt_count + 1,
                last_error_code = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE owner_user_id = ? AND tenant_id = ? AND job_name = ?
              AND (holder_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
              AND (next_run_at IS NULL OR next_run_at <= CURRENT_TIMESTAMP)
        `).run(token, safeLease, normalized.userId, normalized.tenantId, name).changes > 0;
    })();
    return Boolean(result);
}

export function completeCrossSourceExperimentJob(scope, {
    jobName = "cross-source-daily-report",
    holderToken,
    reportId = null,
    nextRunSeconds = 900,
} = {}) {
    const normalized = requireScope(scope, "cross-source experiment job");
    const safeDelay = Math.max(60, Math.min(24 * 60 * 60, Number(nextRunSeconds) || 900));
    return db.prepare(`
        UPDATE cross_source_experiment_jobs
        SET status = 'ready', holder_token = NULL, lease_expires_at = NULL,
            last_run_at = CURRENT_TIMESTAMP,
            last_report_id = ?,
            next_run_at = datetime('now', '+' || ? || ' seconds'),
            updated_at = CURRENT_TIMESTAMP
        WHERE owner_user_id = ? AND tenant_id = ? AND job_name = ? AND holder_token = ?
    `).run(
        reportId == null ? null : Number(reportId) || null,
        safeDelay,
        normalized.userId,
        normalized.tenantId,
        String(jobName || "cross-source-daily-report"),
        String(holderToken || ""),
    ).changes > 0;
}

export function failCrossSourceExperimentJob(scope, {
    jobName = "cross-source-daily-report",
    holderToken,
    errorCode = "REPORT_FAILED",
    retrySeconds = 300,
} = {}) {
    const normalized = requireScope(scope, "cross-source experiment job");
    const safeDelay = Math.max(60, Math.min(24 * 60 * 60, Number(retrySeconds) || 300));
    return db.prepare(`
        UPDATE cross_source_experiment_jobs
        SET status = 'ready', holder_token = NULL, lease_expires_at = NULL,
            last_error_code = ?,
            next_run_at = datetime('now', '+' || ? || ' seconds'),
            updated_at = CURRENT_TIMESTAMP
        WHERE owner_user_id = ? AND tenant_id = ? AND job_name = ? AND holder_token = ?
    `).run(
        String(errorCode || "REPORT_FAILED").slice(0, 100),
        safeDelay,
        normalized.userId,
        normalized.tenantId,
        String(jobName || "cross-source-daily-report"),
        String(holderToken || ""),
    ).changes > 0;
}

export function getCrossSourceExperimentJob(scope, jobName = "cross-source-daily-report") {
    const normalized = requireScope(scope, "cross-source experiment job");
    return db.prepare(`
        SELECT job_name, status, lease_expires_at, next_run_at, last_run_at,
               last_report_id, attempt_count, last_error_code, updated_at
        FROM cross_source_experiment_jobs
        WHERE owner_user_id = ? AND tenant_id = ? AND job_name = ?
    `).get(normalized.userId, normalized.tenantId, String(jobName)) || null;
}

/** Record a manual release/hold/rollback decision; this function never applies it. */
export function saveCrossSourceExperimentApproval(scope, {
    reportId = null,
    action,
    fromConfigVersionId = null,
    targetConfigVersionId = null,
    note = null,
    actorUserId,
} = {}) {
    const normalized = requireScope(scope, "cross-source experiment approval");
    const allowedActions = new Set(["approve_canary", "keep_control", "rollback", "review"]);
    if (!allowedActions.has(String(action))) throw new Error("invalid experiment approval action");
    const actor = Number(actorUserId || normalized.userId);
    if (!Number.isInteger(actor) || actor <= 0) throw new Error("approval actor is required");
    const normalizedReportId = reportId == null ? null : Number(reportId) || null;
    if (normalizedReportId !== null) {
        const report = db.prepare(`
            SELECT id FROM cross_source_experiment_reports
            WHERE id = ? AND owner_user_id = ? AND tenant_id = ?
        `).get(normalizedReportId, normalized.userId, normalized.tenantId);
        if (!report) throw new Error("experiment report not found");
    }
    const result = db.prepare(`
        INSERT INTO cross_source_experiment_approvals
            (report_id, owner_user_id, tenant_id, action, from_config_version_id,
             target_config_version_id, note, actor_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        normalizedReportId,
        normalized.userId,
        normalized.tenantId,
        String(action),
        fromConfigVersionId == null ? null : Number(fromConfigVersionId) || null,
        targetConfigVersionId == null ? null : Number(targetConfigVersionId) || null,
        note == null ? null : String(note).slice(0, 1000),
        actor,
    );
    return Number(result.lastInsertRowid);
}

export function listCrossSourceExperimentApprovals(scope, limit = 50) {
    const normalized = requireScope(scope, "cross-source experiment approval");
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    return db.prepare(`
        SELECT id, report_id, action, from_config_version_id,
               target_config_version_id, note, actor_user_id, created_at
        FROM cross_source_experiment_approvals
        WHERE owner_user_id = ? AND tenant_id = ?
        ORDER BY id DESC
        LIMIT ?
    `).all(normalized.userId, normalized.tenantId, safeLimit);
}

// ── Phase 6b G6: Metric 聚合查询 ──

/**
 * 获取时间窗口内的全部延迟数据（用于百分位计算）
 * @param {string} cutoff — ISO 时间字符串
 * @returns {Array<{latency_ms: number, created_at: string}>}
 */
export function getMetricsLatencies(userId, cutoff) {
    const rows = db.prepare(
        `SELECT mm.latency_ms, mm.created_at
         FROM message_metrics mm
         JOIN messages m ON m.id = mm.message_id
         JOIN sessions s ON s.id = m.session_id
         WHERE s.user_id = ? AND mm.created_at >= ?
         ORDER BY mm.created_at`
    ).all(userId, cutoff);
    return rows;
}

/**
 * 获取时间窗口内的全部 token 数据
 * @param {string} cutoff — ISO 时间字符串
 * @returns {Array<{prompt_tokens: number, completion_tokens: number, total_tokens: number, model: string, created_at: string}>}
 */
export function getMetricsTokens(userId, cutoff) {
    const rows = db.prepare(
        `SELECT mm.prompt_tokens, mm.completion_tokens, mm.total_tokens, mm.model, mm.created_at
         FROM message_metrics mm
         JOIN messages m ON m.id = mm.message_id
         JOIN sessions s ON s.id = m.session_id
         WHERE s.user_id = ? AND mm.created_at >= ?
         ORDER BY mm.created_at`
    ).all(userId, cutoff);
    return rows;
}

/**
 * 获取时间窗口内的 Trace 统计数据（按用户过滤）
 * @param {number} userId
 * @param {string} cutoff — ISO 时间字符串
 * @returns {Array<{tool_call_count: number, error_count: number, agent_traversal_path: string, total_latency_ms: number, trace_type: string, created_at: string}>}
 */
export function getMetricsTraces(userId, cutoff) {
    const rows = db.prepare(
        `SELECT tool_call_count, error_count, agent_traversal_path, total_latency_ms, trace_type, created_at
         FROM eval_traces WHERE user_id = ? AND created_at >= ? ORDER BY created_at`
    ).all(userId, cutoff);
    return rows;
}

/**
 * 获取时间窗口内的每日聚合数据
 * @param {string} cutoff — ISO 时间字符串
 * @returns {Array<{day: string, count: number, avg_latency: number|null, avg_tokens: number|null}>}
 */
export function getMetricsDailyBuckets(userId, cutoff) {
    const rows = db.prepare(
        `SELECT DATE(mm.created_at) as day,
                COUNT(*) as count,
                AVG(mm.latency_ms) as avg_latency,
                AVG(mm.total_tokens) as avg_tokens
         FROM message_metrics mm
         JOIN messages m ON m.id = mm.message_id
         JOIN sessions s ON s.id = m.session_id
         WHERE s.user_id = ? AND mm.created_at >= ?
         GROUP BY DATE(mm.created_at) ORDER BY day`
    ).all(userId, cutoff);
    return rows;
}

// ══════════════════════════════════════════════════════════
// Phase 6b G7: 评测集自动生成 — 生成用例 CRUD
// ══════════════════════════════════════════════════════════

/**
 * 保存一条生成的测试用例
 * @param {object} tc
 * @param {string} tc.id
 * @param {string} tc.category
 * @param {string} tc.difficulty
 * @param {string} tc.description
 * @param {string} tc.input
 * @param {string} tc.expectedBehavior
 * @param {string[]} tc.expectedTools
 * @param {boolean} [tc.enableWebSearch]
 * @param {object[]} [tc.codeChecks]
 * @param {number} [tc.generated] — 1=LLM生成, 0=手动
 * @param {number} [tc.reviewed] — 0=待审核, 1=已审核
 * @param {string[]} [tc.sourceSeeds]
 * @param {string} [tc.genBatchId]
 */
export function insertGeneratedTestCase({
    id,
    category,
    difficulty = "medium",
    description = "",
    input,
    expectedBehavior = "",
    expectedTools = [],
    enableWebSearch = 0,
    codeChecks = null,
    generated = 1,
    reviewed = 0,
    sourceSeeds = [],
    genBatchId = null,
    scope = null,
}) {
    const normalizedScope = normalizeScope(scope);
    if (!normalizedScope) throw new Error("test case ownership is required");
    if (!insertGeneratedTestCaseStmt) {
        insertGeneratedTestCaseStmt = db.prepare(
            `INSERT INTO eval_test_cases
                (id, category, difficulty, description, input, expected_behavior,
                 expected_tools, enable_web_search, code_checks,
                 generated, reviewed, source_seeds, gen_batch_id, owner_user_id, tenant_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        );
    }
    return insertGeneratedTestCaseStmt.run(
        id,
        category,
        difficulty,
        description,
        input,
        expectedBehavior,
        JSON.stringify(expectedTools),
        enableWebSearch ? 1 : 0,
        codeChecks ? JSON.stringify(codeChecks) : null,
        generated ? 1 : 0,
        reviewed ? 1 : 0,
        JSON.stringify(sourceSeeds),
        genBatchId,
        normalizedScope.userId,
        normalizedScope.tenantId,
    );
}

/**
 * 查询生成的测试用例
 * @param {object} filters
 * @param {string} [filters.category]
 * @param {number|null} [filters.reviewed] — 0=待审核, 1=已审核, null=全部
 * @param {number} [filters.page] — 分页页码 (1-based)
 * @param {number} [filters.pageSize] — 每页条数
 * @returns {object[]}
 */
export function getGeneratedTestCases({
    category = null,
    reviewed = null,
    page = 1,
    pageSize = 50,
    scope = null,
} = {}) {
    const normalizedScope = normalizeScope(scope);
    if (!normalizedScope) return [];
    let where = ["owner_user_id = ?", "tenant_id = ?"];
    let params = [normalizedScope.userId, normalizedScope.tenantId];

    if (category) {
        where.push("category = ?");
        params.push(category);
    }
    if (reviewed !== null && reviewed !== undefined) {
        where.push("reviewed = ?");
        params.push(reviewed ? 1 : 0);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const offset = (page - 1) * pageSize;

    const rows = db.prepare(
        `SELECT * FROM eval_test_cases ${whereClause}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);

    return rows.map(r => ({
        ...r,
        expected_tools: safeJsonParse(r.expected_tools, []),
        code_checks: safeJsonParse(r.code_checks, null),
        source_seeds: safeJsonParse(r.source_seeds, []),
    }));
}

/**
 * 获取单条生成用例
 * @param {string} id
 * @returns {object|null}
 */
export function getGeneratedTestCaseById(id, scope = null) {
    if (!selectGeneratedTestCaseByIdStmt) {
        selectGeneratedTestCaseByIdStmt = db.prepare(
            "SELECT * FROM eval_test_cases WHERE id = ?"
        );
    }
    const normalizedScope = normalizeScope(scope);
    if (!normalizedScope) return null;
    const row = db.prepare("SELECT * FROM eval_test_cases WHERE id = ? AND owner_user_id = ? AND tenant_id = ?").get(id, normalizedScope.userId, normalizedScope.tenantId);
    if (!row) return null;
    return {
        ...row,
        expected_tools: safeJsonParse(row.expected_tools, []),
        code_checks: safeJsonParse(row.code_checks, null),
        source_seeds: safeJsonParse(row.source_seeds, []),
    };
}

/**
 * 更新一条生成用例（编辑/审核）
 * @param {string} id
 * @param {object} updates
 * @returns {boolean}
 */
export function updateGeneratedTestCase(id, updates = {}, scope = null) {
    const normalizedScope = normalizeScope(scope);
    if (!normalizedScope) return false;
    if (!updateGeneratedTestCaseStmt) {
        updateGeneratedTestCaseStmt = db.prepare(
            `UPDATE eval_test_cases
             SET input = COALESCE(?, input),
                 expected_behavior = COALESCE(?, expected_behavior),
                 expected_tools = COALESCE(?, expected_tools),
                 difficulty = COALESCE(?, difficulty),
                 category = COALESCE(?, category),
                 description = COALESCE(?, description),
                 reviewed = COALESCE(?, reviewed),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND owner_user_id = ? AND tenant_id = ?`
        );
    }
    const result = updateGeneratedTestCaseStmt.run(
        updates.input ?? null,
        updates.expectedBehavior ?? null,
        updates.expectedTools ? JSON.stringify(updates.expectedTools) : null,
        updates.difficulty ?? null,
        updates.category ?? null,
        updates.description ?? null,
        updates.reviewed !== undefined ? (updates.reviewed ? 1 : 0) : null,
        id,
        normalizedScope.userId,
        normalizedScope.tenantId,
    );
    return result.changes > 0;
}

/**
 * 批量审核生成用例
 * @param {string[]} ids
 * @returns {number} 实际更新的行数
 */
export function approveGeneratedTestCases(ids) {
    if (!ids || ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = db.prepare(
        `UPDATE eval_test_cases SET reviewed = 1, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`
    ).run(...ids);
    return result.changes;
}

/**
 * 删除一条生成用例
 * @param {string} id
 * @returns {boolean}
 */
export function deleteGeneratedTestCase(id, scope = null) {
    const normalizedScope = normalizeScope(scope);
    if (!normalizedScope) return false;
    if (!deleteGeneratedTestCaseStmt) {
        deleteGeneratedTestCaseStmt = db.prepare(
            "DELETE FROM eval_test_cases WHERE id = ? AND owner_user_id = ? AND tenant_id = ?"
        );
    }
    const result = deleteGeneratedTestCaseStmt.run(id, normalizedScope.userId, normalizedScope.tenantId);
    return result.changes > 0;
}

/**
 * 获取所有生成用例的 ID 列表
 * @param {object} filters
 * @param {string} [filters.category]
 * @param {number|null} [filters.reviewed]
 * @returns {string[]}
 */
export function getGeneratedTestCaseIds({ category = null, reviewed = null, scope = null } = {}) {
    const normalizedScope = normalizeScope(scope);
    if (!normalizedScope) return [];
    let where = ["owner_user_id = ?", "tenant_id = ?"];
    let params = [normalizedScope.userId, normalizedScope.tenantId];

    if (category) {
        where.push("category = ?");
        params.push(category);
    }
    if (reviewed !== null && reviewed !== undefined) {
        where.push("reviewed = ?");
        params.push(reviewed ? 1 : 0);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db.prepare(
        `SELECT id FROM eval_test_cases ${whereClause} ORDER BY created_at DESC`
    ).all(...params);
    return rows.map(r => r.id);
}

/** 安全 JSON 解析 */
function safeJsonParse(str, fallback) {
    if (!str) return fallback;
    try { return JSON.parse(str); } catch { return fallback; }
}

// ══════════════════════════════════════════════════════════
// Phase 6c G10: 优化闭环 — 日志 CRUD
// ══════════════════════════════════════════════════════════

function ensureOptimizationLogStatements() {
    if (!selectOptimizationLogsStmt) {
        selectOptimizationLogsStmt = db.prepare(
            "SELECT * FROM optimization_log ORDER BY created_at DESC LIMIT ?"
        );
    }
    if (!selectOptimizationLogByIdStmt) {
        selectOptimizationLogByIdStmt = db.prepare(
            "SELECT * FROM optimization_log WHERE id = ?"
        );
    }
    if (!updateOptimizationLogStmt) {
        updateOptimizationLogStmt = db.prepare(
            `UPDATE optimization_log
             SET target_run_id = COALESCE(?, target_run_id),
                 score_after = COALESCE(?, score_after),
                 status = COALESCE(?, status)
             WHERE id = ?`
        );
    }
}

/**
 * 保存优化日志
 * @param {object} log
 * @returns {number} id
 */
export function createEvalRun(runId, scope, configVersionId = null) {
    if (!insertEvalRunStmt) initDB();
    const normalized = normalizeScope(scope);
    if (!normalized) throw new Error("evaluation ownership is required");
    try {
        insertEvalRunStmt.run(String(runId), normalized.userId, normalized.tenantId, configVersionId ? Number(configVersionId) : null, "running");
    } catch (error) {
        if (String(error?.code || "").includes("CONSTRAINT")) {
            const conflict = new Error("evaluation run already exists");
            conflict.code = "RESOURCE_CONFLICT";
            conflict.statusCode = 409;
            throw conflict;
        }
        throw error;
    }
    return getEvalRun(runId, normalized);
}

export function getEvalRun(runId, scope) {
    if (!selectEvalRunStmt) initDB();
    const normalized = normalizeScope(scope);
    if (!normalized) return null;
    return selectEvalRunStmt.get(String(runId), normalized.userId, normalized.tenantId) || null;
}

export function completeEvalRun(runId, scope, status = "completed") {
    if (!completeEvalRunStmt) initDB();
    const normalized = requireScope(scope, "scoped resource");
    return completeEvalRunStmt.run(String(status), String(runId), normalized.userId, normalized.tenantId).changes > 0;
}

export function reserveChatIdempotency(scope, key, requestHash) {
    if (!insertChatIdempotencyStmt) initDB();
    const normalized = requireScope(scope, "chat idempotency");
    const normalizedKey = String(key || "").trim();
    const normalizedHash = String(requestHash || "").trim();
    if (!normalizedKey || normalizedKey.length > 200 || !normalizedHash) {
        throw new Error("invalid chat idempotency key");
    }
    const newAttemptToken = () => crypto.randomUUID();
    try {
        const attemptToken = newAttemptToken();
        insertChatIdempotencyStmt.run(normalized.userId, normalized.tenantId, normalizedKey, normalizedHash, attemptToken);
        db.prepare(`UPDATE chat_idempotency SET attempt_token = ?, lease_expires_at = datetime('now', '+15 minutes')
            WHERE owner_user_id = ? AND tenant_id = ? AND idempotency_key = ? AND attempt_token IS NULL`)
            .run(attemptToken, normalized.userId, normalized.tenantId, normalizedKey);
        return { status: "reserved", requestHash: normalizedHash, attemptToken, created: true };
    } catch (error) {
        if (!String(error?.code || "").includes("CONSTRAINT")) throw error;
        const existing = selectChatIdempotencyStmt.get(normalized.userId, normalized.tenantId, normalizedKey);
        if (!existing) throw error;
        if (existing.request_hash !== normalizedHash) return { status: "conflict", existing };
        if (existing.status === "reserved" || existing.status === "started") {
            // A process can crash after reserving or starting a request. Reclaim
            // only an expired lease, and let SQLite's conditional UPDATE choose
            // a single winner when multiple clients retry concurrently.
            const attemptToken = newAttemptToken();
            const reclaimed = db.prepare(`UPDATE chat_idempotency SET
                status = 'reserved', stream_started = 0, response_json = NULL,
                failure_code = NULL, attempt_count = COALESCE(attempt_count, 0) + 1,
                attempt_token = ?, lease_expires_at = datetime('now', '+15 minutes'),
                updated_at = CURRENT_TIMESTAMP
                WHERE owner_user_id = ? AND tenant_id = ? AND idempotency_key = ?
                  AND request_hash = ? AND status IN ('reserved', 'started')
                  AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)`)
                .run(attemptToken, normalized.userId, normalized.tenantId, normalizedKey, normalizedHash);
            if (reclaimed.changes > 0) {
                return {
                    status: "reserved",
                    requestHash: normalizedHash,
                    attemptToken,
                    userMessageId: existing.user_message_id || null,
                    reclaimed: true,
                };
            }

            const current = selectChatIdempotencyStmt.get(normalized.userId, normalized.tenantId, normalizedKey);
            return {
                status: "started",
                requestHash: current?.request_hash || normalizedHash,
                streamStarted: Boolean(current?.stream_started),
                attemptToken: current?.attempt_token || null,
                userMessageId: current?.user_message_id || null,
            };
        }
        if (existing.status === "failed") {
            const attemptToken = newAttemptToken();
            const claimed = db.prepare(`UPDATE chat_idempotency SET status = 'reserved', stream_started = 0,
                response_json = NULL, failure_code = NULL, attempt_count = COALESCE(attempt_count, 0) + 1,
                attempt_token = ?, lease_expires_at = datetime('now', '+15 minutes'), updated_at = CURRENT_TIMESTAMP
                WHERE owner_user_id = ? AND tenant_id = ? AND idempotency_key = ? AND request_hash = ? AND status = 'failed'`)
                .run(attemptToken, normalized.userId, normalized.tenantId, normalizedKey, normalizedHash);
            if (claimed.changes === 0) return { status: "started", requestHash: normalizedHash };
            return { status: "reserved", requestHash: normalizedHash, attemptToken, userMessageId: existing.user_message_id || null };
        }
        return {
            status: existing.status,
            requestHash: existing.request_hash,
            streamStarted: Boolean(existing.stream_started),
            userMessageId: existing.user_message_id || null,
            response: existing.response_json ? safeJsonParse(existing.response_json, null) : null,
        };
    }
}

export function markChatIdempotencyStarted(scope, key, attemptToken) {
    if (!updateChatIdempotencyStmt) initDB();
    const normalized = requireScope(scope, "chat idempotency");
    if (!attemptToken) return false;
    return updateChatIdempotencyStmt.run("started", 1, null, normalized.userId, normalized.tenantId, String(key), String(attemptToken)).changes > 0;
}

export function completeChatIdempotency(scope, key, response = null, assistantMessageId = null, attemptToken = null) {
    if (!updateChatIdempotencyResultStmt) initDB();
    const normalized = requireScope(scope, "chat idempotency");
    if (!attemptToken) return false;
    return updateChatIdempotencyResultStmt.run(
        "completed", 1, response == null ? null : JSON.stringify(response),
        assistantMessageId == null ? null : Number(assistantMessageId), null,
        normalized.userId, normalized.tenantId, String(key), String(attemptToken)
    ).changes > 0;
}

export function failChatIdempotency(scope, key, failureCode = null, attemptToken = null) {
    if (!updateChatIdempotencyResultStmt) initDB();
    const normalized = requireScope(scope, "chat idempotency");
    if (!attemptToken) return false;
    return updateChatIdempotencyResultStmt.run(
        "failed", 0, null, null, failureCode ? String(failureCode).slice(0, 80) : null,
        normalized.userId, normalized.tenantId, String(key), String(attemptToken)
    ).changes > 0;
}

export function setChatIdempotencyUserMessage(scope, key, messageId, attemptToken = null) {
    if (!updateChatIdempotencyUserMessageStmt) initDB();
    const normalized = requireScope(scope, "chat idempotency");
    const token = attemptToken == null ? null : String(attemptToken);
    return updateChatIdempotencyUserMessageStmt.run(
        Number(messageId), normalized.userId, normalized.tenantId, String(key), token, token
    ).changes > 0;
}

export function getChatIdempotency(scope, key) {
    if (!selectChatIdempotencyStmt) initDB();
    const normalized = requireScope(scope, "chat idempotency");
    const row = selectChatIdempotencyStmt.get(normalized.userId, normalized.tenantId, String(key));
    if (!row) return null;
    return { ...row, stream_started: Boolean(row.stream_started), response: safeJsonParse(row.response_json, null) };
}

export function insertMCPServerConfig(config = {}, scope = null) {
    if (!insertMCPConfigStmt) initDB();
    const normalized = requireScope(scope, "MCP server");
    const result = insertMCPConfigStmt.run(
        String(config.name), "user", normalized.userId, normalized.tenantId,
        "mcp", String(config.command || ""), JSON.stringify(config.args || []),
        config.cwd ? String(config.cwd) : null,
        JSON.stringify(config.env || {}), config.enabled === false ? 0 : 1,
        config.connectionStatus || "connected"
    );
    return Number(result.lastInsertRowid);
}

export function listMCPServerConfigs(scope = null) {
    if (!selectMCPConfigsStmt) initDB();
    const normalized = requireScope(scope, "scoped resource");
    return selectMCPConfigsStmt.all(normalized.userId, normalized.tenantId).map((row) => ({
        ...row,
        args: safeJsonParse(row.args, []),
        env_refs: safeJsonParse(row.env_refs, {}),
    }));
}

export function getMCPServerConfig(name, scope = null) {
    if (!selectMCPConfigStmt) initDB();
    const normalized = normalizeScope(scope);
    if (!normalized) return null;
    const row = selectMCPConfigStmt.get(String(name), normalized.userId, normalized.tenantId);
    if (!row) return null;
    return { ...row, args: safeJsonParse(row.args, []), env_refs: safeJsonParse(row.env_refs, {}) };
}

export function deleteMCPServerConfig(name, scope = null) {
    if (!deleteMCPConfigStmt) initDB();
    const normalized = requireScope(scope, "scoped resource");
    const row = getMCPServerConfig(name, normalized);
    if (!row || row.scope_type !== "user") return false;
    return deleteMCPConfigStmt.run(row.id, normalized.userId, normalized.tenantId).changes > 0;
}

export function updateMCPServerConfigStatus(name, scope, enabled, status = "disconnected") {
    if (!updateMCPConfigStatusStmt) initDB();
    const normalized = requireScope(scope, "scoped resource");
    const row = getMCPServerConfig(name, normalized);
    if (!row || row.scope_type !== "user") return false;
    return updateMCPConfigStatusStmt.run(enabled ? 1 : 0, String(status), row.id, normalized.userId, normalized.tenantId).changes > 0;
}

function ensureMcpEvalTables() {
    if (!hasTable("mcp_operation_observations") || !hasTable("mcp_eval_runs") || !hasTable("mcp_eval_case_results")) initDB();
}

function parseMcpJson(value, fallback) {
    try { return JSON.parse(value || ""); } catch { return fallback; }
}

export function saveMcpOperationObservation(record = {}) {
    ensureMcpEvalTables();
    const scope = requireScope({ userId: record.owner_user_id, tenantId: record.tenant_id }, "MCP observation");
    const operationId = String(record.operation_id || crypto.randomUUID());
    db.prepare(`INSERT OR REPLACE INTO mcp_operation_observations
        (operation_id, owner_user_id, tenant_id, request_id, trace_id, span_id,
         server_name, tool_name, operation, status, error_code, duration_ms,
         attempt_count, schema_status, subtask_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`).run(
        operationId,
        scope.userId,
        scope.tenantId,
        record.request_id ? String(record.request_id) : null,
        record.trace_id ? String(record.trace_id) : null,
        record.span_id ? String(record.span_id) : null,
        String(record.server_name || "unknown"),
        record.tool_name ? String(record.tool_name) : null,
        String(record.operation || "call_tool"),
        String(record.status || "transport_error"),
        record.error_code ? String(record.error_code) : null,
        Math.max(0, Number(record.duration_ms) || 0),
        Math.max(0, Number(record.attempt_count) || 0),
        String(record.schema_status || "not_checked"),
        record.subtask_id ? String(record.subtask_id) : null,
        record.created_at ? String(record.created_at).replace("T", " ").replace("Z", "") : null,
    );
    return operationId;
}

export function listMcpOperationObservations(scope = null, {
    window = "7d", serverName = null, toolName = null, status = null,
    traceId = null, limit = 100, offset = 0,
} = {}) {
    ensureMcpEvalTables();
    const normalized = requireScope(scope, "MCP observations");
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const clauses = ["owner_user_id = ?", "tenant_id = ?"];
    const params = [normalized.userId, normalized.tenantId];
    if (window !== "all") {
        const days = window === "30d" ? 30 : 7;
        clauses.push("created_at >= datetime('now', ?)");
        params.push(`-${days} days`);
    }
    if (serverName) { clauses.push("server_name = ?"); params.push(String(serverName)); }
    if (toolName) { clauses.push("tool_name = ?"); params.push(String(toolName)); }
    if (status) { clauses.push("status = ?"); params.push(String(status)); }
    if (traceId) { clauses.push("trace_id = ?"); params.push(String(traceId)); }
    params.push(safeLimit, safeOffset);
    return db.prepare(`SELECT * FROM mcp_operation_observations
        WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params);
}

export function createMcpEvalRun({ runId, datasetVersion, caseIds = [], configId = null, variant = "fixture", baselineRunId = null, scope } = {}) {
    ensureMcpEvalTables();
    const normalized = requireScope(scope, "MCP evaluation");
    const id = String(runId || crypto.randomUUID());
    db.prepare(`INSERT INTO mcp_eval_runs
        (run_id, owner_user_id, tenant_id, dataset_version, case_ids_json, config_id, variant, status, baseline_run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`).run(
        id, normalized.userId, normalized.tenantId, String(datasetVersion || "mcp-fixture-v1"),
        JSON.stringify(caseIds.map(String)), configId ? String(configId) : null, String(variant || "fixture"),
        baselineRunId ? String(baselineRunId) : null,
    );
    return id;
}

export function saveMcpEvalCaseResult(result = {}, scope = null) {
    ensureMcpEvalTables();
    const normalized = requireScope(scope || { userId: result.owner_user_id, tenantId: result.tenant_id }, "MCP evaluation result");
    db.prepare(`INSERT OR REPLACE INTO mcp_eval_case_results
        (run_id, case_id, owner_user_id, tenant_id, layer, status, checks_json,
         failure_class, observation_ids_json, trace_ids_json, duration_ms, sample_json, evidence_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        String(result.run_id), String(result.case_id), normalized.userId, normalized.tenantId,
        String(result.layer), String(result.status), JSON.stringify(result.checks || []),
        result.failure_class ? String(result.failure_class) : null,
        JSON.stringify(result.observation_ids || []), JSON.stringify(result.trace_ids || []),
        Math.max(0, Number(result.duration_ms) || 0), JSON.stringify(result.sample || {}),
        result.evidence_summary ? String(result.evidence_summary).slice(0, 500) : null,
    );
}

export function completeMcpEvalRun(runId, { status = "completed", summary = {} } = {}, scope = null) {
    ensureMcpEvalTables();
    const normalized = requireScope(scope, "MCP evaluation");
    return db.prepare(`UPDATE mcp_eval_runs SET status = ?, summary_json = ?, completed_at = CURRENT_TIMESTAMP
        WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ?`).run(
        String(status), JSON.stringify(summary || {}), String(runId), normalized.userId, normalized.tenantId,
    ).changes > 0;
}

function normalizeMcpRun(row) {
    if (!row) return null;
    return {
        ...row,
        case_ids: parseMcpJson(row.case_ids_json, []),
        summary: parseMcpJson(row.summary_json, {}),
    };
}

function normalizeMcpCase(row) {
    return {
        ...row,
        checks: parseMcpJson(row.checks_json, []),
        observation_ids: parseMcpJson(row.observation_ids_json, []),
        trace_ids: parseMcpJson(row.trace_ids_json, []),
        sample: parseMcpJson(row.sample_json, {}),
    };
}

export function listMcpEvalRuns(scope = null, limit = 50) {
    ensureMcpEvalTables();
    const normalized = requireScope(scope, "MCP evaluations");
    return db.prepare(`SELECT * FROM mcp_eval_runs WHERE owner_user_id = ? AND tenant_id = ?
        ORDER BY created_at DESC LIMIT ?`).all(normalized.userId, normalized.tenantId, Math.max(1, Math.min(100, Number(limit) || 50))).map(normalizeMcpRun);
}

export function getMcpEvalRun(runId, scope = null) {
    ensureMcpEvalTables();
    const normalized = requireScope(scope, "MCP evaluation");
    const run = db.prepare("SELECT * FROM mcp_eval_runs WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ?")
        .get(String(runId), normalized.userId, normalized.tenantId);
    if (!run) return null;
    const cases = db.prepare("SELECT * FROM mcp_eval_case_results WHERE run_id = ? AND owner_user_id = ? AND tenant_id = ? ORDER BY case_id")
        .all(String(runId), normalized.userId, normalized.tenantId).map(normalizeMcpCase);
    return { ...normalizeMcpRun(run), cases };
}

export function getMcpObservabilitySummary(scope = null, { window = "7d", serverName = null, toolName = null } = {}) {
    const rows = listMcpOperationObservations(scope, { window, serverName, toolName, limit: 500, offset: 0 });
    const count = rows.length;
    const successful = rows.filter((row) => row.status === "success").length;
    const attempts = rows.filter((row) => Number(row.attempt_count) > 0);
    const sorted = rows.map((row) => Number(row.duration_ms) || 0).sort((a, b) => a - b);
    const percentileValue = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
    const ratio = (numerator, denominator) => ({ numerator, denominator, value: denominator ? Math.round((numerator / denominator) * 10000) / 10000 : null });
    const grouped = new Map();
    for (const row of rows) {
        const key = `${row.server_name}/${row.tool_name || row.operation}`;
        const current = grouped.get(key) || { serverName: row.server_name, toolName: row.tool_name, sampleSize: 0, success: 0, statuses: {} };
        current.sampleSize += 1;
        if (row.status === "success") current.success += 1;
        current.statuses[row.status] = (current.statuses[row.status] || 0) + 1;
        grouped.set(key, current);
    }
    return {
        window,
        sampleSize: count,
        successRate: ratio(successful, count),
        retryRate: ratio(attempts.filter((row) => Number(row.attempt_count) > 1).length, attempts.length),
        latency: { p50: percentileValue(50), p95: percentileValue(95), sampleSize: count },
        byServerTool: [...grouped.values()].map((row) => ({ ...row, successRate: ratio(row.success, row.sampleSize) })),
        statuses: rows.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {}),
        incomplete: rows.some((row) => Number(row.attempt_count) < 1),
    };
}

export function compareMcpEvalRuns(baselineId, candidateId, scope = null) {
    const baseline = getMcpEvalRun(baselineId, scope);
    const candidate = getMcpEvalRun(candidateId, scope);
    if (!baseline || !candidate) return { comparable: false, reason: "run_not_found", baseline, candidate };
    const sameDataset = baseline.dataset_version === candidate.dataset_version;
    const sameCases = JSON.stringify([...baseline.case_ids].sort()) === JSON.stringify([...candidate.case_ids].sort());
    if (!sameDataset || !sameCases) {
        return { comparable: false, reason: !sameDataset ? "dataset_version_mismatch" : "case_set_mismatch", baseline, candidate };
    }
    const baselineById = new Map(baseline.cases.map((item) => [item.case_id, item]));
    const candidateById = new Map(candidate.cases.map((item) => [item.case_id, item]));
    const perCase = baseline.case_ids.map((caseId) => ({ caseId, baseline: baselineById.get(caseId) || null, candidate: candidateById.get(caseId) || null }));
    return { comparable: true, baseline, candidate, perCase, newlyFailed: perCase.filter((item) => item.baseline?.status === "pass" && item.candidate?.status === "fail").map((item) => item.caseId) };
}

export function saveOptimizationLog({
    sourceRunId,
    targetRunId = null,
    configVersionId = null,
    label = null,
    badCaseIds = [],
    changes = [],
    suggestions = [],
    scoreBefore = null,
    scoreAfter = null,
    status = "applied",
    scope = null,
}) {
    if (!insertOptimizationLogStmt) initDB();
    const normalized = requireScope(scope, "optimization");
    const result = db.prepare(`INSERT INTO optimization_log
        (source_run_id, target_run_id, config_version_id, label, bad_case_ids, changes, suggestions, score_before, score_after, status, owner_user_id, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        String(sourceRunId),
        targetRunId ? String(targetRunId) : null,
        configVersionId ? Number(configVersionId) : null,
        label ? String(label) : null,
        JSON.stringify(badCaseIds),
        JSON.stringify(changes),
        JSON.stringify(suggestions),
        scoreBefore ? JSON.stringify(scoreBefore) : null,
        scoreAfter ? JSON.stringify(scoreAfter) : null,
        String(status),
        normalized.userId,
        normalized.tenantId
    );
    return Number(result.lastInsertRowid);
}

/**
 * 查询优化日志列表
 * @param {number} limit
 * @returns {Array}
 */
export function getOptimizationLogs(limit = 20, scope = null) {
    ensureOptimizationLogStatements();
    const normalized = requireScope(scope, "scoped resource");
    const rows = db.prepare("SELECT * FROM optimization_log WHERE owner_user_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT ?").all(normalized.userId, normalized.tenantId, limit);
    return rows.map(row => ({
        ...row,
        bad_case_ids: safeJsonParse(row.bad_case_ids, []),
        changes: safeJsonParse(row.changes, []),
        suggestions: safeJsonParse(row.suggestions, []),
        score_before: safeJsonParse(row.score_before, null),
        score_after: safeJsonParse(row.score_after, null),
    }));
}

/**
 * 获取单条优化日志
 * @param {number} id
 * @returns {object|null}
 */
export function getOptimizationLogById(id, scope = null) {
    ensureOptimizationLogStatements();
    const normalized = normalizeScope(scope);
    if (!normalized) return null;
    const row = db.prepare("SELECT * FROM optimization_log WHERE id = ? AND owner_user_id = ? AND tenant_id = ?").get(id, normalized.userId, normalized.tenantId);
    if (!row) return null;
    return {
        ...row,
        bad_case_ids: safeJsonParse(row.bad_case_ids, []),
        changes: safeJsonParse(row.changes, []),
        suggestions: safeJsonParse(row.suggestions, []),
        score_before: safeJsonParse(row.score_before, null),
        score_after: safeJsonParse(row.score_after, null),
    };
}

/**
 * 更新优化日志（重评完成后调用）
 * @param {number} id
 * @param {object} updates
 * @returns {boolean}
 */
export function updateOptimizationLog(id, { targetRunId, scoreAfter, status } = {}, scope = null) {
    ensureOptimizationLogStatements();
    const normalized = requireScope(scope, "scoped resource");
    const result = db.prepare(`UPDATE optimization_log
        SET target_run_id = COALESCE(?, target_run_id), score_after = COALESCE(?, score_after), status = COALESCE(?, status)
        WHERE id = ? AND owner_user_id = ? AND tenant_id = ?`).run(
        targetRunId ? String(targetRunId) : null,
        scoreAfter ? JSON.stringify(scoreAfter) : null,
        status || null,
        id,
        normalized.userId,
        normalized.tenantId
    );
    return result.changes > 0;
}

export function getMigrationAuditSummary() {
    const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
    const nullableScopes = {};
    for (const table of ["eval_traces", "eval_feedback", "eval_test_cases", "optimization_log", "agent_config_versions", "cross_source_experiment_reports", "cross_source_experiment_approvals", "cross_source_experiment_jobs"]) {
        if (!hasTable(table)) continue;
        const columns = getTableColumns(table).map((column) => column.name);
        const ownerColumn = columns.includes("owner_user_id") ? "owner_user_id" : (columns.includes("user_id") ? "user_id" : null);
        const tenantColumn = columns.includes("tenant_id") ? "tenant_id" : null;
        nullableScopes[table] = {
            ownerNulls: ownerColumn ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${ownerColumn} IS NULL`).get()?.count || 0) : null,
            tenantNulls: tenantColumn ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${tenantColumn} IS NULL`).get()?.count || 0) : null,
        };
    }
    return { tables: tableNames, nullableScopes };
}

export default db;
