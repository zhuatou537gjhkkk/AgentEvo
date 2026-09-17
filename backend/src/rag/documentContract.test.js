import { describe, expect, it } from "vitest";
import {
    allowedIngestTransitions,
    assertIngestStatusTransition,
    canTransitionIngestStatus,
    isTerminalIngestStatus,
    parseParsedDocument,
} from "./documentContract.js";

function validDocument(overrides = {}) {
    const blocks = overrides.blocks || [{
        id: "block-1",
        type: "heading",
        text: "AgentEvo",
        level: 1,
        page: 1,
        bbox: null,
        headingPath: ["AgentEvo"],
        metadata: {},
    }];
    return {
        schemaVersion: "parsed-document-v1",
        parser: "native",
        parserVersion: "test",
        fileName: "manual.md",
        mimeType: "text/markdown",
        title: "Manual",
        blocks,
        warnings: [],
        stats: {
            pages: null,
            blocks: blocks.length,
            chars: blocks.reduce((total, block) => total + block.text.length, 0),
        },
        ...overrides,
    };
}

describe("parsed document contract", () => {
    it("accepts the normalized shape used by downstream chunkers", () => {
        const parsed = parseParsedDocument(validDocument());

        expect(parsed.schemaVersion).toBe("parsed-document-v1");
        expect(parsed.blocks).toHaveLength(1);
        expect(parsed.stats.chars).toBe("AgentEvo".length);
    });

    it("rejects empty text, unknown block types, and inconsistent stats", () => {
        expect(() => parseParsedDocument(validDocument({
            blocks: [{ ...validDocument().blocks[0], text: "   " }],
            stats: { pages: null, blocks: 1, chars: 0 },
        }))).toThrowError(/invalid parsed document contract/);

        expect(() => parseParsedDocument(validDocument({
            blocks: [{ ...validDocument().blocks[0], type: "unknown" }],
        }))).toThrowError(/invalid parsed document contract/);

        expect(() => parseParsedDocument(validDocument({
            stats: { pages: null, blocks: 1, chars: 999 },
        }))).toThrowError(/character count is inconsistent/);
    });

    it("keeps page numbers 1-based and accepts nullable layout metadata", () => {
        const parsed = parseParsedDocument(validDocument({
            parser: "mineru",
            parserVersion: "vlm",
            mimeType: "application/pdf",
            blocks: [{
                id: "page-1-table",
                type: "table",
                text: "Name | Value",
                level: null,
                page: 3,
                bbox: [0, 0, 1000, 1000],
                headingPath: ["Configuration"],
                metadata: { sourceType: "content_list" },
            }],
            stats: { pages: 3, blocks: 1, chars: 12 },
        }));

        expect(parsed.parser).toBe("mineru");
        expect(parsed.blocks[0].page).toBe(3);
        expect(parsed.blocks[0].bbox).toEqual([0, 0, 1000, 1000]);
    });
});

describe("ingest status contract", () => {
    it("allows the queued-to-ready lifecycle and idempotent polling states", () => {
        expect(canTransitionIngestStatus("queued", "submitting")).toBe(true);
        expect(canTransitionIngestStatus("provider_running", "provider_running")).toBe(true);
        expect(canTransitionIngestStatus("indexing", "ready")).toBe(true);
        expect(isTerminalIngestStatus("ready")).toBe(true);
        expect(isTerminalIngestStatus("failed")).toBe(true);
        expect(isTerminalIngestStatus("provider_running")).toBe(false);
    });

    it("allows retry only from terminal failure/cancellation and rejects regressions", () => {
        expect(canTransitionIngestStatus("failed", "queued")).toBe(true);
        expect(canTransitionIngestStatus("cancelled", "queued")).toBe(true);
        expect(canTransitionIngestStatus("ready", "queued")).toBe(false);
        expect(canTransitionIngestStatus("indexing", "provider_running")).toBe(false);
        expect(() => assertIngestStatusTransition("ready", "provider_running"))
            .toThrowError(/invalid ingest status transition/);
        try {
            assertIngestStatusTransition("ready", "provider_running");
        } catch (error) {
            expect(error.code).toBe("INGEST_STATUS_TRANSITION_INVALID");
        }
        expect(allowedIngestTransitions("not-a-status")).toEqual([]);
    });
});
