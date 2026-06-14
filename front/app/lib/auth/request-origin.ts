import "server-only";

export function isSameOriginPostRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const requestOrigin = new URL(request.url).origin;
  if (origin !== requestOrigin) return false;

  const secFetchSite = request.headers.get("sec-fetch-site");
  if (
    secFetchSite &&
    !["same-origin", "same-site", "none"].includes(secFetchSite)
  ) {
    return false;
  }

  return true;
}
