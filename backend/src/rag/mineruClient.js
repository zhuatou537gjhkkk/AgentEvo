import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { AppError, withRetry } from "../services/resilience.js";

const DEFAULT_API_BASE_URL = "https://mineru.net";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_ALLOWED_HOSTS = Object.freeze([
    "mineru.net",
    "cdn-mineru.openxlab.org.cn",
    "mineru.oss-cn-shanghai.aliyuncs.com",
]);

function configuredRetries() {
    const value = Number(process.env.MINERU_HTTP_RETRIES);
    return Number.isInteger(value) && value >= 0 ? value : DEFAULT_RETRIES;
}

export class MineruClientError extends AppError {
    constructor(message, {
        code = "MINERU_REQUEST_FAILED",
        statusCode = 502,
        retryable = false,
        providerCode = null,
        cause,
    } = {}) {
        super(message, { code, statusCode, retryable, cause });
        this.name = "MineruClientError";
        this.providerCode = providerCode;
    }
}

function safeProviderCode(value) {
    if (value == null) return null;
    const text = String(value).trim();
    return /^[A-Za-z0-9_-]{1,80}$/.test(text) ? text : "PROVIDER_ERROR";
}

function getToken(explicitToken) {
    const token = explicitToken ?? process.env.MINERU_API_TOKEN;
    if (!token || !String(token).trim()) {
        throw new MineruClientError("MinerU token is not configured", {
            code: "MINERU_TOKEN_MISSING",
            statusCode: 503,
        });
    }
    return String(token).trim();
}

function parseAllowedHosts(value) {
    if (Array.isArray(value)) return value.map((host) => String(host).toLowerCase()).filter(Boolean);
    if (typeof value === "string") return value.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
    return [...DEFAULT_ALLOWED_HOSTS];
}

function assertHttpsUrl(rawUrl, allowedHosts, code = "MINERU_PROVIDER_URL_INVALID") {
    let url;
    try {
        url = new URL(String(rawUrl));
    } catch (error) {
        throw new MineruClientError("MinerU provider URL is invalid", { code, cause: error });
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || !allowedHosts.includes(host)) {
        throw new MineruClientError("MinerU provider URL is not allowed", { code });
    }
    return url;
}

function jsonError(response, payload) {
    const providerCode = safeProviderCode(payload?.code);
    const numericProviderCode = Number(payload?.code);
    const status = Number(response?.status || 0);
    const authFailed = providerCode === "A0202" || providerCode === "A0211";
    const queueFull = numericProviderCode === -60009;
    const retryable = !authFailed && (status === 408 || status === 425 || status === 429 || status >= 500 || queueFull);
    return new MineruClientError("MinerU provider request failed", {
        code: authFailed ? "MINERU_AUTH_FAILED" : (retryable ? "MINERU_PROVIDER_RETRYABLE" : "MINERU_PROVIDER_FAILED"),
        statusCode: status >= 400 && status < 600 ? status : (retryable ? 503 : 502),
        retryable,
        providerCode: providerCode || (queueFull ? "-60009" : null),
    });
}

function createRequestSignal(parentSignal, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    let timer = null;
    const abortFromParent = () => controller.abort(parentSignal.reason);
    if (parentSignal) {
        if (parentSignal.aborted) controller.abort(parentSignal.reason);
        else parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort(new Error("MinerU request timeout"));
        }, timeoutMs);
    }
    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        cleanup: () => {
            if (timer) clearTimeout(timer);
            parentSignal?.removeEventListener("abort", abortFromParent);
        },
    };
}

async function readJson(response) {
    try {
        return await response.json();
    } catch (error) {
        throw new MineruClientError("MinerU response is not valid JSON", {
            code: "MINERU_RESPONSE_INVALID",
            statusCode: 502,
            cause: error,
        });
    }
}

function assertBatchId(batchId) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(batchId || ""))) {
        throw new MineruClientError("MinerU batch id is invalid", { code: "MINERU_BATCH_ID_INVALID", statusCode: 400 });
    }
}

