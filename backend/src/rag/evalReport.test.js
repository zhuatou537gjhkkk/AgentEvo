import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOwnerScopedRagEvalReport, sanitizeRagEvalReport } from "./evalReport.js";

const report = {
    datasetVersion: "rag-v1",
    modelAlias: "chat-model",
    gates: { status: "insufficient_sample", full: { noAnswerPrecision: { status: "pass", value: 1, target: 0.9, sampleCount: 4 } } },
    profiles: { hybrid: { profile: "hybrid", summary: { sampleCount: 4, recallAtK: 0.9, tokenCount: 10 } } },
    cases: [{ id: "private", answer: "must not be returned" }],
};

describe("K11 RAG eval report projection", () => {
    it("returns only content-free profile summaries and gates", () => {
        const safe = sanitizeRagEvalReport(report);
        expect(safe).toMatchObject({ available: true, datasetVersion: "rag-v1", profiles: { hybrid: { summary: { recallAtK: 0.9, tokenCount: 10 } } } });
        expect(JSON.stringify(safe)).not.toContain("private");
        expect(JSON.stringify(safe)).not.toContain("must not be returned");
    });

    it("auto-binds a global report to the current authenticated user", () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentevo-rag-report-"));
        const filePath = path.join(directory, "report.json");
        fs.writeFileSync(filePath, JSON.stringify(report), "utf8");
        expect(getOwnerScopedRagEvalReport({ userId: 42 }, { filePath })).toMatchObject({ available: true, binding: "current_user" });
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it("enforces the report owner when a user-specific report is supplied", () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentevo-rag-report-"));
        const filePath = path.join(directory, "report.json");
        fs.writeFileSync(filePath, JSON.stringify({ ...report, schemaVersion: "rag-eval-k9-v2", visibility: "user", ownerUserId: 1 }), "utf8");
        expect(getOwnerScopedRagEvalReport({ userId: 2 }, { filePath })).toEqual({ available: false, reason: "RAG_EVAL_REPORT_NOT_OWNER" });
        expect(getOwnerScopedRagEvalReport({ userId: 1 }, { filePath })).toMatchObject({ available: true, binding: "owner" });
        fs.rmSync(directory, { recursive: true, force: true });
    });
});
