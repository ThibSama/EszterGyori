import { z } from "zod";

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

const rawConfigSchema = z.object({
  NODE_ENV: nodeEnvSchema.default("development"),
  HOST: hostSchema,
  PORT: portSchema,
  LOG_LEVEL: logLevelSchema.default("info"),
});

export interface ServerConfig {
  nodeEnv: z.infer<typeof nodeEnvSchema>;
  host: string;
  port: number;
  logLevel: z.infer<typeof logLevelSchema>;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const parsed = rawConfigSchema.parse({
    NODE_ENV: environment.NODE_ENV,
    HOST: environment.HOST,
    PORT: environment.PORT,
    LOG_LEVEL: environment.LOG_LEVEL,
  });

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
  };
}
