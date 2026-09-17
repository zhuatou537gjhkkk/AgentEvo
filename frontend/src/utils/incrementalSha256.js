import { Sha256Hasher } from "./sha256Core.js";

function abortError() {
    return Object.assign(new Error("operation aborted"), { name: "AbortError" });
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
}

function readChunk(file, start, end) {
    return file.slice(start, end).arrayBuffer();
}

export async function hashFileIncrementally(file, { chunkSize = 4 * 1024 * 1024, signal, onProgress } = {}) {
    if (!file || typeof file.slice !== "function") throw new Error("invalid file");
    const total = Number(file.size) || 0;
    const emit = (loaded) => onProgress?.({ loaded, total, percentage: total > 0 ? Math.round((loaded / total) * 100) : 100 });
    throwIfAborted(signal);

    if (typeof globalThis.Worker === "function") {
        const worker = new globalThis.Worker(new URL("./sha256.worker.js", import.meta.url), { type: "module" });
        let waiter = null;
        const nextMessage = () => new Promise((resolve, reject) => { waiter = { resolve, reject }; });
        worker.onmessage = (event) => waiter?.resolve(event.data);
        worker.onerror = (event) => waiter?.reject(event.error || new Error("hash worker failed"));
        const abort = () => { worker.terminate(); waiter?.reject(abortError()); };
        signal?.addEventListener("abort", abort, { once: true });
        try {
            let loaded = 0;
            for (let start = 0; start < total; start += chunkSize) {
                throwIfAborted(signal);
                const buffer = await readChunk(file, start, Math.min(total, start + chunkSize));
                const chunkLength = buffer.byteLength;
                const acknowledgement = nextMessage();
                worker.postMessage({ type: "chunk", buffer }, [buffer]);
                const message = await acknowledgement;
                if (message.type !== "ack") throw new Error("hash worker protocol error");
                loaded = Math.min(total, start + chunkLength);
                emit(loaded);
            }
            const digestResult = nextMessage();
            worker.postMessage({ type: "digest" });
            const message = await digestResult;
            if (message.type !== "digest") throw new Error("hash worker protocol error");
            return message.value;
        } finally {
            signal?.removeEventListener("abort", abort);
            worker.terminate();
        }
    }

    const hasher = new Sha256Hasher();
    let loaded = 0;
    for (let start = 0; start < total; start += chunkSize) {
        throwIfAborted(signal);
        const buffer = await readChunk(file, start, Math.min(total, start + chunkSize));
        hasher.update(buffer);
        loaded = Math.min(total, start + buffer.byteLength);
        emit(loaded);
    }
    return hasher.digestHex();
}

export default { hashFileIncrementally };
