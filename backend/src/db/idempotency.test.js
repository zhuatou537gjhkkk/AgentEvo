import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    completeChatIdempotency,
    failChatIdempotency,
    getChatIdempotency,
    markChatIdempotencyStarted,
    reserveChatIdempotency,
    setChatIdempotencyUserMessage,
    initDB,
    default as db,
} from "./index.js";

const key = () => `idempotency-test-${Date.now()}-${Math.random()}`;

// better-sqlite3 默认 PRAGMA foreign_keys = ON，chat_idempotency.owner_user_id 外键指向 users(id)。
// 测试必须自建父用户行才可能在无历史用户的干净库（CI）上通过 —— 之前本地绿只是因为
// dev agent_data.db 里恰好存在 id 1/2 的真人账号。这里动态建两个专属用户并在跑完清理。
let owners = []; // [{ userId, tenantId, username }]

beforeAll(() => {
    initDB();
    const insertUser = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)");
    const rand = Math.random().toString(36).slice(2, 10);
    for (let i = 0; i < 2; i++) {
        const username = `idem-test-${process.pid}-${rand}-${i}`;
        const { lastInsertRowid } = insertUser.run(username, "test-hash");
        const userId = Number(lastInsertRowid);
        owners.push({ userId, tenantId: `user:${userId}`, username });
    }
});

afterAll(() => {
    // 先删本测试写入的 idempotency 子行，再删自建父用户，避免外键拦截删除
    const deleteRows = db.prepare("DELETE FROM chat_idempotency WHERE owner_user_id = ? AND tenant_id = ?");
    const deleteUser = db.prepare("DELETE FROM users WHERE id = ? AND username = ?");
    for (const owner of owners.splice(0)) {
        deleteRows.run(owner.userId, owner.tenantId);
        deleteUser.run(owner.userId, owner.username);
    }
});

describe("chat idempotency attempt fencing", () => {
    it("claims one attempt and fences stale terminal callbacks", () => {
        const id = key();
        const first = reserveChatIdempotency(owners[0], id, "hash-a");
        expect(first.status).toBe("reserved");
        expect(first.attemptToken).toBeTruthy();
        expect(reserveChatIdempotency(owners[0], id, "hash-a").status).toBe("started");
        expect(markChatIdempotencyStarted(owners[0], id, first.attemptToken)).toBe(true);
        expect(completeChatIdempotency(owners[0], id, { text: "ok" }, 1, "stale-token")).toBe(false);
        expect(failChatIdempotency(owners[0], id, "OLD", "stale-token")).toBe(false);
        expect(completeChatIdempotency(owners[0], id, { text: "ok" }, 1, first.attemptToken)).toBe(true);
        expect(getChatIdempotency(owners[0], id)).toMatchObject({ status: "completed", response: { text: "ok" } });
    });

    it("rejects a different request hash in the same scope", () => {
        const id = key();
        reserveChatIdempotency(owners[0], id, "hash-a");
        expect(reserveChatIdempotency(owners[0], id, "hash-b").status).toBe("conflict");
    });

    it("isolates the same key across owners", () => {
        const id = key();
        const first = reserveChatIdempotency(owners[0], id, "hash-a");
        const second = reserveChatIdempotency(owners[1], id, "hash-a");
        expect(first.status).toBe("reserved");
        expect(second.status).toBe("reserved");
        expect(first.attemptToken).not.toBe(second.attemptToken);
    });
});