export function createMineruClient({
    fetchImpl = globalThis.fetch,
    token,
    apiBaseUrl = process.env.MINERU_API_BASE_URL || DEFAULT_API_BASE_URL,
    allowedHosts = process.env.MINERU_ALLOWED_HOSTS,
    timeoutMs = Number(process.env.MINERU_HTTP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    retries = configuredRetries(),
    maxDownloadBytes = Number(process.env.MINERU_MAX_DOWNLOAD_BYTES) || DEFAULT_MAX_DOWNLOAD_BYTES,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = () => 0.5,
} = {}) {
    if (typeof fetchImpl !== "function") throw new MineruClientError("fetch is not available", { code: "MINERU_FETCH_UNAVAILABLE" });
    const apiUrl = assertHttpsUrl(apiBaseUrl, parseAllowedHosts(allowedHosts));
    const providerHosts = parseAllowedHosts(allowedHosts);

    async function requestJson(path, options = {}) {
        const bearerToken = getToken(token);
        const request = createRequestSignal(options.signal, timeoutMs);
        try {
            return await withRetry(async () => {
                let response;
                try {
                    response = await fetchImpl(new URL(path, apiUrl).toString(), {
                        method: options.method || "GET",
                        headers: {
                            Authorization: `Bearer ${bearerToken}`,
                            Accept: "application/json",
                            ...(options.body ? { "Content-Type": "application/json" } : {}),
                        },
                        body: options.body ? JSON.stringify(options.body) : undefined,
                        redirect: "error",
                        signal: request.signal,
                    });
                } catch (error) {
                    if (options.signal?.aborted) throw new MineruClientError("MinerU request aborted", { code: "ABORTED", statusCode: 499, cause: error });
                    if (request.timedOut()) throw new MineruClientError("MinerU request timed out", { code: "MINERU_TIMEOUT", statusCode: 504, retryable: true, cause: error });
                    throw new MineruClientError("MinerU request failed", { code: "MINERU_TRANSPORT_ERROR", statusCode: 503, retryable: true, cause: error });
                }
                const payload = await readJson(response);
                if (!response.ok || Number(payload?.code || 0) !== 0) throw jsonError(response, payload);
                return payload;
            }, {
                retries,
                signal: options.signal,
                random,
                onRetry: async (_error, _attempt, delay) => sleep(delay),
                shouldRetry: (error) => Boolean(error.retryable),
            });
        } finally {
            request.cleanup();
        }
    }

    async function requestUploadSlot({ fileName, dataId, options = {}, signal } = {}) {
        if (!String(fileName || "").trim()) throw new MineruClientError("fileName is required", { code: "MINERU_FILE_NAME_REQUIRED", statusCode: 400 });
        const payload = await requestJson("/api/v4/file-urls/batch", {
            method: "POST",
            signal,
            body: {
                files: [{
                    name: String(fileName).slice(0, 240),
                    data_id: dataId ? String(dataId).slice(0, 200) : undefined,
                    ...(options.isOcr == null ? {} : { is_ocr: Boolean(options.isOcr) }),
                    ...(options.pageRanges ? { page_ranges: String(options.pageRanges) } : {}),
                }],
                ...(options.modelVersion ? { model_version: String(options.modelVersion) } : {}),
                ...(options.language ? { language: String(options.language) } : {}),
                ...(options.enableFormula == null ? {} : { enable_formula: Boolean(options.enableFormula) }),
                ...(options.enableTable == null ? {} : { enable_table: Boolean(options.enableTable) }),
            },
        });
        const batchId = payload?.data?.batch_id;
        const uploadUrl = payload?.data?.file_urls?.[0];
        assertBatchId(batchId);
        assertHttpsUrl(uploadUrl, providerHosts);
        return { batchId, uploadUrl, traceId: payload?.trace_id || null };
    }

    async function uploadFile({ uploadUrl, filePath, signal } = {}) {
        const url = assertHttpsUrl(uploadUrl, providerHosts);
        if (!String(filePath || "").trim()) throw new MineruClientError("filePath is required", { code: "MINERU_FILE_PATH_REQUIRED", statusCode: 400 });
        return withRetry(async () => {
            const request = createRequestSignal(signal, timeoutMs);
            try {
                let response;
                try {
                    response = await fetchImpl(url.toString(), {
                        method: "PUT",
                        // Signed upload URLs can reject an extra Content-Type header.
                        headers: {},
                        body: fs.createReadStream(filePath),
                        duplex: "half",
                        redirect: "manual",
                        signal: request.signal,
                    });
                } catch (error) {
                    if (signal?.aborted) throw new MineruClientError("MinerU upload aborted", { code: "ABORTED", statusCode: 499, cause: error });
                    if (request.timedOut()) throw new MineruClientError("MinerU upload timed out", { code: "MINERU_TIMEOUT", statusCode: 504, retryable: true, cause: error });
                    throw new MineruClientError("MinerU upload failed", { code: "MINERU_TRANSPORT_ERROR", statusCode: 503, retryable: true, cause: error });
                }
                if (!response.ok) throw jsonError(response, { code: response.status });
                return { uploaded: true, status: response.status };
            } finally {
                request.cleanup();
            }
        }, {
            retries,
            signal,
            random,
            onRetry: async (_error, _attempt, delay) => sleep(delay),
            shouldRetry: (error) => Boolean(error.retryable),
        });
    }

    async function getBatchResult({ batchId, signal } = {}) {
        assertBatchId(batchId);
        const payload = await requestJson(`/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`, { signal });
        const result = payload?.data?.extract_result?.[0] || payload?.data;
        const state = String(result?.state || "").toLowerCase();
        const failed = state === "failed";
        const providerCode = safeProviderCode(result?.err_code || result?.code);
        if (failed) {
            const queueFull = Number(result?.err_code) === -60009;
            throw new MineruClientError("MinerU extraction failed", {
                code: queueFull ? "MINERU_PROVIDER_RETRYABLE" : "MINERU_PROVIDER_FAILED",
                statusCode: queueFull ? 503 : 502,
                retryable: queueFull,
                providerCode: providerCode || (queueFull ? "-60009" : null),
            });
        }
        const resultUrl = result?.full_zip_url ? assertHttpsUrl(result.full_zip_url, providerHosts).toString() : null;
        if (state === "done" && !resultUrl) {
            throw new MineruClientError("MinerU completed without an output URL", { code: "MINERU_OUTPUT_MISSING", statusCode: 502 });
        }
        return {
            batchId: String(batchId),
            state,
            fileName: result?.file_name || null,
            resultUrl,
            pages: Number.isFinite(Number(result?.page_count)) ? Number(result.page_count) : null,
            traceId: payload?.trace_id || null,
        };
    }

    async function downloadResult({ resultUrl, targetPath, signal } = {}) {
        const url = assertHttpsUrl(resultUrl, providerHosts);
        if (!String(targetPath || "").trim()) throw new MineruClientError("targetPath is required", { code: "MINERU_TARGET_PATH_REQUIRED", statusCode: 400 });
        return withRetry(async () => {
            const request = createRequestSignal(signal, timeoutMs);
            try {
                let response;
                try {
                    response = await fetchImpl(url.toString(), { method: "GET", redirect: "manual", signal: request.signal });
                } catch (error) {
                    if (signal?.aborted) throw new MineruClientError("MinerU download aborted", { code: "ABORTED", statusCode: 499, cause: error });
                    if (request.timedOut()) throw new MineruClientError("MinerU download timed out", { code: "MINERU_TIMEOUT", statusCode: 504, retryable: true, cause: error });
                    throw new MineruClientError("MinerU download failed", { code: "MINERU_TRANSPORT_ERROR", statusCode: 503, retryable: true, cause: error });
                }
                if (!response.ok) throw jsonError(response, { code: response.status });
                const declared = Number(response.headers?.get?.("content-length") || 0);
                if (declared > maxDownloadBytes) throw new MineruClientError("MinerU output is too large", { code: "MINERU_DOWNLOAD_TOO_LARGE", statusCode: 413 });
                if (response.body) {
                    let bytes = 0;
                    const limiter = new Transform({
                        transform(chunk, _encoding, callback) {
                            bytes += chunk.length;
                            if (bytes > maxDownloadBytes) callback(new MineruClientError("MinerU output is too large", { code: "MINERU_DOWNLOAD_TOO_LARGE", statusCode: 413 }));
                            else callback(null, chunk);
                        },
                    });
                    await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(targetPath));
                    return { downloaded: true, bytes };
                }
                const body = Buffer.from(await response.arrayBuffer());
                if (body.length > maxDownloadBytes) throw new MineruClientError("MinerU output is too large", { code: "MINERU_DOWNLOAD_TOO_LARGE", statusCode: 413 });
                await fs.promises.writeFile(targetPath, body);
                return { downloaded: true, bytes: body.length };
            } finally {
                request.cleanup();
            }
        }, {
            retries,
            signal,
            random,
            onRetry: async (_error, _attempt, delay) => sleep(delay),
            shouldRetry: (error) => Boolean(error.retryable),
        });
    }

    return { requestUploadSlot, uploadFile, getBatchResult, downloadResult };
}

export default { createMineruClient, MineruClientError };
