import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import fse from "fs-extra";
import {
    initDB,
    saveMessage,
    getHistoryMessages,
    getMessageStats,
    createSession,
    getSessions,
    renameSession,
    removeSession,
    toggleSessionPin,
    createUser,
    getUserByUsername,
    getUserById,
    saveMessageMetric,
    createBranchSession,
    getSessionById,
    getRecentObservability,
    removeMessagePair,
} from "./db/index.js";
import { chatWithStream } from "./services/chat.js";
import { resolveUserQuestion } from "./mcp/tools.js";
import {
    uploadMiddleware,
    processAndStoreDocument,
    retrieveKnowledgeEvidence,
    getLatestUploadedSource,
    activeLargeFile
} from "./rag/index.js";
import { saveUploadedImage, getUploadedImageDataUrl } from "./images/store.js";
import {
    hashPassword,
    verifyPassword,
    issueAuthToken,
    verifyAuthToken,
    parseBearerToken,
} from "./auth.js";

const app = express();
const PORT = process.env.PORT || 3000;
const CHUNK_UPLOAD_ROOT = path.join(process.cwd(), "tmp", "chunks");
const MERGED_UPLOAD_ROOT = path.join(process.cwd(), "tmp", "merged");
const LONG_CONTEXT_MODEL = process.env.QWEN_LONG_CONTEXT_MODEL || "qwen-long";
const LARGE_FILE_SEGMENT_SIZE = Number(process.env.LARGE_FILE_SEGMENT_SIZE || 1800);
const LARGE_FILE_SEGMENT_OVERLAP = Number(process.env.LARGE_FILE_SEGMENT_OVERLAP || 240);
const LARGE_FILE_MAX_SEGMENTS = Number(process.env.LARGE_FILE_MAX_SEGMENTS || 16);
const LARGE_FILE_MAX_CONTEXT_CHARS = Number(process.env.LARGE_FILE_MAX_CONTEXT_CHARS || 120000);
let largeFileSegmentCache = {
    key: "",
    segments: []
};
const chunkUploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 8 * 1024 * 1024,
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

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

initDB();

function requireAuth(req, res, next) {
    const token = parseBearerToken(req);
    const payload = verifyAuthToken(token);

    if (!payload?.sub) {
        return res.status(401).json({
            ok: false,
            message: "unauthorized",
        });
    }

    const user = getUserById(payload.sub);
    if (!user) {
        return res.status(401).json({
            ok: false,
            message: "invalid user",
        });
    }

    req.user = {
        id: Number(user.id),
        username: user.username,
    };
    return next();
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
    return path.basename(String(fileName || "")).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildMergedFilePath(hash, fileName) {
    const safeName = sanitizeUploadFileName(fileName || `${hash}.txt`);
    return path.join(MERGED_UPLOAD_ROOT, `${hash}-${safeName}`);
}

async function appendChunkToStream(writeStream, chunkPath) {
    await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(chunkPath);
        readStream.on("error", reject);
        writeStream.on("error", reject);
        readStream.on("end", resolve);
        readStream.pipe(writeStream, { end: false });
    });
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

