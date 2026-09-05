import { afterEach, describe, expect, it } from "vitest";
import { app, createApp } from "./app.js";
import { hashPassword, issueAuthToken } from "./auth.js";
import { createServer } from "node:http";

let server;
let baseUrl;
let activeApp = app;

afterEach(async () => {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = null;
    activeApp = app;
});

async function start() {
    server = createServer(activeApp);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
}

describe("HTTP error contract", () => {
    it("creates an isolated factory app with dependency overrides", async () => {
        const calls = [];
        const fakeUser = { id: 1, username: "factory-user", tenant_id: "user:1" };
        activeApp = createApp({ dependencies: {
            auth: { getUserById: (id) => { calls.push(["getUserById", Number(id)]); return fakeUser; } },
            db: { getSessions: (id) => { calls.push(["getSessions", Number(id)]); return []; } },
        } });
        await start();
        const response = await fetch(`${baseUrl}/sessions`, {
            headers: { Authorization: `Bearer ${issueAuthToken(fakeUser)}` },
        });
        expect(response.status).toBe(200);
        expect(activeApp.locals.factory).toBe(true);
        expect(calls).toEqual([["getUserById", 1], ["getSessions", 1]]);
    });

    it("routes session extension calls through factory dependencies", async () => {
        const calls = [];
        const fakeUser = { id: 2, username: "extension-user", tenant_id: "user:2" };
        activeApp = createApp({ dependencies: {
            auth: { getUserById: () => fakeUser },
            db: {
                getHistoryMessages: (userId, sessionId, limit) => { calls.push(["history", userId, sessionId, limit]); return []; },
                removeMessagePair: (userId, sessionId, messageId) => { calls.push(["pair", userId, sessionId, messageId]); return { deleted: true }; },
                createBranchSession: (userId, sessionId, fromMessageId, title, edited) => { calls.push(["branch", userId, sessionId, fromMessageId, title, edited]); return 77; },
                getSessionById: (userId, sessionId) => { calls.push(["session", userId, sessionId]); return { id: sessionId }; },
            },
        } });
        await start();
        const token = issueAuthToken(fakeUser);
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
        const usage = await fetch(`${baseUrl}/sessions/8/context-usage`, { headers });
        const pair = await fetch(`${baseUrl}/sessions/8/messages/9/pair`, { method: "DELETE", headers });
        const branch = await fetch(`${baseUrl}/sessions/8/branch`, { method: "POST", headers, body: JSON.stringify({ from_message_id: 9, title: "copy", edited_content: "new" }) });
        expect(usage.status).toBe(200);
        expect(pair.status).toBe(200);
        expect(branch.status).toBe(200);
        expect(calls).toEqual([
            ["history", 2, 8, 200],
            ["pair", 2, 8, 9],
            ["branch", 2, 8, 9, "copy", "new"],
            ["session", 2, 77],
        ]);
    });

    it("routes auth register and login through factory dependencies", async () => {
        const calls = [];
        const fakeUser = { id: 9, username: "auth-factory", tenant_id: "user:9", password_hash: hashPassword("secret1"), created_at: "now" };
        activeApp = createApp({ dependencies: {
            db: {
                getUserByUsername: (username) => { calls.push(["lookup", username]); return username === "auth-factory" ? fakeUser : null; },
                createUser: (username, passwordHash) => { calls.push(["create", username, passwordHash]); return 9; },
                getUserById: (id) => { calls.push(["user", Number(id)]); return fakeUser; },
            },
        } });
        await start();
        const register = await fetch(`${baseUrl}/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: "new-auth", password: "secret1" }),
        });
        const login = await fetch(`${baseUrl}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: "auth-factory", password: "secret1" }),
        });
        expect(register.status).toBe(200);
        expect(login.status).toBe(200);
        expect(calls[0][0]).toBe("lookup");
        expect(calls).toContainEqual(["create", "new-auth", expect.any(String)]);
        expect(calls).toContainEqual(["user", 9]);
        expect(calls).toContainEqual(["lookup", "auth-factory"]);
    });

    it("routes feedback save, toggle-off, and delete through factory dependencies", async () => {
        const calls = [];
        const fakeUser = { id: 12, username: "feedback-factory", tenant_id: "user:12" };
        let existing = null;
        activeApp = createApp({ dependencies: {
            auth: { getUserById: () => fakeUser },
            db: {
                getFeedbackByMessage: (...args) => { calls.push(["get", ...args.slice(0, 2)]); return existing; },
                saveFeedback: (...args) => { calls.push(["save", ...args.slice(0, 4)]); existing = { rating: args[2] }; },
                deleteFeedback: (...args) => { calls.push(["delete", ...args.slice(0, 2)]); existing = null; },
            },
        } });
        await start();
        const token = issueAuthToken(fakeUser);
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
        const save = await fetch(`${baseUrl}/chat/feedback`, { method: "POST", headers, body: JSON.stringify({ message_id: 44, rating: "thumbs_up", comment: "good" }) });
        const toggle = await fetch(`${baseUrl}/chat/feedback`, { method: "POST", headers, body: JSON.stringify({ message_id: 44, rating: "thumbs_up" }) });
        const remove = await fetch(`${baseUrl}/chat/feedback`, { method: "POST", headers, body: JSON.stringify({ message_id: 44, rating: null }) });
        expect([save.status, toggle.status, remove.status]).toEqual([200, 200, 200]);
        expect(calls.map(([name]) => name)).toEqual(["get", "save", "get", "delete", "delete"]);
        expect(calls[0].slice(0, 3)).toEqual(["get", 12, 44]);
    });

    it("returns a public request envelope for unauthenticated access", async () => {
        await start();
        const response = await fetch(`${baseUrl}/sessions`);
        const body = await response.json();
        expect(response.status).toBe(401);
        expect(body).toMatchObject({ ok: false, errorCode: expect.any(String), requestId: expect.any(String), retryable: false });
        expect(body.message).not.toContain("secret");
    });

    it("preserves request id on invalid chat input", async () => {
        await start();
        const requestId = "contract-request-1";
        const response = await fetch(`${baseUrl}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Request-Id": requestId },
            body: JSON.stringify({}),
        });
        const body = await response.json();
        expect(response.status).toBe(401);
        expect(body.requestId).toBe(requestId);
    });
});
