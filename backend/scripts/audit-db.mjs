import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const dbPath = path.resolve(process.env.DB_PATH || "./agent_data.db");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    const schema = Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`PRAGMA table_info(${name})`).all()]));
    const reservations = db.prepare(`SELECT owner_user_id, tenant_id, upload_key, status, reserved_bytes, expires_at
        FROM upload_reservations ORDER BY expires_at`).all();
    const nullableScopes = {};
    for (const table of ["eval_traces", "eval_feedback", "eval_test_cases", "optimization_log", "agent_config_versions"]) {
        if (!tables.some(({ name }) => name === table)) continue;
        const columns = schema[table].map((column) => column.name);
        const ownerColumn = columns.includes("owner_user_id") ? "owner_user_id" : (columns.includes("user_id") ? "user_id" : null);
        const tenantColumn = columns.includes("tenant_id") ? "tenant_id" : null;
        nullableScopes[table] = {
            ownerNulls: ownerColumn ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${ownerColumn} IS NULL`).get()?.count || 0) : null,
            tenantNulls: tenantColumn ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${tenantColumn} IS NULL`).get()?.count || 0) : null,
        };
    }
    const orphanCandidates = fs.existsSync(path.resolve("./tmp/chunks"))
        ? fs.readdirSync(path.resolve("./tmp/chunks"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        : [];

    // Byte-level disk governance (W3.2 residual / T5): how many bytes each owner
    // has committed (durable, survives restart) vs reserved (in-flight), plus the
    // on-disk upload staging footprint, so operators can reconcile the two.
    // upload_quota_usage appears only after initDB() runs, so guard for it.
    const hasQuota = tables.some(({ name }) => name === "upload_quota_usage");
    const hasLocks = tables.some(({ name }) => name === "upload_key_locks");
    const quotaGovernance = hasQuota
        ? {
            perOwner: db.prepare(`SELECT owner_user_id AS owner, tenant_id AS tenant,
                    SUM(committed_bytes) AS committed_bytes,
                    SUM(reserved_bytes) AS reserved_bytes,
                    COUNT(*) AS usage_days
                FROM upload_quota_usage GROUP BY owner_user_id, tenant_id
                ORDER BY committed_bytes DESC`).all(),
            totals: db.prepare(`SELECT
                    COALESCE(SUM(committed_bytes), 0) AS committed_bytes,
                    COALESCE(SUM(reserved_bytes), 0) AS reserved_bytes,
                    COUNT(*) AS usage_days
                FROM upload_quota_usage`).get(),
            activeReservationBytes: Number(db.prepare(
                "SELECT COALESCE(SUM(reserved_bytes), 0) AS bytes FROM upload_reservations WHERE status = 'active'"
            ).get()?.bytes || 0),
            lockLeases: hasLocks
                ? db.prepare(`SELECT
                        COUNT(*) AS total,
                        SUM(CASE WHEN expires_at IS NULL OR expires_at > datetime('now') THEN 1 ELSE 0 END) AS active,
                        SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= datetime('now') THEN 1 ELSE 0 END) AS stale
                    FROM upload_key_locks`).get()
                : null,
        }
        : null;

    function treeBytes(dir) {
        if (!fs.existsSync(dir)) return null;
        let bytes = 0;
        let files = 0;
        const walk = (p) => {
            for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
                const full = path.join(p, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.isFile()) {
                    bytes += fs.statSync(full).size;
                    files += 1;
                }
            }
        };
        walk(dir);
        return { bytes, files };
    }

    const diskStaging = {
        chunksRoot: treeBytes(path.resolve("./tmp/chunks")),
        tmpRoot: treeBytes(path.resolve("./tmp")),
    };

    process.stdout.write(`${JSON.stringify({
        dbPath,
        integrity,
        tableCount: tables.length,
        tables: tables.map(({ name }) => name),
        schema,
        activeReservations: reservations,
        orphanCandidates,
        nullableScopes,
        quotaGovernance,
        diskStaging,
        destructiveActions: false,
    }, null, 2)}\n`);
} finally {
    db.close();
}
