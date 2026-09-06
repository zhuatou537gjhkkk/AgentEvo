import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * W3.2 残余 / W4-R5 (T5) — 源级护栏：易失运行态告警 + 字节级磁盘治理报告不变成死代码。
 *
 * 启动期内存态（上传配额非 durable、RAG 向量、图片字节）重启即丢，之前只在文档里写、
 * 代码零痕迹。T5 在 startServer 真实启动路径加 warnVolatileRuntimeState()，并把
 * audit-db.mjs（只读审计）扩展出 quotaGovernance/diskStaging 字节级报告。本文件用源
 * 读取断言这些接线真实存在、审计脚本保持只读打开 —— 后续重构删掉时护栏先红。
 */

const BACKEND_ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const APP_SRC = readFileSync(path.join(BACKEND_ROOT, "src", "app.js"), "utf8");
const AUDIT_SRC = readFileSync(path.join(BACKEND_ROOT, "scripts", "audit-db.mjs"), "utf8");

describe("startup volatility warnings + byte-level governance report (W4-R5 T5)", () => {
    it("startServer 在 initDB 后调用 warnVolatileRuntimeState()（告警挂在真实启动路径）", () => {
        const anchor = APP_SRC.indexOf("export async function startServer");
        expect(anchor).toBeGreaterThan(-1);
        const after = APP_SRC.slice(anchor);
        expect(after).toMatch(/initDB\(\);\s*\n\s*warnVolatileRuntimeState\(\)/);
    });

    it("告警如实覆盖三个内存态（上传配额 / RAG 向量 / 图片）", () => {
        expect(APP_SRC).toMatch(/DURABLE_UPLOAD_QUOTA/);
        expect(APP_SRC).toMatch(/reservation\/usage/); // 模块注释描述内存态
        expect(APP_SRC).toMatch(/上传配额为内存模式/);
        expect(APP_SRC).toMatch(/知识库向量索引为进程内内存态/);
        expect(APP_SRC).toMatch(/图片上传存储为进程内内存态/);
        expect((APP_SRC.match(/console\.warn\("\[startup\]/g) || []).length).toBeGreaterThanOrEqual(3);
    });

    it("audit-db.mjs 只读打开（readonly+fileMustExist），不写库", () => {
        expect(AUDIT_SRC).toMatch(/readonly:\s*true/);
        expect(AUDIT_SRC).toMatch(/fileMustExist:\s*true/);
        expect(AUDIT_SRC).not.toMatch(/\.run\(/); // 无任何写执行
        expect(AUDIT_SRC).not.toMatch(/\.prepare\([^)]*\)\.run/);
    });

    it("audit-db.mjs 报告含字节级治理段（perOwner committed/reserved + 磁盘暂存字节）", () => {
        expect(AUDIT_SRC).toMatch(/quotaGovernance/);
        expect(AUDIT_SRC).toMatch(/diskStaging/);
        expect(AUDIT_SRC).toMatch(/SUM\(committed_bytes\)/);
        expect(AUDIT_SRC).toMatch(/activeReservationBytes/);
        expect(AUDIT_SRC).toMatch(/lockLeases/); // 新 upload_key_locks 租约纳入治理视图
        expect(AUDIT_SRC).toMatch(/treeBytes/);
    });
});
