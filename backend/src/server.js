import { startServer } from "./app.js";
import { closeDB } from "./db/index.js";
import { uploadQuotaStore } from "./services/uploadQuotaStore.js";
import { toolRegistry } from "./mcp/registry.js";

const server = await startServer();
let shuttingDown = false;

const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
        uploadQuotaStore.close?.();
        await toolRegistry.closeAllMCPServers?.();
    } catch (error) {
        console.error(`[shutdown] MCP cleanup failed: ${error.message}`);
    }
    server.close(() => {
        try { closeDB(); } finally { process.exit(0); }
    });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
