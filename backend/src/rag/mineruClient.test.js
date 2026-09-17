import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createMineruClient } from "./mineruClient.js";

function response(payload, { status = 200, headers = {} } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => headers[String(name).toLowerCase()] || null },
        json: async () => payload,
    };
}

const clientOptions = { token: "test-token", apiBaseUrl: "https://mineru.test", allowedHosts: ["mineru.test", "signed.mineru.test"], retries: 0, sleep: async () => {} };

describe("MinerU provider client", () => {
    it("requests an upload slot with the bearer token and normalized payload", async () => {
        let request;
        const client = createMineruClient({
            ...clientOptions,
            fetchImpl: async (url, options) => { request = { url, options }; return response({ code: 0, trace_id: "trace-1", data: { batch_id: "batch-1", file_urls: ["https://signed.mineru.test/upload?sig=secret"] } }); },
        });
        const result = await client.requestUploadSlot({ fileName: "manual.pdf", dataId: "doc-1", options: { isOcr: true, enableTable: true } });
        expect(result.batchId).toBe("batch-1");
        expect(result.uploadUrl).toContain("https://signed.mineru.test/");
        expect(request.url).toBe("https://mineru.test/api/v4/file-urls/batch");
        expect(request.options.headers.Authorization).toBe("Bearer test-token");
        expect(JSON.parse(request.options.body)).toMatchObject({ files: [{ name: "manual.pdf", data_id: "doc-1", is_ocr: true }], enable_table: true });
    });

    it("fails closed when the token is missing", async () => {
        let calls = 0;
        const client = createMineruClient({ ...clientOptions, token: "", fetchImpl: async () => { calls += 1; return response({ code: 0 }); } });
        await expect(client.getBatchResult({ batchId: "batch-1" })).rejects.toMatchObject({ code: "MINERU_TOKEN_MISSING" });
        expect(calls).toBe(0);
    });

    it("maps authentication failures to a non-retryable safe error", async () => {
        let calls = 0;
        const client = createMineruClient({ ...clientOptions, retries: 2, fetchImpl: async () => { calls += 1; return response({ code: "A0202" }, { status: 401 }); } });
        await expect(client.getBatchResult({ batchId: "batch-1" })).rejects.toMatchObject({ code: "MINERU_AUTH_FAILED", retryable: false, providerCode: "A0202" });
        expect(calls).toBe(1);
    });

    it("retries 429 and 5xx responses without leaking provider details", async () => {
        let calls = 0;
        const client = createMineruClient({ ...clientOptions, retries: 2, sleep: async () => {}, fetchImpl: async () => {
            calls += 1;
            if (calls === 1) return response({ code: 0 }, { status: 429 });
            return response({ code: 0, data: { extract_result: [{ state: "done", full_zip_url: "https://signed.mineru.test/out.zip" }] } });
        } });
        const result = await client.getBatchResult({ batchId: "batch-1" });
        expect(result.state).toBe("done");
        expect(calls).toBe(2);
    });

    it("honors zero retries from the environment", async () => {
        const previous = process.env.MINERU_HTTP_RETRIES;
        process.env.MINERU_HTTP_RETRIES = "0";
        try {
            let calls = 0;
            const client = createMineruClient({
                token: "test-token",
                apiBaseUrl: "https://mineru.test",
                allowedHosts: ["mineru.test"],
                fetchImpl: async () => {
                    calls += 1;
                    return response({ code: 0 }, { status: 429 });
                },
            });
            await expect(client.getBatchResult({ batchId: "batch-1" })).rejects.toMatchObject({ code: "MINERU_PROVIDER_RETRYABLE" });
            expect(calls).toBe(1);
        } finally {
            if (previous === undefined) delete process.env.MINERU_HTTP_RETRIES;
            else process.env.MINERU_HTTP_RETRIES = previous;
        }
    });

    it("rejects non-HTTPS, unallowlisted, and redirect responses", async () => {
        const client = createMineruClient({ ...clientOptions, fetchImpl: async () => response({}, { status: 302 }) });
        await expect(client.downloadResult({ resultUrl: "http://signed.mineru.test/out.zip", targetPath: "out.zip" })).rejects.toMatchObject({ code: "MINERU_PROVIDER_URL_INVALID" });
        await expect(client.downloadResult({ resultUrl: "https://127.0.0.1/out.zip", targetPath: "out.zip" })).rejects.toMatchObject({ code: "MINERU_PROVIDER_URL_INVALID" });
        await expect(client.downloadResult({ resultUrl: "https://signed.mineru.test/out.zip", targetPath: "out.zip" })).rejects.toMatchObject({ code: "MINERU_PROVIDER_FAILED" });
    });

    it("does not add Content-Type to signed uploads and downloads with a byte cap", async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-client-"));
        const source = path.join(tempDir, "source.txt");
        const target = path.join(tempDir, "target.zip");
        await fs.writeFile(source, "payload");
        let uploadOptions;
        const client = createMineruClient({ ...clientOptions, fetchImpl: async (_url, options) => {
            if (options.method === "PUT") { uploadOptions = options; return response({}, { status: 200 }); }
            return { ...response({}), body: Readable.toWeb(Readable.from([Buffer.from("zip-data")])), headers: { get: () => null } };
        } });
        await client.uploadFile({ uploadUrl: "https://signed.mineru.test/upload", filePath: source });
        await client.downloadResult({ resultUrl: "https://signed.mineru.test/out.zip", targetPath: target });
        expect(uploadOptions.headers).toEqual({});
        expect(await fs.readFile(target, "utf8")).toBe("zip-data");
    });

    it("turns caller aborts into the shared aborted error", async () => {
        const controller = new AbortController();
        const client = createMineruClient({ ...clientOptions, timeoutMs: 5_000, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        }) });
        const pending = client.getBatchResult({ batchId: "batch-1", signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    });
});
