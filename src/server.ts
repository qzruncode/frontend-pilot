import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { safeErrorMessage } from "./errors.js";

const config = loadConfig();
const app = await buildApp({ config });

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ dryRun: config.dryRun }, `frontend-pilot listening on ${config.host}:${config.port}`);
} catch (error) {
  app.log.error({ message: safeErrorMessage(error, "server failed to start") }, "server failed to start");
  process.exitCode = 1;
}

async function shutdown(signal: string): Promise<void> {
  app.log.info(`received ${signal}, shutting down`);
  await app.close();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
