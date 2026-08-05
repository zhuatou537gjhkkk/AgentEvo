/**
 * 测试用例验证测试 (Phase 5)
 */

import { describe, it, expect } from "vitest";
import {
    testCases,
    getTestCasesByCategory,
    getTestCaseById,
    getTestCaseCategories,
    validateTestCases,
} from "../testCases.js";

describe("testCases", () => {
    it("should have at least 50 test cases", () => {
        expect(testCases.length).toBeGreaterThanOrEqual(50);
    });

    it("should all have unique IDs", () => {
        const ids = testCases.map(tc => tc.id);
        const unique = new Set(ids);
        expect(unique.size).toBe(testCases.length);
    });

    it("should pass validation", () => {
        const { valid, errors } = validateTestCases();
        if (!valid) {
            console.error("Validation errors:", errors);
        }
        expect(valid).toBe(true);
    });

    it("should have all 8 categories represented", () => {
        const categories = new Set(testCases.map(tc => tc.category));
        expect(categories.size).toBeGreaterThanOrEqual(8);
    });

    it("should have all difficulty levels represented", () => {
        const difficulties = new Set(testCases.map(tc => tc.difficulty));
        expect(difficulties.has("easy")).toBe(true);
        expect(difficulties.has("medium")).toBe(true);
        expect(difficulties.has("hard")).toBe(true);
    });
});

describe("getTestCasesByCategory", () => {
    it("should filter by category", () => {
        const kbTests = getTestCasesByCategory("knowledge_qa");
        expect(kbTests.length).toBeGreaterThanOrEqual(10);
        for (const tc of kbTests) {
            expect(tc.category).toBe("knowledge_qa");
        }
    });

    it("should return all when no category specified", () => {
        const all = getTestCasesByCategory("");
        expect(all.length).toBe(testCases.length);
    });
});

describe("getTestCaseById", () => {
    it("should find by id", () => {
        const tc = getTestCaseById("tc_knowledge_001");
        expect(tc).toBeTruthy();
        expect(tc.id).toBe("tc_knowledge_001");
    });

    it("should return undefined for non-existent id", () => {
        expect(getTestCaseById("nonexistent")).toBeUndefined();
    });
});

describe("getTestCaseCategories", () => {
    it("should return all categories with counts", () => {
        const cats = getTestCaseCategories();
        expect(cats.length).toBeGreaterThanOrEqual(8);
        for (const cat of cats) {
            expect(typeof cat.category).toBe("string");
            expect(cat.count).toBeGreaterThan(0);
        }
    });
});
