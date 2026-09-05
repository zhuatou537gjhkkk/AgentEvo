const BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').trim();
const DEFAULT_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS) || 30000;
const DEFAULT_RETRY_COUNT = 1;
const AUTH_STORAGE_KEY = 'chat-agent-auth-token';

let authToken = '';

function readPersistedAuthToken() {
    if (typeof window === 'undefined') {
        return '';
    }

    return String(window.localStorage.getItem(AUTH_STORAGE_KEY) || '');
}

export function setAuthToken(token) {
    const value = String(token || '');
    authToken = value;

    if (typeof window !== 'undefined') {
        if (value) {
            window.localStorage.setItem(AUTH_STORAGE_KEY, value);
        } else {
            window.localStorage.removeItem(AUTH_STORAGE_KEY);
        }
    }
}

function getAuthToken() {
    if (authToken) {
        return authToken;
    }

    authToken = readPersistedAuthToken();
    return authToken;
}

function shouldRetryStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class HttpRequestError extends Error {
    constructor(message, { status = 0, errorCode = "HTTP_REQUEST_FAILED", requestId = null, retryable = false, retryAfter = null } = {}) {
        super(message);
        this.name = "HttpRequestError";
        this.status = Number(status) || 0;
        this.statusCode = this.status;
        this.errorCode = String(errorCode || "HTTP_REQUEST_FAILED");
        this.requestId = requestId || null;
        this.retryable = Boolean(retryable);
        this.retryAfter = retryAfter;
    }
}

async function parseResponseError(response) {
    let data = null;
    try {
        data = await response.clone().json();
    } catch {
        // Non-JSON errors still receive the HTTP status below.
    }

    if (!data) {
        try {
            const text = await response.clone().text();
            data = text ? { message: text } : null;
        } catch {
            data = null;
        }
    }

    const retryAfter = response.headers?.get?.("Retry-After") || null;
    return new HttpRequestError(data?.message || data?.error || `Request failed with status ${response.status}`, {
        status: response.status,
        errorCode: data?.errorCode || data?.error || "HTTP_REQUEST_FAILED",
        requestId: data?.requestId || response.headers?.get?.("X-Request-Id") || null,
        retryable: data?.retryable ?? shouldRetryStatus(response.status),
        retryAfter,
    });
}

function createRequestController(externalSignal, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort(new Error('Request timeout'));
    }, timeoutMs);

    const abortFromExternal = () => {
        controller.abort(externalSignal?.reason || new Error('Request aborted'));
    };

    if (externalSignal) {
        if (externalSignal.aborted) {
            abortFromExternal();
        } else {
            externalSignal.addEventListener('abort', abortFromExternal, { once: true });
        }
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeout);
            if (externalSignal) {
                externalSignal.removeEventListener('abort', abortFromExternal);
            }
        },
    };
}

export async function request(path, options = {}, config = {}) {
    const {
        timeoutMs = DEFAULT_TIMEOUT_MS,
        retryCount = undefined,
        externalSignal,
    } = config;

    const method = options.method || 'GET';
    // Mutating requests are not safely replayable by default. Callers must
    // explicitly opt in (or provide an idempotency key at the endpoint).
    const effectiveRetryCount = retryCount == null
        ? ((method === 'GET' || method === 'HEAD') ? DEFAULT_RETRY_COUNT : 0)
        : Math.max(0, Number(retryCount) || 0);
    const headers = {
        ...(options.headers || {}),
    };

    const token = getAuthToken();
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    for (let attempt = 0; attempt <= effectiveRetryCount; attempt += 1) {
        const { signal, cleanup } = createRequestController(externalSignal, timeoutMs);

        try {
            const response = await fetch(`${BASE_URL}${path}`, {
                ...options,
                headers,
                signal,
            });

            if (!response.ok) {
                const error = await parseResponseError(response);

                if (attempt < effectiveRetryCount && (error.retryable || shouldRetryStatus(error.status))) {
                    continue;
                }

                throw error;
            }

            return response;
        } catch (error) {
            const isAbort = error?.name === 'AbortError';
            if (isAbort || externalSignal?.aborted) {
                throw error;
            }

            if (attempt >= effectiveRetryCount) {
                throw error;
            }

            // Application/HTTP errors are retried only when explicitly marked
            // retryable; arbitrary validation and auth failures must stop.
            if (error instanceof HttpRequestError) {
                if (!error.retryable && !shouldRetryStatus(error.status)) {
                    throw error;
                }
                continue;
            }

            // Network failures are safe to retry for read-only requests.
            if (method !== 'GET' && method !== 'HEAD') {
                throw error;
            }
        } finally {
            cleanup();
        }
    }

    throw new Error(`${method} request failed`);
}

