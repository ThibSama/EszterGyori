import type { AuthSessionResponse } from "@eszter/contracts";
import { ADMIN_API_MESSAGES, type AdminApiFailure } from "./admin-api";

/**
 * Session state as the browser is allowed to know it (ESZ-034).
 *
 * This is a *view*, never a decision. `authenticated` here means "the last call
 * to `/api/auth/session` said so", which is useful for deciding what to render
 * and worth nothing as access control: PHP re-resolves the account on every
 * privileged request, so a disabled account is refused on its next call whatever
 * this object says (`auth.accessControl`). The editor therefore treats a 401 on
 * any admin call as authoritative and this state as stale, never the reverse.
 */
export type AdminSessionState =
  /** The bootstrap read is in flight; nothing is known yet. */
  | { status: "loading" }
  /** A live anonymous session. `csrfToken` is what the login form must send. */
  | { status: "anonymous"; csrfToken: string }
  /** Signed in. `csrfToken` is bound to this session and rotated at login. */
  | {
      status: "authenticated";
      csrfToken: string;
      email: string;
      lastLoginAt: string | null;
    }
  /** The session endpoint itself could not be reached or understood. */
  | { status: "unavailable"; message: string };

/** Where the login form sends a signed-in admin when `?next` names nothing usable. */
export const ADMIN_HOME_PATH = "/admin";

export const ADMIN_SESSION_MESSAGES = {
  signedOut:
    "Vous n’êtes pas connecté. Connectez-vous pour ouvrir l’éditeur.",
  expired: ADMIN_API_MESSAGES.unauthenticated,
  loading: "Vérification de la session…",
} as const;

/**
 * Turns a validated `/api/auth/session` body into the state the UI renders.
 *
 * `authenticated: true` with a null account is treated as *not* signed in. The
 * schema permits the combination and the server never produces it, so the choice
 * is between trusting a flag and trusting the thing the flag describes; the
 * editor needs an e-mail to render and a contradiction here should not become an
 * empty header on a privileged screen.
 */
export function toSessionState(
  response: AuthSessionResponse,
): AdminSessionState {
  if (response.authenticated && response.account !== null) {
    return {
      status: "authenticated",
      csrfToken: response.csrfToken,
      email: response.account.email,
      lastLoginAt: response.account.lastLoginAt,
    };
  }

  return { status: "anonymous", csrfToken: response.csrfToken };
}

/** The state to fall back to when the session read itself failed. */
export function sessionStateFromFailure(
  failure: AdminApiFailure,
): AdminSessionState {
  return { status: "unavailable", message: failure.message };
}

/**
 * Whether a failure means the browser's idea of the session is finished.
 *
 * Only `unauthenticated`. A 403 `CSRF_TOKEN_INVALID` is *not* an expiry — the
 * session is alive and the token is stale, which is fixed by re-reading it — and
 * treating it as one would sign the admin out of a working session on a
 * recoverable error.
 */
export function isSessionExpiry(failure: AdminApiFailure): boolean {
  return failure.kind === "unauthenticated";
}

/**
 * Sanitises `?next` before it becomes a navigation.
 *
 * The value is attacker-controllable — it arrives in a URL that can be mailed to
 * the admin — so the only accepted shape is an absolute path inside `/admin`.
 * That excludes `//evil.example`, which a browser resolves as a protocol-relative
 * *host*, and `/\evil.example`, which some parsers normalise the same way.
 * Anything else falls back to the admin home rather than being reported: there is
 * no useful thing for an admin to do about a bad `next`.
 */
export function resolveAdminRedirect(raw: string | null): string {
  if (raw === null || raw === "") return ADMIN_HOME_PATH;
  if (!raw.startsWith("/")) return ADMIN_HOME_PATH;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return ADMIN_HOME_PATH;
  if (raw !== ADMIN_HOME_PATH && !raw.startsWith(`${ADMIN_HOME_PATH}/`)) {
    return ADMIN_HOME_PATH;
  }
  // A login page is never a useful destination after logging in.
  if (raw.startsWith("/admin/login")) return ADMIN_HOME_PATH;

  return raw;
}

/** The `?next` to attach when sending an unauthenticated visitor to the form. */
export function loginPathFor(currentPath: string): string {
  const next = resolveAdminRedirect(currentPath);
  return next === ADMIN_HOME_PATH
    ? "/admin/login"
    : `/admin/login?next=${encodeURIComponent(next)}`;
}
