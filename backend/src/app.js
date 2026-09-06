import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import fse from "fs-extra";
import {
    initDB as defaultInitDB,
    saveMessage as defaultSaveMessage,
    getHistoryMessages as defaultGetHistoryMessages,
    getMessageStats as defaultGetMessageStats,
    createSession as defaultCreateSession,
    getSessions as defaultGetSessions,
    renameSession as defaultRenameSession,
    removeSession as defaultRemoveSession,
    toggleSessionPin as defaultToggleSessionPin,
    createUser as defaultCreateUser,
    getUserByUsername as defaultGetUserByUsername,
    getUserById as defaultGetUserById,
    getUserScope as defaultGetUserScope,
    listMCPServerConfigs as defaultListMCPServerConfigs,
    insertMCPServerConfig as defaultInsertMCPServerConfig,
    getMCPServerConfig as defaultGetMCPServerConfig,
    deleteMCPServerConfig as defaultDeleteMCPServerConfig,
    updateMCPServerConfigStatus as defaultUpdateMCPServerConfigStatus,
    saveMessageMetric as defaultSaveMessageMetric,
    createBranchSession as defaultCreateBranchSession,
    getSessionById as defaultGetSessionById,
    getRecentObservability as defaultGetRecentObservability,
    getRecentTraces as defaultGetRecentTraces,
    getTraceById as defaultGetTraceById,
    saveTrace as defaultSaveTrace,
    removeMessagePair as defaultRemoveMessagePair,
    saveFeedback as defaultSaveFeedback,
    getFeedbackByMessage as defaultGetFeedbackByMessage,
    deleteFeedback as defaultDeleteFeedback,
    reserveChatIdempotency as defaultReserveChatIdempotency,
    markChatIdempotencyStarted as defaultMarkChatIdempotencyStarted,
    completeChatIdempotency as defaultCompleteChatIdempotency,
    failChatIdempotency as defaultFailChatIdempotency,
    getChatIdempotency as defaultGetChatIdempotency,
    getMessageById as defaultGetMessageById,
    setChatIdempotencyUserMessage as defaultSetChatIdempotencyUserMessage,
} from "./db/index.js";
import { chatWithStream, estimateTokens, resolveModelName } from "./services/chat.js";
import { calculateContextUsage } from "./services/contextUsage.js";
import { chatWithGraph } from "./services/chatGraph.js";
import { resolveUserQuestion } from "./mcp/tools.js";
import { toolRegistry } from "./mcp/registry.js";
import {
    processAndStoreDocument,
    processAndStoreDocumentFile,
    retrieveKnowledgeEvidence,
    getLatestUploadedSource,
    getActiveLargeFile
} from "./rag/index.js";
import { saveUploadedImage, getUploadedImageDataUrl } from "./images/store.js";
import { MemoryService } from "./services/memory.js";
import evalRoutes from "./eval/evalRoutes.js";
import {
    hashPassword,
    verifyPassword,
    issueAuthToken,
    verifyAuthToken,
    parseBearerToken,
    assertAuthSecurityConfig,
} from "./auth.js";
import { assertProductionSecurityConfig, isAllowedCorsOrigin } from "./security/config.js";
import { validateMCPServerConfig } from "./mcp/security.js";
import { createRequestContext, runWithRequestContext } from "./services/requestContext.js";
import { createRateLimit, requireAdmin } from "./security/access.js";
import { toErrorEnvelope, toPublicError, withRetry } from "./services/resilience.js";
import { getSSEWriter } from "./services/sse.js";
import { reserveUploadChunk, getUploadReservation, rollbackUploadChunk, settleUploadReservation, releaseUploadReservation, withUploadLock, startUploadQuotaCleanup } from "./services/uploadQuotaStore.js";
import { registerCoreRoutes } from "./routes/coreRoutes.js";
import { registerSessionExtensionRoutes } from "./routes/sessionExtensionRoutes.js";
import { registerAuthRoutes } from "./routes/authRoutes.js";
import { registerFeedbackRoutes } from "./routes/feedbackRoutes.js";
import { registerObservabilityRoutes } from "./routes/observabilityRoutes.js";
import { registerConfigRoutes } from "./routes/configRoutes.js";
import { registerMemoryRoutes } from "./routes/memoryRoutes.js";

// Default service bindings; createApp can override the request-visible bag.
const initDB = defaultInitDB;
const saveMessage = defaultSaveMessage;
const getHistoryMessages = defaultGetHistoryMessages;
const getMessageStats = defaultGetMessageStats;
const createSession = defaultCreateSession;
const getSessions = defaultGetSessions;
const renameSession = defaultRenameSession;
const removeSession = defaultRemoveSession;
const toggleSessionPin = defaultToggleSessionPin;
const createUser = defaultCreateUser;
const getUserByUsername = defaultGetUserByUsername;
const getUserById = defaultGetUserById;
const getUserScope = defaultGetUserScope;
const listMCPServerConfigs = defaultListMCPServerConfigs;
const insertMCPServerConfig = defaultInsertMCPServerConfig;
const getMCPServerConfig = defaultGetMCPServerConfig;
const deleteMCPServerConfig = defaultDeleteMCPServerConfig;
const updateMCPServerConfigStatus = defaultUpdateMCPServerConfigStatus;
const saveMessageMetric = defaultSaveMessageMetric;
const createBranchSession = defaultCreateBranchSession;
const getSessionById = defaultGetSessionById;
const getRecentObservability = defaultGetRecentObservability;
const getRecentTraces = defaultGetRecentTraces;
const getTraceById = defaultGetTraceById;
const saveTrace = defaultSaveTrace;
const removeMessagePair = defaultRemoveMessagePair;
const saveFeedback = defaultSaveFeedback;
const getFeedbackByMessage = defaultGetFeedbackByMessage;
const deleteFeedback = defaultDeleteFeedback;
const reserveChatIdempotency = defaultReserveChatIdempotency;
const markChatIdempotencyStarted = defaultMarkChatIdempotencyStarted;
const completeChatIdempotency = defaultCompleteChatIdempotency;
const failChatIdempotency = defaultFailChatIdempotency;
const getChatIdempotency = defaultGetChatIdempotency;
const getMessageById = defaultGetMessageById;
const setChatIdempotencyUserMessage = defaultSetChatIdempotencyUserMessage;

const app = express();
const PORT = process.env.PORT || 3000;
const dependencyStorage = new WeakMap();
const defaultDependencies = {
    quota: { reserveUploadChunk, getUploadReservation, rollbackUploadChunk, settleUploadReservation, releaseUploadReservation, withUploadLock },
    db: {
        initDB,
        getUserByUsername,
        createUser,
        saveMessage,
        getHistoryMessages,
        getMessageStats,
        getSessions,
        createSession,
        renameSession,
        removeSession,
        toggleSessionPin,
        getUserById,
        removeMessagePair,
        createBranchSession,
        getSessionById,
        getFeedbackByMessage,
        saveFeedback,
        deleteFeedback,
        getRecentObservability,
        getRecentTraces,
        getTraceById,
        saveTrace,
        saveMessageMetric,
        getMessageById,
        reserveChatIdempotency,
        markChatIdempotencyStarted,
        completeChatIdempotency,
        failChatIdempotency,
        getChatIdempotency,
        setChatIdempotencyUserMessage,
        listMCPServerConfigs,
        insertMCPServerConfig,
        getMCPServerConfig,
        deleteMCPServerConfig,
        updateMCPServerConfigStatus,
    },
    chat: { chatWithStream, chatWithGraph },
    auth: { getUserById },
    mcp: toolRegistry,
    // Singleton service defaults. Factory instances may override any of these
    // through `dependencies.services` so HTTP fixtures can isolate state that
    // lives outside the db bag (config cache, trace collectors, memory service).
    services: {
        agentConfig,
        metricsAggregator,
        TraceCollector,
        otelToInternalTrace,
        createMemoryService: (userId) => new MemoryService(userId),
        processAndStoreDocument,
        processAndStoreDocumentFile,
        getLatestUploadedSource,
        getActiveLargeFile,
        retrieveKnowledgeEvidence,
        saveUploadedImage,
        getUploadedImageDataUrl,
        resolveUserQuestion,
    },
};

/**
 * Compatibility factory for HTTP fixtures. Mounting the configured singleton
 * preserves every existing route while allowing tests to attach dependency
 * metadata until individual registrars are migrated.
 */
export function createApp({ dependencies = {} } = {}) {
    const instance = express();
    const resolvedDependencies = dependencies || {};
    instance.locals.dependencies = {
        ...defaultDependencies,
        ...resolvedDependencies,
        db: { ...defaultDependencies.db, ...(resolvedDependencies.db || {}) },
        auth: { ...defaultDependencies.auth, ...(resolvedDependencies.auth || {}) },
        chat: { ...defaultDependencies.chat, ...(resolvedDependencies.chat || {}) },
        quota: { ...defaultDependencies.quota, ...(resolvedDependencies.quota || {}) },
        services: { ...defaultDependencies.services, ...(resolvedDependencies.services || {}) },
    };
    // Store the bag by instance so concurrent factory apps cannot overwrite
    // one another's dependencies.
    dependencyStorage.set(instance, instance.locals.dependencies);
    instance.locals.factory = true;
    instance.locals.dependencyStorage = dependencyStorage;
    const configuredHops = Number(process.env.TRUSTED_PROXY_HOPS);
    instance.use((req, res, next) => {
        const requestId = String(req.headers["x-request-id"] || "").trim() || crypto.randomUUID();
        res.setHeader("X-Request-Id", requestId);
        req.requestId = requestId;
        next();
    });
    instance.use(cors({
        origin(origin, callback) {
            if (isAllowedCorsOrigin(origin)) callback(null, true);
            else callback(new Error("Origin is not allowed by CORS"));
        },
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id", "X-Idempotency-Key"],
        credentials: false,
    }));
    instance.set("trust proxy", process.env.TRUST_PROXY === "true"
        && Number.isInteger(configuredHops)
        && configuredHops > 0
        ? configuredHops
        : false);
    // Mounting the legacy router remains the compatibility fallback. New
    // factory instances still expose their dependency bag to mounted routes.
    instance.use((req, res, next) => {
        req.locals = instance.locals;
        next();
    });
    // parsers must run before branch/compact handlers
    instance.use(express.json({ limit: "10mb" }));
    instance.use(express.urlencoded({ limit: "10mb", extended: true, parameterLimit: 100 }));
    // Registrars are the single source of truth for migrated route groups. They
    // resolve DB/services from the instance-local dependency bag at request time.
    registerAllRoutes(instance, {
        buildCompactionSummary: resolvedDependencies.services?.buildCompactionSummary || defaultBuildCompactionSummary,
    });
    instance.use(app);
    return instance;
}

app.locals.dependencies = defaultDependencies;
const configuredProxyHops = Number(process.env.TRUSTED_PROXY_HOPS);
app.set("trust proxy", process.env.TRUST_PROXY === "true"
    && Number.isInteger(configuredProxyHops)
    && configuredProxyHops > 0
    ? configuredProxyHops
    : false);
const CHUNK_UPLOAD_ROOT = path.join(process.cwd(), "tmp", "chunks");
const MERGED_UPLOAD_ROOT = path.join(process.cwd(), "tmp", "merged");
const LONG_CONTEXT_MODEL = process.env.QWEN_LONG_CONTEXT_MODEL || "qwen-long";
const LARGE_FILE_SEGMENT_SIZE = Number(process.env.LARGE_FILE_SEGMENT_SIZE || 1800);
const LARGE_FILE_SEGMENT_OVERLAP = Number(process.env.LARGE_FILE_SEGMENT_OVERLAP || 240);
const LARGE_FILE_MAX_SEGMENTS = Number(process.env.LARGE_FILE_MAX_SEGMENTS || 16);
const LARGE_FILE_MAX_CONTEXT_CHARS = Number(process.env.LARGE_FILE_MAX_CONTEXT_CHARS || 120000);
const largeFileSegmentCache = new Map();
const documentUploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 8 * 1024 * 1024,
    },
}).single("file");
const chunkUploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 4 * 1024 * 1024,
    },
}).single("chunk");
const imageUploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 8 * 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        if (!String(file.mimetype || "").startsWith("image/")) {
            cb(new Error("仅支持图片上传"));
            return;
        }

        cb(null, true);
    },
}).single("image");

