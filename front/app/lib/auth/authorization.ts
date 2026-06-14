import "server-only";

import { redirect } from "next/navigation";
import { loadAdminAuthConfig } from "./config";
import { getAdminSessionCookieValue } from "./session-cookie";
import type { AdminSession } from "./session-token";
import { verifyAdminSessionToken } from "./session-token";

export async function getOptionalAdminSession(): Promise<AdminSession | null> {
  const token = await getAdminSessionCookieValue();
  if (!token) return null;

  try {
    const config = loadAdminAuthConfig();
    return await verifyAdminSessionToken(token, config);
  } catch {
    return null;
  }
}

export async function requireAdminSession(): Promise<AdminSession> {
  const session = await getOptionalAdminSession();
  if (!session) {
    redirect("/admin/login");
  }

  return session;
}
