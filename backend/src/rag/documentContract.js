import { z } from "zod";

export const PARSED_DOCUMENT_SCHEMA_VERSION = "parsed-document-v1";

export const DOCUMENT_BLOCK_TYPES = Object.freeze([
    "heading",
    "paragraph",
    "table",
    "equation",
    "code",
    "list",
    "image_caption",
]);

export const INGEST_STATUSES = Object.freeze([
    "queued",
    "submitting",
    "provider_uploading",
    "provider_pending",
    "provider_running",
    "provider_converting",
    "downloading",
    "parsing",
    "indexing",
    "ready",
    "failed",
    "cancelled",
]);

export const TERMINAL_INGEST_STATUSES = Object.freeze([
    "ready",
    "failed",
    "cancelled",
]);

const finiteNumber = z.number().finite();

const ParsedBlockSchema = z.object({
    id: z.string().min(1).max(200),
    type: z.enum(DOCUMENT_BLOCK_TYPES),
    text: z.string().trim().min(1),
    level: z.number().int().min(1).max(12).nullable(),
    page: z.number().int().min(1).nullable(),
    bbox: z.array(finiteNumber).length(4).nullable(),
    headingPath: z.array(z.string().trim().min(1).max(500)).max(32),
    metadata: z.record(z.unknown()),
});

const ParsedDocumentSchema = z.object({
    schemaVersion: z.literal(PARSED_DOCUMENT_SCHEMA_VERSION),
    parser: z.enum(["native", "mineru"]),
    parserVersion: z.string().trim().min(1).max(100).nullable(),
    fileName: z.string().trim().min(1).max(240),
    mimeType: z.string().trim().min(1).max(160),
    title: z.string().trim().min(1).max(1000).nullable(),
    blocks: z.array(ParsedBlockSchema).min(1).max(1_000_000),
    warnings: z.array(z.string().trim().min(1).max(500)).max(200),
    stats: z.object({
        pages: z.number().int().min(0).nullable(),
        blocks: z.number().int().min(1),
        chars: z.number().int().min(1),
    }),
});

const STATUS_TRANSITIONS = Object.freeze({
    queued: ["submitting", "parsing", "cancelled", "failed"],
    submitting: ["provider_uploading", "provider_pending", "parsing", "failed", "cancelled"],
    provider_uploading: ["provider_pending", "failed", "cancelled"],
    provider_pending: ["provider_pending", "provider_running", "provider_converting", "downloading", "failed", "cancelled"],
    provider_running: ["provider_running", "provider_converting", "downloading", "failed", "cancelled"],
    provider_converting: ["provider_running", "downloading", "failed", "cancelled"],
    downloading: ["parsing", "failed", "cancelled"],
    parsing: ["indexing", "failed", "cancelled"],
    indexing: ["indexing", "ready", "failed", "cancelled"],
    ready: [],
    failed: ["queued"],
    cancelled: ["queued"],
});

export class DocumentContractError extends Error {
    constructor(message, code = "DOCUMENT_CONTRACT_INVALID", details = null) {
        super(message);
        this.name = "DocumentContractError";
        this.code = code;
        this.statusCode = 400;
        this.details = details;
    }
}

function contractErrorFromZod(result) {
    const details = result.error.issues.slice(0, 8).map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
    }));
    return new DocumentContractError("invalid parsed document contract", "DOCUMENT_CONTRACT_INVALID", details);
}

/**
 * Validate the provider-independent document shape consumed by chunkers and
 * indexers. Provider-specific fields must be normalized before this boundary.
 */
export function parseParsedDocument(input) {
    const result = ParsedDocumentSchema.safeParse(input);
    if (!result.success) throw contractErrorFromZod(result);
    const document = result.data;
    if (document.stats.blocks !== document.blocks.length) {
        throw new DocumentContractError("parsed document block count is inconsistent", "DOCUMENT_STATS_INVALID");
    }
    const actualChars = document.blocks.reduce((total, block) => total + block.text.length, 0);
    if (document.stats.chars !== actualChars) {
        throw new DocumentContractError("parsed document character count is inconsistent", "DOCUMENT_STATS_INVALID");
    }
    return document;
}

export function canTransitionIngestStatus(from, to) {
    if (!INGEST_STATUSES.includes(from) || !INGEST_STATUSES.includes(to)) return false;
    return STATUS_TRANSITIONS[from].includes(to);
}

export function allowedIngestTransitions(from) {
    if (!INGEST_STATUSES.includes(from)) return [];
    return [...STATUS_TRANSITIONS[from]];
}

export function assertIngestStatusTransition(from, to) {
    if (!canTransitionIngestStatus(from, to)) {
        throw new DocumentContractError(
            `invalid ingest status transition: ${String(from)} -> ${String(to)}`,
            "INGEST_STATUS_TRANSITION_INVALID",
        );
    }
    return to;
}

export function isTerminalIngestStatus(status) {
    return TERMINAL_INGEST_STATUSES.includes(status);
}

export default {
    PARSED_DOCUMENT_SCHEMA_VERSION,
    DOCUMENT_BLOCK_TYPES,
    INGEST_STATUSES,
    TERMINAL_INGEST_STATUSES,
    DocumentContractError,
    parseParsedDocument,
    canTransitionIngestStatus,
    allowedIngestTransitions,
    assertIngestStatusTransition,
    isTerminalIngestStatus,
};