app.use((req, res, next) => {
    const requestId = String(req.headers["x-request-id"] || "").trim() || crypto.randomUUID();
    res.setHeader("X-Request-Id", requestId);
    req.requestId = requestId;
    next();
});

app.use(cors({
    origin(origin, callback) {
        if (isAllowedCorsOrigin(origin)) {
            callback(null, true);
            return;
        }
        callback(new Error("Origin is not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id", "X-Idempotency-Key"],
    credentials: false,
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true, parameterLimit: 100 }));

// W3.3-C: the production singleton must expose the same registrar routes as
// factory instances. Request-scoped registrars resolve the module defaults from
// `app.locals.dependencies`, so real-path auth/core/session/observability/
// config/memory routes are mounted here before any remaining legacy inline
// handlers below (which stay as an untouched fallback until fully migrated).
registerAllRoutes(app, { buildCompactionSummary: defaultBuildCompactionSummary });

function getDependencies(req) {
    return req.locals?.dependencies || dependencyStorage.get(req.app) || app.locals.dependencies;
}

function requireAuth(req, res, next) {
    const token = parseBearerToken(req);
    const payload = verifyAuthToken(token);

    if (!payload?.sub) {
        return res.status(401).json(toErrorEnvelope(Object.assign(new Error("unauthorized"), {
            code: "UNAUTHORIZED",
            statusCode: 401,
        }), req.requestId));
    }

    const dependencies = getDependencies(req);
    const user = (dependencies.auth?.getUserById || getUserById)(payload.sub);
    if (!user) {
        return res.status(401).json(toErrorEnvelope(Object.assign(new Error("invalid user"), {
            code: "UNAUTHORIZED",
            statusCode: 401,
        }), req.requestId));
    }

    req.user = {
        id: Number(user.id),
        username: user.username,
        tenantId: user.tenant_id || `user:${user.id}`,
    };
    req.requestContext = createRequestContext({
        userId: req.user.id,
        tenantId: req.user.tenantId,
        username: req.user.username,
        requestId: req.requestId,
    });
    return runWithRequestContext(req.requestContext, next);
}

/**
 * Mount every migrated registrar onto an express instance. Each handler pulls
 * db/services functions from the instance dependency bag, so the production
 * singleton and per-test factory instances behave identically.
 */
function registerAllRoutes(instance, { buildCompactionSummary = defaultBuildCompactionSummary } = {}) {
    const appRouter = express.Router();
    registerAuthRoutes(appRouter, {
        createRateLimit,
        hashPassword,
        verifyPassword,
        issueAuthToken,
    });
    registerCoreRoutes(appRouter, { requireAuth });
    registerSessionExtensionRoutes(appRouter, {
        requireAuth,
        estimateTokens,
        resolveModelName,
        buildCompactionSummary,
    });
    registerFeedbackRoutes(appRouter, { requireAuth });
    registerObservabilityRoutes(appRouter, { requireAuth });
    registerConfigRoutes(appRouter, { requireAuth, requireAdmin });
    registerMemoryRoutes(appRouter, { requireAuth });
    // Phase 5: 评估系统 — admin + rate-limited。evalRoutes 内部 DB 访问仍走
    // 模块单例(残余项),待 eval 路由自身 bag 化后再注入。
    appRouter.use("/eval", requireAuth, createRateLimit({ scope: "eval", windowMs: 60_000, max: 30 }), requireAdmin, evalRoutes);
    instance.use(appRouter);
}

/** Default compaction summarizer: LLM-generated summary of conversation text. */
async function defaultBuildCompactionSummary(conversationText) {
    const { ChatOpenAI } = await import("@langchain/openai");
    const { SystemMessage, HumanMessage } = await import("@langchain/core/messages");
    const chatUtils = await import("./services/chatUtils.js");
    const llm = new ChatOpenAI({
        modelName: chatUtils.resolveModelName(false),
        temperature: 0.3,
        ...chatUtils.buildChatOpenAIConfig(false),
    });
    // buildChatOpenAIConfig 默认 maxRetries:0 → 这里补 withRetry 作为唯一重试层
    const result = await withRetry(
        (_, retrySignal) => llm.invoke([
            new SystemMessage("你是一个对话摘要助手。请用中文将以下对话历史压缩为一段简洁摘要，保留关键问题、回答要点和结论，控制在 150-300 字以内。"),
            new HumanMessage(`对话历史：\n\n${conversationText.slice(0, 12000)}\n\n请生成摘要：`),
        ], { signal: retrySignal }),
        { retries: 2 }
    );
    return String(result?.content || "").trim();
}

function isDbCountIntent(input) {
    const text = String(input || "");
    // 复合问题（多个问句）跳过快捷路径，交给 Agent 处理工具调用
    if ((text.match(/[？?]/g) || []).length >= 2) {
        return false;
    }
    return /数据库|sqlite|历史消息|对话记录/.test(text) && /多少|几条|总数|条数|统计|count/.test(text);
}

function isKnowledgeIntent(input) {
    const text = String(input || "");
    const hasDocCue = /文档|资料|文件|手册|说明书|知识库|上传|上文|文中|这份|该文|来源|证据|摘录/.test(text);
    const hasFileRef = /\b[\w.-]+\.(txt|md)\b/i.test(text);
    return hasDocCue || hasFileRef;
}

function refersToLatestUpload(input) {
    const text = String(input || "");
    return /我上传的这个|刚上传|这个文件|这份文件|当前上传/.test(text);
}

function sanitizeUploadFileName(fileName) {
    return path.basename(String(fileName || "")).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}

function normalizeUploadHash(hash) {
    const normalized = String(hash || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
        throw Object.assign(new Error("invalid upload hash"), { code: "UPLOAD_HASH_INVALID", statusCode: 400 });
    }
    return normalized;
}

function normalizeTotalChunks(value) {
    const total = Number(value);
    const maxChunks = Math.max(1, Number(process.env.UPLOAD_MAX_CHUNKS) || 128);
    if (!Number.isInteger(total) || total < 1 || total > maxChunks) {
        throw Object.assign(new Error("invalid totalChunks"), { statusCode: 400 });
    }
    return total;
}

function normalizeChunkIndex(value, totalChunks) {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= totalChunks) {
        throw Object.assign(new Error("invalid chunk index"), { statusCode: 400 });
    }
    return index;
}

function getUserUploadRoot(userId, root) {
    return path.join(root, String(Number(userId)));
}

function buildMergedFilePath(hash, fileName, userId = 0) {
    const safeName = sanitizeUploadFileName(fileName || `${hash}.txt`);
    return path.join(getUserUploadRoot(userId, MERGED_UPLOAD_ROOT), `${hash}-${safeName}`);
}

async function appendChunkToStream(writeStream, chunkPath) {
    await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(chunkPath);
        const onError = (error) => {
            readStream.destroy();
            reject(error);
        };
        readStream.on("error", onError);
        writeStream.on("error", onError);
        readStream.on("end", resolve);
        readStream.pipe(writeStream, { end: false });
    });
}

async function getFilesTotalBytes(paths) {
    let total = 0;
    for (const filePath of paths) {
        const stat = await fse.stat(filePath);
        total += Number(stat.size) || 0;
    }
    return total;
}

async function streamAndVerifyFile(filePath, { maxBytes, expectedHash = null } = {}) {
    const hash = crypto.createHash("sha256");
    let totalBytes = 0;
    await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        const fail = (error) => {
            stream.destroy();
            reject(error);
        };
        stream.on("data", (chunk) => {
            totalBytes += chunk.length;
            if (Number.isFinite(maxBytes) && totalBytes > maxBytes) {
                fail(Object.assign(new Error("file too large"), { statusCode: 413, code: "UPLOAD_QUOTA_EXCEEDED" }));
                return;
            }
            hash.update(chunk);
        });
        stream.once("error", fail);
        stream.once("end", resolve);
    });
    const actualHash = hash.digest("hex");
    if (expectedHash && expectedHash.length === 64 && actualHash !== expectedHash) {
        throw Object.assign(new Error("upload hash mismatch"), { statusCode: 400, code: "UPLOAD_HASH_MISMATCH" });
    }
    return { bytes: totalBytes, hash: actualHash };
}

function mentionsActiveLargeFile(input, largeFile) {
    if (!largeFile?.content) {
        return false;
    }

    const text = String(input || "").toLowerCase();
    const fileName = String(largeFile.fileName || "").toLowerCase();

    if (fileName && text.includes(fileName)) {
        return true;
    }

    return /我上传的这个|刚上传|这个文件|这份文件|当前上传|这篇长文|整份文档|全文/.test(text);
}

function normalizeSegmentSize(size) {
    if (!Number.isFinite(size) || size < 200) {
        return 1800;
    }

    return Math.floor(size);
}

function normalizeSegmentOverlap(overlap, segmentSize) {
    if (!Number.isFinite(overlap) || overlap < 0) {
        return 240;
    }

    return Math.min(Math.floor(overlap), Math.floor(segmentSize / 2));
}

function splitLargeFileContent(content) {
    const text = String(content || "");
    const segmentSize = normalizeSegmentSize(LARGE_FILE_SEGMENT_SIZE);
    const overlap = normalizeSegmentOverlap(LARGE_FILE_SEGMENT_OVERLAP, segmentSize);
    const stride = Math.max(1, segmentSize - overlap);
    const segments = [];

    for (let start = 0; start < text.length; start += stride) {
        const end = Math.min(text.length, start + segmentSize);
        const segmentText = text.slice(start, end).trim();
        if (!segmentText) {
            continue;
        }

        segments.push({
            index: segments.length,
            start,
            end,
            text: segmentText
        });

        if (end >= text.length) {
            break;
        }
    }

    return segments;
}

function getCachedLargeFileSegments(largeFile, userId = 0) {
    const cacheKey = `${Number(userId)}:${String(largeFile?.fileName || "")}:${String(largeFile?.updatedAt || "")}:${Number(largeFile?.sizeBytes || 0)}`;

    const cached = largeFileSegmentCache.get(cacheKey);
    if (cached?.expiresAt > Date.now() && cached.segments?.length > 0) {
        return cached.segments;
    }
    if (cached) largeFileSegmentCache.delete(cacheKey);

    const segments = splitLargeFileContent(largeFile?.content || "");
    if (cacheKey) {
        const maxEntries = Math.max(1, Number(process.env.LARGE_FILE_CACHE_MAX_ENTRIES) || 32);
        const ttlMs = Math.max(1_000, Number(process.env.LARGE_FILE_CACHE_TTL_MS) || 15 * 60 * 1000);
        largeFileSegmentCache.set(cacheKey, { segments, expiresAt: Date.now() + ttlMs });
        while (largeFileSegmentCache.size > maxEntries) {
            largeFileSegmentCache.delete(largeFileSegmentCache.keys().next().value);
        }
    }
    return segments;
}

function extractQueryTerms(input) {
    const source = String(input || "").toLowerCase();
    const terms = source.match(/[\u4e00-\u9fa5]{2,}|[a-z0-9_]{3,}/g) || [];
    const stopTerms = new Set([
        "这个", "那个", "这份", "文件", "文档", "全文", "解析", "分析", "总结", "请问", "帮我", "上传"
    ]);

    return Array.from(new Set(terms.filter((term) => !stopTerms.has(term))));
}

function scoreSegmentByTerms(segmentText, terms) {
    if (!terms.length) {
        return 0;
    }

    const text = String(segmentText || "").toLowerCase();
    let score = 0;

    for (const term of terms) {
        if (!term) {
            continue;
        }

        let index = text.indexOf(term);
        while (index !== -1) {
            score += term.length >= 4 ? 3 : 2;
            index = text.indexOf(term, index + term.length);
        }
    }

    return score;
}

