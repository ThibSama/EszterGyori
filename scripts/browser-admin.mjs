#!/usr/bin/env node
/**
 * ESZ-113 — the project-owned `browser:admin` runner.
 *
 * A real same-origin production-shaped stack (Apache applying the committed
 * generated `.htaccess`, the PHP front controller, an isolated MySQL 8.4)
 * and a real headless Chrome prove the full authenticated editing workflow
 * that `browser:admin` declared but no runner executed:
 *
 *   1. an unauthenticated `/admin` deep link reaches the login gate, by
 *      keyboard (Tab reaches the "Se connecter" CTA, Enter follows it);
 *   2. bad credentials never create authenticated state — the refusal keeps
 *      the session anonymous, writes no `admin_sessions` row with an
 *      account, and the very same form then signs in (the negative/retry
 *      semantic is the existing credential refusal; no new UX contract);
 *   3. valid login reaches protected admin, honours the login `?next`, and
 *      matches a real authenticated session row server-side;
 *   4. an edit to server-backed content saves to the server draft, publishes,
 *      and the real public site then shows the published change (envelope,
 *      draft revision and rendered public page all agree);
 *   5. logout invalidates the server session — the row is gone, the
 *      pre-logout cookie authorises nothing, and a protected reload returns
 *      to the login gate.
 *
 * The same browser also asserts the repository's accessibility contract on
 * the exercised controls: keyboard reachability and a real keyboard-only
 * login, `role=status`/`role=alert` live semantics that actually update,
 * labels bound with `htmlFor`, no contradictory ARIA state on the exercised
 * controls, and 320 px reflow without document overflow where the critical
 * controls stay usable.
 *
 * Requires, like the other browser gates: docker, google-chrome (overridable
 * with ESZTER_BROWSER_ADMIN_CHROME), a built `front/out`, and `php/vendor`.
 * Every container, network, profile and temp file is removed on every exit
 * path; nothing ever leaves 127.0.0.1 and the persistent `eszter_dev`
 * deployment is never touched.
 */

import {
  makeProof,
  startApacheStack,
  launchChrome,
  setViewport,
  navigateAndWait,
  waitFor,
  evaluate,
  setReactInput,
  clickButton,
  pressTab,
  pressEnter,
  typeText,
  activeElement,
  sessionCookie,
  stopProcessQuietly,
} from "./browser-stack.mjs";

const { fail, assert } = makeProof("browser:admin");

const chromeBinary = process.env.ESZTER_BROWSER_ADMIN_CHROME ?? "google-chrome";
const sessionCookieName = "eszter_session"; // non-Secure dev build drops __Host-
const MARKER = "ESZ-113";
let chrome = null;
let stack = null;

