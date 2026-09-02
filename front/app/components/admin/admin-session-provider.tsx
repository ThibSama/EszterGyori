"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { createAdminApiClient, type AdminApiClient } from "../../lib/admin-api";
import {
  ADMIN_SESSION_MESSAGES,
  canStartLogout,
  INITIAL_LOGOUT_UI_STATE,
  loginPathFor,
  logoutUiReducer,
  outcomeOfLogout,
  sessionStateFromFailure,
  toSessionState,
  type AdminSessionState,
} from "../../lib/admin-session";

/**
 * The session bootstrap for everything under `/admin` (ESZ-034).
 *
 * `/admin` is a static file. This provider is *not* the access control for it and
 * cannot be — the check and the thing it guards would both run in the caller's
 * browser. PHP authorises every `/api/admin/*` call per request
 * (`auth.accessControl`), and what this does is narrower and honest: it asks
 * `GET /api/auth/session` who the caller is, so the editor can render for a
 * signed-in admin, refuse to offer buttons to a signed-out one, and hold the CSRF
 * token every write needs.
 *
 * The token lives here, in memory, for the lifetime of the tab. It is never
 * written to `localStorage` — that would survive the session it is bound to and
 * outlive the tab that earned it — and never logged. The session id itself is a
 * `__Host-` cookie no script can read.
 *
 * Children render **only** when the session read said "authenticated". That is a
 * rendering decision, not a security one: it keeps the editor from having to hold
 * a "maybe signed in" state in every callback, while the actual refusal still
 * comes from PHP on each call.
 */

interface AdminSessionContextValue {
  api: AdminApiClient;
  /** The CSRF token bound to the current session; rotated at login. */
  csrfToken: string;
  email: string;
  /**
   * Called when any privileged call returned 401. Flips the whole admin area to
   * the signed-out screen, so a session that died mid-edit cannot leave working
   * buttons behind.
   */
  markExpired: () => void;
  /**
   * Re-reads the session to pick up a rotated CSRF token, which is the documented
   * recovery from a 403 `CSRF_TOKEN_INVALID` on a session that is still alive.
   */
  refreshSession: () => Promise<void>;
  /**
   * Asks the server to end the session and leaves the authenticated surface
   * only when the server confirmed it (ESZ-101): a 2xx or a 401 both mean the
   * session is over server-side, so the UI reconciles and navigates to the
   * login page. Any other outcome keeps the admin on the authenticated surface
   * and shows a retryable error — the UI never claims a revocation the server
   * did not confirm.
   */
  signOut: () => Promise<void>;
  /** True while a sign-out request is in flight; the control is disabled. */
  signOutPending: boolean;
}

const AdminSessionContext = createContext<AdminSessionContextValue | null>(null);

export function useAdminSession(): AdminSessionContextValue {
  const value = useContext(AdminSessionContext);
  if (value === null) {
    throw new Error(
      "useAdminSession must be used inside <AdminSessionProvider>.",
    );
  }
  return value;
}

function AdminNotice({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-warm-50 px-4 py-10 text-warm-800 sm:px-6">
      <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center">
        <div
          role="status"
          aria-live="polite"
          className="rounded-3xl border border-warm-200 bg-white/85 p-6 shadow-[0_18px_60px_rgba(44,43,40,0.10)] backdrop-blur sm:p-8">
          <h1 className="font-display text-2xl font-light text-warm-900">
            {title}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-warm-700">{children}</p>
          {action && <div className="mt-6">{action}</div>}
        </div>
      </div>
    </main>
  );
}

