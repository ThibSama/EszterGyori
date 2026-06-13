import { z } from "zod";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const API_PACKAGE_ROOT =
  currentDirectory.endsWith("\\dist") ||
  currentDirectory.endsWith("\\src") ||
  currentDirectory.endsWith("/dist") ||
  currentDirectory.endsWith("/src")
    ? dirname(currentDirectory)
    : currentDirectory;

const nodeEnvSchema = z.enum(["development", "test", "production"]);
const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

const portSchema = z
  .string()
  .default("4000")
  .refine((value) => /^\d+$/.test(value), "PORT must be a numeric TCP port.")
  .transform((value) => Number(value))
  .refine((value) => Number.isInteger(value) && value >= 1 && value <= 65535, {
    message: "PORT must be between 1 and 65535.",
  });

const hostSchema = z.string().trim().min(1).default("127.0.0.1");
const contentDataDirSchema = z
  .string()
  .optional()
  .transform((value) => value ?? "data")
  .refine((value) => value.trim().length > 0, {
    message: "CONTENT_DATA_DIR must not be empty.",
  })
  .transform((value) => {
    const trimmed = value.trim();
    return isAbsolute(trimmed)
      ? resolve(trimmed)
      : resolve(API_PACKAGE_ROOT, trimmed);
  });

const rawConfigSchema = z.object({
  NODE_ENV: nodeEnvSchema.default("development"),
  HOST: hostSchema,
  PORT: portSchema,
  LOG_LEVEL: logLevelSchema.default("info"),
  CONTENT_DATA_DIR: contentDataDirSchema,
});

export interface ServerConfig {
  nodeEnv: z.infer<typeof nodeEnvSchema>;
  host: string;
  port: number;
  logLevel: z.infer<typeof logLevelSchema>;
  contentDataDir: string;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const parsed = rawConfigSchema.parse({
    NODE_ENV: environment.NODE_ENV,
    HOST: environment.HOST,
    PORT: environment.PORT,
    LOG_LEVEL: environment.LOG_LEVEL,
    CONTENT_DATA_DIR: environment.CONTENT_DATA_DIR,
  });

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    contentDataDir: parsed.CONTENT_DATA_DIR,
  };
}
