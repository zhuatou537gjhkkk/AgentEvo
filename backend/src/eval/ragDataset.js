/**
 * K9 manifest contract for real-corpus RAG evaluation.
 *
 * The manifest is intentionally separate from the production knowledge store:
 * it describes a bounded, reviewable dataset and never becomes an answer or
 * telemetry payload. Private manifests may point at local business files, but
 * the checked-in example only uses sanitized fixtures.
 */
import fs from "node:fs/promises";
import path from "node:path";

export const RAG_EVAL_PROFILES = Object.freeze([
    "lexical",
    "hybrid",
    "hybrid+rewrite",
    "hybrid+rerank",
    "full",
]);

const MAX_DOCUMENTS = 1000;
const MAX_CASES = 5000;
const MAX_TEXT = 4000;
const MAX_FACTS = 20;

function fail(code, message) {
    return { ok: false, code, message };
}

function boundedString(value, max = MAX_TEXT) {
    const text = String(value ?? "").trim();
    return text ? text.slice(0, max) : "";
}

function stringArray(value, max = 100) {
    if (value == null) return [];
    if (!Array.isArray(value)) return null;
    return value.map((item) => boundedString(item, 240)).filter(Boolean).slice(0, max);
}

function validPages(value) {
    if (value == null) return [];
    if (!Array.isArray(value)) return null;
    const pages = value.map(Number);
    if (pages.some((page) => !Number.isInteger(page) || page < 1 || page > 1_000_000)) return null;
    return [...new Set(pages)];
}

function resolveSafePath(rawPath, { manifestDir, allowAbsolute = false, rootDir = null } = {}) {
    const input = String(rawPath || "").trim();
    if (!input) return fail("RAG_MANIFEST_PATH_REQUIRED", "document path is required");
    if (path.isAbsolute(input) && !allowAbsolute) {
        return fail("RAG_MANIFEST_ABSOLUTE_PATH_NOT_ALLOWED", "absolute document paths require explicit opt-in");
    }
    const resolved = path.resolve(manifestDir, input);
    const boundary = rootDir ? path.resolve(rootDir) : path.resolve(manifestDir);
    const relative = path.relative(boundary, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return fail("RAG_MANIFEST_PATH_TRAVERSAL", "document path escapes the allowed root");
    }
    return { ok: true, path: resolved };
}

