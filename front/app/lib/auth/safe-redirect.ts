export function sanitizeAdminRedirect(value: unknown): string {
  if (typeof value !== "string") return "/admin";
  if (!value.startsWith("/admin")) return "/admin";
  if (value.startsWith("//")) return "/admin";

  let parsed: URL;
  try {
    parsed = new URL(value, "https://eszter.local");
  } catch {
    return "/admin";
  }

  if (parsed.origin !== "https://eszter.local") return "/admin";
  if (parsed.pathname === "/admin/login") return "/admin";
  if (parsed.pathname.startsWith("/admin/auth/")) return "/admin";
  if (!parsed.pathname.startsWith("/admin")) return "/admin";

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
