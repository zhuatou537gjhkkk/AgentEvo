/**
 * Durable same-key cross-process upload lock — production acceptance (W4-R5-S1).
 *
 * 缺口：改造前 createDurableAdapter 的 withUploadLock 复用 in-process 内存锁
 * （withMemoryUploadLock）——账目是 SQLite 持久化的，但同 (owner, upload_key) 的
 * merge 临界区（拼装 + FAISS embed/index + settle）只在单进程内互斥。多实例/重启
 * 后两个进程可同时 merge 同一 hash → 双份索引 / 双 settle。
 *
 * W4-R5-S1 把锁升级为 upload_key_locks 租约行（INSERT OR IGNORE 赢 key，过期原子
 * 回收），租约由持有方在临界区内续期、退出按 holder_token 删除；SQLite 串行化这些
 * 写语句 → 同一时刻至多一个进程持有活租约。本文件用真实 DB（per-worker 临时库）+ 真实
 * durable adapter + 独立 OS 子进程（quota-lock-worker.mjs）端到端验收：
 *   1) 两个进程互斥：A hold 期间 B（独立进程）拿不到 → UPLOAD_LOCK_TIMEOUT；A 释放后
 *      C 立即可再拿（无卡死）；租约行在 A 持有时真实落库、释放后删除（证明是 DB 锁而非进程内锁）。
 *   2) 持有方崩溃（SIGKILL，finally 不执行）→ 租约到期后被下一进程回收，key 不永久卡死。
 *   3) 进程内确定性补测：活租约不会被偷（busy 到期抛 UPLOAD_LOCK_TIMEOUT）、
 *      过期租约单条 UPDATE 原子回收成功。
 * 不触碰 dev 库；子进程继承 DB_PATH（与 uploadQuotaDurable.test.js 同构）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db, { initDB } from "../db/index.js";
import { createUploadQuotaStore } from "./uploadQuotaStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const WORKER_SCRIPT = path.join(BACKEND_ROOT, "scripts", "quota-lock-worker.mjs");

const SCOPE = { userId: 1, tenantId: "user:1" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const store = createUploadQuotaStore({ durable: true });

const lockRow = (key) => db.prepare(
    "SELECT holder_token, acquired_at, expires_at FROM upload_key_locks WHERE owner_user_id = ? AND tenant_id = ? AND upload_key = ?"
).get(SCOPE.userId, SCOPE.tenantId, key);

const insertStaleLock = (key, expiresDelta) => {
    db.prepare(`INSERT INTO upload_key_locks (owner_user_id, tenant_id, upload_key, holder_token, acquired_at, expires_at)
        VALUES (?, ?, ?, 'stale-holder', datetime('now'), datetime('now', ?))`)
        .run(SCOPE.userId, SCOPE.tenantId, key, expiresDelta);
};

/** Spawn a lock worker and stream its JSON events until process exit. */
function launchWorker(args) {
    const child = spawn(process.execPath, [WORKER_SCRIPT, ...args], {
        cwd: BACKEND_ROOT,
        env: { ...process.env, DB_PATH: process.env.DB_PATH, NODE_ENV: "test" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const control = {
        events: [],
        waiters: [],
        pid: child.pid,
        exit: new Promise((resolve) => {
            child.on("close", (code, signal) => resolve({ code, signal }));
        }),
        kill() { child.kill("SIGKILL"); },
    };
    let buf = "";
    child.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let obj;
            try { obj = JSON.parse(line); } catch { obj = { raw: line }; }
            control.events.push(obj);
            const pending = control.waiters.splice(0);
            for (const waiter of pending) waiter(obj);
        }
    });
    return control;
}

function waitEvent(control, predicate, label, timeoutMs = 20_000) {
    const existing = control.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
        control.waiters.push((obj) => {
            if (predicate(obj)) {
                clearTimeout(timer);
                resolve(obj);
            }
        });
    });
}

const hasEvent = (control, event) => control.events.some((e) => e.event === event);

