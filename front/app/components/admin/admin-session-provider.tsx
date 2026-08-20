"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { createAdminApiClient, type AdminApiClient } from "../../lib/admin-api";
import {
  ADMIN_SESSION_MESSAGES,
  loginPathFor,
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
  signOut: () => Promise<void>;
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
  const mountedRef = useRef(true);

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
    // The response is not branched on: a logout that fails server-side is still a
    // logout the admin asked for, and the next privileged call will 401 anyway.
    // What must not happen is the UI staying signed in after the request.
    await api.logout(state.csrfToken);
    if (!mountedRef.current) return;
    window.location.assign("/admin/login");
  }, [api, state]);

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
    <AdminSessionContext.Provider
      value={{
        api,
        csrfToken: state.csrfToken,
        email: state.email,
        markExpired,
        refreshSession: read,
        signOut,
      }}>
      {children}
    </AdminSessionContext.Provider>
  );
}

/** The signed-in identity and the sign-out control, rendered in the admin chrome. */
export function AdminSessionBadge() {
  const { email, signOut } = useAdminSession();

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
        className="inline-flex items-center justify-center rounded-full border border-warm-300 bg-white/75 px-4 py-2 text-sm font-medium text-warm-700 transition hover:bg-white hover:text-warm-900 focus:outline-none focus:ring-2 focus:ring-sage-300">
        Se déconnecter
      </button>
    </div>
  );
}
