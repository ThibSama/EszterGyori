import { ZodError } from "zod";
import { loadConfig } from "./config";
import { startServer } from "./server";
import { isStorageError } from "./storage";

try {
  await startServer(loadConfig());
} catch (error) {
  if (error instanceof ZodError) {
    console.error("Invalid server configuration", {
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  } else if (isStorageError(error)) {
    console.error("Fatal content storage error", {
      code: error.code,
      fileRole: error.fileRole,
      message: error.message,
    });
  } else {
    console.error("Fatal startup error", error);
  }
  process.exit(1);
}
