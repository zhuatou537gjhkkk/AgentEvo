import { describe, expect, it } from "vitest";
import { createSSEWriter } from "./sse.js";

function response() {
    return {
        writableEnded: false,
        writes: [],
        write(value) { this.writes.push(String(value)); },
        once(event, handler) {
            this.handlers ||= {};
            this.handlers[event] = handler;
        },
        close() { this.handlers?.close?.(); },
    };
}

describe("SSE writer", () => {
    it("adds monotonic metadata and makes done terminal", () => {
        const res = response();
        const writer = createSSEWriter(res, { requestId: "req-1", enabled: true });
        expect(writer.write({ type: "text", text: "hello" })).toBe(true);
        expect(writer.write({ type: "metrics", metrics: {} })).toBe(true);
        expect(writer.done()).toBe(true);
        expect(writer.done()).toBe(false);
        expect(writer.write({ type: "text", text: "late" })).toBe(false);
        expect(res.writes[0]).toContain('"seq":1');
        expect(res.writes[1]).toContain('"seq":2');
        expect(res.writes[2]).toBe("data: [DONE]\n\n");
    });

    it("stops writing after response close", () => {
        const res = response();
        const writer = createSSEWriter(res, { enabled: true });
        res.close();
        expect(writer.writeText("late")).toBe(false);
        expect(res.writes).toEqual([]);
    });

    it("can disable additive metadata", () => {
        const res = response();
        const writer = createSSEWriter(res, { enabled: false });
        writer.writeText("legacy");
        expect(res.writes[0]).not.toContain("event_id");
        expect(res.writes[0]).toContain('"type":"text"');
    });
});
