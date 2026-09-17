import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../chatStore';

describe('chat session settings isolation', () => {
    beforeEach(() => {
        useChatStore.setState({
            currentSessionId: null,
            systemPrompt: '你是一个有用的 AI 助手。',
            temperature: 0.7,
            sessionAgentSettings: {},
        });
    });

    it('keeps Prompt and Temperature isolated when switching between sessions', () => {
        const store = useChatStore.getState();
        useChatStore.setState({ currentSessionId: 'A' });
        store.setSystemPrompt('A prompt');
        store.setTemperature(0.2);

        useChatStore.setState({ currentSessionId: 'B' });
        useChatStore.getState().setSystemPrompt('B prompt');
        useChatStore.getState().setTemperature(0.9);

        expect(useChatStore.getState().sessionAgentSettings.A).toMatchObject({ systemPrompt: 'A prompt', temperature: 0.2 });
        expect(useChatStore.getState().sessionAgentSettings.B).toMatchObject({ systemPrompt: 'B prompt', temperature: 0.9 });

        useChatStore.setState({ currentSessionId: 'A' });
        expect(useChatStore.getState().sessionAgentSettings.A).toMatchObject({ systemPrompt: 'A prompt', temperature: 0.2 });
    });

    it('resets only the active session settings', () => {
        useChatStore.setState({ currentSessionId: 'A' });
        useChatStore.getState().setSystemPrompt('A prompt');
        useChatStore.getState().setTemperature(0.2);
        useChatStore.setState({ currentSessionId: 'B' });
        useChatStore.getState().setSystemPrompt('B prompt');
        useChatStore.getState().setTemperature(0.9);

        useChatStore.getState().resetCurrentSessionSettings();

        expect(useChatStore.getState().sessionAgentSettings.A).toMatchObject({ systemPrompt: 'A prompt', temperature: 0.2 });
        expect(useChatStore.getState().sessionAgentSettings.B).toMatchObject({ systemPrompt: '你是一个有用的 AI 助手。', temperature: 0.7 });
    });
});
