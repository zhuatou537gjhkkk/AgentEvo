import { afterEach, describe, expect, it } from "vitest";
import { runCrossSourceExperimentSampler, startCrossSourceExperimentSampler } from "./crossSourceExperimentSampler.js";

const previous = {
    experiment: process.env.MEMORY_CROSS_SOURCE_EXPERIMENT_V2,
    sampler: process.env.MEMORY_CROSS_SOURCE_SAMPLER_V2,
};

afterEach(() => {
    if (previous.experiment === undefined) delete process.env.MEMORY_CROSS_SOURCE_EXPERIMENT_V2;
    else process.env.MEMORY_CROSS_SOURCE_EXPERIMENT_V2 = previous.experiment;
    if (previous.sampler === undefined) delete process.env.MEMORY_CROSS_SOURCE_SAMPLER_V2;
    else process.env.MEMORY_CROSS_SOURCE_SAMPLER_V2 = previous.sampler;
});

describe("cross-source experiment sampler", () => {
    it("stays inert while either opt-in flag is disabled", () => {
        delete process.env.MEMORY_CROSS_SOURCE_EXPERIMENT_V2;
        process.env.MEMORY_CROSS_SOURCE_SAMPLER_V2 = "true";
        expect(runCrossSourceExperimentSampler()).toMatchObject({ enabled: false, reason: "feature_disabled" });
        expect(typeof startCrossSourceExperimentSampler()).toBe("function");
    });
});
