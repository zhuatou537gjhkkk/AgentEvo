import { describe, expect, it } from 'vitest';
import {
    AGENT_CONFIGS,
    ALL_CONFIGS,
    MEMORY_CONFIGS,
    TOOL_CONFIGS,
    validateConfigValue,
} from './configSchema';

describe('settings config schema', () => {
    it('keeps the documented 6/5/7 configuration groups with human labels', () => {
        expect(AGENT_CONFIGS).toHaveLength(6);
        expect(TOOL_CONFIGS).toHaveLength(5);
        expect(MEMORY_CONFIGS).toHaveLength(7);
        expect(ALL_CONFIGS).toHaveLength(18);
        expect(AGENT_CONFIGS.every((item) => item.label && item.responsibility)).toBe(true);
        expect(TOOL_CONFIGS.every((item) => item.label && item.responsibility)).toBe(true);
        expect(MEMORY_CONFIGS.every((item) => item.label && item.inputType)).toBe(true);
    });

    it('validates ratios and non-negative integer days by their actual types', () => {
        expect(validateConfigValue('memory.consolidateThreshold', '0.7').ok).toBe(true);
        expect(validateConfigValue('memory.consolidateThreshold', '1.2').ok).toBe(false);
        expect(validateConfigValue('memory.autoForgetDays', '0').ok).toBe(true);
        expect(validateConfigValue('memory.autoForgetDays', '-1').ok).toBe(false);
        expect(validateConfigValue('memory.autoForgetDays', '1.5').ok).toBe(false);
    });

    it('validates score weight JSON and allows an empty config version id', () => {
        const valid = '{"relevance":0.5,"confidence":0.2,"importance":0.1,"recency":0.1,"trust":0.1}';
        expect(validateConfigValue('memory.crossSource.scoreWeights', valid).ok).toBe(true);
        expect(validateConfigValue('memory.crossSource.scoreWeights', '{bad json').ok).toBe(false);
        expect(validateConfigValue('memory.crossSource.scoreWeights', '{"relevance":-1,"confidence":0,"importance":0,"recency":0,"trust":0}').ok).toBe(false);
        expect(validateConfigValue('memory.crossSource.configVersionId', '').ok).toBe(true);
        expect(validateConfigValue('memory.crossSource.experimentKey', 'test-key').value).toBe('test-key');
    });
});
