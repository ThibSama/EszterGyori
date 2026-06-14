import "server-only";

import { z } from "zod";

export const DEFAULT_ADMIN_SESSION_TTL_SECONDS = 28_800;
export const MIN_ADMIN_SESSION_TTL_SECONDS = 900;
export const MAX_ADMIN_SESSION_TTL_SECONDS = 86_400;

const ttlSchema = z
  .string()
  .optional()
  .transform((value) => value ?? String(DEFAULT_ADMIN_SESSION_TTL_SECONDS))
  .refine((value) => /^\d+$/.test(value), {
    message: "ADMIN_SESSION_TTL_SECONDS doit etre un entier.",
  })
  .transform((value) => Number(value))
  .refine(
    (value) =>
      Number.isInteger(value) &&
      value >= MIN_ADMIN_SESSION_TTL_SECONDS &&
      value <= MAX_ADMIN_SESSION_TTL_SECONDS,
    {
      message: `ADMIN_SESSION_TTL_SECONDS doit etre entre ${MIN_ADMIN_SESSION_TTL_SECONDS} et ${MAX_ADMIN_SESSION_TTL_SECONDS}.`,
    },
  );

const secretSchema = z.string().superRefine((value, context) => {
  if (value.trim().length === 0) {
    context.addIssue({
      code: "custom",
      message: "ADMIN_SESSION_SECRET est requis.",
    });
    return;
  }

  if (new TextEncoder().encode(value).byteLength < 32) {
    context.addIssue({
      code: "custom",
      message: "ADMIN_SESSION_SECRET doit contenir au moins 32 octets.",
    });
  }
});

const authConfigSchema = z.object({
  ADMIN_USERNAME: z.string().trim().min(1, "ADMIN_USERNAME est requis."),
  ADMIN_PASSWORD_HASH: z
    .string()
    .trim()
    .min(1, "ADMIN_PASSWORD_HASH est requis."),
  ADMIN_SESSION_SECRET: secretSchema,
  ADMIN_SESSION_TTL_SECONDS: ttlSchema,
});

export interface AdminAuthConfig {
  username: string;
  passwordHash: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
}

export function loadAdminAuthConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AdminAuthConfig {
  const parsed = authConfigSchema.parse({
    ADMIN_USERNAME: environment.ADMIN_USERNAME,
    ADMIN_PASSWORD_HASH: environment.ADMIN_PASSWORD_HASH,
    ADMIN_SESSION_SECRET: environment.ADMIN_SESSION_SECRET,
    ADMIN_SESSION_TTL_SECONDS: environment.ADMIN_SESSION_TTL_SECONDS,
  });

  return {
    username: parsed.ADMIN_USERNAME,
    passwordHash: parsed.ADMIN_PASSWORD_HASH,
    sessionSecret: parsed.ADMIN_SESSION_SECRET,
    sessionTtlSeconds: parsed.ADMIN_SESSION_TTL_SECONDS,
  };
}
