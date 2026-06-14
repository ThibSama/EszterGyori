import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createAdminSessionToken,
  loadAdminAuthConfig,
  sanitizeAdminRedirect,
  setAdminSessionCookie,
  verifyPassword,
} from "../../../lib/auth";
import { isSameOriginPostRequest } from "../../../lib/auth/request-origin";

const MAX_LOGIN_BODY_BYTES = 8 * 1024;

const loginFormSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(512),
  next: z.string().optional(),
});

export async function POST(request: Request) {
  if (!isSameOriginPostRequest(request)) {
    console.warn("ADMIN_AUTH_ORIGIN_REJECTED");
    return noStoreResponse("Forbidden", 403);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]?.trim() !== "application/x-www-form-urlencoded") {
    return noStoreResponse("Unsupported Media Type", 415);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_LOGIN_BODY_BYTES) {
    return noStoreResponse("Payload Too Large", 413);
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_LOGIN_BODY_BYTES) {
    return noStoreResponse("Payload Too Large", 413);
  }

  const form = new URLSearchParams(rawBody);
  const parsed = loginFormSchema.safeParse({
    username: form.get("username"),
    password: form.get("password"),
    next: form.get("next") ?? undefined,
  });

  const fallbackNext = sanitizeAdminRedirect(form.get("next"));
  if (!parsed.success) {
    console.warn("ADMIN_LOGIN_FAILED");
    return redirectToLogin(request, "invalid", fallbackNext);
  }

  let config: ReturnType<typeof loadAdminAuthConfig>;
  try {
    config = loadAdminAuthConfig();
  } catch {
    console.warn("ADMIN_LOGIN_UNAVAILABLE");
    return redirectToLogin(request, "unavailable", fallbackNext);
  }

  const validUsername = parsed.data.username === config.username;
  const validPassword = await verifyPassword(
    parsed.data.password,
    config.passwordHash,
  );

  if (!validUsername || !validPassword) {
    console.warn("ADMIN_LOGIN_FAILED");
    return redirectToLogin(
      request,
      "invalid",
      sanitizeAdminRedirect(parsed.data.next),
    );
  }

  const destination = sanitizeAdminRedirect(parsed.data.next);
  const response = NextResponse.redirect(new URL(destination, request.url), 303);
  response.headers.set("Cache-Control", "no-store");
  setAdminSessionCookie(
    response,
    await createAdminSessionToken(config),
    config,
  );
  console.info("ADMIN_LOGIN_SUCCEEDED");
  return response;
}

function redirectToLogin(
  request: Request,
  error: "invalid" | "unavailable",
  next: string,
) {
  const target = new URL("/admin/login", request.url);
  target.searchParams.set("error", error);
  if (next !== "/admin") target.searchParams.set("next", next);
  const response = NextResponse.redirect(target, 303);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function noStoreResponse(body: string, status: number): NextResponse {
  const response = new NextResponse(body, { status });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
