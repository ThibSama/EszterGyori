import type { AuthSessionResponse } from "@eszter/contracts";
import {
  ADMIN_API_MESSAGES,
  type AdminApiFailure,
  type AdminApiResult,
} from "./admin-api";

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
  /**
   * ESZ-101: the surface shown when the server did not confirm a logout.
   *
   * The wording never claims the session was revoked — in every failure that
   * reaches this surface (network, server error, refused CSRF) the revocation
   * did not happen or was not confirmed, and the admin must not walk away from
   * a device believing a session that may still authorise was ended.
   */
  logoutFailedTitle: "Déconnexion impossible",
  logoutFailed:
    "La déconnexion n’a pas abouti. Ne considérez pas cette session comme révoquée : réessayez, ou continuez à travailler.",
  logoutRetry: "Réessayer la déconnexion",
  logoutDismiss: "Continuer à travailler",
  logoutPending: "Déconnexion en cours…",
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

// --- ESZ-101: failure-honest sign-out -------------------------------------

/**
 * What the UI may conclude from one `POST /api/auth/logout` result.
 *
 * Only two answers exist. The server confirmed the session is over — either by
 * revoking it (2xx) or by saying there was nothing to revoke (401) — and the UI
 * leaves the authenticated surface. Everything else (network, server failure,
 * refused CSRF, an unreadable response) means the server did **not** confirm a
 * revocation, and the only honest UI is to stay signed in and offer a retry:
 * navigating away would tell the admin a session that may still authorise was
 * ended, and a subsequent 401 on the login page's own reads would make the
 * signed-out claim retroactively true without the server ever having revoked.
 */
export type LogoutOutcome =
  | { action: "leave"; reason: "server-confirmed" | "already-signed-out" }
  | { action: "stay" };

export function outcomeOfLogout(result: AdminApiResult<null>): LogoutOutcome {
  if (result.ok) return { action: "leave", reason: "server-confirmed" };

  // 401 `UNAUTHENTICATED` is the server saying no live session existed: the
  // logout the admin asked for is already the server-side state, so the client
  // reconciles itself as signed out rather than reporting an error.
  if (result.failure.kind === "unauthenticated") {
    return { action: "leave", reason: "already-signed-out" };
  }

  return { action: "stay" };
}

/**
 * The client-side lifecycle of one sign-out request.
 *
 * `in-flight` exists so that two clicks cannot race two logout requests — a
 * duplicate submission is not a second chance at a first failure, and a
 * revocation racing a revocation is how a session id comes back to life.
 */
export type AdminLogoutUiState =
  | { status: "idle" }
  | { status: "in-flight" }
  | { status: "failed" };

export type AdminLogoutAction =
  | { type: "logout-attempt" }
  | { type: "logout-failed" }
  | { type: "logout-dismissed" };

export const INITIAL_LOGOUT_UI_STATE: AdminLogoutUiState = { status: "idle" };

export function logoutUiReducer(
  state: AdminLogoutUiState,
  action: AdminLogoutAction,
): AdminLogoutUiState {
  switch (action.type) {
    case "logout-attempt":
      // An attempt already in flight is never doubled: the second click leaves
      // the first request running instead of starting a second one.
      return state.status === "in-flight" ? state : { status: "in-flight" };

    case "logout-failed":
      return { status: "failed" };

    case "logout-dismissed":
      return { status: "idle" };

    default:
      return state;
  }
}

/** Whether a logout request may be started at all. */
export function canStartLogout(state: AdminLogoutUiState): boolean {
  return state.status !== "in-flight";
}
