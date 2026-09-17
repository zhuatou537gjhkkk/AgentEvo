import { beforeAll, describe, expect, it } from "vitest";
import db, {
    claimCrossSourceExperimentJob,
    completeCrossSourceExperimentJob,
    createUser,
    getCrossSourceExperimentJob,
    getUserScope,
    initDB,
} from "../db/index.js";

let scope;

beforeAll(() => {
    initDB();
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userId = createUser(`m15_lease_${suffix}`, "hash");
    scope = getUserScope(userId);
});

describe("cross-source experiment durable lease", () => {
    it("rejects a second holder and reclaims an expired holder", () => {
        const jobName = "m15-lease-test";
        expect(claimCrossSourceExperimentJob(scope, { jobName, holderToken: "holder-a", leaseSeconds: 30 })).toBe(true);
        expect(claimCrossSourceExperimentJob(scope, { jobName, holderToken: "holder-b", leaseSeconds: 30 })).toBe(false);

        db.prepare(`UPDATE cross_source_experiment_jobs SET lease_expires_at = datetime('now', '-1 second') WHERE owner_user_id = ? AND tenant_id = ? AND job_name = ?`).run(scope.userId, scope.tenantId, jobName);
        expect(claimCrossSourceExperimentJob(scope, { jobName, holderToken: "holder-b", leaseSeconds: 30 })).toBe(true);
        expect(completeCrossSourceExperimentJob(scope, { jobName, holderToken: "holder-a", reportId: 1 })).toBe(false);
        expect(completeCrossSourceExperimentJob(scope, { jobName, holderToken: "holder-b", reportId: 2, nextRunSeconds: 60 })).toBe(true);
        expect(getCrossSourceExperimentJob(scope, jobName)).toMatchObject({ status: "ready", last_report_id: 2, attempt_count: 2 });
    });
});
