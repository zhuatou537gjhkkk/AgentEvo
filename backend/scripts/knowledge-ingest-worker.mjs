/**
 * K13 external knowledge-ingest worker.
 *
 * Run with KNOWLEDGE_INGEST_V2=true and KNOWLEDGE_INGEST_WORKER_MODE=external.
 * `--once` is intentionally supported for smoke/operational probes: it claims
 * at most one job and exits without exposing document or provider payloads.
 */
await import("dotenv/config");

const [{ knowledgeIngestWorkerMode, knowledgeIngestV2Enabled }, { createIngestWorker }] = await Promise.all([
    import("../src/rag/flags.js"),
    import("../src/rag/ingestWorker.js"),
]);

const once = process.argv.slice(2).includes("--once");
const mode = knowledgeIngestWorkerMode();
if (!knowledgeIngestV2Enabled()) {
    console.error(JSON.stringify({ ok: false, code: "KNOWLEDGE_INGEST_V2_DISABLED" }));
    process.exitCode = 2;
} else if (mode !== "external") {
    console.error(JSON.stringify({ ok: false, code: "KNOWLEDGE_INGEST_WORKER_MODE_NOT_EXTERNAL", mode }));
    process.exitCode = 2;
} else {
    const worker = createIngestWorker();
    if (once) {
        const result = await worker.runOnce();
        console.log(JSON.stringify({ ok: true, ...result }));
        await worker.stop();
    } else {
        worker.start();
        let stopping = false;
        const stop = async () => {
            if (stopping) return;
            stopping = true;
            await worker.stop();
            process.exit(0);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        console.log(JSON.stringify({ ok: true, status: "running", mode: "external" }));
    }
}
