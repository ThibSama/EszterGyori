import { NextResponse } from "next/server";
import { deleteAdminSessionCookie } from "../../../lib/auth";
import { isSameOriginPostRequest } from "../../../lib/auth/request-origin";

export async function POST(request: Request) {
  if (!isSameOriginPostRequest(request)) {
    console.warn("ADMIN_AUTH_ORIGIN_REJECTED");
    const response = new NextResponse("Forbidden", { status: 403 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const response = NextResponse.redirect(new URL("/admin/login", request.url), 303);
  response.headers.set("Cache-Control", "no-store");
  deleteAdminSessionCookie(response);
  console.info("ADMIN_LOGOUT");
  return response;
}
