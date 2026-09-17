import { describe, expect, it, vi } from 'vitest';
import { openSettings, SETTINGS_TABS, SETTINGS_VIEW } from './navigation';

describe('settings navigation contract', () => {
    it('exposes the five workspace sections and settings view id', () => {
        expect(SETTINGS_VIEW).toBe('settings');
        expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual(['agent', 'tools', 'memory', 'appearance', 'versions']);
        expect(SETTINGS_TABS.find((tab) => tab.id === 'appearance').scope).toBe('当前浏览器');
    });

    it('uses the same settings entry for desktop and mobile sidebar instances', () => {
        const onViewChange = vi.fn();
        openSettings(onViewChange);
        expect(onViewChange).toHaveBeenCalledWith('settings');
    });
});