export async function registerAuth(username, password) {
    const response = await request('/auth/register', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
    }, {
        retryCount: 0,
    });

    return response.json();
}

export async function loginAuth(username, password) {
    const response = await request('/auth/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
    }, {
        retryCount: 0,
    });

    return response.json();
}

export async function fetchMe() {
    const response = await request('/auth/me', {
        method: 'GET',
    }, {
        retryCount: 0,
    });

    return response.json();
}

export async function fetchSessions() {
    const response = await request('/sessions');
    const data = await response.json();
    return data?.sessions || [];
}

export async function createSession(title) {
    const response = await request('/sessions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title }),
    });

    const data = await response.json();
    return data?.id;
}

export async function updateSessionTitle(id, title) {
    const response = await request(`/sessions/${id}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title }),
    });

    return response.json();
}

export async function deleteSession(id) {
    const response = await request(`/sessions/${id}`, {
        method: 'DELETE',
    });

    return response.json();
}

export async function updateSessionPin(id, pinned) {
    const response = await request(`/sessions/${id}/pin`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ pinned }),
    });

    return response.json();
}

export async function fetchMessagesBySession(id) {
    const response = await request(`/sessions/${id}/messages`);
    const data = await response.json();
    return data?.messages || [];
}

export async function deleteMessagePair(sessionId, messageId) {
    const response = await request(`/sessions/${sessionId}/messages/${messageId}/pair`, {
        method: 'DELETE',
    });

    return response.json();
}

export async function createSessionBranch(sessionId, options = {}) {
    const {
        fromMessageId = null,
        title = '',
        editedContent = '',
    } = options;

    const response = await request(`/sessions/${sessionId}/branch`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from_message_id: fromMessageId,
            title,
            edited_content: editedContent,
        }),
    });

    return response.json();
}

export async function sendUserAnswer(questionId, answer) {
    const response = await request('/chat/answer', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ questionId, answer }),
    }, {
        retryCount: 0,
    });

    return response.json();
}

export async function fetchChatStream(sessionId, message, onChunk, onToolEvent, onDone, onError, options = {}) {
    const {
        signal,
        idempotencyKey = null,
        enableWebSearch = false,
        planMode = false,
        enableMemory = true,
        systemPrompt = '你是一个有用的 AI 助手。',
        temperature = 0.7,
        image = null,
        imageId = null,
    } = options;

    try {
        const response = await request(
            '/chat',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
                },
                body: JSON.stringify({
                    session_id: sessionId,
                    message,
                    image,
                    image_id: imageId,
                    enable_web_search: enableWebSearch,
                    plan_mode: planMode,
                    enable_memory: enableMemory,
                    systemPrompt,
                    temperature,
                }),
            },
            {
                externalSignal: signal,
                // /chat persists messages and may execute tools; never replay it
                // through the generic request retry loop.
                retryCount: 0,
            }
        );

        if (!response.body) {
            throw new Error('Response body is empty');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        // 监听外部 abort signal，取消 reader → 断开 HTTP 连接 → 后端检测到断连
        let abortHandler;
        let streamTerminal = false;
        let streamDone = false;
        if (signal) {
            abortHandler = () => {
                reader.cancel();
            };
            if (!signal.aborted) {
                signal.addEventListener('abort', abortHandler, { once: true });
            }
        }

        let lastSequence = 0;
        let lastEventId = null;
        const handlePayload = (payload, eventId = null) => {
            if (streamTerminal || !payload) {
                return;
            }
            if (payload === '[DONE]') {
                streamDone = true;
                streamTerminal = true;
                return;
            }

            try {
                const parsed = JSON.parse(payload);
                const eventType = parsed?.type;
                const sequence = Number(parsed?.seq);
                if (Number.isInteger(sequence)) {
                    if (sequence <= lastSequence || sequence > lastSequence + 1) {
                        const sequenceError = new Error('stream returned out-of-order event');
                        sequenceError.errorCode = 'SSE_SEQUENCE_ERROR';
                        sequenceError.requestId = parsed.request_id || parsed.requestId || null;
                        streamTerminal = true;
                        onError(sequenceError);
                        return;
                    }
                    lastSequence = sequence;
                }

                if (!eventType || eventType === 'text') {
                    const text = parsed && typeof parsed.text === 'string' ? parsed.text : '';

                    if (text) {
                        onChunk(text);
                    }
                    return;
                }

                if (eventType === 'error') {
                    const streamError = new Error(parsed.message || 'stream failed');
                    streamError.errorCode = parsed.errorCode || parsed.error || 'STREAM_FAILED';
                    streamError.requestId = parsed.requestId || null;
                    streamError.retryable = Boolean(parsed.retryable);
                    streamTerminal = true;
                    onError(streamError);
                    return;
                }

                if (eventType === 'tool_start' || eventType === 'tool_end' || eventType === 'tool_error' || eventType === 'thought' || eventType === 'metrics' || eventType === 'ask_user_question' || eventType === 'todo_updated' || eventType === 'agent_start' || eventType === 'agent_end' || eventType === 'agent_handoff') {
                    onToolEvent(parsed);
                    return;
                }

                const unknownEvent = new Error('stream returned an unknown event');
                unknownEvent.errorCode = 'MALFORMED_SSE_EVENT';
                unknownEvent.requestId = parsed.requestId || null;
                streamTerminal = true;
                onError(unknownEvent);
            } catch {
                const malformedError = new Error('stream returned malformed data');
                malformedError.errorCode = 'MALFORMED_SSE_EVENT';
                streamTerminal = true;
                onError(malformedError);
            }
        };

        const consumeBuffer = (isDone = false) => {
            const separator = isDone ? /\n\n+/ : /\n\n/;
            const parts = buffer.split(separator);

            if (!isDone) {
                buffer = parts.pop() || '';
            } else {
                buffer = '';
            }

            for (const part of parts) {
                const lines = part.split('\n');
                let eventId = null;
                let data = null;
                for (const line of lines) {
                    if (line.startsWith('id: ')) eventId = line.slice(4).trim();
                    if (line.startsWith('data: ')) data = line.slice(6);
                }
                if (eventId && eventId === lastEventId) continue;
                if (eventId) lastEventId = eventId;
                if (data != null) handlePayload(data, eventId);
            }
        };

        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                consumeBuffer(true);
                if (!streamTerminal) {
                    streamTerminal = true;
                    if (streamDone) onDone();
                    else {
                        const truncated = new Error('stream ended before [DONE]');
                        truncated.errorCode = 'INCOMPLETE_SSE_STREAM';
                        truncated.retryable = true;
                        onError(truncated);
                    }
                }
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            consumeBuffer(false);
        }
    } catch (error) {
        if (error instanceof Error && /413/.test(error.message)) {
            onError(new Error('图片过大，请压缩后重试。'));
            return;
        }

        onError(error);
    } finally {
        if (signal && abortHandler) {
            signal.removeEventListener('abort', abortHandler);
        }
    }
}

export async function uploadFile(file, options = {}) {
    const { onProgress } = options;
    const CHUNK_SIZE = 4 * 1024 * 1024;
    const LARGE_FILE_THRESHOLD = 500 * 1024;
    const DOC_UPLOAD_RETRY_COUNT = 2;
    const RESUME_KEY_PREFIX = 'chunk-upload-resume:';

    const emitProgress = (loaded, total) => {
        if (typeof onProgress !== 'function' || !Number.isFinite(total) || total <= 0) {
            return;
        }

        const safeLoaded = Math.max(0, Math.min(total, loaded));
        onProgress({
            loaded: safeLoaded,
            total,
            percentage: Math.round((safeLoaded / total) * 100),
        });
    };

    const readResumeState = (resumeKey) => {
        if (typeof window === 'undefined') {
            return null;
        }

        try {
            const raw = window.localStorage.getItem(resumeKey);
            if (!raw) {
                return null;
            }

            return JSON.parse(raw);
        } catch {
            return null;
        }
    };

    const writeResumeState = (resumeKey, state) => {
        if (typeof window === 'undefined') {
            return;
        }

        window.localStorage.setItem(resumeKey, JSON.stringify(state || {}));
    };

    const clearResumeState = (resumeKey) => {
        if (typeof window === 'undefined') {
            return;
        }

        window.localStorage.removeItem(resumeKey);
    };

    const toHex = (arrayBuffer) => {
        const bytes = new Uint8Array(arrayBuffer);
        return Array.from(bytes)
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
    };

    const computeFileHash = async (targetFile) => {
        const buffer = await targetFile.arrayBuffer();

        if (globalThis.crypto?.subtle) {
            const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
            return toHex(digest);
        }

        // Do not fabricate a SHA-256-looking value: the server verifies the
        // file hash at merge time. Older browsers without SubtleCrypto use a
        // deterministic non-cryptographic key only for resume, while the
        // server must reject it before indexing rather than accepting it as
        // integrity evidence.
        throw Object.assign(new Error('SHA-256 is unavailable in this browser'), {
            errorCode: 'UPLOAD_HASH_UNAVAILABLE',
        });
    };

    const uploadSingleChunk = async (hash, chunkIndex, chunkBlob, totalChunks) => {
        const formData = new FormData();
        formData.append('chunk', chunkBlob, `${file.name}.part.${chunkIndex}`);
        formData.append('hash', hash);
        formData.append('chunkIndex', String(chunkIndex));
        formData.append('fileName', file.name);
        formData.append('totalChunks', String(totalChunks));

        const response = await request('/upload/chunk', {
            method: 'POST',
            body: formData,
        }, {
            retryCount: 0,
        });

        return response.json();
    };

    const uploadSingleChunkWithRetry = async (hash, chunkIndex, chunkBlob, totalChunks) => {
        for (let attempt = 0; attempt <= DOC_UPLOAD_RETRY_COUNT; attempt += 1) {
            try {
                return await uploadSingleChunk(hash, chunkIndex, chunkBlob, totalChunks);
            } catch (error) {
                const retryable = error?.retryable === true || error?.status === 408 || error?.status === 429 || error?.status >= 500;
                if (!retryable || attempt >= DOC_UPLOAD_RETRY_COUNT) {
                    throw error;
                }
            }
        }

        throw new Error('chunk upload failed');
    };

    if (!file || typeof file.slice !== 'function') {
        throw new Error('invalid file');
    }

    if (file.size <= LARGE_FILE_THRESHOLD) {
        emitProgress(0, file.size);
        const formData = new FormData();
        formData.append('file', file);

        const response = await request('/upload', {
            method: 'POST',
            body: formData,
        });

        emitProgress(file.size, file.size);
        return response.json();
    }

    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    const fileHash = await computeFileHash(file);
    const authScope = typeof window === 'undefined'
        ? 'anonymous'
        : (window.localStorage.getItem(AUTH_STORAGE_KEY) || 'anonymous').slice(-24);
    const resumeKey = `${RESUME_KEY_PREFIX}${authScope}:${fileHash}`;
    const resumedState = readResumeState(resumeKey);
    const checkPayload = {
        hash: fileHash,
        fileName: file.name,
        totalChunks,
    };

    const checkResponse = await request('/upload/check', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(checkPayload),
    }, {
        retryCount: 0,
    });
    const checkData = await checkResponse.json();

    if (checkData?.data?.uploaded === true) {
        clearResumeState(resumeKey);
        emitProgress(file.size, file.size);
        return {
            ok: true,
            message: 'document indexed',
            data: {
                fileName: file.name,
                hash: fileHash,
                mode: 'already_uploaded',
            },
        };
    }

    const uploadedSet = new Set([
        ...(Array.isArray(checkData?.data?.uploadedChunks) ? checkData.data.uploadedChunks : []),
        ...(Array.isArray(resumedState?.uploadedChunks) ? resumedState.uploadedChunks : []),
    ]);
    let uploadedBytes = 0;

    for (const index of uploadedSet) {
        if (!Number.isInteger(index) || index < 0 || index >= totalChunks) {
            continue;
        }

        const start = index * CHUNK_SIZE;
        const end = Math.min(file.size, start + CHUNK_SIZE);
        uploadedBytes += Math.max(0, end - start);
    }

    emitProgress(uploadedBytes, file.size);

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
        if (uploadedSet.has(chunkIndex)) {
            continue;
        }

        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(file.size, start + CHUNK_SIZE);
        const chunkBlob = file.slice(start, end);

        await uploadSingleChunkWithRetry(fileHash, chunkIndex, chunkBlob, totalChunks);

        uploadedSet.add(chunkIndex);
        uploadedBytes += chunkBlob.size;

        writeResumeState(resumeKey, {
            hash: fileHash,
            uploadedChunks: Array.from(uploadedSet).sort((a, b) => a - b),
            updatedAt: Date.now(),
        });

        emitProgress(uploadedBytes, file.size);
    }

    const completeResponse = await request('/upload/merge', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            hash: fileHash,
            fileName: file.name,
            totalChunks,
        }),
    }, {
        retryCount: 0,
        timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, 3 * 60 * 1000),
    });

    clearResumeState(resumeKey);
    emitProgress(file.size, file.size);

    return completeResponse.json();
}

export async function uploadImage(file, options = {}) {
    const {
        onProgress,
        signal,
        retryCount = DEFAULT_RETRY_COUNT,
        timeoutMs = DEFAULT_TIMEOUT_MS,
    } = options;

    const formData = new FormData();
    formData.append('image', file);

    const sendWithXhr = () => new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${BASE_URL}/upload-image`, true);
        xhr.responseType = 'json';
        xhr.timeout = timeoutMs;

        const token = getAuthToken();
        if (token) {
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        }

        const abortFromSignal = () => {
            xhr.abort();
        };

        const cleanup = () => {
            if (signal) {
                signal.removeEventListener('abort', abortFromSignal);
            }
        };

        if (signal) {
            if (signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }

            signal.addEventListener('abort', abortFromSignal, { once: true });
        }

        xhr.upload.onprogress = (event) => {
            if (typeof onProgress === 'function') {
                onProgress(event);
            }
        };

        xhr.onerror = () => {
            cleanup();
            reject(new Error('Image upload failed'));
        };

        xhr.ontimeout = () => {
            cleanup();
            reject(new Error('Image upload timeout'));
        };

        xhr.onabort = () => {
            cleanup();
            reject(new DOMException('Aborted', 'AbortError'));
        };

        xhr.onload = async () => {
            cleanup();

            const status = xhr.status;
            const data = xhr.response;

            if (status >= 200 && status < 300) {
                resolve(data || {});
                return;
            }

            const message = data?.message || data?.error || `Request failed with status ${status}`;
            reject(new Error(message));
        };

        xhr.send(formData);
    });

    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        try {
            return await sendWithXhr();
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw error;
            }

            const retryable = error?.retryable || error?.status === 408 || error?.status === 429 || error?.status >= 500;
            if (!retryable || attempt >= retryCount) {
                throw error;
            }
        }
    }

    throw new Error('Image upload failed');
}

