import "server-only";

import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import type { AdminAuthConfig } from "./config";
import {
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_COOKIE_PATH,
} from "./cookie-constants";

export { ADMIN_SESSION_COOKIE_NAME, ADMIN_SESSION_COOKIE_PATH };

export async function getAdminSessionCookieValue(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(ADMIN_SESSION_COOKIE_NAME)?.value ?? null;
}

export function setAdminSessionCookie(
  response: NextResponse,
  token: string,
  config: AdminAuthConfig,
): void {
  response.cookies.set(ADMIN_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: ADMIN_SESSION_COOKIE_PATH,
    maxAge: config.sessionTtlSeconds,
  });
}

export function deleteAdminSessionCookie(response: NextResponse): void {
  response.cookies.set(ADMIN_SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: ADMIN_SESSION_COOKIE_PATH,
    maxAge: 0,
    expires: new Date(0),
  });
}
