import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollKnowledgeIngestJob } from '../chat.js';

function response(payload) {
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
}

afterEach(() => vi.unstubAllGlobals());

describe('knowledge ingest polling', () => {
    it('polls 202-style jobs until ready and reports stage progress', async () => {
        const progress = [];
        let calls = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            calls += 1;
            return response({ ok: true, job: calls === 1
                ? { id: 'ing-1', status: 'provider_running', progress: { current: 2, total: 6 }, pollUrl: '/rag/ingest/ing-1' }
                : { id: 'ing-1', status: 'ready', progress: { current: 6, total: 6 }, pollUrl: '/rag/ingest/ing-1', documentId: 'kd-1' } });
        }));
        const result = await pollKnowledgeIngestJob('/rag/ingest/ing-1', { initialDelayMs: 0, maxDelayMs: 0, onProgress: (value) => progress.push(value) });
        expect(result.data.status).toBe('ready');
        expect(result.data.documentId).toBe('kd-1');
        expect(calls).toBe(2);
        expect(progress.map((item) => item.phase)).toContain('解析中');
        expect(progress.at(-1).phase).toBe('可用');
    });

    it('stops polling when the caller aborts during the wait', async () => {
        const controller = new AbortController();
        const pending = pollKnowledgeIngestJob('/rag/ingest/ing-2', {
            signal: controller.signal,
            initialJob: { id: 'ing-2', status: 'queued', pollUrl: '/rag/ingest/ing-2' },
            initialDelayMs: 10_000,
            maxDelayMs: 10_000,
        });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });
});
