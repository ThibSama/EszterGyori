import type { Server } from "node:http";
import { createApp } from "./app";
import type { ServerConfig } from "./config";
import { loadConfig } from "./config";
import { defaultSiteContent } from "@eszter/contracts";
import { createContentStorage } from "./storage";

const SHUTDOWN_TIMEOUT_MS = 5_000;

export async function startServer(config: ServerConfig = loadConfig()): Promise<Server> {
  const contentStorage = createContentStorage(config.contentDataDir);
  const initialization = await contentStorage.initialize(defaultSiteContent);
  console.info("Content storage initialized.", {
    draft: initialization.draft,
    published: initialization.published,
  });

  const app = createApp({ publishedContentReader: contentStorage });
  const server = app.listen(config.port, config.host, () => {
    console.info(
      `eszter-api listening on http://${config.host}:${config.port} (${config.nodeEnv})`,
    );
  });

  registerGracefulShutdown(server);
  return server;
}

export function registerGracefulShutdown(server: Server) {
  let shuttingDown = false;

  function shutdown(reason: NodeJS.Signals) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.info(`Received ${reason}; closing eszter-api.`);

    const timeout = setTimeout(() => {
      console.error("Graceful shutdown timed out.");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timeout.unref();

    server.close((error) => {
      clearTimeout(timeout);
      if (error) {
        console.error("Failed to close eszter-api cleanly.", error);
        process.exit(1);
      }
      console.info("eszter-api closed.");
      process.exit(0);
    });
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