// ═══════════════════════════════════════════════════════
// MCP Server 管理 API (Phase 3)
// ═══════════════════════════════════════════════════════

export async function fetchMcpServers() {
    const res = await request('/mcp/servers');
    return res.json();
}

export async function addMcpServer(name, command, args = []) {
    const res = await request('/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, command, args }),
    });
    return res.json();
}

export async function removeMcpServer(name) {
    const res = await request(`/mcp/servers/${encodeURIComponent(name)}`, {
        method: 'DELETE',
    });
    return res.json();
}

export async function fetchMcpServerTools(name) {
    const res = await request(`/mcp/servers/${encodeURIComponent(name)}/tools`);
    return res.json();
}

export async function connectMcpServer(name) {
    const res = await request(`/mcp/servers/${encodeURIComponent(name)}/connect`, {
        method: 'POST',
    });
    return res.json();
}

export async function disconnectMcpServer(name) {
    const res = await request(`/mcp/servers/${encodeURIComponent(name)}/disconnect`, {
        method: 'POST',
    });
    return res.json();
}

// ═══════════════════════════════════════════════════════
// 记忆系统管理 API (Phase 4)
// ═══════════════════════════════════════════════════════

export async function fetchMemories(query = '', memoryType = '', limit = 50) {
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    if (memoryType) params.set('memory_type', memoryType);
    params.set('limit', String(limit));
    const res = await request(`/memory?${params.toString()}`);
    return res.json();
}