function getCachedLargeFileSegments(largeFile) {
    const cacheKey = `${String(largeFile?.fileName || "")}:${String(largeFile?.updatedAt || "")}:${Number(largeFile?.sizeBytes || 0)}`;

    if (cacheKey && largeFileSegmentCache.key === cacheKey && largeFileSegmentCache.segments.length > 0) {
        return largeFileSegmentCache.segments;
    }

    const segments = splitLargeFileContent(largeFile?.content || "");
    largeFileSegmentCache = {
        key: cacheKey,
        segments
    };

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

function buildLargeFileContext(largeFile, query) {
    const segments = getCachedLargeFileSegments(largeFile);
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
    res.write(`data: ${JSON.stringify({ text })}\n\n`);
}

function sendSseMetrics(res, metrics) {
    res.write(`data: ${JSON.stringify({ type: "metrics", metrics })}\n\n`);
}

app.get("/ping", (req, res) => {
    res.json({
        ok: true,
        message: "pong",
        time: new Date().toISOString()
    });
});

app.post("/auth/register", (req, res) => {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (username.length < 3 || password.length < 6) {
        return res.status(400).json({
            ok: false,
            message: "用户名至少 3 位，密码至少 6 位",
        });
    }

    if (getUserByUsername(username)) {
        return res.status(409).json({
            ok: false,
            message: "用户名已存在",
        });
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

app.post("/auth/login", (req, res) => {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (!username || !password) {
        return res.status(400).json({
            ok: false,
            message: "username and password are required",
        });
    }

    const user = getUserByUsername(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({
            ok: false,
            message: "用户名或密码错误",
        });
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

app.get("/auth/me", requireAuth, (req, res) => {
    return res.json({
        ok: true,
        user: req.user,
    });
});

app.get("/sessions", requireAuth, (req, res) => {
    const sessions = getSessions(req.user.id);

    return res.json({
        ok: true,
        sessions
    });
});

app.post("/sessions", requireAuth, (req, res) => {
    const { title } = req.body || {};
    const id = createSession(req.user.id, title || "新对话");

    return res.json({
        ok: true,
        id
    });
});

app.patch("/sessions/:id", requireAuth, (req, res) => {
    const sessionId = Number(req.params.id);
    const { title } = req.body || {};

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json({
            ok: false,
            message: "invalid session id"
        });
    }

    if (!String(title || "").trim()) {
        return res.status(400).json({
            ok: false,
            message: "title is required"
        });
    }

    const result = renameSession(req.user.id, sessionId, title);
    if (!result?.changes) {
        return res.status(404).json({
            ok: false,
            message: "session not found"
        });
    }

    return res.json({
        ok: true
    });
});

app.delete("/sessions/:id", requireAuth, (req, res) => {
    const sessionId = Number(req.params.id);

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json({
            ok: false,
            message: "invalid session id"
        });
    }

    const result = removeSession(req.user.id, sessionId);
    if (!result?.changes) {
        return res.status(404).json({
            ok: false,
            message: "session not found"
        });
    }

    return res.json({
        ok: true
    });
});

app.patch("/sessions/:id/pin", requireAuth, (req, res) => {
    const sessionId = Number(req.params.id);
    const pinned = Boolean(req.body?.pinned);

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json({
            ok: false,
            message: "invalid session id"
        });
    }

    const result = toggleSessionPin(req.user.id, sessionId, pinned);
    if (!result?.changes) {
        return res.status(404).json({
            ok: false,
            message: "session not found"
        });
    }

    return res.json({
        ok: true
    });
});

app.get("/sessions/:id/messages", requireAuth, (req, res) => {
    const sessionId = Number(req.params.id);

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json({
            ok: false,
            message: "invalid session id"
        });
    }

    const history = getHistoryMessages(req.user.id, sessionId, 100);
    return res.json({
        ok: true,
        messages: history
    });
});

app.delete("/sessions/:id/messages/:messageId/pair", requireAuth, (req, res) => {
    const sessionId = Number(req.params.id);
    const messageId = Number(req.params.messageId);

    if (!Number.isInteger(sessionId) || sessionId <= 0 || !Number.isInteger(messageId) || messageId <= 0) {
        return res.status(400).json({
            ok: false,
            message: "invalid session id or message id",
        });
    }

    try {
        const result = removeMessagePair(req.user.id, sessionId, messageId);
        return res.json({
            ok: true,
            ...result,
        });
    } catch (error) {
        return res.status(400).json({
            ok: false,
            message: error.message || "remove message pair failed",
        });
    }
});

app.post("/sessions/:id/branch", requireAuth, (req, res) => {
    const sourceSessionId = Number(req.params.id);
    const fromMessageIdRaw = req.body?.from_message_id;
    const fromMessageId = fromMessageIdRaw == null ? null : Number(fromMessageIdRaw);
    const title = String(req.body?.title || "").trim();
    const editedContent = String(req.body?.edited_content || "");

    if (!Number.isInteger(sourceSessionId) || sourceSessionId <= 0) {
        return res.status(400).json({
            ok: false,
            message: "invalid source session id"
        });
    }

    if (fromMessageId != null && (!Number.isInteger(fromMessageId) || fromMessageId <= 0)) {
        return res.status(400).json({
            ok: false,
            message: "invalid from message id"
        });
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
        return res.status(400).json({
            ok: false,
            message: error.message || "branch failed",
        });
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

app.post("/test-db", requireAuth, (req, res) => {
    const { session_id, role, content } = req.body || {};
    const sessionId = Number(session_id);

    if (!Number.isInteger(sessionId) || sessionId <= 0 || !role || !content) {
        return res.status(400).json({
            ok: false,
            message: "session_id, role and content are required"
        });
    }

    saveMessage(req.user.id, sessionId, role, content);
    const history = getHistoryMessages(req.user.id, sessionId, 20);

    return res.json({
        ok: true,
        history
    });
});

app.post("/upload", requireAuth, uploadMiddleware, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                ok: false,
                message: "file is required"
            });
        }

        const result = await processAndStoreDocument(
            req.file.buffer,
            req.file.originalname
        );

        return res.json({
            ok: true,
            message: "document indexed",
            data: result
        });
    } catch (error) {
        const message = error.message || "upload failed";
        const statusCode = /仅支持上传|file type|invalid file/i.test(message)
            ? 400
            : 500;

        return res.status(statusCode).json({
            ok: false,
            message
        });
    }
});

app.post("/upload/check", requireAuth, async (req, res) => {
    try {
        const { hash, totalChunks, fileName } = req.body || {};
        const normalizedHash = String(hash || "").trim();
        const normalizedTotalChunks = Number(totalChunks);

        if (!normalizedHash) {
            return res.status(400).json({
                ok: false,
                message: "hash is required",
            });
        }

        await fse.ensureDir(CHUNK_UPLOAD_ROOT);
        await fse.ensureDir(MERGED_UPLOAD_ROOT);

        const mergedFilePath = buildMergedFilePath(normalizedHash, fileName);
        const mergedExists = await fse.pathExists(mergedFilePath);

        const uploadedChunks = [];
        const hashDir = path.join(CHUNK_UPLOAD_ROOT, normalizedHash);
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
        const statusCode = /required|invalid/i.test(message) ? 400 : 500;
        return res.status(statusCode).json({
            ok: false,
            message,
        });
    }
});

app.post("/upload/chunk", requireAuth, (req, res) => {
    chunkUploadMiddleware(req, res, async (error) => {
        if (error) {
            return res.status(400).json({
                ok: false,
                message: error?.message || "chunk upload failed",
            });
        }

        try {
            const { hash, chunkIndex, fileName, totalChunks } = req.body || {};
            const normalizedHash = String(hash || "").trim();
            const normalizedChunkIndex = Number(chunkIndex);
            const normalizedTotalChunks = Number(totalChunks);

            if (!normalizedHash || !Number.isInteger(normalizedChunkIndex) || normalizedChunkIndex < 0) {
                return res.status(400).json({
                    ok: false,
                    message: "invalid hash or chunk index",
                });
            }

            if (!req.file?.buffer) {
                return res.status(400).json({
                    ok: false,
                    message: "chunk is required",
                });
            }

            await fse.ensureDir(CHUNK_UPLOAD_ROOT);
            const hashDir = path.join(CHUNK_UPLOAD_ROOT, normalizedHash);
            await fse.ensureDir(hashDir);

            const chunkPath = path.join(hashDir, `${normalizedChunkIndex}.part`);
            await fse.writeFile(chunkPath, req.file.buffer);

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
                totalChunks: Number.isInteger(normalizedTotalChunks) && normalizedTotalChunks > 0
                    ? normalizedTotalChunks
                    : undefined,
                uploadedChunks,
            };

            return res.json({
                ok: true,
                data,
            });
        } catch (saveError) {
            return res.status(500).json({
                ok: false,
                message: saveError?.message || "save chunk failed",
            });
        }
    });
});