function buildLargeFileContext(largeFile, query, userId = 0) {
    const segments = getCachedLargeFileSegments(largeFile, userId);
    if (segments.length === 0) {
        return {
            contextText: "",
            selectedCount: 0,
            selectedChars: 0,
            totalSegments: 0
        };
    }

    const terms = extractQueryTerms(query);
    const scored = segments
        .map((segment) => ({
            ...segment,
            score: scoreSegmentByTerms(segment.text, terms)
        }))
        .sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }

            return a.index - b.index;
        });

    const pickCandidates = scored.filter((item) => item.score > 0);
    const candidates = pickCandidates.length > 0 ? pickCandidates : scored.slice(0, LARGE_FILE_MAX_SEGMENTS);

    const selected = [];
    let totalChars = 0;
    for (const item of candidates) {
        if (selected.length >= LARGE_FILE_MAX_SEGMENTS) {
            break;
        }

        const block = `片段#${item.index + 1} (字符 ${item.start}-${item.end})\n${item.text}`;
        if (totalChars + block.length > LARGE_FILE_MAX_CONTEXT_CHARS) {
            break;
        }

        selected.push(block);
        totalChars += block.length;
    }

    if (selected.length === 0) {
        const fallback = scored[0];
        if (fallback) {
            const fallbackBlock = `片段#${fallback.index + 1} (字符 ${fallback.start}-${fallback.end})\n${fallback.text.slice(0, LARGE_FILE_MAX_CONTEXT_CHARS)}`;
            selected.push(fallbackBlock);
            totalChars = fallbackBlock.length;
        }
    }

    return {
        contextText: selected.join("\n\n"),
        selectedCount: selected.length,
        selectedChars: totalChars,
        totalSegments: segments.length
    };
}

function sendSseText(res, text) {
    return getSSEWriter(res, { requestId: res.req?.requestId }).write({ type: "text", text });
}

function sendSseMetrics(res, metrics) {
    return getSSEWriter(res, { requestId: res.req?.requestId }).write({ type: "metrics", metrics });
}

function writeReplaySSE(res, response, requestId) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Idempotency-Replayed", "true");
    const writer = getSSEWriter(res, { requestId });
    const text = String(response?.text || "");
    if (text) writer.write({ type: "text", text });
    if (response?.metrics) writer.write({ type: "metrics", metrics: response.metrics });
    writer.done();
    res.end();
}

function writeSseError(res, error, requestId) {
    if (res.writableEnded) return;
    return getSSEWriter(res, { requestId }).writeError(error);
}

function canonicalChatRequest(body, resolvedImage) {
    return JSON.stringify({
        session_id: Number(body?.session_id),
        message: String(body?.message || ""),
        image: resolvedImage ? String(resolvedImage) : null,
        image_id: body?.image_id == null ? null : Number(body.image_id),
        enable_web_search: body?.enable_web_search === true,
        plan_mode: body?.plan_mode === true,
        enable_memory: body?.enable_memory !== false,
        systemPrompt: String(body?.systemPrompt || ""),
        temperature: body?.temperature == null ? null : Number(body.temperature),
    });
}

app.post("/legacy-auth/register", createRateLimit({ scope: "auth-register", max: 10 }), (req, res) => {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (username.length < 3 || password.length < 6) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("用户名至少 3 位，密码至少 6 位"), { code: "AUTH_INVALID", statusCode: 400 }), req.requestId));
    }

    if (getUserByUsername(username)) {
        return res.status(409).json(toErrorEnvelope(Object.assign(new Error("用户名已存在"), { code: "AUTH_CONFLICT", statusCode: 409 }), req.requestId));
    }

    const userId = createUser(username, hashPassword(password));
    const user = getUserById(userId);
    const token = issueAuthToken(user);

    return res.json({
        ok: true,
        token,
        user,
    });
});

app.post("/legacy-auth/login", createRateLimit({ scope: "auth-login", max: 10 }), (req, res) => {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (!username || !password) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("username and password are required"), { code: "AUTH_INVALID", statusCode: 400 }), req.requestId));
    }

    const user = getUserByUsername(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json(toErrorEnvelope(Object.assign(new Error("用户名或密码错误"), { code: "UNAUTHORIZED", statusCode: 401 }), req.requestId));
    }

    const token = issueAuthToken(user);
    return res.json({
        ok: true,
        token,
        user: {
            id: user.id,
            username: user.username,
            created_at: user.created_at,
        },
    });
});

app.get("/sessions", requireAuth, (req, res) => {
    const dependencies = getDependencies(req);
    const sessions = (dependencies.db?.getSessions || getSessions)(req.user.id);

    return res.json({
        ok: true,
        sessions
    });
});

app.post("/sessions", requireAuth, (req, res) => {
    const dependencies = getDependencies(req);
    const { title } = req.body || {};
    const id = (dependencies.db?.createSession || createSession)(req.user.id, title || "新对话");

    return res.json({
        ok: true,
        id
    });
});

app.patch("/sessions/:id", requireAuth, (req, res) => {
    const sessionId = Number(req.params.id);
    const { title } = req.body || {};

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("invalid session id"), { code: "INVALID_SESSION", statusCode: 400 }), req.requestId));
    }

    if (!String(title || "").trim()) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("title is required"), { code: "INVALID_TITLE", statusCode: 400 }), req.requestId));
    }

    const dependencies = getDependencies(req);
    const result = (dependencies.db?.renameSession || renameSession)(req.user.id, sessionId, title);
    if (!result?.changes) {
        return res.status(404).json(toErrorEnvelope(Object.assign(new Error("session not found"), { code: "SESSION_NOT_FOUND", statusCode: 404 }), req.requestId));
    }

    return res.json({
        ok: true
    });
});

app.delete("/sessions/:id", requireAuth, (req, res) => {
    const sessionId = Number(req.params.id);

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("invalid session id"), { code: "INVALID_SESSION", statusCode: 400 }), req.requestId));
    }

    const result = removeSession(req.user.id, sessionId);
    if (!result?.changes) {
        return res.status(404).json(toErrorEnvelope(Object.assign(new Error("session not found"), { code: "SESSION_NOT_FOUND", statusCode: 404 }), req.requestId));
    }

    return res.json({
        ok: true
    });
});

app.patch("/sessions/:id/pin", requireAuth, (req, res) => {
    const sessionId = Number(req.params.id);
    const pinned = Boolean(req.body?.pinned);

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("invalid session id"), { code: "INVALID_SESSION", statusCode: 400 }), req.requestId));
    }

    const result = toggleSessionPin(req.user.id, sessionId, pinned);
    if (!result?.changes) {
        return res.status(404).json(toErrorEnvelope(Object.assign(new Error("session not found"), { code: "SESSION_NOT_FOUND", statusCode: 404 }), req.requestId));
    }

    return res.json({
        ok: true
    });
});

app.get("/sessions/:id/messages", requireAuth, (req, res) => {
    const dependencies = getDependencies(req);
    const sessionId = Number(req.params.id);

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("invalid session id"), { code: "INVALID_SESSION", statusCode: 400 }), req.requestId));
    }

    const history = (dependencies.db?.getHistoryMessages || getHistoryMessages)(req.user.id, sessionId, 100);
    return res.json({
        ok: true,
        messages: history
    });
});

// ── 上下文窗口管理 ──

// GET /sessions/:id/context-usage — 估算当前会话的 token 用量
app.get("/legacy-sessions/:id/context-usage", requireAuth, (req, res) => {
    const sessionId = Number(req.params.id);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("invalid session id"), { code: "INVALID_SESSION", statusCode: 400 }), req.requestId));
    }

    try {
        const history = getHistoryMessages(req.user.id, sessionId, 200);
        const modelName = resolveModelName(false);
        return res.json({
            ok: true,
            data: calculateContextUsage(history, modelName, sessionId),
        });
    } catch (err) {
        console.error("[context-usage] GET failed:", err.message);
        return res.status(500).json(toErrorEnvelope(Object.assign(new Error("context usage unavailable"), { code: "CONTEXT_USAGE_FAILED", statusCode: 500 }), req.requestId));
    }
});

// POST /sessions/:id/compact — 压缩上下文：LLM 摘要旧消息
app.post("/legacy-sessions/:id/compact", requireAuth, async (req, res) => {
    const sessionId = Number(req.params.id);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("invalid session id"), { code: "INVALID_SESSION", statusCode: 400 }), req.requestId));
    }

    try {
        const history = getHistoryMessages(req.user.id, sessionId, 200);

        // 保留最近 6 条消息（3 轮对话），更早的纳入压缩
        const KEEP_RECENT = 6;
        const messagesToCompact = history.slice(0, Math.max(0, history.length - KEEP_RECENT));

        if (messagesToCompact.length === 0) {
            console.log(`[compact] session ${sessionId}: 0 messages to compact (total ${history.length}, keep ${KEEP_RECENT})`);
            return res.json({
                ok: true,
                data: { summary: null, tokensSaved: 0, messageCount: 0, message: "没有需要压缩的消息" },
            });
        }

        console.log(`[compact] session ${sessionId}: compacting ${messagesToCompact.length} messages, keeping recent ${KEEP_RECENT}`);

        // 拼接对话文本 + 估算压缩前的 token 数
        const conversationText = messagesToCompact
            .map((m) => `[${m.role === "user" ? "用户" : "助手"}]: ${m.content}`)
            .join("\n\n");
        let tokensBefore = 0;
        for (const msg of messagesToCompact) {
            tokensBefore += msg.metrics?.total_tokens || estimateTokens(String(msg.content || ""));
        }

        // 调 LLM 生成摘要
        const { ChatOpenAI } = await import("@langchain/openai");
        const { SystemMessage, HumanMessage } = await import("@langchain/core/messages");
        const chatUtils = await import("./services/chatUtils.js");
        const config = chatUtils.buildChatOpenAIConfig(false);
        const llm = new ChatOpenAI({
            modelName: chatUtils.resolveModelName(false),
            temperature: 0.3,
            ...config,
        });

        const systemMsg = new SystemMessage(
            "你是一个对话摘要助手。请用中文将以下对话历史压缩为一段简洁的摘要，" +
            "保留关键信息：用户的主要问题、你的回答要点、重要决策或结论。" +
            "摘要控制在 150-300 字以内。"
        );
        const userMsg = new HumanMessage(
            `对话历史：\n\n${conversationText.slice(0, 12000)}\n\n请生成摘要：`
        );

        // buildChatOpenAIConfig 默认 maxRetries:0 → 这里补 withRetry 作为唯一重试层
        const result = await withRetry(
            (_, retrySignal) => llm.invoke([systemMsg, userMsg], { signal: retrySignal }),
            { retries: 2 }
        );
        const summaryContent = String(result?.content || "").trim();

        if (!summaryContent) {
            return res.status(500).json(toErrorEnvelope(Object.assign(new Error("LLM 摘要生成失败"), { code: "LLM_FAILED", statusCode: 500 }), req.requestId));
        }

        console.log(`[compact] session ${sessionId}: LLM summary generated (${summaryContent.length} chars)`);

        const summaryTokens = estimateTokens(summaryContent);
        const tokensSaved = Math.max(0, tokensBefore - summaryTokens);
        console.log(`[compact] session ${sessionId}: tokensSaved=${tokensSaved}, tokensBefore=${tokensBefore}, summaryTokens=${summaryTokens}`);

        // 存摘要为 system 消息（标记为上下文压缩边界）
        saveMessage(
            req.user.id,
            sessionId,
            "system",
            `[上下文压缩摘要 — ${new Date().toLocaleString("zh-CN")}]\n${summaryContent}`
        );

        return res.json({
            ok: true,
            data: {
                summary: summaryContent,
                tokensSaved,
                tokensBefore,
                summaryTokens,
                compactedMessages: messagesToCompact.length,
            },
        });
    } catch (err) {
        console.error("[compact] POST failed:", err.message);
        return res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

app.delete("/legacy-sessions/:id/messages/:messageId/pair", requireAuth, (req, res) => {
    const sessionId = Number(req.params.id);
    const messageId = Number(req.params.messageId);

    if (!Number.isInteger(sessionId) || sessionId <= 0 || !Number.isInteger(messageId) || messageId <= 0) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("invalid session id or message id"), { code: "INVALID_ARGUMENT", statusCode: 400 }), req.requestId));
    }

    try {
        const result = removeMessagePair(req.user.id, sessionId, messageId);
        return res.json({
            ok: true,
            ...result,
        });
    } catch (error) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("remove message pair failed"), { code: "INVALID_ARGUMENT", statusCode: 400 }), req.requestId));
    }
});

