import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../chatStore';

const api = vi.hoisted(() => ({
    fetchContextUsage: vi.fn(),
}));

vi.mock('../../api/chat', async () => {
    const actual = await vi.importActual('../../api/chat');
    return { ...actual, fetchContextUsage: api.fetchContextUsage };
});

const getState = () => useChatStore.getState();

beforeEach(() => {
    api.fetchContextUsage.mockReset();
    useChatStore.setState({ currentSessionId: 1, contextUsage: null });
});

describe('chatStore context usage lifecycle', () => {
    it('accepts usage only when it belongs to the active session', async () => {
        api.fetchContextUsage.mockResolvedValue({
            ok: true,
            data: { sessionId: 1, usedTokens: 100, maxTokens: 1000, ratio: 10, messageCount: 2 },
        });

        await getState().fetchContextUsage(1);

        expect(getState().contextUsage).toMatchObject({ sessionId: 1, ratio: 10 });
    });

    it('drops a response after the active session changes', async () => {
        let resolveUsage;
        api.fetchContextUsage.mockReturnValue(new Promise((resolve) => {
            resolveUsage = resolve;
        }));

        const request = getState().fetchContextUsage(1);
        useChatStore.setState({ currentSessionId: 2, contextUsage: null });
        resolveUsage({ ok: true, data: { sessionId: 1, ratio: 10, messageCount: 2 } });
        await request;

        expect(getState().contextUsage).toBeNull();
    });

    it('drops an older response when a newer refresh wins', async () => {
        const resolvers = [];
        api.fetchContextUsage.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));

        const oldRequest = getState().fetchContextUsage(1);
        const newRequest = getState().fetchContextUsage(1);
        resolvers[1]({ ok: true, data: { sessionId: 1, ratio: 20, messageCount: 3 } });
        await newRequest;
        resolvers[0]({ ok: true, data: { sessionId: 1, ratio: 10, messageCount: 3 } });
        await oldRequest;

        expect(getState().contextUsage.ratio).toBe(20);
    });

    it('clears usage when starting a session switch', async () => {
        useChatStore.setState({ contextUsage: { sessionId: 1, ratio: 10, messageCount: 2 } });
        api.fetchContextUsage.mockResolvedValue({ ok: true, data: { sessionId: 2, ratio: 0, messageCount: 0 } });

        await getState().switchSession(2);

        expect(getState().contextUsage).toBeNull();
    });
});
