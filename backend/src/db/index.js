import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, "../../agent_data.db");

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

let defaultUserId = null;

function hasTable(tableName) {
    const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(tableName);
    return Boolean(row);
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

    db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_agent_memory_user_id ON agent_memory(user_id)`
    ).run();
    db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_agent_memory_type ON agent_memory(memory_type)`
    ).run();
    db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_agent_memory_session ON agent_memory(session_id)`
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
            "SELECT id, username, password_hash, created_at FROM users WHERE username = ?"
        );
    }

    if (!selectUserByIdStmt) {
        selectUserByIdStmt = db.prepare(
            "SELECT id, username, created_at FROM users WHERE id = ?"
        );
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
    return Number(result.lastInsertRowid);
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

function ensureMemoryStatements() {
    if (!insertMemoryStmt) {
        insertMemoryStmt = db.prepare(
            `INSERT INTO agent_memory (user_id, session_id, content, memory_type, importance, metadata)
             VALUES (?, ?, ?, ?, ?, ?)`
        );
    }
    if (!searchMemoriesStmt) {
        searchMemoriesStmt = db.prepare(
            `SELECT * FROM agent_memory
             WHERE user_id = ?
               AND (memory_type = ? OR ? IS NULL)
               AND importance >= ?
             ORDER BY created_at DESC
             LIMIT ?`
        );
    }
    if (!consolidateFromTypeStmt) {
        consolidateFromTypeStmt = db.prepare(
            `SELECT * FROM agent_memory
             WHERE user_id = ? AND memory_type = ? AND importance >= ?
             ORDER BY importance DESC`
        );
    }
    if (!insertConsolidatedStmt) {
        insertConsolidatedStmt = db.prepare(
            `INSERT INTO agent_memory (user_id, session_id, content, memory_type, importance, metadata)
             VALUES (?, ?, ?, ?, ?, ?)`
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
             SET content = ?, importance = ?, memory_type = ?, updated_at = CURRENT_TIMESTAMP
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
            `INSERT INTO eval_scores (trace_id, message_id, test_case_id, run_id, dimension, score, judge_rationale, judge_model, score_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

/**
 * 添加一条记忆
 * @param {number} userId
 * @param {number|null} sessionId
 * @param {string} content
 * @param {string} memoryType - "working" | "episodic" | "semantic"
 * @param {number} importance - 0.0 ~ 1.0
 * @param {object} metadata - 额外的结构化元数据
 * @returns {number} memoryId
 */
export function addMemory(userId, sessionId, content, memoryType = "working", importance = 0.5, metadata = {}) {
    ensureMemoryStatements();
    const safeImportance = Math.max(0, Math.min(1, Number(importance) || 0.5));
    const result = insertMemoryStmt.run(
        Number(userId),
        sessionId ? Number(sessionId) : null,
        String(content),
        String(memoryType),
        safeImportance,
        JSON.stringify(metadata)
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
 * @returns {Array} 带 relevanceScore 的记忆列表
 */
export function searchMemory(userId, query, memoryTypes = null, limit = 10, minImportance = 0.1) {
    ensureMemoryStatements();
    const safeUserId = Number(userId);

    // 批量获取候选集 — 对每种记忆类型分别查询
    const typesToSearch = (Array.isArray(memoryTypes) && memoryTypes.length > 0)
        ? memoryTypes
        : ["working", "episodic", "semantic"];
    const typeSet = new Set(typesToSearch);

    const allCandidates = [];
    for (const memType of typeSet) {
        // 每种类型取 3x limit 做候选池，后续混合排序
        const rows = searchMemoriesStmt.all(safeUserId, memType, memType, minImportance, limit * 3);
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

        return {
            id: row.id,
            content: row.content,
            memory_type: row.memory_type,
            importance: row.importance,
            relevanceScore,
            created_at: row.created_at,
            metadata: safeParseJSON(row.metadata),
        };
    });

    // 5. 有搜索词时，过滤掉完全不匹配的结果（所有查询词都不命中内容 → 排除）
    const filtered = queryWords.length > 0
        ? scored.filter(item => item.relevanceScore > 0.15)
        : scored;

    // 按综合评分降序排序
    filtered.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return filtered.slice(0, limit);
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
            // 创建新记忆到目标类型，importance 获得 1.1x 提升
            const boostedImportance = Math.min(1, (row.importance || 0.5) * 1.1);
            const metadata = {
                ...safeParseJSON(row.metadata),
                consolidated_from: row.id,
                consolidated_from_type: fromType,
                consolidated_at: new Date().toISOString(),
            };

            insertConsolidatedStmt.run(
                safeUserId,
                row.session_id,
                row.content,
                toType,
                boostedImportance,
                JSON.stringify(metadata)
            );

            // 提升后删除原始记忆
            deleteMemoryByIdStmt.run(row.id, safeUserId);
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
        result = deleteLowImportanceStmt.run(safeUserId, memoryType, threshold);
    } else if (strategy === "time") {
        const cutoffDate = new Date(Date.now() - Number(threshold) * 24 * 3600 * 1000).toISOString();
        result = deleteOldMemoriesStmt.run(safeUserId, memoryType, cutoffDate);
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
    const rows = selectMemoryStatsStmt.all(safeUserId);

    const byType = { working: 0, episodic: 0, semantic: 0 };
    let total = 0;
    for (const row of rows) {
        byType[row.memory_type] = row.count;
        total += row.count;
    }

    return { total, byType };
}

/**
 * 获取记忆摘要
 * @param {number} userId
 * @param {number} limit
 * @returns {Array}
 */
export function getMemorySummary(userId, limit = 20) {
    ensureMemoryStatements();
    const safeUserId = Number(userId);
    const rows = selectMemorySummaryStmt.all(safeUserId, limit);

    return rows.map((row) => ({
        id: row.id,
        content: row.content,
        memory_type: row.memory_type,
        importance: row.importance,
        created_at: row.created_at,
    }));
}

/**
 * 更新一条记忆
 * @param {number} userId
 * @param {number} memoryId
 * @param {object} updates - { content, importance, memory_type }
 */
export function updateMemory(userId, memoryId, updates = {}) {
    ensureMemoryStatements();
    const safeUserId = Number(userId);
    const row = db.prepare("SELECT * FROM agent_memory WHERE id = ? AND user_id = ?").get(memoryId, safeUserId);
    if (!row) return false;

    updateMemoryStmt.run(
        String(updates.content ?? row.content),
        Number(updates.importance ?? row.importance),
        String(updates.memory_type ?? row.memory_type),
        memoryId,
        safeUserId
    );
    return true;
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
    const result = insertTraceStmt.run(
        Number(trace.userId) || defaultUserId,
        Number(trace.sessionId) || 0,
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
    return result.lastInsertRowid;
}

/**
 * 获取最近的 Trace 列表
 * @param {number} userId
 * @param {number} limit
 * @returns {Array}
 */
export function getRecentTraces(userId, limit = 30) {
    ensureEvalStatements();
    const safeUserId = Number(userId) || defaultUserId;
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 30));
    return selectRecentTracesStmt.all(safeUserId, safeLimit);
}

/**
 * 按 trace_id 查询 Trace
 * @param {string} traceId
 * @returns {object|null}
 */
export function getTraceById(traceId) {
    ensureEvalStatements();
    return selectTraceByTraceIdStmt.get(String(traceId)) || null;
}

// ── Phase 5: 评估分数 ──

/**
 * 保存评估分数
 * @param {object} score
 * @returns {number} id
 */
export function saveEvalScore(score = {}) {
    ensureEvalStatements();
    const result = insertEvalScoreStmt.run(
        score.traceId ? String(score.traceId) : null,
        score.messageId ? Number(score.messageId) : null,
        score.testCaseId ? String(score.testCaseId) : null,
        score.runId ? String(score.runId) : null,
        String(score.dimension || ""),
        Number(score.score) || 0,
        score.judgeRationale ? String(score.judgeRationale) : null,
        score.judgeModel ? String(score.judgeModel) : null,
        String(score.scoreType || "offline")
    );
    return result.lastInsertRowid;
}

/**
 * 按 run_id 查询评估分数
 * @param {string} runId
 * @returns {Array}
 */
export function getScoresByRun(runId) {
    ensureEvalStatements();
    return selectScoresByRunIdStmt.all(String(runId));
}

/**
 * 获取评分趋势
 * @param {number} limit
 * @returns {Array}
 */
export function getScoreTrends(limit = 30) {
    ensureEvalStatements();
    const rows = selectScoreTrendsStmt.all(limit);

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
export function getScoreTrendsByRun(runId, limit = 30) {
    ensureEvalStatements();
    const rows = selectScoreTrendsByRunStmt.all(String(runId), limit);

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
export function getRunIds() {
    ensureEvalStatements();
    return selectRunIdsStmt.all();
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
export function saveFeedback(userId, messageId, rating, comment = null) {
    ensureEvalStatements();
    const result = insertFeedbackStmt.run(
        Number(userId),
        Number(messageId),
        String(rating),
        comment ? String(comment) : null
    );
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
export function getFeedbackByMessage(userId, messageId) {
    ensureEvalStatements();
    return selectFeedbackByMessageStmt.get(Number(userId), Number(messageId)) || null;
}

/**
 * 获取用户的反馈汇总
 * @param {number} userId
 * @returns {{ thumbs_up: number, thumbs_down: number, total: number }}
 */
export function getFeedbackSummary(userId) {
    ensureEvalStatements();
    const rows = selectFeedbackSummaryStmt.all(Number(userId));
    const result = { thumbs_up: 0, thumbs_down: 0, total: 0 };
    for (const row of rows) {
        if (row.rating === "thumbs_up") result.thumbs_up = row.count;
        else if (row.rating === "thumbs_down") result.thumbs_down = row.count;
        result.total += row.count;
    }
    return result;
}

export default db;