app.post("/legacy-sessions/:id/branch", requireAuth, (req, res) => {
    const sourceSessionId = Number(req.params.id);
    const fromMessageIdRaw = req.body?.from_message_id;
    const fromMessageId = fromMessageIdRaw == null ? null : Number(fromMessageIdRaw);
    const title = String(req.body?.title || "").trim();
    const editedContent = String(req.body?.edited_content || "");

    if (!Number.isInteger(sourceSessionId) || sourceSessionId <= 0) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("invalid source session id"), { code: "INVALID_ARGUMENT", statusCode: 400 }), req.requestId));
    }

    if (fromMessageId != null && (!Number.isInteger(fromMessageId) || fromMessageId <= 0)) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("invalid from message id"), { code: "INVALID_ARGUMENT", statusCode: 400 }), req.requestId));
    }

    try {
        const branchTitle = title || `分支-${new Date().toLocaleString()}`;
        const branchId = createBranchSession(
            req.user.id,
            sourceSessionId,
            fromMessageId,
            branchTitle,
            editedContent
        );
        const session = getSessionById(req.user.id, branchId);

        return res.json({
            ok: true,
            id: branchId,
            session,
        });
    } catch (error) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("branch failed"), { code: "INVALID_ARGUMENT", statusCode: 400 }), req.requestId));
    }
});

app.get("/observability/recent", requireAuth, (req, res) => {
    const limit = Number(req.query?.limit || 30);
    const records = getRecentObservability(req.user.id, limit);

    return res.json({
        ok: true,
        records,
    });
});

