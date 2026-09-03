import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ADMIN_HOME_PATH,
  ADMIN_SESSION_MESSAGES,
  canStartLogout,
  INITIAL_LOGOUT_UI_STATE,
  isSessionExpiry,
  loginPathFor,
  logoutUiReducer,
  outcomeOfLogout,
  resolveAdminRedirect,
  sessionStateFromFailure,
  toSessionState,
} from "../app/lib/admin-session";

/**
 * ESZ-034 — the session bootstrap, as the browser is allowed to understand it.
 *
 * None of this is access control. What it decides is what to *render*, and the
 * cases below are the ones where rendering the wrong thing has a cost: showing an
 * editor to someone with no session, signing someone out of a live session over a
 * recoverable error, or turning a mailed `?next` into an open redirect.
 */

test("a signed-in session yields the identity the chrome renders", () => {
  const state = toSessionState({
    authenticated: true,
    account: { email: "admin@example.com", lastLoginAt: "2026-08-20T09:00:00.000Z" },
    csrfToken: "b".repeat(43),
  });

  assert.equal(state.status, "authenticated");
  if (state.status !== "authenticated") return;
  assert.equal(state.email, "admin@example.com");
  assert.equal(state.csrfToken, "b".repeat(43));
});

test("an anonymous session still yields the token the login form needs", () => {
  const state = toSessionState({
    authenticated: false,
    account: null,
    csrfToken: "c".repeat(43),
  });

  assert.equal(state.status, "anonymous");
  if (state.status !== "anonymous") return;
  // `csrf.requiredOn` includes login itself, so an anonymous session that
  // carried no usable token would make signing in impossible.
  assert.equal(state.csrfToken, "c".repeat(43));
});

test("authenticated with no account is not treated as signed in", () => {
  // The schema permits the combination and the server never emits it. Trusting
  // the flag over the thing it describes would put an empty identity in the
  // admin chrome on a privileged screen.
  const state = toSessionState({
    authenticated: true,
    account: null,
    csrfToken: "d".repeat(43),
  });

  assert.equal(state.status, "anonymous");
});

test("only a 401 ends the browser's idea of the session", () => {
  assert.equal(
    isSessionExpiry({ kind: "unauthenticated", message: "x" }),
    true,
  );
  // A stale CSRF token is a live session with an old token. Signing the admin
  // out here would lose unsaved work over something one refresh fixes.
  assert.equal(isSessionExpiry({ kind: "forbidden", message: "x" }), false);
  assert.equal(isSessionExpiry({ kind: "network", message: "x" }), false);
  assert.equal(
    isSessionExpiry({ kind: "conflict", message: "x", currentRevision: 3 }),
    false,
  );
});

test("a failed session read leaves the admin area unavailable, not signed in", () => {
  const state = sessionStateFromFailure({ kind: "network", message: "injoignable" });

  assert.equal(state.status, "unavailable");
  if (state.status !== "unavailable") return;
  assert.equal(state.message, "injoignable");
});

test("a rate-limited session read leaves the admin area unavailable, never signed in or out", () => {
  // ESZ-130: a 429 on the anonymous bootstrap means \"ask again later\", not
  // \"you have no session\" — the caller may simply have no cookie yet. The
  // provider renders this as the unavailable notice with a manual retry
  // button; there is no automatic retry anywhere on this path.
  const state = sessionStateFromFailure({
    kind: "rate-limited",
    message: ADMIN_SESSION_MESSAGES.signedOut,
    retryAfterSeconds: null,
  });

  assert.equal(state.status, "unavailable");
  if (state.status !== "unavailable") return;
  assert.equal(state.message, ADMIN_SESSION_MESSAGES.signedOut);
  assert.equal(
    isSessionExpiry({ kind: "rate-limited", message: "x", retryAfterSeconds: null }),
    false,
  );
});

