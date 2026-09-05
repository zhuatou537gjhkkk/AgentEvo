import crypto from "node:crypto";
import { toPublicError } from "./resilience.js";

const writers = new WeakMap();

function isMetadataEnabled(explicit) {
    if (explicit != null) return explicit !== false;
    return process.env.SSE_METADATA_ENABLED !== "false";
}

/**
 * Additive SSE writer. Existing payload fields are preserved; metadata is
 * attached only to JSON events so the legacy [DONE] sentinel remains intact.
 */
export function createSSEWriter(res, { requestId = null, enabled, clock = Date } = {}) {
    const metadataEnabled = isMetadataEnabled(enabled);
    const streamId = crypto.randomUUID();
    let seq = 0;
    let ended = false;

    const write = (payload = {}) => {
        if (ended || res.writableEnded) return false;
        const event = { ...payload };
        let eventId = null;
        if (metadataEnabled) {
            seq += 1;
            eventId = `${streamId}:${seq}`;
            event.seq = seq;
            event.event_id = eventId;
            event.request_id = requestId || null;
            // Existing clients consume requestId on error events.
            event.requestId = event.requestId || requestId || null;
        }
        if (event.at == null) event.at = new clock().toISOString();
        const frame = `${eventId ? `id: ${eventId}\n` : ""}data: ${JSON.stringify(event)}\n\n`;
        res.write(frame);
        return true;
    };

    const done = () => {
        if (ended || res.writableEnded) return false;
        ended = true;
        res.write("data: [DONE]\n\n");
        return true;
    };

    const writer = {
        get sequence() { return seq; },
        write,
        writeText(text) { return write({ type: "text", text }); },
        writeMetrics(metrics) { return write({ type: "metrics", metrics }); },
        writeError(error) {
            const result = write(toPublicError(error, requestId));
            ended = true;
            return result;
        },
        done,
        reset() { ended = false; },
    };
    const markClosed = () => { ended = true; };
    res.once?.("close", markClosed);
    res.once?.("finish", markClosed);
    writers.set(res, writer);
    return writer;
}

export function getSSEWriter(res, options = {}) {
    return writers.get(res) || createSSEWriter(res, options);
}

export function writeSSEEvent(res, payload, options = {}) {
    return getSSEWriter(res, options).write(payload);
}

export function writeSSEDone(res, options = {}) {
    return getSSEWriter(res, options).done();
}

export function resetSSEWriter(res) {
    writers.delete(res);
}
