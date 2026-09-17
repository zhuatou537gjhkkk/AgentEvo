import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createApp } from "../app.js";
import { issueAuthToken } from "../auth.js";
import {
    addMemory,
    createSession,
    createUser,
    getFeedbackSummary,
    initDB,
    saveMessage,
    getUserScope,
    saveTrace,
} from "../db/index.js";
import { ProjectMemoryService } from "../services/projectMemory.js";
import { evaluateCrossSourceQuality } from "./crossSourceQuality.js";
import { calibrateHelpfulnessFromFeedback } from "./feedbackCalibration.js";

const ENV_KEYS = ["PROJECT_RAG_ENABLED", "PROJECT_MEMORY_ENABLED", "MEMORY_CONTRACT_V2", "MEMORY_CROSS_SOURCE_EVAL_V2", "MEMORY_CROSS_SOURCE_IMPACT_V2", "MEMORY_CROSS_SOURCE_EXPERIMENT_V2", "MEMORY_CROSS_SOURCE_SAMPLER_V2", "ADMIN_USER_IDS"];
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let server;
let base;
let alice;
let bob;
let aliceMessageId;
let aliceControlMessageId;
let aliceProjectPacket;

function headers(user) {
    return {
        Authorization: `Bearer ${issueAuthToken({ id: user.id, username: user.username })}`,
        "Content-Type": "application/json",
    };
}

async function request(method, path, user, body) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: headers(user),
        body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: response.status, body: json, text };
}

function open(app) {
    return new Promise((resolve) => {
        server = createServer(app);
        server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
    });
}

beforeAll(async () => {
    initDB();
    process.env.PROJECT_RAG_ENABLED = "true";
    process.env.PROJECT_MEMORY_ENABLED = "true";
    process.env.MEMORY_CONTRACT_V2 = "true";
    process.env.MEMORY_CROSS_SOURCE_EVAL_V2 = "true";
    process.env.MEMORY_CROSS_SOURCE_IMPACT_V2 = "true";
    process.env.MEMORY_CROSS_SOURCE_EXPERIMENT_V2 = "true";

    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    alice = { id: createUser(`m11_alice_${suffix}`, "hash-a"), username: `m11_alice_${suffix}` };
    bob = { id: createUser(`m11_bob_${suffix}`, "hash-b"), username: `m11_bob_${suffix}` };
    process.env.ADMIN_USER_IDS = String(alice.id);

    const aliceSession = createSession(alice.id, "M11 Alice fixture");
    aliceMessageId = saveMessage(alice.id, aliceSession, "assistant", "M11 synthetic answer");
    aliceControlMessageId = saveMessage(alice.id, aliceSession, "assistant", "M11 control answer");
    saveTrace({
        userId: alice.id,
        scope: getUserScope(alice.id),
        sessionId: aliceSession,
        messageId: aliceMessageId,
        traceId: `m12-injected-${suffix}`,
        traceType: "chat",
        rootSpan: { metadata: {
            cross_source_recall: { selected: [{ id: "fixture-user-memory", sourceType: "user_memory", score: 0.9 }] },
            cross_source_experiment: { group: "injected", stratum: { key: "general:user_memory" } },
        } },
    });
    saveTrace({
        userId: alice.id,
        scope: getUserScope(alice.id),
        sessionId: aliceSession,
        messageId: aliceControlMessageId,
        traceId: `m12-control-${suffix}`,
        traceType: "chat",
        rootSpan: { metadata: {
            cross_source_recall: { selected: [] },
            cross_source_experiment: { group: "control", stratum: { key: "general:user_memory" } },
        } },
    });
    addMemory(alice.id, aliceSession, "ALICE_M11_PRIVATE_PREFERENCE", "semantic", 0.9, {}, { status: "active", confidence: 0.95 });

    const aliceProject = new ProjectMemoryService({ scope: getUserScope(alice.id) });
    aliceProjectPacket = aliceProject.packetsForContext({ projectId: "m11-project", query: "release", limit: 1 })[0] || aliceProject.add({
        projectId: "m11-project",
        layer: "semantic",
        content: "M11 project release policy is owner scoped",
        confidence: 0.95,
        importance: 0.9,
        files: ["docs/release.md"],
    });
    if (!aliceProjectPacket?.content) {
        aliceProjectPacket = aliceProject.packetsForContext({ projectId: "m11-project", query: "release", limit: 1 })[0];
    }

    base = await open(createApp());
    const indexed = await request("POST", "/rag/project/m11-project/index", alice, {
        files: [{ path: "src/release.js", text: "export const M11OLDONLYZX9 = 'alice-project-rag';" }],
        commit: "m11-a1",
    });
    expect(indexed.status).toBe(200);
});

afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const key of ENV_KEYS) {
        if (previousEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousEnv[key];
    }
});

describe("M11 real HTTP cross-source fixtures", () => {
    it("keeps user memory and project RAG isolated across two authenticated users", async () => {
        const aliceMemory = await request("GET", "/memory?query=ALICE_M11_PRIVATE_PREFERENCE", alice);
        const bobMemory = await request("GET", "/memory?query=ALICE_M11_PRIVATE_PREFERENCE", bob);
        expect(aliceMemory.status).toBe(200);
        expect(aliceMemory.text).toContain("ALICE_M11_PRIVATE_PREFERENCE");
        expect(bobMemory.status).toBe(200);
        expect(bobMemory.text).not.toContain("ALICE_M11_PRIVATE_PREFERENCE");

        const aliceRag = await request("POST", "/rag/project/m11-project/query", alice, { query: "M11OLDONLYZX9" });
        const bobRag = await request("POST", "/rag/project/m11-project/query", bob, { query: "M11OLDONLYZX9" });
        expect(aliceRag.status).toBe(200);
        expect(aliceRag.body.status).toBe("ok");
        expect(aliceRag.text).toContain("alice-project-rag");
        expect(bobRag.status).toBe(200);
        expect(bobRag.body.status).toBe("no_match");
        expect(bobRag.text).not.toContain("alice-project-rag");

        const revision = await request("POST", "/rag/project/m11-project/index", alice, {
            files: [{ path: "src/release.js", text: "export const M11NEWONLYZX9 = 'alice-project-rag-v2';" }],
            commit: "m11-a2",
        });
        expect(revision.status).toBe(200);
        const currentRag = await request("POST", "/rag/project/m11-project/query", alice, { query: "M11NEWONLYZX9" });
        const staleRag = await request("POST", "/rag/project/m11-project/query", alice, { query: "M11OLDONLYZX9" });
        expect(currentRag.body.status).toBe("ok");
        expect(currentRag.text).toContain("alice-project-rag-v2");
        expect(staleRag.body.status).toBe("no_match");

        const bobProject = new ProjectMemoryService({ scope: getUserScope(bob.id) });
        expect(bobProject.packetsForContext({ projectId: "m11-project", query: "release" })).toEqual([]);
        expect(aliceProjectPacket?.metadata?.ownerUserId ?? aliceProjectPacket?.metadata?.provenance?.ownerUserId).not.toBe(bob.id);
    });

    it("links a real HTTP feedback label to a content-free helpfulness calibration", async () => {
        const feedback = await request("POST", "/chat/feedback", alice, { message_id: aliceMessageId, rating: "thumbs_up" });
        expect(feedback.status).toBe(200);
        expect(getFeedbackSummary(alice.id, getUserScope(alice.id))).toMatchObject({ thumbs_up: 1, total: 1 });
        const controlFeedback = await request("POST", "/chat/feedback", alice, { message_id: aliceControlMessageId, rating: "thumbs_down" });
        expect(controlFeedback.status).toBe(200);
        expect(getFeedbackSummary(alice.id, getUserScope(alice.id))).toMatchObject({ thumbs_up: 1, thumbs_down: 1, total: 2 });
        await request("POST", "/chat/feedback", bob, { message_id: aliceMessageId, rating: "thumbs_down" });
        expect(getFeedbackSummary(bob.id, getUserScope(bob.id))).toMatchObject({ total: 0 });

        const impact = await request("GET", "/eval/cross-source/impact?min_samples=1", alice);
        expect(impact.status).toBe(200);
        expect(impact.body.enabled).toBe(true);
        expect(impact.body.impact).toMatchObject({ sufficient: true, uplift: 1, recommendation: "candidate_for_canary" });
        expect(impact.text).not.toContain("M11OLDONLYZX9");

        const experiment = await request("GET", "/eval/cross-source/experiment?min_samples=1", alice);
        expect(experiment.status).toBe(200);
        expect(experiment.body.experiment).toMatchObject({ sufficient: true, uplift: 1 });
        expect(experiment.body.canary).toMatchObject({ approved: true, action: "request_manual_canary_approval" });

        const snapshot = await request("POST", "/eval/cross-source/experiment/snapshots", alice, {
            min_samples: 1,
            window_hours: 24 * 30,
            experiment_key: "m14-fixture",
        });
        expect(snapshot.status).toBe(200);
        expect(snapshot.body.snapshot).toMatchObject({ id: expect.any(Number), summary: { sufficient: true, uplift: 1 } });
        expect(snapshot.text).not.toContain("M11OLDONLYZX9");

        const approval = await request("POST", "/eval/cross-source/experiment/approvals", alice, {
            report_id: snapshot.body.snapshot.id,
            action: "approve_canary",
            target_config_version_id: 7,
            note: "fixture approval only",
        });
        expect(approval.status).toBe(201);
        expect(approval.body.approval).toMatchObject({ id: expect.any(Number), action: "approve_canary" });

        const history = await request("GET", "/eval/cross-source/experiment/history?limit=5", alice);
        expect(history.status).toBe(200);
        expect(history.body.reports[0]).toMatchObject({ id: snapshot.body.snapshot.id });
        expect(history.body.approvals[0]).toMatchObject({ action: "approve_canary", report_id: snapshot.body.snapshot.id });
        expect(history.text).not.toContain("M11OLDONLYZX9");

        const secondSnapshot = await request("POST", "/eval/cross-source/experiment/snapshots", alice, {
            min_samples: 1,
            window_hours: 24 * 30,
            experiment_key: "m14-fixture",
        });
        const guard = await request("GET", `/eval/cross-source/experiment/release-guard?before_id=${snapshot.body.snapshot.id}&after_id=${secondSnapshot.body.snapshot.id}`, alice);
        expect(guard.status).toBe(200);
        expect(guard.body.guard).toMatchObject({ automatic: false });
        expect(guard.text).not.toContain("M11OLDONLYZX9");

        const calibration = await request("POST", "/eval/cross-source/calibrate", alice, {
            records: [
                { rating: "thumbs_up", metrics: { isolation: 1, sourceCoverage: 1, budgetCompliance: 1, helpfulness: 0.9 } },
                { rating: "thumbs_up", metrics: { isolation: 1, sourceCoverage: 0.8, budgetCompliance: 1, helpfulness: 0.8 } },
                { rating: "thumbs_down", metrics: { isolation: 0, sourceCoverage: 0.3, budgetCompliance: 1, helpfulness: 0.2 } },
                { rating: "thumbs_down", metrics: { isolation: 0.2, sourceCoverage: 0.2, budgetCompliance: 0, helpfulness: 0.1 } },
            ],
        });
        expect(calibration.status).toBe(200);
        expect(calibration.body.calibration.sufficient).toBe(true);
        expect(calibration.body.calibration.best.balancedAccuracy).toBe(1);
        expect(calibration.text).not.toContain("M11OLDONLYZX9");

        const rejected = await request("POST", "/eval/cross-source/calibrate", alice, {
            records: [{ rating: "thumbs_up", text: "private answer", metrics: { helpfulness: 1 } }],
        });
        expect(rejected.status).toBe(400);
        expect(rejected.body.errorCode).toBe("CALIBRATION_RAW_CONTENT_NOT_ALLOWED");
    });

    it("can score the HTTP fixture's sanitized cross-source observation", () => {
        const quality = evaluateCrossSourceQuality({
            id: "m11-http-fixture",
            category: "cross_source_recall",
            crossSourceChecks: {
                requiredSourceTypes: ["user_memory", "project_memory", "rag"],
                outputAny: ["建议"],
            },
        }, {
            text: "根据我的偏好、项目约定和 RAG 片段给出建议。",
            trace: {
                metadata: {
                    cross_source_recall: {
                        selected: [
                            { id: "alice-memory", sourceType: "user_memory", score: 0.9 },
                            { id: "alice-project", sourceType: "project_memory", score: 0.88 },
                            { id: "alice-rag", sourceType: "rag", score: 0.86 },
                        ],
                        selectedTokens: 120,
                        config: { maxItems: 10, maxTokens: 1000 },
                        bySource: {
                            user_memory: { selected: 1, cap: 4 },
                            project_memory: { selected: 1, cap: 4 },
                            rag: { selected: 1, cap: 4 },
                        },
                    },
                },
            },
        });
        expect(quality.passed).toBe(true);
        expect(quality.metrics.sourceCoverage).toBe(1);
    });
});
