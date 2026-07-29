import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { uploadFile, uploadImage } from '../api/chat';

const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024;
const TARGET_IMAGE_BYTES = 2 * 1024 * 1024;

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('图片读取失败'));
        };
        img.src = objectUrl;
    });
}

async function compressImageIfNeeded(file) {
    if (file.size <= TARGET_IMAGE_BYTES) {
        return file;
    }

    const image = await loadImage(file);
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const context = canvas.getContext('2d');
    if (!context) {
        return file;
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    let quality = 0.88;
    let blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

    while (blob && blob.size > TARGET_IMAGE_BYTES && quality > 0.5) {
        quality -= 0.08;
        blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    }

    if (!blob) {
        return file;
    }

    const fallbackName = String(file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${fallbackName}.jpg`, { type: 'image/jpeg' });
}

export default function ChatInput() {
    const [value, setValue] = useState('');
    const [uploadStatus, setUploadStatus] = useState('');
    const [uploadProgress, setUploadProgress] = useState(null);
    const [isListening, setIsListening] = useState(false);
    const textareaRef = useRef(null);
    const docFileInputRef = useRef(null);
    const imageFileInputRef = useRef(null);
    const recognitionRef = useRef(null);
    const previewUrlRef = useRef(null);
    const draftTimerRef = useRef(null);
    const sendMessage = useChatStore((state) => state.sendMessage);
    const currentSessionId = useChatStore((state) => state.currentSessionId);
    const enableWebSearch = useChatStore((state) => state.enableWebSearch);
    const setEnableWebSearch = useChatStore((state) => state.setEnableWebSearch);
    const planMode = useChatStore((state) => state.planMode);
    const setPlanMode = useChatStore((state) => state.setPlanMode);
    const selectedImage = useChatStore((state) => state.selectedImage);
    const setSelectedImage = useChatStore((state) => state.setSelectedImage);
    const clearSelectedImage = useChatStore((state) => state.clearSelectedImage);
    const isTyping = useChatStore((state) => state.isTyping);
    const stopMessageStream = useChatStore((state) => state.stopMessageStream);
    const retryLastFailedMessage = useChatStore((state) => state.retryLastFailedMessage);
    const lastFailedUserMessage = useChatStore((state) => state.lastFailedUserMessage);
    const setCurrentDraft = useChatStore((state) => state.setCurrentDraft);
    const clearCurrentDraft = useChatStore((state) => state.clearCurrentDraft);
    const getCurrentDraft = useChatStore((state) => state.getCurrentDraft);

    useEffect(() => {
        setValue(getCurrentDraft());
    }, [currentSessionId, getCurrentDraft]);

    useEffect(() => {
        if (!currentSessionId) {
            return undefined;
        }

        if (draftTimerRef.current) {
            clearTimeout(draftTimerRef.current);
        }

        draftTimerRef.current = setTimeout(() => {
            setCurrentDraft(value);
            draftTimerRef.current = null;
        }, 320);

        return () => {
            if (draftTimerRef.current) {
                clearTimeout(draftTimerRef.current);
                draftTimerRef.current = null;
            }
        };
    }, [value, currentSessionId, setCurrentDraft]);

    useEffect(() => {
        const element = textareaRef.current;

        if (!element) {
            return;
        }

        element.style.height = 'auto';
        element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
    }, [value]);

    useEffect(() => {
        if (!uploadStatus) {
            return undefined;
        }

        const timer = setTimeout(() => {
            setUploadStatus('');
        }, 2400);

        return () => {
            clearTimeout(timer);
        };
    }, [uploadStatus]);

    useEffect(() => {
        const currentPreviewUrl = selectedImage?.previewUrl || null;

        if (previewUrlRef.current && previewUrlRef.current !== currentPreviewUrl) {
            URL.revokeObjectURL(previewUrlRef.current);
        }

        previewUrlRef.current = currentPreviewUrl;
    }, [selectedImage]);

    useEffect(() => () => {
        if (recognitionRef.current) {
            recognitionRef.current.stop();
        }

        if (draftTimerRef.current) {
            clearTimeout(draftTimerRef.current);
            draftTimerRef.current = null;
        }

        const previewUrl = previewUrlRef.current;
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
        }
    }, []);

    const handleSend = async () => {
        const text = value.trim();
        const hasImage = Boolean(selectedImage?.imageId);

        if ((!text && !hasImage) || isTyping) {
            return;
        }

        setValue('');
        clearCurrentDraft();
        await sendMessage(text || '请帮我描述这张图片。', { enableWebSearch });
    };

    const handleKeyDown = async (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            await handleSend();
        }
    };

    const handleUploadClick = () => {
        docFileInputRef.current?.click();
    };

    const handleImageUploadClick = () => {
        imageFileInputRef.current?.click();
    };

    const handleFileChange = async (event) => {
        const [file] = event.target.files || [];

        if (!file) {
            return;
        }

        try {
            setUploadStatus('上传中...');
            await uploadFile(file);
            setUploadStatus(`上传成功: ${file.name}`);
        } catch (error) {
            setUploadStatus(`上传失败: ${error.message || '请重试'}`);
        } finally {
            event.target.value = '';
        }
    };

    const handleClearImage = () => {
        const previewUrl = selectedImage?.previewUrl;
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
        }

        previewUrlRef.current = null;

        clearSelectedImage();
    };

    const handleImageChange = async (event) => {
        const [file] = event.target.files || [];

        if (!file) {
            return;
        }

        try {
            if (!String(file.type || '').startsWith('image/')) {
                setUploadStatus('请选择图片文件。');
                return;
            }

            if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
                setUploadStatus('图片过大，请选择 8MB 以内的图片。');
                return;
            }

            setUploadStatus('正在上传图片...');
            setUploadProgress(0);
            const previousPreviewUrl = selectedImage?.previewUrl;
            if (previousPreviewUrl) {
                URL.revokeObjectURL(previousPreviewUrl);
            }

            const preparedFile = await compressImageIfNeeded(file);
            const uploaded = await uploadImage(preparedFile, {
                retryCount: 1,
                onProgress: (progressEvent) => {
                    if (!progressEvent?.lengthComputable || progressEvent.total <= 0) {
                        return;
                    }

                    const percentage = Math.round((progressEvent.loaded / progressEvent.total) * 100);
                    setUploadProgress(Math.max(0, Math.min(100, percentage)));
                },
            });
            const imageId = uploaded?.id;

            if (!imageId) {
                setUploadStatus('图片上传失败，请重试。');
                return;
            }

            const previewUrl = URL.createObjectURL(file);
            previewUrlRef.current = previewUrl;
            setSelectedImage({
                imageId,
                previewUrl,
                fileName: file.name,
            });
            setUploadStatus(`已选择图片: ${file.name}`);
            setUploadProgress(null);
        } catch (error) {
            setUploadStatus(`图片处理失败: ${error.message || '请重试'}`);
            setUploadProgress(null);
        } finally {
            event.target.value = '';
        }
    };

    const handleVoiceInput = () => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            setUploadStatus('当前浏览器不支持原生语音识别。');
            return;
        }

        if (isListening && recognitionRef.current) {
            recognitionRef.current.stop();
            return;
        }

        const recognition = new SpeechRecognition();
        recognition.lang = 'zh-CN';
        recognition.continuous = false;
        recognition.interimResults = false;

        recognition.onstart = () => {
            setIsListening(true);
        };

        recognition.onresult = (event) => {
            const transcript = Array.from(event.results || [])
                .map((result) => result?.[0]?.transcript || '')
                .join('')
                .trim();

            if (!transcript) {
                return;
            }

            setValue((prev) => (prev ? `${prev}${transcript}` : transcript));
        };

        recognition.onerror = () => {
            setUploadStatus('语音识别失败，请重试。');
            setIsListening(false);
        };

        recognition.onend = () => {
            setIsListening(false);
        };

        recognitionRef.current = recognition;
        recognition.start();
    };

    return (
        <div className="border-t border-[var(--panel-border)] bg-[var(--app-bg)]/95 px-2 pb-3 pt-3 backdrop-blur sm:px-4 sm:pb-4">
            <div className="mx-auto w-full max-w-4xl">
                {isTyping && (
                    <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 py-1 text-xs text-[var(--text-muted)]">
                        <span>AI 正在思考</span>
                        <span className="inline-flex items-center gap-1">
                            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-500 [animation-delay:0ms]" />
                            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-500 [animation-delay:120ms]" />
                            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-500 [animation-delay:240ms]" />
                        </span>
                    </div>
                )}

                {!isTyping && lastFailedUserMessage && (
                    <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                        <span>上次发送失败</span>
                        <button
                            type="button"
                            onClick={retryLastFailedMessage}
                            className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-200"
                        >
                            立即重试
                        </button>
                    </div>
                )}

                {uploadStatus && (
                    <div className="mb-2 inline-flex max-w-full rounded-full border border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 py-1 text-xs text-[var(--text-muted)]">
                        <span className="truncate">{uploadStatus}{typeof uploadProgress === 'number' ? ` ${uploadProgress}%` : ''}</span>
                    </div>
                )}

                {selectedImage && (
                    <div className="mb-3 flex items-start gap-2 rounded-xl border border-[var(--panel-border)] bg-[var(--panel-bg)] p-2">
                        <img
                            src={selectedImage.previewUrl}
                            alt="已选择图片"
                            className="h-16 w-16 rounded-lg border border-[var(--panel-border)] object-cover sm:h-20 sm:w-20"
                        />
                        <button
                            type="button"
                            onClick={handleClearImage}
                            className="rounded-md border border-[var(--panel-border)] bg-[var(--panel-soft)] px-2 py-1 text-xs text-[var(--text-main)] transition hover:opacity-95"
                        >
                            X
                        </button>
                    </div>
                )}

                <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-bg)] p-2.5 shadow-[0_12px_30px_rgba(15,23,42,0.06)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.35)]">
                    <p className="mb-2 text-[11px] text-[var(--text-muted)]">快捷键: Ctrl/⌘+K 聚焦输入, Ctrl/⌘+/ 查看帮助</p>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={handleUploadClick}
                            className="h-9 w-9 shrink-0 rounded-lg border border-[var(--panel-border)] bg-[var(--panel-soft)] text-base text-[var(--text-main)] transition hover:opacity-95"
                            title="上传 txt 或 md 文档"
                        >
                            <svg viewBox="0 0 24 24" className="mx-auto h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                                <path d="M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5Z" />
                            </svg>
                            <span className="sr-only">上传文档</span>
                        </button>
                        <input
                            ref={docFileInputRef}
                            type="file"
                            accept=".txt,.md"
                            className="hidden"
                            onChange={handleFileChange}
                        />

                        <button
                            type="button"
                            onClick={handleImageUploadClick}
                            className="h-9 w-9 shrink-0 rounded-lg border border-[var(--panel-border)] bg-[var(--panel-soft)] text-base text-[var(--text-main)] transition hover:opacity-95"
                            title="上传图片"
                        >
                            <svg viewBox="0 0 24 24" className="mx-auto h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                                <rect x="3.5" y="5" width="17" height="14" rx="2" />
                                <circle cx="9" cy="10" r="1.5" />
                                <path d="m20.5 16-4.2-4.2a1 1 0 0 0-1.4 0L9 17.7" />
                            </svg>
                            <span className="sr-only">上传图片</span>
                        </button>
                        <input
                            ref={imageFileInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={handleImageChange}
                        />

                        <button
                            type="button"
                            onClick={handleVoiceInput}
                            className={`h-9 w-9 shrink-0 rounded-lg border border-[var(--panel-border)] bg-[var(--panel-soft)] text-base text-[var(--text-main)] transition hover:opacity-95 ${isListening ? 'animate-pulse text-red-500' : ''}`}
                            title="语音输入"
                        >
                            <svg viewBox="0 0 24 24" className="mx-auto h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                                <rect x="9" y="3" width="6" height="11" rx="3" />
                                <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" />
                            </svg>
                            <span className="sr-only">语音输入</span>
                        </button>

                        <button
                            type="button"
                            onClick={() => setEnableWebSearch(!enableWebSearch)}
                            className={`h-9 rounded-lg border px-3 text-xs font-semibold transition outline-none ${enableWebSearch
                                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-100'
                                : 'border-[var(--panel-border)] bg-[var(--panel-soft)] text-[var(--text-muted)]'
                                }`}
                            title="是否启用联网搜索"
                        >
                            联网: {enableWebSearch ? '开' : '关'}
                        </button>

                        <button
                            type="button"
                            onClick={() => setPlanMode(!planMode)}
                            className={`h-9 rounded-lg border px-3 text-xs font-semibold transition outline-none ${planMode
                                ? 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-900/30 dark:text-violet-100'
                                : 'border-[var(--panel-border)] bg-[var(--panel-soft)] text-[var(--text-muted)]'
                                }`}
                            title="先列出计划再执行"
                        >
                            🗓 Plan: {planMode ? '开' : '关'}
                        </button>
                    </div>

                    <div className="flex items-end gap-2 sm:gap-3">
                        <textarea
                            id="chat-input-textarea"
                            ref={textareaRef}
                            className="min-h-12 max-h-40 flex-1 resize-none rounded-xl border border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 py-2 text-sm text-[var(--text-main)] outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200 dark:focus:border-slate-500 dark:focus:ring-slate-700"
                            placeholder="给 AI 发送消息，Enter 发送，Shift+Enter 换行"
                            value={value}
                            onChange={(event) => {
                                setValue(event.target.value);
                            }}
                            onKeyDown={handleKeyDown}
                            aria-keyshortcuts="Enter Shift+Enter Control+K Meta+K"
                        />
                        <button
                            type="button"
                            disabled={isTyping}
                            onClick={handleSend}
                            className="h-11 rounded-xl bg-[#111827] px-4 text-sm font-semibold text-white transition hover:bg-[#0b1220] disabled:cursor-not-allowed disabled:bg-slate-400"
                        >
                            {isTyping ? '思考中...' : '发送'}
                        </button>

                        {isTyping && (
                            <button
                                type="button"
                                onClick={stopMessageStream}
                                className="h-11 rounded-xl border border-[var(--panel-border)] bg-[var(--panel-bg)] px-3 text-sm font-medium text-[var(--text-main)] transition hover:opacity-95"
                            >
                                停止
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
