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
    return status === 408 || status === 409 || status === 425 || status === 429 || status === 502 || status === 503 || status === 504;
}

async function parseResponseError(response) {
    let message = `Request failed with status ${response.status}`;

    try {
        const data = await response.clone().json();
        if (data?.message) {
            message = data.message;
        } else if (data?.error) {
            message = data.error;
        }
    } catch {
        try {
            const text = await response.clone().text();
            if (text) {
                message = text;
            }
        } catch {
            // Ignore text parsing errors and keep default message.
        }
    }

    return message;
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

async function request(path, options = {}, config = {}) {
    const {
        timeoutMs = DEFAULT_TIMEOUT_MS,
        retryCount = DEFAULT_RETRY_COUNT,
        externalSignal,
    } = config;

    const method = options.method || 'GET';
    const headers = {
        ...(options.headers || {}),
    };

    const token = getAuthToken();
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        const { signal, cleanup } = createRequestController(externalSignal, timeoutMs);

        try {
            const response = await fetch(`${BASE_URL}${path}`, {
                ...options,
                headers,
                signal,
            });

            if (!response.ok) {
                const message = await parseResponseError(response);

                if (attempt < retryCount && shouldRetryStatus(response.status)) {
                    continue;
                }

                throw new Error(message);
            }

            return response;
        } catch (error) {
            const isAbort = error?.name === 'AbortError';
            if (isAbort || externalSignal?.aborted) {
                throw error;
            }

            if (attempt >= retryCount) {
                throw error;
            }

            if (error instanceof Error && /Request failed with status/.test(error.message)) {
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
        enableWebSearch = false,
        planMode = false,
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
                },
                body: JSON.stringify({
                    session_id: sessionId,
                    message,
                    image,
                    image_id: imageId,
                    enable_web_search: enableWebSearch,
                    plan_mode: planMode,
                    systemPrompt,
                    temperature,
                }),
            },
            {
                externalSignal: signal,
                retryCount: DEFAULT_RETRY_COUNT,
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
        if (signal) {
            abortHandler = () => {
                reader.cancel();
            };
            if (!signal.aborted) {
                signal.addEventListener('abort', abortHandler, { once: true });
            }
        }

        const handlePayload = (payload) => {
            if (!payload || payload === '[DONE]') {
                return;
            }

            try {
                const parsed = JSON.parse(payload);
                const eventType = parsed?.type;

                if (!eventType || eventType === 'text') {
                    const text = parsed && typeof parsed.text === 'string' ? parsed.text : '';

                    if (text) {
                        onChunk(text);
                    }
                    return;
                }

                if (eventType === 'tool_start' || eventType === 'tool_end' || eventType === 'tool_error' || eventType === 'thought' || eventType === 'metrics' || eventType === 'ask_user_question' || eventType === 'todo_updated') {
                    onToolEvent(parsed);
                }
            } catch {
                // Ignore malformed chunk and continue streaming.
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

                for (const line of lines) {
                    if (!line.startsWith('data: ')) {
                        continue;
                    }

                    handlePayload(line.slice(6));
                }
            }
        };

        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                consumeBuffer(true);
                onDone();
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

        let hash = 2166136261;
        const view = new Uint8Array(buffer);
        for (const byte of view) {
            hash ^= byte;
            hash = Math.imul(hash, 16777619);
        }

        return `fallback-${targetFile.size}-${hash >>> 0}`;
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
                if (attempt >= DOC_UPLOAD_RETRY_COUNT) {
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
    const resumeKey = `${RESUME_KEY_PREFIX}${fileHash}`;
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

            if (attempt >= retryCount) {
                throw error;
            }
        }
    }

    throw new Error('Image upload failed');
}