describe("durable same-key cross-process upload lock (W4-R5-S1)", () => {
    beforeAll(() => {
        initDB(); // bootstrap schema + demo user id 1 (FK parent for the lease rows)
    });

    beforeEach(() => {
        db.prepare("DELETE FROM upload_key_locks").run();
    });

    afterEach(() => {
        db.prepare("DELETE FROM upload_key_locks").run();
    });

    it("two OS processes are mutually exclusive on the same key; release frees it", { timeout: 45_000 }, async () => {
        const key = `mutex-${Date.now()}`;

        // A: independent process holds the key for ~5s (lease renewed while held).
        const a = launchWorker(["hold", String(SCOPE.userId), SCOPE.tenantId, key, "5000", "60000"]);
        await waitEvent(a, (e) => e.event === "ACQUIRED", "A ACQUIRED");

        // The lease is materialized in SQLite while A holds — a DB lock, not an
        // in-process one (this row is only visible because A is a separate process).
        const held = lockRow(key);
        expect(held).toBeTruthy();
        expect(held.holder_token).not.toBe("stale-holder");
        expect(String(held.expires_at)).toBeTruthy();

        // B: a second process must NOT enter while A holds → busy timeout.
        const b = launchWorker(["wait", String(SCOPE.userId), SCOPE.tenantId, key, "1500", "60000"]);
        const bExit = await b.exit;
        expect(bExit.code).toBe(1);
        const failed = b.events.find((e) => e.event === "FAILED");
        expect(failed).toBeTruthy();
        expect(failed.code).toBe("UPLOAD_LOCK_TIMEOUT");

        // B's failed attempts must not have stolen or cleared A's lease.
        expect(lockRow(key)).toBeTruthy();

        // A finishes its critical section and releases.
        const aExit = await a.exit;
        expect(aExit.code).toBe(0);
        expect(hasEvent(a, "OP_DONE")).toBe(true);
        expect(hasEvent(a, "RELEASED")).toBe(true);
        expect(lockRow(key)).toBeUndefined(); // release deleted the lease row

        // C: the same key is immediately acquirable again (no permanent wedge).
        const c = launchWorker(["wait", String(SCOPE.userId), SCOPE.tenantId, key, "5000", "60000"]);
        const cExit = await c.exit;
        expect(cExit.code).toBe(0);
        expect(hasEvent(c, "ACQUIRED")).toBe(true);
        expect(lockRow(key)).toBeUndefined();
    });

    it("a crashed holder's expired lease is reclaimed — the key is not wedged", { timeout: 45_000 }, async () => {
        const key = `crash-${Date.now()}`;

        // R: hold with a short lease (2s) for a long critical section, then die
        // mid-hold via SIGKILL so the finally-release never runs.
        const r = launchWorker(["hold", String(SCOPE.userId), SCOPE.tenantId, key, "30000", "2000"]);
        await waitEvent(r, (e) => e.event === "ACQUIRED", "R ACQUIRED");
        r.kill();
        const rExit = await r.exit;
        expect(rExit.code).not.toBe(0); // killed without releasing

        // Lease is left behind; wait past its expiry, then a new process must be
        // able to reclaim the stale row and acquire.
        await sleep(2600);
        const stale = lockRow(key);
        expect(stale).toBeTruthy();
        expect(String(stale.expires_at) <= new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")).toBe(true);

        const s = launchWorker(["wait", String(SCOPE.userId), SCOPE.tenantId, key, "6000", "2000"]);
        const sExit = await s.exit;
        expect(sExit.code).toBe(0);
        expect(hasEvent(s, "ACQUIRED")).toBe(true);
        expect(lockRow(key)).toBeUndefined();
    });

    it("a live lease is not stolen: busy-wait times out instead of reclaiming the future row", async () => {
        insertStaleLock("busy", "+30 seconds"); // unexpired lease held by "stale-holder"
        await expect(store.withUploadLock(SCOPE, "busy", async () => {}, { ttlMs: 2000, busyTimeoutMs: 250 }))
            .rejects.toMatchObject({ code: "UPLOAD_LOCK_TIMEOUT" });
        expect(lockRow("busy").holder_token).toBe("stale-holder"); // untouched
    });

    it("an expired lease is reclaimed by a single atomic UPDATE", async () => {
        insertStaleLock("reap", "-5 seconds"); // expired
        await store.withUploadLock(SCOPE, "reap", async () => {
            const row = lockRow("reap");
            expect(row.holder_token).not.toBe("stale-holder"); // we now own it
        }, { ttlMs: 2000, busyTimeoutMs: 1000 });
        expect(lockRow("reap")).toBeUndefined(); // released on exit
    });
});