app.post("/upload/merge", requireAuth, async (req, res) => {
    try {
        const { hash, fileName, totalChunks } = req.body || {};
        const normalizedHash = String(hash || "").trim();
        const normalizedFileName = String(fileName || "").trim();
        const normalizedTotalChunks = Number(totalChunks);

        if (!normalizedHash || !normalizedFileName || !Number.isInteger(normalizedTotalChunks) || normalizedTotalChunks <= 0) {
            return res.status(400).json({
                ok: false,
                message: "hash, fileName and totalChunks are required",
            });
        }

        const hashDir = path.join(CHUNK_UPLOAD_ROOT, normalizedHash);
        if (!await fse.pathExists(hashDir)) {
            return res.status(404).json({
                ok: false,
                message: "chunk directory not found",
            });
        }

        const missingChunks = [];
        for (let index = 0; index < normalizedTotalChunks; index += 1) {
            const chunkPath = path.join(hashDir, `${index}.part`);
            if (!await fse.pathExists(chunkPath)) {
                missingChunks.push(index);
            }
        }

        if (missingChunks.length > 0) {
            return res.status(409).json({
                ok: false,
                message: "missing chunks",
                missing_chunks: missingChunks,
            });
        }

        await fse.ensureDir(MERGED_UPLOAD_ROOT);
        const mergedFilePath = buildMergedFilePath(normalizedHash, normalizedFileName);
        await fse.remove(mergedFilePath);

        const writeStream = fs.createWriteStream(mergedFilePath, { flags: "a" });
        for (let index = 0; index < normalizedTotalChunks; index += 1) {
            const chunkPath = path.join(hashDir, `${index}.part`);
            await appendChunkToStream(writeStream, chunkPath);
        }
        await new Promise((resolve, reject) => {
            writeStream.on("error", reject);
            writeStream.end(resolve);
        });

        const mergedBuffer = await fse.readFile(mergedFilePath);
        const ragResult = await processAndStoreDocument(mergedBuffer, normalizedFileName);
        await fse.remove(hashDir);

        const data = {
            ...ragResult,
            hash: normalizedHash,
            mergedFilePath,
        };

        return res.json({
            ok: true,
            message: "document indexed",
            data,
        });
    } catch (error) {
        return res.status(500).json({
            ok: false,
            message: error?.message || "merge chunk upload failed",
        });
    }
});