test("the post-login destination cannot leave the admin area", () => {
  assert.equal(resolveAdminRedirect("/admin/preview"), "/admin/preview");
  assert.equal(resolveAdminRedirect("/admin"), ADMIN_HOME_PATH);

  // `?next` arrives in a URL that can be mailed to an admin. Each of these is a
  // navigation off-origin that a naive `assign()` would perform after checking a
  // password, which is exactly what makes it worth phishing.
  assert.equal(resolveAdminRedirect("//evil.example/"), ADMIN_HOME_PATH);
  assert.equal(resolveAdminRedirect("/\\evil.example/"), ADMIN_HOME_PATH);
  assert.equal(resolveAdminRedirect("https://evil.example/"), ADMIN_HOME_PATH);
  assert.equal(resolveAdminRedirect("javascript:alert(1)"), ADMIN_HOME_PATH);
  assert.equal(resolveAdminRedirect("/administration-externe"), ADMIN_HOME_PATH);
  assert.equal(resolveAdminRedirect(null), ADMIN_HOME_PATH);
  assert.equal(resolveAdminRedirect(""), ADMIN_HOME_PATH);

  // Sending a freshly signed-in admin back to the login form is a loop.
  assert.equal(resolveAdminRedirect("/admin/login"), ADMIN_HOME_PATH);
  assert.equal(resolveAdminRedirect("/admin/login?next=/admin"), ADMIN_HOME_PATH);
});

test("the login link carries only a destination it would accept back", () => {
  assert.equal(loginPathFor("/admin"), "/admin/login");
  assert.equal(
    loginPathFor("/admin/preview"),
    `/admin/login?next=${encodeURIComponent("/admin/preview")}`,
  );
  assert.equal(loginPathFor("https://evil.example/"), "/admin/login");
});

// --- ESZ-101: failure-honest sign-out -------------------------------------

test("a confirmed logout leaves the authenticated surface", () => {
  assert.deepEqual(outcomeOfLogout({ ok: true, value: null }), {
    action: "leave",
    reason: "server-confirmed",
  });
});

test("an already-401 logout reconciles as signed out and leaves", () => {
  // The server said there is no live session to revoke: the state the admin
  // asked for is already the server-side state, so leaving is not a lie.
  assert.deepEqual(
    outcomeOfLogout({
      ok: false,
      failure: { kind: "unauthenticated", message: "session expirée" },
    }),
    { action: "leave", reason: "already-signed-out" },
  );
});

test("an unconfirmed logout stays and never claims a signed-out state", () => {
  // Every failure that is not a 401 means the server did not confirm the
  // revocation. The only honest answers are "stay" — no navigation, no
  // signed-out screen, no claim that anything was revoked.
  for (const failure of [
    { kind: "network", message: "injoignable" },
    { kind: "server", message: "erreur", status: 500 },
    { kind: "forbidden", message: "csrf" },
    { kind: "malformed-response", message: "inexploitable" },
    { kind: "conflict", message: "conflit", currentRevision: null },
    { kind: "validation", message: "refusé" },
  ] as const) {
    assert.equal(outcomeOfLogout({ ok: false, failure }).action, "stay");
  }
});

test("the retryable failure copy never claims the session was revoked", () => {
  assert.equal(
    ADMIN_SESSION_MESSAGES.logoutFailed,
    "La déconnexion n’a pas abouti. Ne considérez pas cette session comme révoquée : réessayez, ou continuez à travailler.",
  );
  // The visible controls the failure surface offers: retry, or go back to work.
  assert.equal(ADMIN_SESSION_MESSAGES.logoutRetry, "Réessayer la déconnexion");
  assert.equal(ADMIN_SESSION_MESSAGES.logoutDismiss, "Continuer à travailler");
  assert.equal(ADMIN_SESSION_MESSAGES.logoutFailedTitle, "Déconnexion impossible");
});

test("a sign-out attempt already in flight is never doubled", () => {
  const inFlight = logoutUiReducer(INITIAL_LOGOUT_UI_STATE, {
    type: "logout-attempt",
  });
  assert.equal(inFlight.status, "in-flight");
  assert.equal(canStartLogout(inFlight), false);

  // A second attempt while the first is running changes nothing: the reducer
  // returns the very same state, so the caller has nothing new to act on.
  assert.strictEqual(
    logoutUiReducer(inFlight, { type: "logout-attempt" }),
    inFlight,
  );
});