export function validateRagManifest(manifest, {
    manifestDir = process.cwd(),
    allowAbsolute = false,
    rootDir = null,
} = {}) {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        return fail("RAG_MANIFEST_OBJECT_REQUIRED", "manifest must be an object");
    }
    const datasetVersion = boundedString(manifest.datasetVersion, 120);
    if (!datasetVersion) return fail("RAG_MANIFEST_VERSION_REQUIRED", "datasetVersion is required");
    if (!Array.isArray(manifest.documents) || manifest.documents.length === 0 || manifest.documents.length > MAX_DOCUMENTS) {
        return fail("RAG_MANIFEST_DOCUMENTS_INVALID", "documents must be a non-empty bounded array");
    }
    if (!Array.isArray(manifest.cases) || manifest.cases.length === 0 || manifest.cases.length > MAX_CASES) {
        return fail("RAG_MANIFEST_CASES_INVALID", "cases must be a non-empty bounded array");
    }

    const documentIds = new Set();
    const documents = [];
    for (const document of manifest.documents) {
        const id = boundedString(document?.id, 160);
        if (!id || documentIds.has(id)) return fail("RAG_MANIFEST_DUPLICATE_DOCUMENT_ID", "document IDs must be unique");
        const resolved = resolveSafePath(document?.path, { manifestDir, allowAbsolute, rootDir });
        if (!resolved.ok) return resolved;
        documentIds.add(id);
        documents.push({ id, path: String(document.path), resolvedPath: resolved.path });
    }

    const caseIds = new Set();
    const cases = [];
    for (const testCase of manifest.cases) {
        const id = boundedString(testCase?.id, 160);
        const query = boundedString(testCase?.query, 2000);
        if (!id || caseIds.has(id)) return fail("RAG_MANIFEST_DUPLICATE_CASE_ID", "case IDs must be unique");
        if (!query) return fail("RAG_MANIFEST_QUERY_REQUIRED", "each case needs a query");
        const relevantDocumentIds = stringArray(testCase.relevantDocumentIds);
        const relevantChunkIds = stringArray(testCase.relevantChunkIds);
        const excludedChunkIds = stringArray(testCase.excludedChunkIds);
        const expectedPages = validPages(testCase.expectedPages);
        const expectedFacts = stringArray(testCase.expectedFacts, MAX_FACTS);
        if (!relevantDocumentIds || !relevantChunkIds || !excludedChunkIds || !expectedPages || !expectedFacts) {
            return fail("RAG_MANIFEST_CASE_FIELDS_INVALID", "case list fields have invalid types or values");
        }
        if (relevantDocumentIds.some((documentId) => !documentIds.has(documentId))) {
            return fail("RAG_MANIFEST_UNKNOWN_DOCUMENT", "case references an unknown document");
        }
        if (testCase.noAnswer === true && (relevantDocumentIds.length > 0 || relevantChunkIds.length > 0)) {
            return fail("RAG_MANIFEST_NO_ANSWER_CONFLICT", "no-answer cases cannot contain positive labels");
        }
        if (testCase.noAnswer !== true && relevantDocumentIds.length === 0 && relevantChunkIds.length === 0) {
            return fail("RAG_MANIFEST_EMPTY_POSITIVE_CASE", "positive cases need a relevant document or chunk");
        }
        caseIds.add(id);
        cases.push({
            id,
            query,
            category: boundedString(testCase.category, 120) || "unknown",
            relevantDocumentIds,
            relevantChunkIds,
            excludedChunkIds,
            expectedPages,
            expectedFacts,
            noAnswer: testCase.noAnswer === true,
            ownerIsolation: testCase.ownerIsolation !== false,
            staleRevision: testCase.staleRevision === true,
        });
    }

    return { ok: true, datasetVersion, documents, cases };
}

export async function loadRagManifest(manifestPath, options = {}) {
    const filePath = path.resolve(String(manifestPath || ""));
    const manifestDir = path.dirname(filePath);
    let raw;
    try {
        raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
        const code = error?.code === "ENOENT" ? "RAG_MANIFEST_NOT_FOUND" : "RAG_MANIFEST_INVALID_JSON";
        throw Object.assign(new Error(code), { code });
    }
    const result = validateRagManifest(raw, { manifestDir, ...options });
    if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
    return { ...result, manifestPath: filePath };
}

export async function readRagDocuments(manifest, { maxBytesPerDocument = 10 * 1024 * 1024 } = {}) {
    const documents = [];
    for (const document of manifest.documents || []) {
        let stat;
        try {
            stat = await fs.stat(document.resolvedPath);
        } catch (error) {
            throw Object.assign(new Error("document file is missing"), { code: "RAG_MANIFEST_DOCUMENT_NOT_FOUND" });
        }
        if (!stat.isFile() || stat.size > maxBytesPerDocument) {
            throw Object.assign(new Error("document file is invalid or too large"), { code: "RAG_MANIFEST_DOCUMENT_TOO_LARGE" });
        }
        const extension = path.extname(document.resolvedPath).toLowerCase();
        if (![".md", ".txt", ".text"].includes(extension)) {
            throw Object.assign(new Error("offline manifest driver supports only text fixtures"), { code: "RAG_MANIFEST_UNSUPPORTED_FORMAT" });
        }
        documents.push({ ...document, content: await fs.readFile(document.resolvedPath, "utf8") });
    }
    return documents;
}

export default { RAG_EVAL_PROFILES, validateRagManifest, loadRagManifest, readRagDocuments };
