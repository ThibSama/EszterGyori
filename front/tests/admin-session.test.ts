import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_HOME_PATH,
  isSessionExpiry,
  loginPathFor,
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
