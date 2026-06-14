import { NextResponse, type NextRequest } from "next/server";
import { loadAdminAuthConfig } from "./app/lib/auth/config";
import { ADMIN_SESSION_COOKIE_NAME } from "./app/lib/auth/cookie-constants";
import { sanitizeAdminRedirect } from "./app/lib/auth/safe-redirect";
import { verifyAdminSessionToken } from "./app/lib/auth/session-token";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isLoginPage = pathname === "/admin/login";
  const isAuthRoute = pathname.startsWith("/admin/auth/");

  if (isAuthRoute) {
    return NextResponse.next();
  }

  const session = await getProxySession(request);

  if (isLoginPage) {
    if (session) {
      return NextResponse.redirect(new URL("/admin", request.url));
    }
    return NextResponse.next();
  }

  if (!session) {
    const loginUrl = new URL("/admin/login", request.url);
    const nextPath = sanitizeAdminRedirect(
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );
    if (nextPath !== "/admin") {
      loginUrl.searchParams.set("next", nextPath);
    }
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};

async function getProxySession(request: NextRequest) {
  const token = request.cookies.get(ADMIN_SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const authConfig = loadAdminAuthConfig();
    return await verifyAdminSessionToken(token, authConfig);
  } catch {
    return null;
  }
}
