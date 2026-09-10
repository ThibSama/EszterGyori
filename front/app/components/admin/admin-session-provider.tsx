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

/**
 * A gate screen: shown *instead of* the admin shell, never inside it.
 *
 * That is why it declares `admin-theme` itself (ESZ-158). The scope is applied
 * by `AdminShell`, and this notice replaces the shell rather than sitting under
 * it, so inheriting is not available — the alternative would be a screen in the
 * public palette in the middle of the back-office.
 */
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
    <main className="admin-theme admin-canvas min-h-screen px-4 py-10 sm:px-6">
      <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center">
        <div
          role="status"
          aria-live="polite"
          className="admin-panel rounded-3xl p-6 sm:p-8">
          <h1 className="admin-text font-display text-2xl font-light">
            {title}
          </h1>
          <p className="admin-text-muted mt-3 text-sm leading-relaxed">{children}</p>
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
            className="admin-btn-primary inline-flex w-full items-center justify-center rounded-full px-5 py-3 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300">
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
            className="admin-btn-primary inline-flex w-full items-center justify-center rounded-full px-5 py-3 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300">
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
          className="admin-theme admin-canvas fixed inset-0 z-[60] overflow-y-auto px-4 py-10 sm:px-6">
          <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center">
            <div className="admin-panel rounded-3xl p-6 sm:p-8">
              <h1 className="admin-text font-display text-2xl font-light">
                {ADMIN_SESSION_MESSAGES.logoutFailedTitle}
              </h1>
              <p className="admin-text-muted mt-3 text-sm leading-relaxed">
                {ADMIN_SESSION_MESSAGES.logoutFailed}
              </p>
              <div className="mt-6 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void signOut();
                  }}
                  className="admin-btn-primary inline-flex w-full items-center justify-center rounded-full px-5 py-3 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300">
                  {ADMIN_SESSION_MESSAGES.logoutRetry}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    dispatchLogout({ type: "logout-dismissed" });
                  }}
                  className="admin-btn-secondary inline-flex w-full items-center justify-center rounded-full px-5 py-3 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300">
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

/**
 * The signed-in identity and the sign-out control, rendered in the lower band of
 * the admin chrome, between “Besoin d’aide” and “Paramètres” (ESZ-154).
 *
 * One row while the chrome is a banner — the band it sits in scrolls
 * horizontally, so the pair costs one line rather than two — and a stacked block
 * at `lg`, where the chrome is a 16rem sidebar and an email beside a button would
 * overflow the column.
 */
export function AdminSessionBadge() {
  const { email, signOut, signOutPending } = useAdminSession();

  return (
    <div className="flex min-w-0 flex-row items-center gap-2 lg:flex-col lg:items-stretch">
      {/* Visible at every width, including the narrowest chrome: an operator who
          can sign out has to be able to see *which* account they are signing out
          of, and `sr-only` would answer that for assistive technology only.
          Below `sm` it is a bounded, truncated line beside the control — the
          widest it can be while staying inside a 375 px viewport rather than
          scrolled off the end of the band — and the full address stays in the
          DOM, so the accessibility tree and a hover both still carry it whole. */}
      <span
        className="admin-text-muted block min-w-0 max-w-[8rem] truncate text-xs leading-tight sm:max-w-none sm:text-sm sm:leading-normal"
        title={email}
        data-testid="admin-account-email">
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
        className="admin-btn-secondary inline-flex shrink-0 items-center justify-center rounded-full px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sage-300 disabled:cursor-not-allowed">
        {signOutPending ? ADMIN_SESSION_MESSAGES.logoutPending : "Se déconnecter"}
      </button>
    </div>
  );
}