async function main() {
  stack = await startApacheStack({ gate: "browser:admin", tag: "esz113admin", chromeBinary });
  const { origin, credentials, workRoot, mysqlExec, mysqlJson } = stack;
  const chromeProfile = `${workRoot}/chrome-profile`;
  const browser = await launchChrome(chromeBinary, chromeProfile);
  chrome = browser.chrome;
  const cdp = browser.cdp;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await setViewport(cdp, 1280, 800);

  const json = async (path, init = {}) => {
    const response = await fetch(`${origin}${path}`, init);
    return { status: response.status, body: await response.json() };
  };
  const gateStateSource = `(() => {
    const cta = [...document.querySelectorAll("a")].find((link) => link.textContent?.trim() === "Se connecter");
    return {
      h1: document.querySelector("h1")?.textContent?.trim() ?? null,
      signedOutCopy: document.body?.innerText?.includes("Vous n’êtes pas connecté. Connectez-vous pour ouvrir l’éditeur.") ?? false,
      ctaHref: cta?.getAttribute("href") ?? null,
      hasCalendar: document.body?.innerText?.includes("Calendrier") ?? false,
      hasEditor: Boolean(document.getElementById("hero-title-suffix")),
    };
  })()`;

  // ── 1. Unauthenticated deep link reaches login, by keyboard ─────────────
  await navigateAndWait(
    cdp,
    `${origin}/admin`,
    "unauthenticated /admin deep link",
    `document.querySelector("h1")?.textContent?.trim() === "Connexion requise"`,
  );
  let gate = await evaluate(cdp, gateStateSource);
  assert(gate.h1 === "Connexion requise", `the /admin deep link did not show the signed-out gate: ${JSON.stringify(gate)}`);
  assert(gate.signedOutCopy, "the signed-out gate copy is missing");
  assert(!gate.hasEditor, "the editor rendered while signed out");
  assert(
    gate.ctaHref === "/admin/login",
    `the gate CTA does not point to login: ${gate.ctaHref}`,
  );
  // Keyboard: Tab reaches the CTA, Enter follows it to the login form.
  await pressTab(cdp);
  const ctaFocus = await activeElement(cdp);
  assert(
    ctaFocus.tag === "a" && ctaFocus.text === "Se connecter",
    `Tab did not reach the Se connecter CTA: ${JSON.stringify(ctaFocus)}`,
  );
  await pressEnter(cdp);
  await waitFor(
    () => evaluate(cdp, `location.pathname === "/admin/login" && Boolean(document.getElementById("admin-login-email"))`),
    "login form after the deep-link CTA",
  );
  const nextParam = await evaluate(cdp, `new URLSearchParams(location.search).get("next")`);
  assert(nextParam === null, `the plain deep-link login carries an unexpected next: ${nextParam}`);
  const loginSemantics = await evaluate(cdp, `(() => ({
    h1: document.querySelector("h1")?.textContent?.trim(),
    emailLabel: Boolean(document.querySelector('label[for="admin-login-email"]')?.textContent?.includes("Adresse email")),
    passwordLabel: Boolean(document.querySelector('label[for="admin-login-password"]')?.textContent?.includes("Mot de passe")),
  }))()`);
  assert(loginSemantics.h1 === "Connexion" && loginSemantics.emailLabel && loginSemantics.passwordLabel, "the login form lost its labelled structure");

  // ── 2. Bad credentials never create authenticated state ─────────────────
  await setReactInput(cdp, "admin-login-email", credentials.email);
  await setReactInput(cdp, "admin-login-password", "mauvais-mot-de-passe-esz113");
  await clickButton(cdp, "Se connecter");
  await waitFor(
    () => evaluate(cdp, `document.body?.innerText?.includes("Adresse email ou mot de passe incorrect")`),
    "bad-credential refusal",
    30_000,
  );
  const refused = await evaluate(cdp, `(() => {
    const alerts = [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent?.trim());
    return { path: location.pathname, alerts };
  })()`);
  assert(refused.path === "/admin/login", "a refused login left the login page");
  assert(
    refused.alerts.some((text) => text?.includes("Adresse email ou mot de passe incorrect")),
    `the refusal is not announced through role=alert: ${JSON.stringify(refused.alerts)}`,
  );
  const refusedCookie = await sessionCookie(cdp, origin, sessionCookieName);
  const refusedSession = await json("/api/auth/session", {
    headers: { accept: "application/json", cookie: refusedCookie },
  });
  assert(refusedSession.body.authenticated === false, "a refused login left authenticated state behind");
  const authenticatedRows = mysqlExec("SELECT COUNT(*) FROM admin_sessions WHERE account_id IS NOT NULL");
  assert(authenticatedRows === "0", `a refused login created ${authenticatedRows} authenticated session row(s)`);

  // 320 px reflow on the login form: no document overflow, usable submit.
  await setViewport(cdp, 320, 720);
  const login320 = await evaluate(cdp, `(() => {
    const html = document.documentElement;
    const submit = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Se connecter");
    const rect = submit?.getBoundingClientRect();
    return {
      scrollWidth: html.scrollWidth,
      clientWidth: html.clientWidth,
      submitUsable: Boolean(rect && rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= html.clientWidth + 1),
    };
  })()`);
  assert(login320.scrollWidth <= login320.clientWidth + 1, `login overflows at 320 px: ${login320.scrollWidth} > ${login320.clientWidth}`);
  assert(login320.submitUsable, "the login submit is not usable at 320 px");
  await setViewport(cdp, 1280, 800);

  // ── 3. Valid login reaches protected admin, honouring the ?next link ────
  // The gate CTA itself lands on the plain login; signing in from a
  // `?next=/admin/bookings` login proves the redirect-after-sign-in honours a
  // protected deep link (the login form's destination is read at submit time).
  await navigateAndWait(
    cdp,
    `${origin}/admin/login?next=${encodeURIComponent("/admin/bookings")}`,
    "deep-link login page",
    `Boolean(document.getElementById("admin-login-email"))`,
  );
  await setReactInput(cdp, "admin-login-email", credentials.email);
  await setReactInput(cdp, "admin-login-password", credentials.password);
  await clickButton(cdp, "Se connecter");
  await waitFor(
    () => evaluate(cdp, `location.pathname === "/admin/bookings" && document.querySelector("h1")?.textContent?.trim() === "Calendrier"`),
    "authenticated deep-link destination (calendar)",
    45_000,
  );
  const signedInBadge = await evaluate(cdp, `document.querySelector('[data-testid="admin-account-email"]')?.textContent?.trim() ?? null`);
  assert(signedInBadge === credentials.email, `the admin chrome does not show the signed-in account: ${signedInBadge}`);
  const liveCookie = await sessionCookie(cdp, origin, sessionCookieName);
  const liveSession = await json("/api/auth/session", {
    headers: { accept: "application/json", cookie: liveCookie },
  });
  assert(
    liveSession.body.authenticated === true && liveSession.body.account?.email === credentials.email,
    "the live session is not authenticated as the provisioned admin",
  );
  const row = mysqlJson(`SELECT JSON_OBJECT('id', id, 'account_id', account_id, 'csrf_token', csrf_token) FROM admin_sessions WHERE account_id IS NOT NULL`);
  assert(row && String(row.account_id).length > 0, "no authenticated admin_sessions row exists after login");
  assert(row.id === liveCookie.split("=")[1], "the session cookie does not name the authenticated session row");
  assert(typeof row.csrf_token === "string" && row.csrf_token.length === 64, "the authenticated row carries no CSRF token");
  await evaluate(cdp, `(() => {
    const link = [...document.querySelectorAll('nav a')].find((candidate) => candidate.textContent?.trim() === "Contenu");
    link?.click();
    return Boolean(link);
  })()`);
  await waitFor(
    () => evaluate(cdp, `location.pathname === "/admin" && Boolean(document.getElementById("hero-title-suffix"))`),
    "content editor from the authenticated chrome",
    45_000,
  );
  const logoutButton = await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Se déconnecter");
    return button ? { disabled: button.disabled, ariaDisabled: button.getAttribute("aria-disabled"), ariaBusy: button.getAttribute("aria-busy") } : null;
  })()`);
  assert(logoutButton && !logoutButton.disabled, "the sign-out control is not present/enabled in the admin chrome");
  assert(
    logoutButton.ariaDisabled === "false" || logoutButton.ariaDisabled === null,
    "the idle sign-out control carries a contradictory aria-disabled",
  );
  const editorSemantics = await evaluate(cdp, `(() => ({
    statusCount: document.querySelectorAll('[role="status"]').length,
    livePoliteCount: [...document.querySelectorAll('[aria-live="polite"]')].length,
  }))()`);
  assert(editorSemantics.statusCount >= 1 && editorSemantics.livePoliteCount >= 1, "the editor exposes no polite status live region");

  // ── 4. Edit server content → save draft → publish → public site shows it ─
  // Revision bookkeeping follows the frozen content semantics
  // (contentRevisionSemantics): the draft head lives in the draft envelope,
  // the published head in the published envelope served by /api/content, and
  // a save advances the draft alone while a publish moves the published head
  // onto the saved draft head.
  const publicBefore = await json("/api/content", { headers: { accept: "application/json" } });
  assert(publicBefore.status === 200, `public content GET returned ${publicBefore.status}`);
  assert(typeof publicBefore.body.revision === "number", "the published envelope carries no revision");
  const publishedHeadBefore = publicBefore.body.revision;
  const suffixBefore = publicBefore.body.content?.hero?.title?.suffix;
  assert(typeof suffixBefore === "string", "the published hero title suffix is not a string");
  const draftBefore = await json("/api/admin/content/draft", {
    headers: { accept: "application/json", cookie: liveCookie },
  });
  assert(draftBefore.status === 200, `draft GET returned ${draftBefore.status}`);
  assert(typeof draftBefore.body.revision === "number", "the draft carries no revision");
  const marker = `${suffixBefore.replace(/\s+$/, "")} ${MARKER}`.trim();
  await setReactInput(cdp, "hero-title-suffix", marker);
  const statusBeforeSave = await evaluate(cdp, `document.querySelector('[role="status"]')?.textContent?.trim() ?? ""`);
  await clickButton(cdp, "Enregistrer le brouillon");
  await waitFor(
    () => evaluate(cdp, `document.querySelector('[data-testid="admin-freshness"]')?.textContent?.trim() === "Brouillon enregistré, non publié"`),
    "server draft save",
    30_000,
  );
  const statusAfterSave = await evaluate(cdp, `(() => {
    const status = document.querySelector('[role="status"]')?.textContent?.trim() ?? "";
    return { status, alertCount: document.querySelectorAll('[role="alert"]').length };
  })()`);
  assert(
    statusAfterSave.status !== statusBeforeSave && statusAfterSave.status.includes("Brouillon enregistré"),
    `the polite live region did not announce the save: before=${JSON.stringify(statusBeforeSave)} after=${JSON.stringify(statusAfterSave.status)}`,
  );
  assert(statusAfterSave.alertCount === 0, "a successful save surfaced an alert");
  const draftSaved = await json("/api/admin/content/draft", {
    headers: { accept: "application/json", cookie: liveCookie },
  });
  assert(draftSaved.status === 200 && draftSaved.body.revision === draftBefore.body.revision + 1, `draft revision did not advance by one: ${draftBefore.body.revision} -> ${draftSaved.body.revision}`);
  assert(draftSaved.body.content.hero.title.suffix === marker, "the saved draft does not carry the edited suffix");
  const publicAfterSave = await json("/api/content", { headers: { accept: "application/json" } });
  assert(publicAfterSave.status === 200, "public content GET after the save failed");
  assert(publicAfterSave.body.revision === publishedHeadBefore, "the draft save moved the published head");
  assert(publicAfterSave.body.content.hero.title.suffix === suffixBefore, "the draft save already reached the public content");

  await evaluate(cdp, `window.confirm = () => true`);
  await clickButton(cdp, "Publier");
  await waitFor(
    () => evaluate(cdp, `document.querySelector('[data-testid="admin-freshness"]')?.textContent?.trim() === "Publié"`),
    "publication",
    30_000,
  );
  const publishedAfter = await json("/api/content", { headers: { accept: "application/json" } });
  assert(publishedAfter.body.content.hero.title.suffix === marker, "the published envelope does not carry the edited suffix");
  assert(publishedAfter.body.revision === draftSaved.body.revision, "the published head does not match the saved draft revision after publish");

  // The real public site now shows the published change (fresh navigation).
  await navigateAndWait(cdp, `${origin}/`, "public site after publication", `Boolean(document.querySelector("h1"))`);
  const publicH1 = await evaluate(cdp, `document.querySelector("h1")?.textContent?.trim() ?? ""`);
  assert(publicH1.includes(MARKER), `the public page does not show the published change; h1: ${publicH1.slice(0, 160)}`);

  // 320 px reflow on the authenticated editor.
  await navigateAndWait(cdp, `${origin}/admin`, "editor for 320 px reflow", `Boolean(document.getElementById("hero-title-suffix"))`);
  await setViewport(cdp, 320, 720);
  const editor320 = await evaluate(cdp, `(() => {
    const html = document.documentElement;
    const usable = (label) => {
      const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
      const rect = button?.getBoundingClientRect();
      return Boolean(rect && rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= html.clientWidth + 1);
    };
    return { scrollWidth: html.scrollWidth, clientWidth: html.clientWidth, saveUsable: usable("Enregistrer le brouillon"), publishUsable: usable("Publier") };
  })()`);
  assert(editor320.scrollWidth <= editor320.clientWidth + 1, `the editor overflows at 320 px: ${editor320.scrollWidth} > ${editor320.clientWidth}`);
  assert(editor320.saveUsable && editor320.publishUsable, "the editor's critical controls are not usable at 320 px");
  await setViewport(cdp, 1280, 800);

  // ── 5. Logout invalidates the server session; reload returns to login ───
  await clickButton(cdp, "Se déconnecter");
  await waitFor(
    () => evaluate(cdp, `location.pathname === "/admin/login" && Boolean(document.getElementById("admin-login-email"))`),
    "logout landing on the login form",
    30_000,
  );
  const authenticatedRowsAfterLogout = mysqlExec("SELECT COUNT(*) FROM admin_sessions WHERE account_id IS NOT NULL");
  assert(authenticatedRowsAfterLogout === "0", `logout left ${authenticatedRowsAfterLogout} authenticated session row(s) behind`);
  const staleRowCount = mysqlExec(`SELECT COUNT(*) FROM admin_sessions WHERE id = '${liveCookie.split("=")[1]}'`);
  assert(staleRowCount === "0", "the pre-logout session row survived the logout");
  const staleSession = await json("/api/auth/session", {
    headers: { accept: "application/json", cookie: liveCookie },
  });
  assert(staleSession.body.authenticated === false, "the pre-logout cookie still authorises after logout");

  // A protected reload returns to the login gate, never to protected content.
  await navigateAndWait(cdp, `${origin}/admin/bookings`, "protected reload after logout", `document.querySelector("h1")?.textContent?.trim() === "Connexion requise"`);
  gate = await evaluate(cdp, gateStateSource);
  assert(gate.h1 === "Connexion requise" && !gate.hasCalendar, "a protected reload rendered protected content after logout");
  assert(gate.ctaHref === "/admin/login", "the post-logout gate has no path back to login");
  await evaluate(cdp, `(() => {
    const cta = [...document.querySelectorAll("a")].find((link) => link.textContent?.trim() === "Se connecter");
    cta?.click();
    return Boolean(cta);
  })()`);
  await waitFor(
    () => evaluate(cdp, `location.pathname === "/admin/login" && Boolean(document.getElementById("admin-login-email"))`),
    "login form after the post-logout gate",
  );

  // Keyboard-only login: Tab to each field, real typing, Enter on the submit.
  await pressTab(cdp);
  const emailFocus = await activeElement(cdp);
  assert(emailFocus.id === "admin-login-email", `Tab did not reach the email field: ${JSON.stringify(emailFocus)}`);
  await typeText(cdp, credentials.email);
  await waitFor(
    () => evaluate(cdp, `document.getElementById("admin-login-email")?.value === ${JSON.stringify(credentials.email)}`),
    "keyboard-typed email",
  );
  await pressTab(cdp);
  const passwordFocus = await activeElement(cdp);
  assert(passwordFocus.id === "admin-login-password", `Tab did not reach the password field: ${JSON.stringify(passwordFocus)}`);
  await typeText(cdp, credentials.password);
  await waitFor(
    () => evaluate(cdp, `document.getElementById("admin-login-password")?.value === ${JSON.stringify(credentials.password)}`),
    "keyboard-typed password",
  );
  await pressTab(cdp);
  const submitFocus = await activeElement(cdp);
  assert(submitFocus.tag === "button" && submitFocus.text === "Se connecter", `Tab did not reach the submit button: ${JSON.stringify(submitFocus)}`);
  await pressEnter(cdp);
  try {
    await waitFor(
      () => evaluate(cdp, `location.pathname === "/admin" && Boolean(document.getElementById("hero-title-suffix"))`),
      "keyboard-only login reaching the editor",
      45_000,
    );
  } catch (loginError) {
    const state = await evaluate(cdp, `JSON.stringify({
      path: location.pathname,
      bodyHead: (document.body?.innerText ?? "").slice(0, 400),
      focused: (() => { const e = document.activeElement; return e ? (e.id || e.tagName) : null; })(),
      emailValue: document.getElementById("admin-login-email")?.value ?? null,
    })`);
    throw new Error(`${loginError.message}; page state: ${state}`);
  }
  const badgeAfterKeyboardLogin = await evaluate(cdp, `document.querySelector('[data-testid="admin-account-email"]')?.textContent?.trim() ?? null`);
  assert(badgeAfterKeyboardLogin === credentials.email, "keyboard login did not reach the authenticated chrome");

  cdp.close();
  process.stdout.write("browser:admin proof: PASS\n");
  process.stdout.write("deep link: /admin (anonymous) -> keyboard CTA -> /admin/login; sign-in from ?next=/admin/bookings lands on the calendar\n");
  process.stdout.write("bad credentials: refused indistinguishably via role=alert, 0 authenticated session rows, session stayed anonymous; the same form then signed in\n");
  process.stdout.write(`valid login: session row ${row.id.slice(0, 8)}… matches the cookie, badge = ${credentials.email}, protected calendar reached\n`);
  process.stdout.write(`content workflow: hero suffix -> "${marker}" saved (revision ${draftBefore.body.revision} -> ${draftSaved.body.revision}; published head before: ${publishedHeadBefore}), published, public page shows ${MARKER}\n`);
  process.stdout.write("logout: 0 authenticated session rows, pre-logout cookie authenticated=false, protected reload -> login gate; keyboard-only login reached the editor\n");
  process.stdout.write("accessibility: CTA keyboard-reachable, live regions updated on save, labels bound, no contradictory ARIA, 320 px login+editor without overflow\n");
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
} finally {
  try {
    stopProcessQuietly(chrome);
    stack?.cleanup();
  } catch (cleanupError) {
    process.stderr.write(`browser:admin cleanup failed: ${cleanupError.message}\n`);
  }
}

if (failure) {
  process.stderr.write(`${failure.stack ?? failure}\n`);
  process.exit(1);
}
