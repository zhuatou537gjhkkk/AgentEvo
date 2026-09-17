import { describe, expect, it } from "vitest";
import { Sha256Hasher } from "../sha256Core.js";

describe("incremental SHA-256", () => {
    it("matches the standard empty and multi-chunk vectors", () => {
        expect(new Sha256Hasher().digestHex()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        const hasher = new Sha256Hasher();
        hasher.update(new TextEncoder().encode("abc"));
        hasher.update(new TextEncoder().encode("defghijklmnopqrstuvwxyz"));
        expect(hasher.digestHex()).toBe("71c480df93d6ae2f1efad1447c66c9525e316218cf51fc8d9ed832f2daf18b73");
    });
});