test("a failed logout surfaces a retryable error and a fresh retry is allowed", () => {
  const failed = logoutUiReducer(
    logoutUiReducer(INITIAL_LOGOUT_UI_STATE, { type: "logout-attempt" }),
    { type: "logout-failed" },
  );
  assert.equal(failed.status, "failed");
  // The failure state is not "in-flight", so the retry control can act.
  assert.equal(canStartLogout(failed), true);

  const retried = logoutUiReducer(failed, { type: "logout-attempt" });
  assert.equal(retried.status, "in-flight");
});

test("dismissing a failed logout returns to a quiet state", () => {
  const failed = logoutUiReducer(
    logoutUiReducer(INITIAL_LOGOUT_UI_STATE, { type: "logout-attempt" }),
    { type: "logout-failed" },
  );
  const dismissed = logoutUiReducer(failed, { type: "logout-dismissed" });
  assert.equal(dismissed.status, "idle");
  assert.equal(canStartLogout(dismissed), true);
});

// --- ESZ-136: the login form consumes a rate-limited refusal distinctly ----

const loginForm = readFileSync(
  join(process.cwd(), "app", "components", "admin", "admin-login-form.tsx"),
  "utf8",
);

test("a rate-limited login refusal is its own branch with the bounded deadline", () => {
  // The 429 is consumed separately from credential failures (401) and stale
  // CSRF (403): it opens the retry gate from the frozen Retry-After and shows
  // the rate-limit message, never a credential or CSRF copy.
  assert.match(
    loginForm,
    /if \(result\.failure\.kind === "rate-limited"\)/,
  );
  assert.match(
    loginForm,
    /retryAllowedAtEpochMs\(now, result\.failure\.retryAfterSeconds\)/,
  );
  assert.match(loginForm, /setErrorMessage\(result\.failure\.message\)/);
  // The other failures clear the gate before showing their own copy.
  assert.match(loginForm, /setRetryAllowedUntil\(null\)/);
  assert.match(loginForm, /failure\.kind === "forbidden"/);
  // A refused login must not be routed through the stale-CSRF recovery (the
  // forbidden branch re-reads the session) — the 429 branch only arms the
  // gate and shows the rate-limit copy.
  const rateLimitedBranchStart = loginForm.indexOf('if (result.failure.kind === "rate-limited")');
  const rateLimitedBranch = loginForm.slice(
    rateLimitedBranchStart,
    loginForm.indexOf("setRetryAllowedUntil(null)", rateLimitedBranchStart),
  );
  assert.doesNotMatch(rateLimitedBranch, /readSession/);
  assert.match(rateLimitedBranch, /retryAllowedAtEpochMs\(/);
});

test("the login cannot be resubmitted while the trusted delay runs", () => {
  // The handler refuses to submit while the gate is closed, and the button is
  // disabled with it — two independent guards, so a click in the same tick as
  // the render cannot slip through.
  assert.match(loginForm, /isRetryBlocked\(retryAllowedUntil, Date\.now\(\)\)/);
  assert.match(loginForm, /disabled=\{submitting \|\| retryBlocked\}/);
  // While blocked the form announces when the retry becomes possible.
  assert.match(loginForm, /retryCopy/);
  assert.match(loginForm, /retryWaitLabel\(retryAllowedUntil, nowEpochMs\)/);
  assert.match(loginForm, /role="status"/);
});

test("expiration re-enables the submit control without any automatic request", () => {
  // The countdown interval only advances the render clock (and clears the
  // gate at expiry): it must never call the API, the session read or the
  // submit handler by itself.
  const intervalBody = loginForm.slice(
    loginForm.indexOf("const interval = window.setInterval"),
    loginForm.indexOf("}, 1000)"),
  );
  assert.match(intervalBody, /setNowEpochMs/);
  assert.doesNotMatch(intervalBody, /login|readSession|submit|handleSubmit|fetch/);
});