export function AdminSessionProvider({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const api = useMemo(() => createAdminApiClient(), []);
  const [state, setState] = useState<AdminSessionState>({ status: "loading" });
  const [expired, setExpired] = useState(false);
  const [logoutUi, dispatchLogout] = useReducer(
    logoutUiReducer,
    INITIAL_LOGOUT_UI_STATE,
  );
  const mountedRef = useRef(true);
  // The same-tick duplicate-submission guard: the reducer's `in-flight` state
  // stops a second *rendered* attempt, but two clicks in one tick both see the
  // pre-render state; the ref closes that gap.
  const logoutInFlightRef = useRef(false);

  const read = useCallback(async () => {
    const result = await api.readSession();
    if (!mountedRef.current) return;

    setState(
      result.ok ? toSessionState(result.value) : sessionStateFromFailure(result.failure),
    );
  }, [api]);

  useEffect(() => {
    mountedRef.current = true;
    void read();
    return () => {
      mountedRef.current = false;
    };
  }, [read]);

  const markExpired = useCallback(() => {
    setExpired(true);
    setState((current) =>
      current.status === "authenticated"
        ? { status: "anonymous", csrfToken: current.csrfToken }
        : current,
    );
  }, []);

  const signOut = useCallback(async () => {
    if (state.status !== "authenticated") return;
    if (logoutInFlightRef.current || !canStartLogout(logoutUi)) return;

    logoutInFlightRef.current = true;
    dispatchLogout({ type: "logout-attempt" });

    try {
      const result = await api.logout(state.csrfToken);
      if (!mountedRef.current) return;

      const outcome = outcomeOfLogout(result);
      if (outcome.action === "leave") {
        // Server-confirmed, or already signed out server-side: both mean the
        // session is over, so the only honest move is the login page.
        window.location.assign("/admin/login");
        return;
      }

      // The server did not confirm a revocation. Stay on the authenticated
      // surface and show the retryable error: navigating would claim a
      // signed-out state that does not exist server-side.
      dispatchLogout({ type: "logout-failed" });
    } finally {
      logoutInFlightRef.current = false;
    }
  }, [api, logoutUi, state]);

  if (state.status === "loading") {
    return (
      <AdminNotice title="Administration">
        {ADMIN_SESSION_MESSAGES.loading}
      </AdminNotice>
    );
  }

  if (state.status === "unavailable") {
    return (
      <AdminNotice
        title="Serveur injoignable"
        action={
          <button
            type="button"
            onClick={() => {
              setState({ status: "loading" });
              void read();
            }}
            className="inline-flex w-full items-center justify-center rounded-full bg-warm-900 px-5 py-3 text-sm font-medium text-porcelain transition hover:bg-warm-700 focus:outline-none focus:ring-2 focus:ring-sage-300">
            Réessayer
          </button>
        }>
        {state.message}
      </AdminNotice>
    );
  }

  if (state.status !== "authenticated") {
    return (
      <AdminNotice
        title="Connexion requise"
        action={
          <Link
            href={loginPathFor("/admin")}
            className="inline-flex w-full items-center justify-center rounded-full bg-warm-900 px-5 py-3 text-sm font-medium text-porcelain transition hover:bg-warm-700 focus:outline-none focus:ring-2 focus:ring-sage-300">
            Se connecter
          </Link>
        }>
        {expired ? ADMIN_SESSION_MESSAGES.expired : ADMIN_SESSION_MESSAGES.signedOut}
      </AdminNotice>
    );
  }

  return (
    <>
      {logoutUi.status === "failed" && (
        <div
          role="alert"
          className="fixed inset-0 z-[60] overflow-y-auto bg-warm-50/95 px-4 py-10 text-warm-800 sm:px-6">
          <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center">
            <div className="rounded-3xl border border-warm-200 bg-white/85 p-6 shadow-[0_18px_60px_rgba(44,43,40,0.10)] backdrop-blur sm:p-8">
              <h1 className="font-display text-2xl font-light text-warm-900">
                {ADMIN_SESSION_MESSAGES.logoutFailedTitle}
              </h1>
              <p className="mt-3 text-sm leading-relaxed text-warm-700">
                {ADMIN_SESSION_MESSAGES.logoutFailed}
              </p>
              <div className="mt-6 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void signOut();
                  }}
                  className="inline-flex w-full items-center justify-center rounded-full bg-warm-900 px-5 py-3 text-sm font-medium text-porcelain transition hover:bg-warm-700 focus:outline-none focus:ring-2 focus:ring-sage-300">
                  {ADMIN_SESSION_MESSAGES.logoutRetry}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    dispatchLogout({ type: "logout-dismissed" });
                  }}
                  className="inline-flex w-full items-center justify-center rounded-full border border-warm-300 bg-white/75 px-5 py-3 text-sm font-medium text-warm-700 transition hover:bg-white hover:text-warm-900 focus:outline-none focus:ring-2 focus:ring-sage-300">
                  {ADMIN_SESSION_MESSAGES.logoutDismiss}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <AdminSessionContext.Provider
        value={{
          api,
          csrfToken: state.csrfToken,
          email: state.email,
          markExpired,
          refreshSession: read,
          signOut,
          signOutPending: logoutUi.status === "in-flight",
        }}>
        {children}
      </AdminSessionContext.Provider>
    </>
  );
}

/** The signed-in identity and the sign-out control, rendered in the admin chrome. */
export function AdminSessionBadge() {
  const { email, signOut, signOutPending } = useAdminSession();

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <span className="text-sm text-warm-600" data-testid="admin-account-email">
        {email}
      </span>
      <button
        type="button"
        onClick={() => {
          void signOut();
        }}
        disabled={signOutPending}
        aria-disabled={signOutPending}
        aria-busy={signOutPending}
        className="inline-flex items-center justify-center rounded-full border border-warm-300 bg-white/75 px-4 py-2 text-sm font-medium text-warm-700 transition hover:bg-white hover:text-warm-900 focus:outline-none focus:ring-2 focus:ring-sage-300 disabled:cursor-not-allowed disabled:opacity-60">
        {signOutPending ? ADMIN_SESSION_MESSAGES.logoutPending : "Se déconnecter"}
      </button>
    </div>
  );
}