// GET /observability/metrics?window=7d|30d|all
app.get("/observability/metrics", requireAuth, (req, res) => {
    try {
        const window = ["7d", "30d", "all"].includes(req.query?.window)
            ? req.query.window
            : "7d";
        const report = metricsAggregator.getFullReport(req.user.id, window);
        return res.json({ ok: true, ...report });
    } catch (err) {
        console.error("[observability/metrics] GET failed:", err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// GET /observability/traces?limit=30 — Phase 6b G9: Trace 列表
app.get("/observability/traces", requireAuth, (req, res) => {
    try {
        const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 30));
        const scope = { userId: req.user.id, tenantId: req.user.tenantId };
        const rows = getRecentTraces(req.user.id, limit, scope);
        const traces = rows.map((r) => ({
            trace_id: r.trace_id,
            trace_type: r.trace_type,
            agent_traversal_path: (() => {
                try { return JSON.parse(r.agent_traversal_path || "[]"); } catch { return []; }
            })(),
            tool_call_count: r.tool_call_count,
            error_count: r.error_count,
            total_latency_ms: r.total_latency_ms,
            model: r.model,
            created_at: r.created_at ? new Date(r.created_at + "Z").toISOString() : null,
        }));
        return res.json({ ok: true, traces, total: traces.length });
    } catch (err) {
        console.error("[observability/traces] GET failed:", err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// GET /observability/traces/:traceId — Phase 6b G9: Trace 详情（含完整 Span 树）
app.get("/observability/traces/:traceId", requireAuth, (req, res) => {
    try {
        const scope = { userId: req.user.id, tenantId: req.user.tenantId };
        const trace = getTraceById(req.params.traceId, req.user.id, scope);
        if (!trace) {
            return res.status(404).json(toErrorEnvelope(Object.assign(new Error("trace not found"), { code: "NOT_FOUND", statusCode: 404 }), req.requestId));
        }
        const rootSpan = (() => {
            try { return JSON.parse(trace.root_span || "{}"); } catch { return {}; }
        })();
        const agentTraversalPath = (() => {
            try { return JSON.parse(trace.agent_traversal_path || "[]"); } catch { return []; }
        })();
        return res.json({
            ok: true,
            trace: {
                trace_id: trace.trace_id,
                trace_type: trace.trace_type,
                total_latency_ms: trace.total_latency_ms,
                tool_call_count: trace.tool_call_count,
                error_count: trace.error_count,
                model: trace.model,
                agent_traversal_path: agentTraversalPath,
                root_span: rootSpan,
                created_at: trace.created_at ? new Date(trace.created_at + "Z").toISOString() : null,
            },
        });
    } catch (err) {
        console.error("[observability/traces/:id] GET failed:", err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// GET /observability/traces/:traceId/otel — Phase 6c OTel: 导出为 OpenTelemetry 格式
app.get("/observability/traces/:traceId/otel", requireAuth, (req, res) => {
    try {
        const scope = { userId: req.user.id, tenantId: req.user.tenantId };
        const trace = getTraceById(req.params.traceId, req.user.id, scope);
        if (!trace) {
            return res.status(404).json(toErrorEnvelope(Object.assign(new Error("trace not found"), { code: "NOT_FOUND", statusCode: 404 }), req.requestId));
        }
        const rootSpan = (() => {
            try { return JSON.parse(trace.root_span || "{}"); } catch { return {}; }
        })();
        const agentTraversalPath = (() => {
            try { return JSON.parse(trace.agent_traversal_path || "[]"); } catch { return []; }
        })();

        const traceRecord = {
            traceId: trace.trace_id,
            rootSpan,
            agentTraversalPath,
            toolCallCount: trace.tool_call_count,
            errorCount: trace.error_count,
            model: trace.model,
        };

        const otelFormat = TraceCollector.toOpenTelemetry(traceRecord);
        if (!otelFormat) {
            return res.status(500).json(toErrorEnvelope(Object.assign(new Error("failed to convert to OTel format"), { code: "OTEL_EXPORT_FAILED", statusCode: 500 }), req.requestId));
        }
        return res.json({ ok: true, otel: otelFormat });
    } catch (err) {
        console.error("[observability/traces/:id/otel] GET failed:", err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// POST /observability/otel/import — Phase 6c OTel: 导入外部 OTel Trace
app.post("/observability/otel/import", requireAuth, (req, res) => {
    try {
        const { otel } = req.body || {};
        if (!otel) {
            return res.status(400).json(toErrorEnvelope(Object.assign(new Error("otel is required in request body"), { code: "OTEL_INVALID", statusCode: 400 }), req.requestId));
        }
        // 支持 JSON 字符串或已解析对象
        const otelJson = typeof otel === "string" ? JSON.parse(otel) : otel;

        // 获取有效 session_id：导入 Trace 没有真实 session，取用户最新 session 兜底
        let sessionId = Number(req.body?.session_id) || 0;
        if (sessionId && !getSessionById(req.user.id, sessionId)) {
            return res.status(404).json(toErrorEnvelope(Object.assign(new Error("session not found"), { code: "NOT_FOUND", statusCode: 404 }), req.requestId));
        }
        if (!sessionId) {
            const sessions = getSessions(req.user.id);
            if (sessions.length > 0) {
                sessionId = sessions[0].id;
            } else {
                // 用户没有任何 session，创建一个占位 session
                const newSession = createSession(req.user.id, "OTel 导入");
                sessionId = typeof newSession === "object" ? newSession.id : newSession;
            }
        }

        const internal = otelToInternalTrace(otelJson, {
            userId: req.user.id,
            sessionId,
        });

        if (!internal) {
            return res.status(400).json(toErrorEnvelope(Object.assign(new Error("failed to parse OTel trace: no valid spans found"), { code: "OTEL_INVALID", statusCode: 400 }), req.requestId));
        }

        // 写入 DB
        const id = saveTrace(internal);
        console.log(`[observability/otel/import] imported trace "${internal.traceId}" (${internal.toolCallCount} tools, ${internal.agentTraversalPath.length} agents), db id=${id}`);
        return res.json({
            ok: true,
            trace_id: internal.traceId,
            db_id: id,
            spans: internal.agentTraversalPath.length + internal.toolCallCount,
        });
    } catch (err) {
        console.error("[observability/otel/import] POST failed:", err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// ── Phase 5: 评估系统路由 ──
app.use("/eval", requireAuth, createRateLimit({ scope: "eval", windowMs: 60_000, max: 30 }), requireAdmin, evalRoutes);

// Phase 5: 用户反馈（支持切换取消）
app.post("/legacy-chat/feedback", requireAuth, (req, res) => {
    const { message_id, rating, comment } = req.body || {};
    const messageId = Number(message_id);

    // rating 为 null 表示取消反馈
    if (rating === null || rating === undefined) {
        if (!messageId) {
            return res.status(400).json(toErrorEnvelope(Object.assign(new Error("message_id is required"), { code: "INVALID_ARGUMENT", statusCode: 400 }), req.requestId));
        }
        try {
            deleteFeedback(req.user.id, messageId, { userId: req.user.id, tenantId: req.user.tenantId });
            return res.json({ ok: true, rating: null });
        } catch (err) {
            console.error(`[feedback] delete failed:`, err.message);
            return res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
        }
    }

    if (!["thumbs_up", "thumbs_down"].includes(rating) || !messageId) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("message_id and rating are required"), {
            code: "INVALID_ARGUMENT", statusCode: 400,
        }), req.requestId));
    }

    try {
        // 检查是否已存在同 rating 的反馈 → 切换取消
        const scope = { userId: req.user.id, tenantId: req.user.tenantId };
        const existing = getFeedbackByMessage(req.user.id, messageId, scope);
        if (existing && existing.rating === rating) {
            deleteFeedback(req.user.id, messageId, { userId: req.user.id, tenantId: req.user.tenantId });
            return res.json({ ok: true, rating: null });
        }

        saveFeedback(req.user.id, messageId, rating, comment || null, scope);
        res.json({ ok: true, rating });
    } catch (err) {
        console.error(`[feedback] save failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// ── Phase 6: Agent 配置管理 ──

import { agentConfig } from "./services/agentConfig.js";
import { metricsAggregator } from "./trace/metrics.js";
import { TraceCollector } from "./trace/collector.js";
import { otelToInternalTrace } from "./trace/import.js";

app.get("/agent-config", requireAuth, requireAdmin, (req, res) => {
    try {
        const all = agentConfig.getAll({ userId: req.user.id, tenantId: req.user.tenantId });
        return res.json({ ok: true, configs: all, scope: { userId: req.user.id, tenantId: req.user.tenantId } });
    } catch (err) {
        console.error(`[agent-config] GET failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

app.put("/agent-config", requireAuth, requireAdmin, (req, res) => {
    const { key, value } = req.body || {};
    if (!key || value === undefined) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("key and value are required"), { code: "INVALID_ARGUMENT", statusCode: 400 }), req.requestId));
    }
    try {
        const ok = agentConfig.set(String(key), String(value), null, false, {
            userId: req.user.id,
            tenantId: req.user.tenantId,
        });
        return res.json({ ok, config: { key: String(key), value: String(value) } });
    } catch (err) {
        console.error(`[agent-config] PUT failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// ── Phase 6b G5: Agent 配置版本管理 ──

app.get("/agent-config/versions", requireAuth, requireAdmin, (req, res) => {
    try {
        const versions = agentConfig.listVersions(20, { userId: req.user.id, tenantId: req.user.tenantId });
        return res.json({ ok: true, versions });
    } catch (err) {
        console.error(`[agent-config/versions] GET failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

app.get("/agent-config/versions/:id", requireAuth, requireAdmin, (req, res) => {
    try {
        const version = agentConfig.getVersion(Number(req.params.id), { userId: req.user.id, tenantId: req.user.tenantId });
        if (!version) {
            return res.status(404).json(toErrorEnvelope(Object.assign(new Error("Version not found"), { code: "NOT_FOUND", statusCode: 404 }), req.requestId));
        }
        return res.json({ ok: true, version });
    } catch (err) {
        console.error(`[agent-config/versions/:id] GET failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

app.post("/agent-config/rollback", requireAuth, requireAdmin, (req, res) => {
    const { versionId } = req.body || {};
    if (!versionId) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("versionId is required"), { code: "INVALID_ARGUMENT", statusCode: 400 }), req.requestId));
    }
    try {
        const ok = agentConfig.restoreVersion(Number(versionId), { userId: req.user.id, tenantId: req.user.tenantId });
        if (!ok) {
            return res.status(400).json(toErrorEnvelope(Object.assign(new Error("Rollback failed"), { code: "ROLLBACK_FAILED", statusCode: 400 }), req.requestId));
        }
        // 回滚后返回当前配置状态
        const all = agentConfig.getAll({ userId: req.user.id, tenantId: req.user.tenantId });
        return res.json({ ok: true, configs: all, scope: { userId: req.user.id, tenantId: req.user.tenantId } });
    } catch (err) {
        console.error(`[agent-config/rollback] POST failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// PATCH /agent-config/versions/:id/label — 重命名版本标签
app.patch("/agent-config/versions/:id/label", requireAuth, requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const { label } = req.body || {};
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("Invalid version id"), { code: "INVALID_ARGUMENT", statusCode: 400 }), req.requestId));
    }
    try {
        const ok = agentConfig.renameVersion(id, label || null, { userId: req.user.id, tenantId: req.user.tenantId });
        if (!ok) {
            return res.status(404).json(toErrorEnvelope(Object.assign(new Error("Version not found"), { code: "NOT_FOUND", statusCode: 404 }), req.requestId));
        }
        return res.json({ ok: true });
    } catch (err) {
        console.error(`[agent-config/versions/:id/label] PATCH failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// DELETE /agent-config/versions/:id — 删除版本记录
app.delete("/agent-config/versions/:id", requireAuth, requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("Invalid version id"), { code: "INVALID_ARGUMENT", statusCode: 400 }), req.requestId));
    }
    try {
        const ok = agentConfig.removeVersion(id, { userId: req.user.id, tenantId: req.user.tenantId });
        if (!ok) {
            return res.status(404).json(toErrorEnvelope(Object.assign(new Error("Version not found"), { code: "NOT_FOUND", statusCode: 404 }), req.requestId));
        }
        return res.json({ ok: true });
    } catch (err) {
        console.error(`[agent-config/versions/:id] DELETE failed:`, err.message);
        res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

app.post("/test-db", requireAuth, (req, res) => {
    if (process.env.NODE_ENV === "production") {
        return res.status(404).json(toErrorEnvelope(Object.assign(new Error("not found"), { code: "NOT_FOUND", statusCode: 404 }), req.requestId));
    }
    const { session_id, role, content } = req.body || {};
    const sessionId = Number(session_id);

    if (!Number.isInteger(sessionId) || sessionId <= 0 || !role || !content) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("session_id, role and content are required"), {
            code: "INVALID_ARGUMENT", statusCode: 400,
        }), req.requestId));
    }

    saveMessage(req.user.id, sessionId, role, content);
    const history = getHistoryMessages(req.user.id, sessionId, 20);

    return res.json({
        ok: true,
        history
    });
});

app.post("/upload", requireAuth, createRateLimit({ scope: "upload", windowMs: 60_000, max: 10 }), (req, res, next) => {
    documentUploadMiddleware(req, res, (uploadError) => {
        if (uploadError) {
            const status = uploadError.code === "LIMIT_FILE_SIZE" ? 413 : 400;
            res.status(status).json(toErrorEnvelope(Object.assign(uploadError, {
                statusCode: status,
                code: status === 413 ? "UPLOAD_QUOTA_EXCEEDED" : "UPLOAD_INVALID",
            }), req.requestId));
            return;
        }
        next();
    });
}, async (req, res) => {
    const {
        quota: { withUploadLock, reserveUploadChunk, settleUploadReservation, releaseUploadReservation },
        services: { processAndStoreDocument },
    } = getDependencies(req);
    let uploadKey = "";
    try {
        if (!req.file) {
            return res.status(400).json(toErrorEnvelope(Object.assign(new Error("file is required"), {
                code: "UPLOAD_INVALID",
                statusCode: 400,
            }), req.requestId));
        }

        uploadKey = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
        const result = await withUploadLock(req.user.id, uploadKey, async () => {
            reserveUploadChunk(req.user.id, uploadKey, 0, req.file.buffer.length);
            const indexed = await processAndStoreDocument(
                req.file.buffer,
                req.file.originalname,
                req.user.id
            );
            settleUploadReservation(req.user.id, uploadKey, req.file.buffer.length);
            return indexed;
        });
        return res.json({
            ok: true,
            message: "document indexed",
            data: result
        });
    } catch (error) {
        releaseUploadReservation(req.user.id, typeof uploadKey === "string" ? uploadKey : "", { reason: "upload_failed" });
        const message = error.message || "upload failed";
        const statusCode = Number(error?.statusCode) || (/仅支持上传|file type|invalid file|empty document/i.test(message)
            ? 400
            : 500);
        return res.status(statusCode).json(toErrorEnvelope(Object.assign(error, {
            statusCode,
            code: error?.code || (statusCode >= 500 ? "UPLOAD_FAILED" : "UPLOAD_INVALID"),
        }), req.requestId));
    }
});

app.post("/upload/check", requireAuth, createRateLimit({ scope: "upload-check", windowMs: 60_000, max: 30 }), async (req, res) => {
    try {
        const { hash, totalChunks, fileName } = req.body || {};
        const normalizedHash = normalizeUploadHash(hash);
        const normalizedTotalChunks = normalizeTotalChunks(totalChunks);

        await fse.ensureDir(getUserUploadRoot(req.user.id, CHUNK_UPLOAD_ROOT));
        await fse.ensureDir(getUserUploadRoot(req.user.id, MERGED_UPLOAD_ROOT));

        const mergedFilePath = buildMergedFilePath(normalizedHash, fileName, req.user.id);
        const mergedExists = await fse.pathExists(mergedFilePath);

        const uploadedChunks = [];
        const hashDir = path.join(getUserUploadRoot(req.user.id, CHUNK_UPLOAD_ROOT), normalizedHash);
        if (await fse.pathExists(hashDir)) {
            const chunkFiles = await fse.readdir(hashDir);
            for (const chunkFile of chunkFiles) {
                const match = String(chunkFile).match(/^(\d+)\.part$/);
                if (match) {
                    uploadedChunks.push(Number(match[1]));
                }
            }
        }

        uploadedChunks.sort((a, b) => a - b);

        const allChunkIndexes = Number.isInteger(normalizedTotalChunks) && normalizedTotalChunks > 0
            ? Array.from({ length: normalizedTotalChunks }, (_, index) => index)
            : [];

        const data = {
            hash: normalizedHash,
            uploaded: mergedExists,
            uploadedChunks: mergedExists ? allChunkIndexes : uploadedChunks,
        };

        return res.json({
            ok: true,
            data,
        });
    } catch (error) {
        const message = error?.message || "check chunk upload failed";
        const statusCode = error?.code === "LIMIT_FILE_SIZE" ? 413 : (/required|invalid/i.test(message) ? 400 : 500);
        return res.status(statusCode).json(toErrorEnvelope(Object.assign(error, {
            statusCode,
            code: statusCode === 413 ? "UPLOAD_QUOTA_EXCEEDED" : (statusCode >= 500 ? "UPLOAD_FAILED" : "UPLOAD_INVALID"),
        }), req.requestId));
    }
});

app.post("/upload/chunk", requireAuth, createRateLimit({ scope: "upload-chunk", windowMs: 60_000, max: 120 }), (req, res) => {
    chunkUploadMiddleware(req, res, async (error) => {
        const {
            quota: { withUploadLock, reserveUploadChunk, rollbackUploadChunk },
        } = getDependencies(req);
        if (error) {
            const statusCode = error?.code === "LIMIT_FILE_SIZE" ? 413 : 400;
            return res.status(statusCode).json(toErrorEnvelope(Object.assign(error, {
                statusCode,
                code: statusCode === 413 ? "UPLOAD_QUOTA_EXCEEDED" : "UPLOAD_INVALID",
            }), req.requestId));
        }

        try {
            const { hash, chunkIndex, fileName, totalChunks } = req.body || {};
            const normalizedHash = normalizeUploadHash(hash);
            const normalizedTotalChunks = normalizeTotalChunks(totalChunks);
            const normalizedChunkIndex = normalizeChunkIndex(chunkIndex, normalizedTotalChunks);

            if (!normalizedHash) {
                return res.status(400).json(toErrorEnvelope(Object.assign(new Error("invalid hash or chunk index"), {
                    code: "UPLOAD_INVALID",
                    statusCode: 400,
                }), req.requestId));
            }

            if (!req.file?.buffer) {
                return res.status(400).json(toErrorEnvelope(Object.assign(new Error("chunk is required"), {
                    code: "UPLOAD_INVALID",
                    statusCode: 400,
                }), req.requestId));
            }

            await fse.ensureDir(getUserUploadRoot(req.user.id, CHUNK_UPLOAD_ROOT));
            const hashDir = path.join(getUserUploadRoot(req.user.id, CHUNK_UPLOAD_ROOT), normalizedHash);
            await fse.ensureDir(hashDir);

            const chunkPath = path.join(hashDir, `${normalizedChunkIndex}.part`);
            await withUploadLock(req.user.id, normalizedHash, async () => {
                const previousExists = await fse.pathExists(chunkPath);
                const previousSize = previousExists ? Number((await fse.stat(chunkPath)).size) || 0 : 0;
                reserveUploadChunk(req.user.id, normalizedHash, normalizedChunkIndex, req.file.buffer.length);
                const temporaryPath = path.join(hashDir, `.${normalizedChunkIndex}.${crypto.randomUUID()}.part.tmp`);
                try {
                    await fse.writeFile(temporaryPath, req.file.buffer, { flag: "wx" });
                    await fse.rename(temporaryPath, chunkPath);
                } catch (writeError) {
                    await fse.remove(temporaryPath).catch(() => {});
                    rollbackUploadChunk(req.user.id, normalizedHash, normalizedChunkIndex, previousSize, req.file.buffer.length);
                    if (!previousExists) await fse.remove(chunkPath).catch(() => {});
                    else if (await fse.pathExists(chunkPath) && Number((await fse.stat(chunkPath)).size) !== previousSize) {
                        await fse.remove(chunkPath).catch(() => {});
                    }
                    throw writeError;
                }
            });

            const chunkFiles = await fse.readdir(hashDir);
            const uploadedChunks = chunkFiles
                .map((name) => {
                    const match = String(name).match(/^(\d+)\.part$/);
                    return match ? Number(match[1]) : null;
                })
                .filter((value) => Number.isInteger(value))
                .sort((a, b) => a - b);

            const data = {
                hash: normalizedHash,
                fileName: sanitizeUploadFileName(fileName),
                chunkIndex: normalizedChunkIndex,
                totalChunks: normalizedTotalChunks,
                uploadedChunks,
            };

            return res.json({
                ok: true,
                data,
            });
        } catch (saveError) {
            const statusCode = Number(saveError?.statusCode) || 500;
            return res.status(statusCode).json(toErrorEnvelope(Object.assign(saveError, {
                statusCode,
                code: saveError?.code || (statusCode >= 500 ? "UPLOAD_FAILED" : "UPLOAD_INVALID"),
            }), req.requestId));
        }
    });
});

app.post("/upload/merge", requireAuth, createRateLimit({ scope: "upload-merge", windowMs: 60_000, max: 30 }), async (req, res) => {
    const {
        quota: { withUploadLock, getUploadReservation, releaseUploadReservation, settleUploadReservation },
        services: { processAndStoreDocumentFile },
    } = getDependencies(req);
    let normalizedHash = "";
    try {
        const { hash, fileName, totalChunks } = req.body || {};
        normalizedHash = normalizeUploadHash(hash);
        const normalizedFileName = sanitizeUploadFileName(fileName);
        const normalizedTotalChunks = normalizeTotalChunks(totalChunks);
        if (!normalizedFileName) {
            return res.status(400).json(toErrorEnvelope(Object.assign(new Error("hash, fileName and totalChunks are required"), {
                code: "UPLOAD_INVALID", statusCode: 400,
            }), req.requestId));
        }

        return await withUploadLock(req.user.id, normalizedHash, async () => {
            let hashDir = path.join(getUserUploadRoot(req.user.id, CHUNK_UPLOAD_ROOT), normalizedHash);
            let mergedFilePath = "";
            let mergeCommitted = false;
            try {
                const maxUploadBytes = Math.max(1, Number(process.env.UPLOAD_MAX_FILE_BYTES) || 8 * 1024 * 1024);
                const reservation = getUploadReservation(req.user.id, normalizedHash);
                if (!reservation) {
                    return res.status(409).json(toErrorEnvelope(Object.assign(new Error("upload reservation not found"), {
                        code: "UPLOAD_RESERVATION_REQUIRED", statusCode: 409,
                    }), req.requestId));
                }
                if (!await fse.pathExists(hashDir)) {
                    if (reservation) releaseUploadReservation(req.user.id, normalizedHash, { reason: "missing_chunk_directory" });
                    return res.status(404).json(toErrorEnvelope(Object.assign(new Error("chunk directory not found"), {
                        code: "UPLOAD_NOT_FOUND", statusCode: 404,
                    }), req.requestId));
                }

                const missingChunks = [];
                for (let index = 0; index < normalizedTotalChunks; index += 1) {
                    if (!await fse.pathExists(path.join(hashDir, `${index}.part`))) missingChunks.push(index);
                }
                if (missingChunks.length > 0) {
                    return res.status(409).json({
                        ...toErrorEnvelope(Object.assign(new Error("missing chunks"), {
                            code: "UPLOAD_MISSING_CHUNKS", statusCode: 409,
                        }), req.requestId),
                        missing_chunks: missingChunks,
                    });
                }

                await fse.ensureDir(getUserUploadRoot(req.user.id, MERGED_UPLOAD_ROOT));
                mergedFilePath = buildMergedFilePath(normalizedHash, normalizedFileName, req.user.id);
                await fse.remove(mergedFilePath);
                const chunkPaths = Array.from({ length: normalizedTotalChunks }, (_, index) =>
                    path.join(hashDir, `${index}.part`)
                );
                const totalBytes = await getFilesTotalBytes(chunkPaths);
                if (totalBytes > maxUploadBytes) {
                    await fse.remove(hashDir);
                    releaseUploadReservation(req.user.id, normalizedHash, { reason: "merge_too_large" });
                    return res.status(413).json(toErrorEnvelope(Object.assign(new Error("file too large"), {
                        code: "UPLOAD_QUOTA_EXCEEDED", statusCode: 413,
                    }), req.requestId));
                }

                const writeStream = fs.createWriteStream(mergedFilePath, { flags: "w" });
                for (const chunkPath of chunkPaths) await appendChunkToStream(writeStream, chunkPath);
                await new Promise((resolve, reject) => {
                    writeStream.once("error", reject);
                    writeStream.end(resolve);
                });

                const verified = await streamAndVerifyFile(mergedFilePath, {
                    maxBytes: maxUploadBytes, expectedHash: normalizedHash,
                });
                const ragResult = await processAndStoreDocumentFile(mergedFilePath, normalizedFileName, req.user.id, {
                    sizeBytes: verified.bytes,
                });
                if (!settleUploadReservation(req.user.id, normalizedHash, verified.bytes)) {
                    throw Object.assign(new Error("upload reservation unavailable"), {
                        code: "UPLOAD_RESERVATION_LOST", statusCode: 409,
                    });
                }
                mergeCommitted = true;
                await fse.remove(hashDir);
                await fse.remove(mergedFilePath);
                return res.json({ ok: true, message: "document indexed", data: { ...ragResult, hash: normalizedHash } });
            } catch (error) {
                if (!mergeCommitted) {
                    await Promise.allSettled([
                        hashDir ? fse.remove(hashDir) : Promise.resolve(),
                        mergedFilePath ? fse.remove(mergedFilePath) : Promise.resolve(),
                    ]);
                    releaseUploadReservation(req.user.id, normalizedHash, { reason: "merge_failed" });
                }
                throw error;
            }
        });
    } catch (error) {
        const status = Number(error?.statusCode) || 500;
        return res.status(status).json(toErrorEnvelope(Object.assign(error || new Error("upload merge failed"), {
            statusCode: status,
            code: error?.code || (status >= 500 ? "UPLOAD_FAILED" : "UPLOAD_INVALID"),
        }), req.requestId));
    }
});

app.post("/upload-image", requireAuth, createRateLimit({ scope: "upload-image", windowMs: 60_000, max: 20 }), (req, res) => {
    imageUploadMiddleware(req, res, (error) => {
        const {
            services: { saveUploadedImage },
        } = getDependencies(req);
        if (error) {
            const message = error.message || "image upload failed";
            const statusCode = /仅支持图片上传|file type|invalid file/i.test(message)
                ? 400
                : /File too large/i.test(message)
                    ? 413
                    : 500;

            res.status(statusCode).json(toErrorEnvelope(Object.assign(error, {
                statusCode,
                code: statusCode === 413 ? "UPLOAD_QUOTA_EXCEEDED" : (statusCode >= 500 ? "UPLOAD_FAILED" : "UPLOAD_INVALID"),
            }), req.requestId));
            return;
        }

        if (!req.file?.buffer) {
            res.status(400).json(toErrorEnvelope(Object.assign(new Error("image is required"), {
                code: "UPLOAD_INVALID",
                statusCode: 400,
            }), req.requestId));
            return;
        }

        const id = saveUploadedImage(req.file.buffer, req.file.mimetype || "image/jpeg", req.user.id);

        res.json({
            ok: true,
            id,
        });
    });
});

app.post("/chat", requireAuth, createRateLimit({ scope: "chat", windowMs: 60_000, max: 30 }), async (req, res) => {
    // W3.3-C: 路由层依赖从实例 bag 解析（factory 可注入 fake db/services）；
    // 名称与模块默认一致,生产 singleton 行为不变。
    const instanceDeps = getDependencies(req);
    const {
        db: {
            getSessionById,
            reserveChatIdempotency,
            markChatIdempotencyStarted,
            completeChatIdempotency,
            failChatIdempotency,
            getChatIdempotency,
            setChatIdempotencyUserMessage,
            saveMessage,
            getMessageStats,
            saveMessageMetric,
        },
        chat: { chatWithStream, chatWithGraph },
        services: { getUploadedImageDataUrl, getLatestUploadedSource, getActiveLargeFile, retrieveKnowledgeEvidence },
    } = instanceDeps;
    const {
        session_id,
        message,
        image,
        image_id,
        enable_web_search,
        plan_mode,
        enable_memory,
        systemPrompt,
        temperature
    } = req.body || {};
    const sessionId = Number(session_id);
    const enableWebSearch = enable_web_search === true;
    const planMode = plan_mode === true;
    const enableMemory = enable_memory !== false; // 默认 true，向后兼容
    const resolvedImage = image || getUploadedImageDataUrl(image_id, req.user.id);
    const idempotencyKey = String(req.headers["x-idempotency-key"] || "").trim();
    const idempotencyEnabled = process.env.CHAT_IDEMPOTENCY_ENABLED !== "false";
    const requestHash = crypto.createHash("sha256").update(canonicalChatRequest(req.body, resolvedImage)).digest("hex");
    const scope = { userId: req.user.id, tenantId: req.user.tenantId };
    let idempotencyReserved = false;
    let idempotencyAttemptToken = null;

    if (image_id && !resolvedImage) {
        return res.status(400).json({ ...toErrorEnvelope(Object.assign(new Error("invalid image"), { code: "INVALID_IMAGE", statusCode: 400 }), req.requestId) });
    }

    if (!Number.isInteger(sessionId) || sessionId <= 0 || (!message && !resolvedImage)) {
        return res.status(400).json({ ...toErrorEnvelope(Object.assign(new Error("invalid chat request"), { code: "INVALID_ARGUMENT", statusCode: 400 }), req.requestId) });
    }

    if (!getSessionById(req.user.id, sessionId)) {
        return res.status(404).json({ ...toErrorEnvelope(Object.assign(new Error("session not found"), { code: "NOT_FOUND", statusCode: 404 }), req.requestId) });
    }

    if (idempotencyEnabled && idempotencyKey) {
        try {
            const reservation = reserveChatIdempotency(scope, idempotencyKey, requestHash);
            if (reservation.status === "conflict") {
                return res.status(409).json(toErrorEnvelope(Object.assign(new Error("idempotency key conflict"), { code: "IDEMPOTENCY_KEY_REUSED", statusCode: 409 }), req.requestId));
            }
            if (reservation.status === "started") {
                return res.status(409).json(toErrorEnvelope(Object.assign(new Error("request already in progress"), { code: "REQUEST_IN_PROGRESS", statusCode: 409, retryable: true }), req.requestId));
            }
            if (reservation.status === "completed" && reservation.response?.text != null) {
                writeReplaySSE(res, reservation.response, req.requestId);
                return;
            }
            idempotencyReserved = reservation.status === "reserved";
            idempotencyAttemptToken = reservation.attemptToken || null;
        } catch (error) {
            return res.status(500).json(toErrorEnvelope(error, req.requestId));
        }
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (idempotencyReserved) {
        markChatIdempotencyStarted(scope, idempotencyKey, idempotencyAttemptToken);
    }

    if (isDbCountIntent(message)) {
        const existing = idempotencyEnabled && idempotencyKey ? getChatIdempotency(scope, idempotencyKey) : null;
        let userMessageId = existing?.user_message_id ? Number(existing.user_message_id) : null;
        if (!userMessageId) {
            userMessageId = saveMessage(req.user.id, sessionId, "user", message);
            if (idempotencyReserved) setChatIdempotencyUserMessage(scope, idempotencyKey, userMessageId, idempotencyAttemptToken);
        }
        const stats = getMessageStats(req.user.id);
        const answer = `截至目前，数据库消息共 ${stats.total} 条（user: ${stats.user_count}，assistant: ${stats.assistant_count}）。`;
        const assistantMessageId = saveMessage(req.user.id, sessionId, "assistant", answer);
        const metrics = {
            latency_ms: 0,
            prompt_tokens: 0,
            completion_tokens: estimateTokens(answer) || 1,
            total_tokens: estimateTokens(answer) || 1,
            model: "local-stats",
        };
        saveMessageMetric(assistantMessageId, metrics);

        sendSseText(res, answer);
        sendSseMetrics(res, metrics);
        getSSEWriter(res, { requestId: req.requestId }).done();
        res.end();
        if (idempotencyReserved) {
            completeChatIdempotency(scope, idempotencyKey, { text: answer, metrics }, assistantMessageId, idempotencyAttemptToken);
        }
        return;
    }

    // Phase 2: LangGraph 多 Agent 管道（feature flag）— 提前定义，所有路径共用
    const _useLangGraph = process.env.USE_LANGGRAPH === 'true';
    // W3.3-G: 把实例依赖 bag 注入深链路 options.deps，使 chatWithStream 内部
    // 的 db/executor/trace/eval 读取可按 factory 隔离。生产 singleton 的 bag
    // 不含覆盖键，chat.js 全回落模块默认 → 零行为变化。
    // 路由级 SSE 兜底：chatWithStream/chatWithGraph 各自的内部 try 从 impl 中段才开始，
    // 之前（如 getHistoryMessages/saveMessage 预取）的抛错会逃逸到这里 —— Express 4 不
    // 转发 async handler rejection，SSE 头已发时不在此收尾会挂死（无 error 帧、无 end）。
    // 正常失败已由服务层内部 catch + opts.onFailure 处理，这里只兜 pre-try 逃逸。
    const chatImpl = async (uid, sid, msg, img, sys, temp, response, opts = {}) => {
        try {
            return await (_useLangGraph ? chatWithGraph : chatWithStream)(uid, sid, msg, img, sys, temp, response, { ...opts, deps: instanceDeps });
        } catch (error) {
            console.error(`[chat][route] uncaught error escaping chatImpl: ${error?.message}`);
            if (!response.headersSent) {
                // handler 已 setHeader("Content-Type","text/event-stream")，但首帧未 flush；
                // Express res.json 不会覆盖已显式设置的 Content-Type → 显式改回 JSON，
                // 避免以 SSE content-type 返回 JSON body（前端以 status 判错，此为协议干净化）。
                response.setHeader("Content-Type", "application/json");
                return response.status(500).json(toErrorEnvelope(error, req.requestId));
            }
            writeSseError(response, error, req.requestId);
            opts?.onFailure?.(error, { text: "" });
            response.end();
            return undefined;
        }
    };

    if (isKnowledgeIntent(message) && !resolvedImage) {
        const userLargeFile = getActiveLargeFile(req.user.id);
        const shouldUseLargeContext = mentionsActiveLargeFile(message, userLargeFile);

        if (shouldUseLargeContext) {
            const currentIdempotency = idempotencyEnabled && idempotencyKey ? getChatIdempotency(scope, idempotencyKey) : null;
            if (!currentIdempotency?.user_message_id) {
                const userMessageId = saveMessage(req.user.id, sessionId, "user", message);
                if (idempotencyReserved) setChatIdempotencyUserMessage(scope, idempotencyKey, userMessageId, idempotencyAttemptToken);
            }

            const contextPayload = buildLargeFileContext(userLargeFile, message, req.user.id);
            const longContextPrompt = `你是一个智能助手。请仅根据给定文档片段回答问题，不得编造文档中不存在的信息；若片段不足以支持结论，请明确说明"证据不足，需补充片段"。\n\n文档名：${userLargeFile.fileName}\n片段总数：${contextPayload.totalSegments}\n本轮命中片段：${contextPayload.selectedCount}\n\n参考片段：\n${contextPayload.contextText}\n\n用户问题：${message}`;
            console.log(
                `[chat][large_file] source=${userLargeFile.fileName} segments=${contextPayload.selectedCount}/${contextPayload.totalSegments} chars=${contextPayload.selectedChars} model=${LONG_CONTEXT_MODEL}`
            );

            await chatImpl(req.user.id, sessionId, longContextPrompt, resolvedImage, systemPrompt, temperature, res, {
                enableWebSearch: false,
                skipUserMessageSave: true,
                forceModel: LONG_CONTEXT_MODEL,
                planMode,
                enableMemory,
                onComplete: (metrics, result = {}) => {
                    if (metrics?.messageId) {
                        saveMessageMetric(metrics.messageId, metrics);
                    }
                    sendSseMetrics(res, metrics);
                    if (idempotencyReserved) {
                        completeChatIdempotency(scope, idempotencyKey, { text: result.text || "", metrics }, result.messageId || metrics?.messageId, idempotencyAttemptToken);
                    }
                },
                onFailure: (error) => {
                    if (idempotencyReserved) failChatIdempotency(scope, idempotencyKey, error?.code || "CHAT_FAILED", idempotencyAttemptToken);
                },
            });
            return;
        }

        // LangGraph 路径：跳过预检索，让 Graph Router → knowledge_agent 自行调用 search_knowledge_base
        if (_useLangGraph) {
            const currentIdempotency = idempotencyEnabled && idempotencyKey ? getChatIdempotency(scope, idempotencyKey) : null;
            if (!currentIdempotency?.user_message_id) {
                const userMessageId = saveMessage(req.user.id, sessionId, "user", message);
                if (idempotencyReserved) setChatIdempotencyUserMessage(scope, idempotencyKey, userMessageId, idempotencyAttemptToken);
            }
            await chatImpl(req.user.id, sessionId, message, resolvedImage, systemPrompt, temperature, res, {
                enableWebSearch,
                skipUserMessageSave: true,
                planMode,
                enableMemory,
                onComplete: (metrics, result = {}) => {
                    if (metrics?.messageId) {
                        saveMessageMetric(metrics.messageId, metrics);
                    }
                    sendSseMetrics(res, metrics);
                    if (idempotencyReserved) {
                        completeChatIdempotency(scope, idempotencyKey, { text: result.text || "", metrics }, result.messageId || metrics?.messageId, idempotencyAttemptToken);
                    }
                },
                onFailure: (error) => {
                    if (idempotencyReserved) failChatIdempotency(scope, idempotencyKey, error?.code || "CHAT_FAILED", idempotencyAttemptToken);
                },
            });
            return;
        }

            const preferredSource = refersToLatestUpload(message)
            ? getLatestUploadedSource(req.user.id)
            : "";
        const evidence = await retrieveKnowledgeEvidence(message, {
            userId: req.user.id,
            topK: 12,
            returnK: 6,
            preferredSource
        });
        const currentIdempotency = idempotencyEnabled && idempotencyKey ? getChatIdempotency(scope, idempotencyKey) : null;
        if (!currentIdempotency?.user_message_id) {
            const userMessageId = saveMessage(req.user.id, sessionId, "user", message);
            if (idempotencyReserved) setChatIdempotencyUserMessage(scope, idempotencyKey, userMessageId, idempotencyAttemptToken);
        }

        if (evidence.status === "ok") {
            const context = evidence.items
                .map((item) => String(item?.content || "").trim())
                .filter(Boolean)
                .join("\n\n");

            const enhancedPrompt = `你是一个智能助手。请严格根据以下检索到的参考资料，回答用户的问题。如果资料不包含相关答案，请告知用户。\n\n参考资料：\n${context}\n\n用户问题：${message}`;

            await chatImpl(req.user.id, sessionId, enhancedPrompt, resolvedImage, systemPrompt, temperature, res, {
                enableWebSearch,
                skipUserMessageSave: true,
                planMode,
                enableMemory,
                onComplete: (metrics, result = {}) => {
                    if (metrics?.messageId) {
                        saveMessageMetric(metrics.messageId, metrics);
                    }
                    sendSseMetrics(res, metrics);
                    if (idempotencyReserved) {
                        completeChatIdempotency(scope, idempotencyKey, { text: result.text || "", metrics }, result.messageId || metrics?.messageId, idempotencyAttemptToken);
                    }
                },
                onFailure: (error) => {
                    if (idempotencyReserved) failChatIdempotency(scope, idempotencyKey, error?.code || "CHAT_FAILED", idempotencyAttemptToken);
                },
            });
            return;
        }

        const answer = evidence.status === "empty"
            ? "当前知识库为空，请先上传 txt 或 md 文档。"
            : "知识库中未检索到足够相关证据，建议换个问法，或在问题里带上文档名/关键词（如 A.txt、B.md）。";

        const assistantMessageId = saveMessage(req.user.id, sessionId, "assistant", answer);
        const metrics = {
            latency_ms: 0,
            prompt_tokens: 0,
            completion_tokens: estimateTokens(answer) || 1,
            total_tokens: estimateTokens(answer) || 1,
            model: "local-rag",
        };
        saveMessageMetric(assistantMessageId, metrics);
        sendSseText(res, answer);
        sendSseMetrics(res, metrics);
        getSSEWriter(res, { requestId: req.requestId }).done();
        res.end();
        if (idempotencyReserved) {
            completeChatIdempotency(scope, idempotencyKey, { text: answer, metrics }, assistantMessageId, idempotencyAttemptToken);
        }
        return;
    }

    // 通用聊天路径
    const currentIdempotency = idempotencyEnabled && idempotencyKey ? getChatIdempotency(scope, idempotencyKey) : null;
    if (!currentIdempotency?.user_message_id) {
        const userMessageId = saveMessage(req.user.id, sessionId, "user", message);
        if (idempotencyReserved) setChatIdempotencyUserMessage(scope, idempotencyKey, userMessageId, idempotencyAttemptToken);
    }
    await chatImpl(req.user.id, sessionId, message, resolvedImage, systemPrompt, temperature, res, {
        enableWebSearch,
        skipUserMessageSave: true,
        planMode,
        enableMemory,
        onComplete: (metrics, result = {}) => {
            if (metrics?.messageId) {
                saveMessageMetric(metrics.messageId, metrics);
            }
            sendSseMetrics(res, metrics);
            if (idempotencyReserved) {
                completeChatIdempotency(scope, idempotencyKey, { text: result.text || "", metrics }, result.messageId || metrics?.messageId, idempotencyAttemptToken);
            }
        },
        onFailure: (error) => {
            if (idempotencyReserved) failChatIdempotency(scope, idempotencyKey, error?.code || "CHAT_FAILED", idempotencyAttemptToken);
        },
    });
});

app.post("/chat/answer", requireAuth, createRateLimit({ scope: "chat-answer", windowMs: 60_000, max: 60 }), async (req, res) => {
    const {
        services: { resolveUserQuestion },
    } = getDependencies(req);
    const { questionId, answer } = req.body || {};

    if (!questionId || answer == null) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("questionId and answer are required"), { code: "INVALID_ARGUMENT", statusCode: 400 }), req.requestId));
    }

    const resolved = resolveUserQuestion(questionId, String(answer), req.requestContext);

    if (!resolved) {
        return res.status(404).json({
            ...toErrorEnvelope(Object.assign(new Error("问题已超时或已被回答"), { code: "QUESTION_NOT_FOUND", statusCode: 404 }), req.requestId),
            status: "already_answered",
        });
    }

    console.log(`[chat][answer] questionId=${questionId} answered`);

    return res.json({ ok: true, status: "accepted" });
});

// ═══════════════════════════════════════════════════════
// MCP Server 管理 API (Phase 3)
// ═══════════════════════════════════════════════════════

// 解析 MCP Server 配置里的 env 字段：值形如 "env:VAR_NAME" 时从 process.env 取值，
// 避免把 API key 明文写进 servers.json（servers.json 进 git，key 放 .env 才安全）。
function resolveMCPEnv(envConfig) {
    if (!envConfig || typeof envConfig !== "object") return undefined;
    const resolved = {};
    for (const [key, value] of Object.entries(envConfig)) {
        if (typeof value === "string" && value.startsWith("env:")) {
            const sourceKey = value.slice(4);
            const sourceValue = process.env[sourceKey];
            if (sourceValue !== undefined) resolved[key] = sourceValue;
        }
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
}

// 列出所有已注册的 MCP Server
app.get("/mcp/servers", requireAuth, requireAdmin, (req, res) => {
    const {
        db: { listMCPServerConfigs },
        mcp: toolRegistry,
    } = getDependencies(req);
    const scope = { userId: req.user.id, tenantId: req.user.tenantId };
    const scopedConfigs = listMCPServerConfigs(scope);
    const activeNames = toolRegistry.getMCPServerNames(scope);
    // 加载配置文件中的 server 列表
    let configServers = [];
    try {
        const configPath = path.join(import.meta.dirname, "mcp", "servers.json");
        const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        configServers = raw.servers || [];
    } catch {
        configServers = [];
    }

    // 动态注册的 MCP Server（不在 servers.json 里的）
    const dynamicNames = activeNames.filter(
        (n) => !configServers.some((s) => s.name === n)
    );
    const dynamicServers = dynamicNames
        .filter((name) => scopedConfigs.some((config) => config.name === name))
        .map((name) => ({
            name,
            type: "mcp",
            enabled: true,
            connected: true,
            scope: "user",
        }));

    const configWithStatus = configServers.map((s) => ({
        name: s.name,
        type: s.type,
        enabled: s.enabled !== false,
        connected: s.type === "builtin" || activeNames.includes(s.name),
        scope: "system",
        description: s.description || "",
    }));
    const userServers = scopedConfigs.map((s) => ({
        name: s.name,
        type: s.type,
        enabled: Boolean(s.enabled),
        connected: activeNames.includes(s.name),
        scope: "user",
        connection_status: s.connection_status,
        description: s.description || "",
    }));

    return res.json({ servers: [...configWithStatus, ...userServers, ...dynamicServers] });
});

// 添加/连接 MCP Server
app.post("/mcp/servers", requireAuth, requireAdmin, async (req, res) => {
    const {
        db: { insertMCPServerConfig, getMCPServerConfig, updateMCPServerConfigStatus },
        mcp: toolRegistry,
    } = getDependencies(req);
    const { name, command, args = [] } = req.body || {};
    if (!name || !command) {
        return res.status(400).json(toErrorEnvelope(Object.assign(new Error("name and command are required"), { code: "INVALID_ARGUMENT", statusCode: 400 }), req.requestId));
    }

    try {
        const safeConfig = validateMCPServerConfig({
            name,
            command,
            args,
            cwd: req.body?.cwd,
            env: req.body?.env,
        });
        const scope = { userId: req.user.id, tenantId: req.user.tenantId };
        await toolRegistry.registerMCPServer({ ...safeConfig, env: resolveMCPEnv(safeConfig.env), scope });
        insertMCPServerConfig({ ...safeConfig, env: safeConfig.env }, scope);

        // User-owned MCP configuration is stored in the scoped database table.
        // servers.json remains a read-only system seed and is never mutated by
        // an authenticated request.
        const ownedConfig = getMCPServerConfig(name, scope);
        if (ownedConfig) updateMCPServerConfigStatus(name, scope, true, "connected");
        return res.json({ ok: true, name, toolCount: toolRegistry.getMCPServerTools(name, scope).length });
    } catch (err) {
        const status = Number(err?.statusCode) || 500;
        return res.status(status).json(toErrorEnvelope(Object.assign(new Error("MCP connection failed"), { code: err?.code || "MCP_CONNECT_FAILED", statusCode: status, retryable: status >= 500 }), req.requestId));
    }
});

// 断开/移除 MCP Server
app.delete("/mcp/servers/:name", requireAuth, requireAdmin, async (req, res) => {
    const {
        db: { getMCPServerConfig, deleteMCPServerConfig },
        mcp: toolRegistry,
    } = getDependencies(req);
    const { name } = req.params;
    const scope = { userId: req.user.id, tenantId: req.user.tenantId };
    const config = getMCPServerConfig(name, scope);
    if (!config || config.scope_type !== "user") {
        return res.status(404).json(toErrorEnvelope(Object.assign(new Error("resource not found"), { code: "NOT_FOUND", statusCode: 404 }), req.requestId));
    }
    await toolRegistry.removeMCPServer(name, scope);
    deleteMCPServerConfig(name, scope);

    // The system seed in servers.json is read-only; user deletion only
    // removes the current user's scoped record above.

    return res.json({ ok: true });
});

// 列出某 MCP Server 的工具
app.get("/mcp/servers/:name/tools", requireAuth, requireAdmin, (req, res) => {
    const {
        db: { getMCPServerConfig },
        mcp: toolRegistry,
    } = getDependencies(req);
    const { name } = req.params;
    const scope = { userId: req.user.id, tenantId: req.user.tenantId };
    const config = getMCPServerConfig(name, scope);
    const isKnownSystemServer = toolRegistry.getMCPServerNames(scope).includes(name);
    if (!config && !isKnownSystemServer) {
        return res.status(404).json(toErrorEnvelope(Object.assign(new Error("resource not found"), { code: "NOT_FOUND", statusCode: 404 }), req.requestId));
    }
    const tools = toolRegistry.getMCPServerTools(name, scope);
    return res.json({ name, tools });
});

// 重新连接 MCP Server（从 servers.json 读取配置）
app.post("/mcp/servers/:name/connect", requireAuth, requireAdmin, async (req, res) => {
    const {
        db: { getMCPServerConfig, updateMCPServerConfigStatus },
        mcp: toolRegistry,
    } = getDependencies(req);
    const { name } = req.params;
    const scope = { userId: req.user.id, tenantId: req.user.tenantId };
    const ownedConfig = getMCPServerConfig(name, scope);

    // 从 servers.json 读取该 server 的配置
    const configPath = path.join(import.meta.dirname, "mcp", "servers.json");
    let serverConfig;
    if (!ownedConfig) {
        try {
            const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            serverConfig = (raw.servers || []).find((s) => s.name === name);
        } catch {
            return res.status(500).json(toErrorEnvelope(Object.assign(new Error("MCP configuration unavailable"), { code: "CONFIG_UNAVAILABLE", statusCode: 500 }), req.requestId));
        }
    }

    if (ownedConfig) {
        serverConfig = {
            name: ownedConfig.name,
            command: ownedConfig.command,
            args: ownedConfig.args,
            cwd: ownedConfig.cwd,
            env: ownedConfig.env_refs,
        };
    }
    if (!serverConfig || !serverConfig.command) {
        return res.status(404).json(toErrorEnvelope(Object.assign(new Error("resource not found"), { code: "NOT_FOUND", statusCode: 404 }), req.requestId));
    }

    try {
        const safeConfig = validateMCPServerConfig(serverConfig);
        await toolRegistry.registerMCPServer({
            ...safeConfig,
            env: resolveMCPEnv(safeConfig.env),
            scope,
        });

        // System seed configuration is read-only; user status is stored in DB.

        if (ownedConfig) updateMCPServerConfigStatus(name, scope, true, "connected");
        return res.json({ ok: true, name, toolCount: toolRegistry.getMCPServerTools(name, scope).length });
    } catch (err) {
        const status = Number(err?.statusCode) || 500;
        return res.status(status).json(toErrorEnvelope(Object.assign(new Error("MCP connection failed"), { code: err?.code || "MCP_CONNECT_FAILED", statusCode: status, retryable: status >= 500 }), req.requestId));
    }
});

// 断开 MCP Server（保留配置，标记 enabled: false 禁止自动重连）
app.post("/mcp/servers/:name/disconnect", requireAuth, requireAdmin, async (req, res) => {
    const {
        db: { getMCPServerConfig, updateMCPServerConfigStatus },
        mcp: toolRegistry,
    } = getDependencies(req);
    const { name } = req.params;
    const scope = { userId: req.user.id, tenantId: req.user.tenantId };
    const config = getMCPServerConfig(name, scope);
    if (!config || config.scope_type !== "user") {
        return res.status(404).json(toErrorEnvelope(Object.assign(new Error("resource not found"), { code: "NOT_FOUND", statusCode: 404 }), req.requestId));
    }
    await toolRegistry.removeMCPServer(name, scope);
    updateMCPServerConfigStatus(name, scope, false, "disconnected");

    // User-owned status is persisted in the scoped database record above.

    return res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════
// 记忆系统管理 API (Phase 4)
// ═══════════════════════════════════════════════════════

// 获取当前用户的记忆列表
app.get("/memory", requireAuth, (req, res) => {
    const memory = new MemoryService(req.user.id);
    const { limit = 50, memory_type } = req.query;

    try {
        const memoryTypes = memory_type ? [memory_type] : null;

        if (req.query.query || memoryTypes) {
            // 搜索模式（有查询词时按关键词搜索；仅类型筛选时传空查询走过滤）
            const results = memory.search(req.query.query || '', memoryTypes, Number(limit), 0.1);
            return res.json({ memories: results, count: results.length });
        }

        // 列表模式（无筛选条件）
        const items = memory.summary(Number(limit));
        return res.json({ memories: items, count: items.length });
    } catch (err) {
        return res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// 获取记忆统计
app.get("/memory/stats", requireAuth, (req, res) => {
    const memory = new MemoryService(req.user.id);
    try {
        return res.json(memory.stats());
    } catch (err) {
        return res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// 删除单条记忆
app.delete("/memory/:id", requireAuth, (req, res) => {
    const memory = new MemoryService(req.user.id);
    try {
        const deleted = memory.remove(Number(req.params.id));
        if (!deleted) {
            return res.status(404).json(toErrorEnvelope(Object.assign(new Error("memory not found"), { code: "NOT_FOUND", statusCode: 404 }), req.requestId));
        }
        return res.json({ ok: true });
    } catch (err) {
        return res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// 清空所有记忆
app.delete("/memory", requireAuth, (req, res) => {
    const memory = new MemoryService(req.user.id);
    try {
        const deleted = memory.forget("all");
        return res.json({ ok: true, deleted });
    } catch (err) {
        return res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

// 手动触发记忆巩固
app.post("/memory/consolidate", requireAuth, (req, res) => {
    const memory = new MemoryService(req.user.id);
    const { from_type = "working", to_type = "episodic", importance_threshold = 0.7 } = req.body || {};
    try {
        const result = memory.consolidate(from_type, to_type, importance_threshold);
        return res.json({ ok: true, ...result });
    } catch (err) {
        return res.status(500).json(toErrorEnvelope(Object.assign(new Error("request failed"), { code: "REQUEST_FAILED", statusCode: 500 }), req.requestId));
    }
});

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const statusCode = Number(err?.statusCode || err?.status || 500);
    return res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json(
        toErrorEnvelope(err, req.requestId)
    );
});

export { app };

// W3.2 残余（T5）：把"重启即丢失"的易失运行态在真实启动路径上显式告警，防止
// in-memory 存储被误当作持久层（用户在文档里问的"重启丢什么"要能在日志里自证）。
// - 上传配额：DURABLE_UPLOAD_QUOTA!=="true" 时 reservation/usage 只在内存 → 分片上传
//   预留与当日字节记账重启即清零；设 DURABLE_UPLOAD_QUOTA=true 走 SQLite 账本。
// - 知识库向量：rag tenantStores 是进程内 Map（vectorStore/indexedFiles/activeLargeFile），
//   无落盘重载 → 重启后检索索引清空，需重新上传文档（durable RAG 在 roadmap W6）。
// - 图片上传：images/store.js 内存 Map（TTL 30min）→ 重启清空已上传图片字节。
function warnVolatileRuntimeState() {
    if (process.env.DURABLE_UPLOAD_QUOTA !== "true") {
        console.warn("[startup] 上传配额为内存模式（DURABLE_UPLOAD_QUOTA 未设为 true）：分片上传预留与当日字节记账重启即清零。设为 DURABLE_UPLOAD_QUOTA=true 启用 SQLite 持久记账。");
    }
    // 当前无 durable RAG 开关，索引恒为进程内存态 —— 如实标注而非假装可持久。
    console.warn("[startup] 知识库向量索引为进程内内存态（无落盘重载）：服务重启后各用户检索索引清空，需重新上传文档。持久化 RAG 见 roadmap W6。");
    console.warn("[startup] 图片上传存储为进程内内存态（TTL 30min）：服务重启后尚未随消息持久化的已上传图片字节清空。");
}

export async function startServer({ port = PORT, autoConnectMCP = true } = {}) {
    assertAuthSecurityConfig();
    assertProductionSecurityConfig();
    initDB();
    warnVolatileRuntimeState();
    const stopUploadQuotaCleanup = startUploadQuotaCleanup({
        onExpire: (released) => console.log(`[upload-quota] released ${released} expired reservation(s)`),
    });
    if (autoConnectMCP) {
        let persistedServers = [];
        try {
            const configPath = path.join(import.meta.dirname, "mcp", "servers.json");
            const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            persistedServers = (raw.servers || []).filter(
                (s) => s.type === "mcp" && s.enabled !== false && s.command
            );
        } catch { /* config file missing or invalid, skip */ }

        for (const server of persistedServers) {
            try {
                await toolRegistry.registerMCPServer({
                    name: server.name,
                    command: server.command,
                    args: server.args || [],
                    cwd: server.cwd,
                    env: resolveMCPEnv(server.env),
                });
            } catch (err) {
                console.warn(`[mcp] auto-connect "${server.name}" failed: ${err.message}`);
            }
        }
    }
    return new Promise((resolve) => {
        const server = app.listen(port, () => {
            console.log(`Backend running at http://localhost:${port}`);
            const close = server.close.bind(server);
            server.close = (callback) => {
                stopUploadQuotaCleanup();
                return close(callback);
            };
            resolve(server);
        });
    });
}
