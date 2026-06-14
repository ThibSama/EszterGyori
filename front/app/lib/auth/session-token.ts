import "server-only";

import { jwtVerify, SignJWT } from "jose";
import type { AdminAuthConfig } from "./config";

export const ADMIN_SESSION_ISSUER = "eszter-frontend";
export const ADMIN_SESSION_AUDIENCE = "eszter-admin";
export const ADMIN_SESSION_SUBJECT = "admin";
export const ADMIN_SESSION_ROLE = "admin";

export interface AdminSession {
  sub: typeof ADMIN_SESSION_SUBJECT;
  role: typeof ADMIN_SESSION_ROLE;
  jti: string;
  iat: number;
  exp: number;
}

export async function createAdminSessionToken(
  config: AdminAuthConfig,
  now = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + config.sessionTtlSeconds;

  return new SignJWT({
    sub: ADMIN_SESSION_SUBJECT,
    role: ADMIN_SESSION_ROLE,
    jti: crypto.randomUUID(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ADMIN_SESSION_ISSUER)
    .setAudience(ADMIN_SESSION_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(getSecretKey(config.sessionSecret));
}

export async function verifyAdminSessionToken(
  token: string,
  config: AdminAuthConfig,
  options: { currentDate?: Date } = {},
): Promise<AdminSession | null> {
  try {
    const verified = await jwtVerify(token, getSecretKey(config.sessionSecret), {
      issuer: ADMIN_SESSION_ISSUER,
      audience: ADMIN_SESSION_AUDIENCE,
      algorithms: ["HS256"],
      currentDate: options.currentDate,
    });

    const payload = verified.payload;
    if (payload.sub !== ADMIN_SESSION_SUBJECT) return null;
    if (payload.role !== ADMIN_SESSION_ROLE) return null;
    if (typeof payload.jti !== "string" || payload.jti.length === 0) {
      return null;
    }
    if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
      return null;
    }
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return null;
    }

    return {
      sub: ADMIN_SESSION_SUBJECT,
      role: ADMIN_SESSION_ROLE,
      jti: payload.jti,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

function getSecretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}
