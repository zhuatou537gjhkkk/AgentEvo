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
    process.stdout.write(`${JSON.stringify({
        dbPath,
        integrity,
        tableCount: tables.length,
        tables: tables.map(({ name }) => name),
        schema,
        activeReservations: reservations,
        orphanCandidates,
        nullableScopes,
        destructiveActions: false,
    }, null, 2)}\n`);
} finally {
    db.close();
}
