/**
 * User-memory lifecycle flags.
 *
 * The v2 lifecycle is intentionally opt-in while its write path is being
 * validated. Existing agent_memory rows remain usable when the flag is off.
 */
function flagEnabled(name) {
    const raw = process.env[name];
    if (raw == null) return false;
    return ["true", "1", "yes"].includes(String(raw).trim().toLowerCase());
}

export const memoryLifecycleEnabled = () => flagEnabled("MEMORY_LIFECYCLE_V2");
export const memoryRetentionEnabled = () => flagEnabled("MEMORY_RETENTION_V2");
export const memoryRecallEnabled = () => flagEnabled("MEMORY_RECALL_V2");
export const memoryTypeAwareScoringEnabled = () => flagEnabled("MEMORY_TYPE_AWARE_SCORING_V2");
export const memoryVectorRecallEnabled = () => flagEnabled("MEMORY_VECTOR_RECALL_V2");
export const memoryExtractionScoringRubricEnabled = () => flagEnabled("MEMORY_EXTRACTION_SCORING_RUBRIC_V2");
// Working-memory maintenance is a separate dark flag because it adds writes
// on the planning/graph/compaction paths and changes the ContextBuilder packet
// set. Legacy memory recall and explicit memory APIs remain independent.
export const workingMemoryEnabled = () => flagEnabled("MEMORY_WORKING_CONTEXT_V1");
// M8 is additive: it enriches serialized records and ContextPackets while
// leaving the user/project stores physically and operationally separate.
export const memoryContractEnabled = () => flagEnabled("MEMORY_CONTRACT_V2");
export const crossSourceRecallEnabled = () => flagEnabled("MEMORY_CROSS_SOURCE_V2");
export const crossSourceEvalEnabled = () => flagEnabled("MEMORY_CROSS_SOURCE_EVAL_V2");
export const crossSourceImpactEnabled = () => flagEnabled("MEMORY_CROSS_SOURCE_IMPACT_V2");
export const crossSourceExperimentEnabled = () => flagEnabled("MEMORY_CROSS_SOURCE_EXPERIMENT_V2");
export const crossSourceExperimentSamplerEnabled = () => flagEnabled("MEMORY_CROSS_SOURCE_SAMPLER_V2");

export const MEMORY_FLAG_NAMES = ["MEMORY_LIFECYCLE_V2", "MEMORY_RETENTION_V2", "MEMORY_RECALL_V2", "MEMORY_TYPE_AWARE_SCORING_V2", "MEMORY_VECTOR_RECALL_V2", "MEMORY_EXTRACTION_SCORING_RUBRIC_V2", "MEMORY_WORKING_CONTEXT_V1", "MEMORY_CONTRACT_V2", "MEMORY_CROSS_SOURCE_V2", "MEMORY_CROSS_SOURCE_EVAL_V2", "MEMORY_CROSS_SOURCE_IMPACT_V2", "MEMORY_CROSS_SOURCE_EXPERIMENT_V2", "MEMORY_CROSS_SOURCE_SAMPLER_V2"];

export function clearMemoryFlags() {
    for (const name of MEMORY_FLAG_NAMES) delete process.env[name];
}

export default { memoryLifecycleEnabled, memoryRetentionEnabled, memoryRecallEnabled, memoryTypeAwareScoringEnabled, memoryVectorRecallEnabled, memoryExtractionScoringRubricEnabled, workingMemoryEnabled, memoryContractEnabled, crossSourceRecallEnabled, crossSourceEvalEnabled, crossSourceImpactEnabled, crossSourceExperimentEnabled, crossSourceExperimentSamplerEnabled, MEMORY_FLAG_NAMES, clearMemoryFlags };
