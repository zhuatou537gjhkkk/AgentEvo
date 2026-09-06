import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initDB, createUser } from "../../db/index.js";
import { clearCodingFlags } from "../../coding/flags.js";
import * as benchService from "./benchService.js";
import { listScenarioIds } from "./scenarios.js";

/**
 * Phase 7 / R6 — bench service: run the FULL 11-category scenario catalog once each
 * over the real coding substrate (deterministic scripted model, fixed-revision
 * fixture repos), persist the bench_runs summary + sanitized raw, and prove the
 * owner-consent gate on trajectory/dataset export (R6 #1/#3/#4/#5/#6).
 *
 * Every authored scenario is a "correct" reproduction of its category — each must
 * reproduce deterministically and PASS its offline gate. A failure here means the
 * scenario/seed/driver no longer reproduces at its fixed revision (the R6 anchor).
 * Deterministic failure detection itself is covered by reward.test.js (no LLM judge).
 */

const OWNER = { name: "bench_service_owner", username: "benchsvc" };

beforeAll(() => {
    initDB();
    OWNER.id = createUser(OWNER.name, "hash-bench-svc");
    // The bench substrate shares the server's coding feature flags — enable them
    // here exactly as a live operator would for the offline evaluation.
    process.env.CODING_WORKSPACE_ENABLED = "true";
    process.env.CODING_WRITE_TOOLS_ENABLED = "true";
    process.env.CODING_COMMAND_TOOLS_ENABLED = "true";
    process.env.CODING_RAG_REUSE_ENABLED = "true";
});

afterAll(() => {
    clearCodingFlags();
});

const scope = () => ({ userId: OWNER.id });

describe("bench service — full catalog reproduces + passes its offline gate", () => {
    it(
        "every scenario drives to its expected terminal, persists, and clears the gate",
        async () => {
            const ids = listScenarioIds();
            expect(ids.length).toBe(11);
            const seen = {};
            for (const scenarioId of ids) {
                const result = await benchService.runScenario(scope(), scenarioId, { cleanup: true });
                const { run } = result;
                seen[scenarioId] = run.id;
                // durable summary row persisted
                expect(run.scenarioId).toBe(scenarioId);
                expect(run.status).toBe("completed");
                expect(run.consent).toBe(false);
                expect(run.repoHeadSha).toMatch(/^[0-9a-f]{40}$/);
                expect(run.codingRunId).toBeTruthy();
                // metrics + reward derived and stored
                expect(run.metrics.completion.phase).toBeTruthy();
                expect(run.metrics.latency.totalMs).toBeGreaterThanOrEqual(0);
                const meta = benchService.getScenarioMeta(scenarioId);
                expect(run.metrics.completion.phase).toBe(meta.expectTerminal || "done");
                // the authored category must reproduce its intended acceptance
                const gate = run.reward.gate;
                expect(gate.accepted, `${scenarioId} failed offline gate: ${gate.reasons?.join("; ")}`).toBe(true);
                // listing round-trips the same row
                const listed = benchService.listRuns(scope(), { scenarioId, limit: 5 });
                expect(listed.some((r) => r.id === run.id)).toBe(true);
            }
            // full listing across the catalog
            const all = benchService.listRuns(scope(), { limit: 100 });
            expect(all.length).toBe(11);
            expect(new Set(all.map((r) => r.scenarioId))).toEqual(new Set(ids));
        },
        180_000,
    );
});

describe("bench service — consent gates trajectory/dataset export", () => {
    it(
        "refuses export until consent, then serves a redacted trajectory + jsonl dataset",
        async () => {
            const run = await benchService.runScenario(scope(), "navigation-locate-config", { cleanup: true });
            const runId = run.run.id;

            // 1) no consent → export refused (R6 #5)
            await expect(async () => benchService.exportRunTrajectory(scope(), runId, { redact: "paths" }))
                .rejects.toMatchObject({ code: "BENCH_CONSENT_REQUIRED", statusCode: 403 });
            await expect(async () => benchService.exportRunDataset(scope(), runId, { kinds: ["sft"] }))
                .rejects.toMatchObject({ code: "BENCH_CONSENT_REQUIRED", statusCode: 403 });

            // 2) owner opts in
            const consented = benchService.setConsent(scope(), runId, true);
            expect(consented.consent).toBe(true);

            // 3) trajectory export (structural/redacted, not the raw DB rows)
            const traj = benchService.exportRunTrajectory(scope(), runId, { redact: "structural" });
            expect(traj.trajectory.level).toBe("run");
            expect(traj.redact).toBe("structural");
            expect(traj.counts.planSteps).toBeGreaterThan(0);
            expect(traj.trajectory.nodes[0].node).toBe("code_agent");
            // structural redaction keeps ids/statuses but no prose/paths
            const serialized = JSON.stringify(traj.trajectory);
            expect(serialized).not.toMatch(/src\//); // paths stripped
            expect(serialized).not.toContain("RETRY_LIMIT"); // notes stripped

            // 4) dataset export (sft + grpo jsonl rows with run provenance)
            const ds = benchService.exportRunDataset(scope(), runId, { kinds: ["sft", "grpo"], redact: "full" });
            expect(ds.format).toBe("jsonl");
            expect(ds.kinds.map((k) => k.kind)).toEqual(["sft", "grpo"]);
            const sftRows = ds.kinds.find((k) => k.kind === "sft").rows;
            expect(sftRows.length).toBeGreaterThan(0);
            expect(sftRows[0]).toMatchObject({ kind: "sft", runId, scenarioId: "navigation-locate-config" });
            const grpoRows = ds.kinds.find((k) => k.kind === "grpo").rows;
            expect(grpoRows.length).toBe(1);
            expect(grpoRows[0].trace.length).toBeGreaterThan(0);
            expect(Object.keys(grpoRows[0].reward).length).toBeGreaterThan(0);

            // 5) consent can be revoked
            expect(benchService.setConsent(scope(), runId, false).consent).toBe(false);
        },
        120_000,
    );
});

describe("bench service — errors", () => {
    it("rejects an unknown scenario id without running anything", async () => {
        await expect(async () => benchService.runScenario(scope(), "does-not-exist"))
            .rejects.toMatchObject({ code: "BENCH_SCENARIO_NOT_FOUND", statusCode: 404 });
    });

    it("a get on another owner's run is invisible (owner scope)", async () => {
        const run = await benchService.runScenario(scope(), "patch-wrong-sign", { cleanup: true });
        const other = createUser("bench_service_other", "hash-other");
        expect(benchService.getRun({ userId: other }, run.run.id)).toBeNull();
        expect(benchService.listRuns({ userId: other }, { limit: 100 })).toEqual([]);
    }, 60_000);
});
