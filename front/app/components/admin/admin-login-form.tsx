"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createAdminApiClient } from "../../lib/admin-api";
import {
  ADMIN_SESSION_MESSAGES,
  resolveAdminRedirect,
  toSessionState,
  type AdminSessionState,
} from "../../lib/admin-session";

/**
 * `/admin/login` — the real form (ESZ-034).
 *
 * What stood here was a placeholder that said, correctly, that nothing in the
 * browser could sign anyone in. Package 2.2 built the half that had to come
 * first: `/api/auth/login` verifies the password in PHP, creates a server-side
 * session with an opaque id, rotates that id on success and mints a fresh CSRF
 * token. This form is the caller of that endpoint and nothing more — it verifies
 * nothing, stores no credential, and holds no authority of its own.
 *
 * ## Why it reads the session before it can post
 *
 * `csrf.requiredOn` includes login itself, and the token is bound to a session —
 * anonymous is fine, absent is not. So the first thing the page does is
 * `GET /api/auth/session`, which both reports whether the visitor is *already*
 * signed in and creates the anonymous session the token hangs off. Posting
 * credentials before that returns 403 with no session to bind to, which would
 * look to an admin exactly like a wrong password.
 *
 * ## What each failure is allowed to say
 *
 * 401 is one message for unknown e-mail, wrong password and disabled account,
 * because `loginFailure.requirements` makes the three indistinguishable on the
 * wire and a form that guessed between them would undo that. 403 is the token
 * going stale — the session outlived the token, which happens after an idle tab
 * or a rotation — so the form re-reads the session and asks for one retry rather
 * than reporting a credential problem that did not happen.
 *
 * Login throttling is explicitly out of scope for this package and is not
 * implemented on either side; `docs/hetzner-target-architecture.md` §6 still asks
 * for it server-side, which is the only place it can work.
 */

const LOGIN_FORM_MESSAGES = {
  submitting: "Connexion en cours…",
  alreadySignedIn: "Vous êtes déjà connecté.",
  retryCsrf:
    "La session de sécurité a été renouvelée. Renvoyez le formulaire pour vous connecter.",
  missingFields: "Renseignez votre adresse email et votre mot de passe.",
} as const;

export function AdminLoginForm() {
  const api = useMemo(() => createAdminApiClient(), []);
  const [session, setSession] = useState<AdminSessionState>({ status: "loading" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const readSession = useCallback(async (): Promise<AdminSessionState> => {
    const result = await api.readSession();
    const next: AdminSessionState = result.ok
      ? toSessionState(result.value)
      : { status: "unavailable", message: result.failure.message };

    if (mountedRef.current) setSession(next);
    return next;
  }, [api]);

  useEffect(() => {
    mountedRef.current = true;
    void readSession();
    return () => {
      mountedRef.current = false;
    };
  }, [readSession]);

  /**
   * The destination after a successful login.
   *
   * Read at submit time rather than at mount, and passed through
   * `resolveAdminRedirect`, which only accepts an absolute path inside `/admin`.
   * `?next` arrives in a URL that can be mailed to an admin, so an unsanitised
   * one turns this form into an open redirect that happens to check a password
   * first.
   */
  function destination(): string {
    if (typeof window === "undefined") return "/admin";
    return resolveAdminRedirect(
      new URLSearchParams(window.location.search).get("next"),
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    if (email.trim() === "" || password === "") {
      setErrorMessage(LOGIN_FORM_MESSAGES.missingFields);
      return;
    }

    // A token is required to post at all. If the bootstrap read failed there is
    // none, so the read is retried here instead of sending a request that is
    // certain to be refused for a reason the admin cannot act on.
    let current = session;
    if (current.status !== "anonymous" && current.status !== "authenticated") {
      current = await readSession();
    }
    if (current.status !== "anonymous" && current.status !== "authenticated") {
      setErrorMessage(
        current.status === "unavailable"
          ? current.message
          : ADMIN_SESSION_MESSAGES.loading,
      );
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    setNoticeMessage(LOGIN_FORM_MESSAGES.submitting);

    const result = await api.login(
      { email: email.trim(), password },
      current.csrfToken,
    );

    if (!mountedRef.current) return;

    if (result.ok) {
      // The credential is dropped before navigating; nothing keeps it in a React
      // tree that a devtools inspection or an error overlay could surface.
      setPassword("");
      setSubmitting(false);
      window.location.assign(destination());
      return;
    }

    setSubmitting(false);
    setNoticeMessage(null);

    if (result.failure.kind === "forbidden") {
      await readSession();
      if (!mountedRef.current) return;
      setErrorMessage(LOGIN_FORM_MESSAGES.retryCsrf);
      return;
    }

    setErrorMessage(result.failure.message);
  }

  const alreadySignedIn = session.status === "authenticated";

  return (
    <main className="min-h-screen bg-warm-50 px-4 py-10 text-warm-800 sm:px-6">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md flex-col justify-center">
        <div className="rounded-3xl border border-warm-200 bg-white/85 p-6 shadow-[0_18px_60px_rgba(44,43,40,0.10)] backdrop-blur sm:p-8">
          <div className="mb-8 space-y-2">
            <p className="text-sm font-medium uppercase tracking-wide text-sage-600">
              Administration
            </p>
            <h1 className="font-display text-3xl font-light text-warm-900">
              Connexion
            </h1>
          </div>

          {alreadySignedIn ? (
            <div className="space-y-6">
              <p
                role="status"
                className="rounded-xl border border-sage-200 bg-sage-50 px-4 py-3 text-sm leading-relaxed text-warm-700">
                {LOGIN_FORM_MESSAGES.alreadySignedIn}
              </p>
              <Link
                href="/admin"
                className="inline-flex w-full items-center justify-center rounded-full bg-warm-900 px-5 py-3 text-sm font-medium text-porcelain transition hover:bg-warm-700 focus:outline-none focus:ring-2 focus:ring-sage-300">
                Ouvrir l&apos;éditeur
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5" noValidate>
              <div className="space-y-1.5">
                <label
                  htmlFor="admin-login-email"
                  className="block text-sm font-medium text-warm-800">
                  Adresse email
                </label>
                <input
                  id="admin-login-email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="w-full rounded-xl border border-warm-200 bg-white px-3 py-2.5 text-sm text-warm-900 focus:border-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-200"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="admin-login-password"
                  className="block text-sm font-medium text-warm-800">
                  Mot de passe
                </label>
                <input
                  id="admin-login-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-xl border border-warm-200 bg-white px-3 py-2.5 text-sm text-warm-900 focus:border-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-200"
                />
              </div>

              {errorMessage && (
                <p
                  role="alert"
                  className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {errorMessage}
                </p>
              )}

              {noticeMessage && !errorMessage && (
                <p
                  role="status"
                  aria-live="polite"
                  className="rounded-xl border border-warm-200 bg-warm-50 px-3 py-2 text-sm text-warm-700">
                  {noticeMessage}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="inline-flex w-full items-center justify-center rounded-full bg-warm-900 px-5 py-3 text-sm font-medium text-porcelain transition hover:bg-warm-700 focus:outline-none focus:ring-2 focus:ring-sage-300 disabled:cursor-not-allowed disabled:opacity-60">
                {submitting ? LOGIN_FORM_MESSAGES.submitting : "Se connecter"}
              </button>
            </form>
          )}

          <Link
            href="/"
            className="mt-6 inline-flex text-sm font-medium text-sage-700 transition hover:text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300">
            Retour au site public
          </Link>
        </div>
      </div>
    </main>
  );
}
