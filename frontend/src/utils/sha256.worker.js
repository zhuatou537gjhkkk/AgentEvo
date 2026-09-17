import { Sha256Hasher } from "./sha256Core.js";

const hasher = new Sha256Hasher();
self.onmessage = (event) => {
    const message = event.data || {};
    if (message.type === "chunk") {
        hasher.update(message.buffer);
        self.postMessage({ type: "ack" });
    } else if (message.type === "digest") {
        self.postMessage({ type: "digest", value: hasher.digestHex() });
    }
};