app.post("/upload-image", requireAuth, (req, res) => {
    imageUploadMiddleware(req, res, (error) => {
        if (error) {
            const message = error.message || "image upload failed";
            const statusCode = /仅支持图片上传|file type|invalid file/i.test(message)
                ? 400
                : /File too large/i.test(message)
                    ? 413
                    : 500;

            res.status(statusCode).json({
                ok: false,
                message,
            });
            return;
        }

        if (!req.file?.buffer) {
            res.status(400).json({
                ok: false,
                message: "image is required",
            });
            return;
        }

        const id = saveUploadedImage(req.file.buffer, req.file.mimetype || "image/jpeg");

        res.json({
            ok: true,
            id,
        });
    });
});

app.post("/chat", requireAuth, async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const {
        session_id,
        message,
        image,
        image_id,
        enable_web_search,
        systemPrompt,
        temperature
    } = req.body || {};
    const sessionId = Number(session_id);
    const enableWebSearch = enable_web_search === true;
    const resolvedImage = image || getUploadedImageDataUrl(image_id);

    if (image_id && !resolvedImage) {
        res.write(
            `data: ${JSON.stringify({ error: "image_id is invalid or expired, please re-upload" })}\n\n`
        );
        res.end();
        return;
    }

    if (!Number.isInteger(sessionId) || sessionId <= 0 || (!message && !resolvedImage)) {
        res.write(
            `data: ${JSON.stringify({ error: "session_id and message or image are required" })}\n\n`
        );
        res.end();
        return;
    }

    if (!getSessionById(req.user.id, sessionId)) {
        res.write(
            `data: ${JSON.stringify({ error: "session not found" })}\n\n`
        );
        res.end();
        return;
    }

    if (isDbCountIntent(message)) {
        saveMessage(req.user.id, sessionId, "user", message);
        const stats = getMessageStats(req.user.id);
        const answer = `截至目前，数据库消息共 ${stats.total} 条（user: ${stats.user_count}，assistant: ${stats.assistant_count}）。`;
        const assistantMessageId = saveMessage(req.user.id, sessionId, "assistant", answer);
        const metrics = {
            latency_ms: 0,
            prompt_tokens: 0,
            completion_tokens: Math.max(1, Math.ceil(String(answer).length / 4)),
            total_tokens: Math.max(1, Math.ceil(String(answer).length / 4)),
            model: "local-stats",
        };
        saveMessageMetric(assistantMessageId, metrics);

        sendSseText(res, answer);
        sendSseMetrics(res, metrics);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
    }

    if (isKnowledgeIntent(message) && !resolvedImage) {
        const shouldUseLargeContext = mentionsActiveLargeFile(message, activeLargeFile);

        if (shouldUseLargeContext) {
            saveMessage(req.user.id, sessionId, "user", message);

            const contextPayload = buildLargeFileContext(activeLargeFile, message);
            const longContextPrompt = `你是一个智能助手。请仅根据给定文档片段回答问题，不得编造文档中不存在的信息；若片段不足以支持结论，请明确说明“证据不足，需补充片段”。\n\n文档名：${activeLargeFile.fileName}\n片段总数：${contextPayload.totalSegments}\n本轮命中片段：${contextPayload.selectedCount}\n\n参考片段：\n${contextPayload.contextText}\n\n用户问题：${message}`;
            console.log(
                `[chat][large_file] source=${activeLargeFile.fileName} segments=${contextPayload.selectedCount}/${contextPayload.totalSegments} chars=${contextPayload.selectedChars} model=${LONG_CONTEXT_MODEL}`
            );

            await chatWithStream(req.user.id, sessionId, longContextPrompt, resolvedImage, systemPrompt, temperature, res, {
                enableWebSearch: false,
                skipUserMessageSave: true,
                forceModel: LONG_CONTEXT_MODEL,
                onComplete: (metrics) => {
                    if (metrics?.messageId) {
                        saveMessageMetric(metrics.messageId, metrics);
                    }
                    sendSseMetrics(res, metrics);
                },
            });
            return;
        }

        const preferredSource = refersToLatestUpload(message)
            ? getLatestUploadedSource()
            : "";
        const evidence = await retrieveKnowledgeEvidence(message, {
            topK: 12,
            returnK: 6,
            preferredSource
        });
        saveMessage(req.user.id, sessionId, "user", message);

        if (evidence.status === "ok") {
            const context = evidence.items
                .map((item) => String(item?.content || "").trim())
                .filter(Boolean)
                .join("\n\n");

            const enhancedPrompt = `你是一个智能助手。请严格根据以下检索到的参考资料，回答用户的问题。如果资料不包含相关答案，请告知用户。\n\n参考资料：\n${context}\n\n用户问题：${message}`;

            await chatWithStream(req.user.id, sessionId, enhancedPrompt, resolvedImage, systemPrompt, temperature, res, {
                enableWebSearch: false,
                skipUserMessageSave: true,
                onComplete: (metrics) => {
                    if (metrics?.messageId) {
                        saveMessageMetric(metrics.messageId, metrics);
                    }
                    sendSseMetrics(res, metrics);
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
            completion_tokens: Math.max(1, Math.ceil(String(answer).length / 4)),
            total_tokens: Math.max(1, Math.ceil(String(answer).length / 4)),
            model: "local-rag",
        };
        saveMessageMetric(assistantMessageId, metrics);
        sendSseText(res, answer);
        sendSseMetrics(res, metrics);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
    }

    await chatWithStream(req.user.id, sessionId, message, resolvedImage, systemPrompt, temperature, res, {
        enableWebSearch,
        onComplete: (metrics) => {
            if (metrics?.messageId) {
                saveMessageMetric(metrics.messageId, metrics);
            }
            sendSseMetrics(res, metrics);
        },
    });
});

app.post("/chat/answer", requireAuth, async (req, res) => {
    const { questionId, answer } = req.body || {};

    if (!questionId || answer == null) {
        return res.status(400).json({ ok: false, message: "questionId and answer are required" });
    }

    const resolved = resolveUserQuestion(questionId, String(answer));

    if (!resolved) {
        return res.status(404).json({
            ok: false,
            status: "already_answered",
            message: "问题已超时或已被回答",
        });
    }

    console.log(`[chat][answer] questionId=${questionId} answered`);

    return res.json({ ok: true, status: "accepted" });
});

app.listen(PORT, () => {
    console.log(`Backend running at http://localhost:${PORT}`);
});
