/**
 * vitest 逐文件 DB 隔离（W3.3-J）。
 *
 * 问题：db/index.js 在模块导入时读一次 process.env.DB_PATH（默认 backend/agent_data.db），
 * 此前所有测试共享真实开发库，曾致 CI 红灯（idempotency 测试依赖 dev 库里恰好存在的 user id 1/2）。
 *
 * 机制：vitest 默认 pool=forks + isolate=true —— 每个测试文件一个独立子进程；本 setup 在每个
 * worker 内、测试文件模块导入前执行，为它指定一个独立临时空库。env 不跨文件泄漏（各进程独立）。
 *
 * 约定：本文件不 import db/index.js（否则会破坏对其 vi.mock 的测试文件），只依赖 db/index.js
 * 惰性 initDB() 在首次真实调用时自举完整 schema + demo 用户（空库上 AUTOINCREMENT id=1）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const parent = path.join(os.tmpdir(), "agentevo-vitest");
fs.mkdirSync(parent, { recursive: true });
const dir = fs.mkdtempSync(path.join(parent, path.sep));
process.env.DB_PATH = path.join(dir, "agent_data.db");

// 兜底清理：清掉 >1h 的旧残留目录（并发/长时间运行远超阈值，不会误删活目录；只扫自己命名空间）
try {
    const cutoff = Date.now() - 3600_000;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const p = path.join(parent, entry.name);
        try {
            if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
        } catch { /* best-effort */ }
    }
} catch { /* best-effort */ }

// 本 worker 退出时尽力删除（POSIX 可删打开的文件；Windows 可能失败 → 留给下次 sweep）
process.on("exit", () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});
