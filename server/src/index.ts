import { ZodError } from "zod";
import { loadConfig } from "./config";
import { startServer } from "./server";

try {
  startServer(loadConfig());
} catch (error) {
  if (error instanceof ZodError) {
    console.error("Invalid server configuration", {
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  } else {
    console.error("Fatal startup error", error);
  }
  process.exit(1);
}