export async function fetchMemoryStats() {
    const res = await request('/memory/stats');
    return res.json();
}

export async function deleteMemory(memoryId) {
    const res = await request(`/memory/${encodeURIComponent(memoryId)}`, {
        method: 'DELETE',
    });
    return res.json();
}

export async function clearAllMemories() {
    const res = await request('/memory', {
        method: 'DELETE',
    });
    return res.json();
}

export async function consolidateMemories(fromType = 'working', toType = 'episodic', threshold = 0.7) {
    const res = await request('/memory/consolidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from_type: fromType,
            to_type: toType,
            importance_threshold: threshold,
        }),
    });
    return res.json();
}

// ── Phase 6a: Agent 配置管理 ──

export async function fetchAgentConfig() {
    const res = await request("/agent-config");
    return res.json();
}

export async function updateAgentConfig(key, value) {
    const res = await request("/agent-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
    });
    return res.json();
}

export async function fetchAgentConfigVersions() {
    const res = await request("/agent-config/versions");
    return res.json();
}

export async function rollbackAgentConfig(versionId) {
    const res = await request("/agent-config/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId }),
    });
    return res.json();
}

export async function renameAgentConfigVersion(id, label) {
    const res = await request(`/agent-config/versions/${id}/label`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
    });
    return res.json();
}

