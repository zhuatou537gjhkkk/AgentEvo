import { describe, expect, it } from 'vitest';
import { isContextUsageVisible } from '../ContextIndicator';

describe('isContextUsageVisible', () => {
    it('shows usage only for the active session with messages', () => {
        expect(isContextUsageVisible(2, { sessionId: 2, messageCount: 3 })).toBe(true);
    });

    it('hides missing, stale, or empty-session usage', () => {
        expect(isContextUsageVisible(null, { sessionId: 2, messageCount: 3 })).toBe(false);
        expect(isContextUsageVisible(2, null)).toBe(false);
        expect(isContextUsageVisible(2, { sessionId: 1, messageCount: 3 })).toBe(false);
        expect(isContextUsageVisible(2, { sessionId: 2, messageCount: 0 })).toBe(false);
    });

    it('accepts numeric and string session ids', () => {
        expect(isContextUsageVisible(2, { sessionId: '2', messageCount: 1 })).toBe(true);
    });
});
