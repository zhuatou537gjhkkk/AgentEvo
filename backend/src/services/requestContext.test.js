import { describe, expect, it } from "vitest";
import { createRequestContext, getRequestContext, runWithRequestContext } from "./requestContext.js";

describe("request context", () => {
    it("keeps immutable authenticated identity", async () => {
        const context = createRequestContext({ userId: 7, sessionId: 9, requestId: "req-1" });
        await runWithRequestContext(context, async () => {
            expect(getRequestContext()).toMatchObject({ userId: 7, sessionId: 9, requestId: "req-1" });
        });
        expect(() => { context.userId = 8; }).toThrow();
    });

    it("isolates concurrent contexts", async () => {
        const values = await Promise.all([1, 2].map((userId) => runWithRequestContext(
            createRequestContext({ userId }),
            async () => new Promise((resolve) => setTimeout(() => resolve(getRequestContext().userId), userId === 1 ? 10 : 1))
        )));
        expect(values.sort()).toEqual([1, 2]);
    });
});