export async function deleteAgentConfigVersion(id) {
    const res = await request(`/agent-config/versions/${id}`, {
        method: "DELETE",
    });
    return res.json();
}

// ══════════════════════════════════════════════════════════
// Phase 6b G9: 观测面板 API
// ══════════════════════════════════════════════════════════

export async function fetchTraces(limit = 30) {
    const res = await request(`/observability/traces?limit=${limit}`);
    return res.json();
}

export async function fetchTraceDetail(traceId) {
    const res = await request(`/observability/traces/${encodeURIComponent(traceId)}`);
    return res.json();
}

export async function fetchMetricsReport(window = "7d") {
    const res = await request(`/observability/metrics?window=${window}`);
    return res.json();
}

// ══════════════════════════════════════════════════════════
// Phase 6c OTel: Trace 格式导出/导入
// ══════════════════════════════════════════════════════════

/**
 * 导出 Trace 为 OpenTelemetry 格式
 * @param {string} traceId
 * @returns {Promise<object>} { ok, otel }
 */
export async function exportTraceAsOtel(traceId) {
    const res = await request(`/observability/traces/${encodeURIComponent(traceId)}/otel`);
    return res.json();
}

/**
 * 导入外部 OTel Trace JSON
 * @param {object|string} otel — OTel JSON 对象或 JSON 字符串
 * @param {number} sessionId — 关联的 session ID（可选）
 * @returns {Promise<object>} { ok, trace_id, db_id, spans }
 */
export async function importOtelTrace(otel, sessionId = 0) {
    const res = await request("/observability/otel/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otel, session_id: sessionId }),
    });
    return res.json();
}

// ═══════════════════════════════════════════════════════
// 上下文窗口管理 (Context Window Management)
// ═══════════════════════════════════════════════════════

/** 获取当前会话的 token 用量估算 */
export async function fetchContextUsage(sessionId) {
    const res = await request(`/sessions/${sessionId}/context-usage`);
    return res.json();
}

/** 压缩会话上下文（LLM 摘要旧消息） */
export async function compactContext(sessionId) {
    const res = await request(`/sessions/${sessionId}/compact`, { method: "POST" });
    return res.json();
}
