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
 *   4. the CMS at `/admin/content` is a focused editor (ESZ-156): one section
 *      editable at a time with the others absent from the document, an edit that
 *      survives navigating to another section and back, a live preview that
 *      shows it before anything is saved, an explicit preview mode below the
 *      desktop layout, and no write to the server caused by any of it;
 *   5. an edit to server-backed content saves to the server draft, publishes,
 *      and the real public site then shows the published change (envelope,
 *      draft revision and rendered public page all agree);
 *   6. logout invalidates the server session — the row is gone, the
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
  screenshot,
  sessionCookie,
  stopProcessQuietly,
} from "./browser-stack.mjs";

const { fail, assert } = makeProof("browser:admin");

/**
 * Captures the current route at desktop and at 375 px, then restores the desktop
 * viewport. Each resize is awaited rather than assumed, so the narrow shot is
 * never the desktop layout caught mid-reflow.
 */
async function captureBothLayouts(cdp, name) {
  if (!shotDir) return;
  await screenshot(cdp, shotDir, `${name}-1280`);
  await setViewport(cdp, 375, 720);
  await waitFor(
    () => evaluate(cdp, `document.documentElement.clientWidth <= 375`),
    `${name} reflowed to 375 px`,
    10_000,
  );
  await screenshot(cdp, shotDir, `${name}-375`);
  await setViewport(cdp, 1280, 800);
  await waitFor(
    () => evaluate(cdp, `document.documentElement.clientWidth > 375`),
    `${name} reflowed back to 1280 px`,
    10_000,
  );
}

const chromeBinary = process.env.ESZTER_BROWSER_ADMIN_CHROME ?? "google-chrome";
// Opt-in layout evidence (ESZ-154). Unset, the gate writes nothing; set to a
// directory, the same run drops the same screens under the same names.
const shotDir = process.env.ESZTER_BROWSER_ADMIN_SHOTS ?? "";
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

  // ── 3b. The admin shell: one navigation, no dead destination (ESZ-154) ──
  // Read from the rendered chrome rather than from source: this is the only
  // place that proves the four canonical first-level entries reach the browser,
  // that the pending ones are inert rather than links to a 404, that the lower
  // band carries help/account/settings in that order, and that the entry the
  // operator is on is marked by something other than a colour.
  const shell = await evaluate(cdp, `(() => {
    const nav = document.querySelector('nav[aria-label="Navigation de l’administration"]');
    if (!nav) return null;
    const entries = [...nav.querySelectorAll("li > a, li > span")].map((node) => ({
      label: node.textContent?.replace("Bientôt", "").trim(),
      link: node.tagName === "A",
      href: node.getAttribute("href"),
      current: node.getAttribute("aria-current"),
      pending: node.textContent?.includes("Bientôt") ?? false,
      weight: getComputedStyle(node).fontWeight,
      markerWidth: node.querySelector("[data-active-marker]")?.getBoundingClientRect().width ?? 0,
      markerPainted:
        getComputedStyle(node.querySelector("[data-active-marker]")).backgroundColor !==
        "rgba(0, 0, 0, 0)",
    }));
    const shellRoot = nav.closest("header");
    return {
      navCount: document.querySelectorAll('nav[aria-label="Navigation de l’administration"]').length,
      entries,
      brand: shellRoot?.textContent?.includes("Eszter") && shellRoot?.textContent?.includes("Administration"),
      sidebarWidth: shellRoot?.getBoundingClientRect().width ?? 0,
      sidebarSticky: getComputedStyle(shellRoot).position,
      workspaceLeft: document.querySelector("main")?.getBoundingClientRect().left ?? 0,
      chromeOverflow: shellRoot.scrollWidth <= shellRoot.clientWidth + 1,
      // The lower band, read as rendered. It sits outside the navigation
      // landmark on purpose, so it is measured separately from the four
      // business destinations rather than counted among them.
      secondary: (() => {
        const band = shellRoot.querySelector('[data-testid="admin-shell-secondary"]');
        if (!band) return null;
        return {
          insideNav: nav.contains(band),
          order: [...band.children].map((node) => {
            const email = node.querySelector('[data-testid="admin-account-email"]');
            if (email) return "account";
            return node.textContent?.replace("Bientôt", "").trim();
          }),
          entries: [...band.querySelectorAll("a, span[aria-disabled]")].map((node) => ({
            label: node.textContent?.replace("Bientôt", "").trim(),
            link: node.tagName === "A",
            href: node.getAttribute("href"),
            ariaDisabled: node.getAttribute("aria-disabled"),
            tabIndex: node.getAttribute("tabindex"),
            pending: node.textContent?.includes("Bientôt") ?? false,
          })),
          hasLogout: [...band.querySelectorAll("button")].some(
            (node) => node.textContent?.trim() === "Se déconnecter",
          ),
        };
      })(),
      // The way back to the public site, wherever the chrome puts it.
      publicReturn: [...shellRoot.querySelectorAll("a")].some(
        (node) => node.getAttribute("href") === "/" && node.textContent?.includes("Retour au site"),
      ),
    };
  })()`);
  assert(shell, "the admin shell exposes no labelled navigation landmark");
  assert(shell.navCount === 1, `the admin navigation is rendered ${shell.navCount} times; it must be rendered once`);
  assert(shell.brand, "the admin shell shows neither the Eszter name nor the Administration role");
  const labels = JSON.stringify(shell.entries.map((entry) => entry.label));
  assert(
    labels ===
      JSON.stringify(["Vue d’ensemble", "Contenu du site", "Calendrier", "Prestations"]),
    `the first level is not the four canonical business destinations, in order: ${labels}`,
  );
  // Rendez-vous and Disponibilités converged under Calendrier. Their routes stay
  // reachable; the removed labels must be gone from the rendered chrome, both
  // from the navigation and from the band below it.
  const removedLabels = shell.entries
    .concat(shell.secondary?.entries ?? [])
    .map((entry) => entry.label)
    .filter((label) => label === "Rendez-vous" || label === "Disponibilités");
  assert(
    removedLabels.length === 0,
    `the chrome still exposes removed first-level labels: ${JSON.stringify(removedLabels)}`,
  );
  const hrefs = JSON.stringify(shell.entries.filter((entry) => entry.link).map((entry) => entry.href));
  assert(
    hrefs === JSON.stringify(["/admin", "/admin/content", "/admin/bookings"]),
    `only destinations backed by a usable route may be clickable, got ${hrefs}`,
  );
  for (const entry of shell.entries.filter((candidate) => !candidate.link)) {
    assert(entry.pending, `${entry.label} is neither a link nor marked as pending`);
  }
  const currentOnBookings = shell.entries.filter((entry) => entry.current === "page");
  assert(
    currentOnBookings.length === 1 && currentOnBookings[0].label === "Calendrier",
    `exactly one entry must be aria-current=page on /admin/bookings, got ${JSON.stringify(currentOnBookings.map((entry) => entry.label))}`,
  );
  // Non-colour cues, measured: the active entry is the only one carrying a
  // painted marker, and it is the only one whose label is heavier.
  const activeEntry = currentOnBookings[0];
  assert(
    activeEntry.markerWidth > 0 && activeEntry.markerPainted,
    "the active entry carries no painted non-colour marker",
  );
  for (const entry of shell.entries.filter((candidate) => candidate.current !== "page")) {
    assert(!entry.markerPainted, `${entry.label} paints an active marker while not current`);
    assert(
      Number(entry.weight) < Number(activeEntry.weight),
      `${entry.label} is as heavy as the active entry, leaving colour as the only active cue`,
    );
  }
  // Desktop: a persistent sidebar beside the workspace, not a bar above it.
  assert(shell.sidebarSticky === "sticky", `the desktop sidebar is ${shell.sidebarSticky}, not sticky`);
  assert(
    shell.sidebarWidth > 200 && shell.sidebarWidth < 320,
    `the desktop sidebar is ${shell.sidebarWidth} px wide; it must stay a restrained column`,
  );
  assert(
    shell.workspaceLeft >= shell.sidebarWidth - 1,
    "the workspace does not start beside the sidebar at 1280 px",
  );
  assert(shell.chromeOverflow, "the admin chrome overflows horizontally at 1280 px");

  // The lower band (ESZ-154 canonical architecture): help, the signed-in account
  // with its sign-out, then settings last. Both bookends are inert because no
  // support screen and no settings screen exist — "Paramètres" is reserved for
  // real account/application settings and must not be faked into a dead link.
  const secondary = shell.secondary;
  assert(secondary, "the admin chrome exposes no secondary band below the navigation");
  assert(
    !secondary.insideNav,
    "the secondary controls are inside the navigation landmark, which makes the first level unstateable",
  );
  const bandOrder = JSON.stringify(secondary.order);
  assert(
    bandOrder === JSON.stringify(["Besoin d’aide", "account", "Paramètres"]),
    `the lower band is not Help → account → Settings: ${bandOrder}`,
  );
  assert(secondary.hasLogout, "the lower band carries no sign-out control");
  for (const entry of secondary.entries) {
    assert(
      !entry.link && entry.pending && entry.ariaDisabled === "true",
      `${entry.label} must stay a visibly pending, inert control rather than a dead link (link=${entry.link}, href=${entry.href})`,
    );
    assert(
      entry.tabIndex === null,
      `${entry.label} is inert and must take no tab stop (tabindex=${entry.tabIndex})`,
    );
  }
  assert(shell.publicReturn, "the chrome no longer offers a way back to the public site");

  // Keyboard traversal: only the destinations that exist are reachable by Tab,
  // and the pending ones are skipped rather than focusable dead ends.
  const navTabStops = await evaluate(cdp, `(() => {
    const nav = document.querySelector('nav[aria-label="Navigation de l’administration"]');
    const band = document.querySelector('[data-testid="admin-shell-secondary"]');
    const focusable = (root) => [...root.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .map((node) => node.textContent?.replace("Bientôt", "").trim());
    return { nav: focusable(nav), band: focusable(band) };
  })()`);
  assert(
    JSON.stringify(navTabStops.nav) ===
      JSON.stringify(["Vue d’ensemble", "Contenu du site", "Calendrier"]),
    `the navigation tab stops are not exactly the three live destinations: ${JSON.stringify(navTabStops.nav)}`,
  );
  assert(
    JSON.stringify(navTabStops.band) === JSON.stringify(["Se déconnecter"]),
    `the lower band must offer the sign-out control and nothing inert: ${JSON.stringify(navTabStops.band)}`,
  );

  // Narrow: the same DOM collapses to one scrollable rail, so the work area
  // keeps the width instead of paying for a permanent sidebar.
  await setViewport(cdp, 375, 720);
  // The resize is asynchronous: measuring before the layout has taken the new
  // width reads the desktop layout's overflow and makes this gate flaky.
  await waitFor(
    () => evaluate(cdp, `document.documentElement.clientWidth <= 375 && getComputedStyle(document.querySelector('nav[aria-label="Navigation de l’administration"]').closest("header")).position === "static"`),
    "the admin chrome reflowed to the narrow layout",
    10_000,
  );
  const narrowShell = await evaluate(cdp, `(() => {
    const nav = document.querySelector('nav[aria-label="Navigation de l’administration"]');
    const header = nav.closest("header");
    const main = document.querySelector("main");
    const list = nav.querySelector("ul");
    const band = header.querySelector('[data-testid="admin-shell-secondary"]');
    return {
      navCount: document.querySelectorAll('nav[aria-label="Navigation de l’administration"]').length,
      // Both rails absorb their own horizontal overflow. That is what keeps the
      // chrome inside a 375 px viewport while every entry stays reachable.
      railOverflowX: getComputedStyle(list).overflowX,
      secondaryOverflowX: getComputedStyle(band).overflowX,
      secondaryContained: band.getBoundingClientRect().right <= document.documentElement.clientWidth + 1,
      chromeHeight: header.getBoundingClientRect().height,
      viewportHeight: window.innerHeight,
      workspaceWidth: main.getBoundingClientRect().width,
      // clientWidth, not innerWidth: the latter counts the scrollbar the work
      // area does not get.
      viewportWidth: document.documentElement.clientWidth,
      railScrolls: list.scrollWidth > list.clientWidth,
      activeFullyVisible: (() => {
        const entry = nav.querySelector('[aria-current="page"]');
        const rail = list.getBoundingClientRect();
        const box = entry.getBoundingClientRect();
        return box.left >= rail.left - 1 && box.right <= rail.right + 1;
      })(),
      entriesReachable: nav.querySelectorAll("li").length,
      // Scoped to the chrome on purpose. The bookings page below it carries a
      // 680 px minimum-width month grid that overflows a 375 px viewport on
      // its own, which predates this shell and belongs to the calendar.
      chromeOverflow: header.scrollWidth <= header.clientWidth + 1,
      chromeWidth: header.getBoundingClientRect().width,
      // The signed-in identity at 375 px. An operator who can sign out has to be
      // able to see which account they are signing out of, so this is measured
      // as a painted box inside the chrome and inside the viewport, not merely
      // as a node that exists.
      account: (() => {
        const node = header.querySelector('[data-testid="admin-account-email"]');
        if (node === null) return null;
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return {
          text: node.textContent.trim(),
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          width: box.width,
          height: box.height,
          right: box.right,
          // An sr-only line clips itself to a 1 px box; a legible one does not.
          clipped: style.clipPath !== "none" || style.position === "absolute",
          ariaHidden: node.closest("[aria-hidden='true']") !== null,
          insideChrome: box.top >= header.getBoundingClientRect().top - 1
            && box.bottom <= header.getBoundingClientRect().bottom + 1,
          insideBand: band.contains(node),
        };
      })(),
    };
  })()`);
  assert(narrowShell.navCount === 1, "the narrow layout duplicates the navigation instead of reflowing it");
  assert(narrowShell.entriesReachable === 4, `the narrow rail drops entries: ${narrowShell.entriesReachable}/4`);
  assert(
    narrowShell.railOverflowX === "auto" && narrowShell.secondaryOverflowX === "auto",
    `the narrow rails must absorb their own overflow, got nav=${narrowShell.railOverflowX} band=${narrowShell.secondaryOverflowX}`,
  );
  assert(
    narrowShell.secondaryContained,
    "the secondary band runs past the 375 px viewport instead of scrolling inside it",
  );
  assert(
    narrowShell.activeFullyVisible,
    "the narrow rail leaves the current destination scrolled out of sight",
  );
  assert(
    narrowShell.workspaceWidth >= narrowShell.viewportWidth - 1,
    "the narrow layout gives the work area less than the full width",
  );
  assert(
    narrowShell.chromeHeight < narrowShell.viewportHeight * 0.3,
    `the narrow chrome eats ${Math.round((narrowShell.chromeHeight / narrowShell.viewportHeight) * 100)}% of the viewport`,
  );
  if (!narrowShell.chromeOverflow) {
    // Name what actually overflows: "it overflows" is not a debuggable message.
    const culprits = await evaluate(cdp, `[...document.querySelector('nav[aria-label="Navigation de l’administration"]').closest("header").querySelectorAll("*")]
      .filter((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === "visible")
      .slice(0, 6)
      .map((node) => node.tagName + "." + String(node.className).slice(0, 60) + " scroll=" + node.scrollWidth + " client=" + node.clientWidth)`);
    fail(`the admin chrome overflows horizontally at 375 px: ${JSON.stringify(culprits)}`);
  }
  assert(
    narrowShell.chromeWidth <= narrowShell.viewportWidth + 1,
    `the narrow chrome is ${narrowShell.chromeWidth} px wide in a ${narrowShell.viewportWidth} px viewport`,
  );

  // ESZ-154 correction: the account identity survives the narrow layout as a
  // visible, non-clipped, accessible line — not as `sr-only` text and not as a
  // node `display:none` removed from the render.
  const account = narrowShell.account;
  assert(account !== null, "the signed-in account identity is absent from the chrome at 375 px");
  assert(
    account.text === signedInBadge && account.text.length > 0,
    `the narrow chrome shows "${account.text}" instead of the signed-in account "${signedInBadge}"`,
  );
  assert(
    account.display !== "none" && account.visibility === "visible" && Number(account.opacity) > 0,
    `the signed-in account identity is not rendered at 375 px (display=${account.display}, visibility=${account.visibility}, opacity=${account.opacity})`,
  );
  assert(
    account.width > 1 && account.height > 1,
    `the signed-in account identity has no rendered box at 375 px (${account.width}x${account.height})`,
  );
  assert(!account.clipped, "the signed-in account identity is clipped away from sighted operators at 375 px");
  assert(!account.ariaHidden, "the signed-in account identity is hidden from the accessibility tree at 375 px");
  assert(
    account.insideChrome,
    "the signed-in account identity is painted outside the admin chrome at 375 px",
  );
  assert(
    account.insideBand,
    "the signed-in account identity left the canonical lower band at 375 px",
  );
  assert(
    account.right <= narrowShell.viewportWidth + 1,
    `the signed-in account identity runs ${Math.round(account.right - narrowShell.viewportWidth)} px past the 375 px viewport`,
  );
  await setViewport(cdp, 1280, 800);
  await waitFor(
    () => evaluate(cdp, `document.documentElement.clientWidth > 375`),
    "the admin chrome reflowed back to the desktop layout",
    10_000,
  );
  await captureBothLayouts(cdp, "admin-bookings");
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
  // The availability editor lost its first-level entry to Calendrier, and the
  // route still works. Reached by URL on purpose — that is exactly the case the
  // shell has to survive: a page nobody can click to must still leave the chrome
  // coherent, and must not bring the removed label back.
  await navigateAndWait(
    cdp,
    `${origin}/admin/availability`,
    "availability editor by direct route",
    `document.querySelector("h1")?.textContent?.trim() === "Horaires et fermetures"`,
  );
  await captureBothLayouts(cdp, "admin-availability");
  const onAvailability = await evaluate(cdp, `(() => {
    const nav = document.querySelector('nav[aria-label="Navigation de l’administration"]');
    return {
      current: [...nav.querySelectorAll('[aria-current="page"]')].map((node) => node.textContent?.trim()),
      labels: [...nav.querySelectorAll("li > a, li > span")].map((node) => node.textContent?.replace("Bientôt", "").trim()),
    };
  })()`);
  assert(
    JSON.stringify(onAvailability.current) === JSON.stringify(["Calendrier"]),
    `availability must be represented by exactly one entry — Calendrier — got ${JSON.stringify(onAvailability.current)}`,
  );
  assert(
    !onAvailability.labels.includes("Disponibilités") && !onAvailability.labels.includes("Rendez-vous"),
    `the shell reintroduced a removed first-level label on the availability route: ${JSON.stringify(onAvailability.labels)}`,
  );

  // The Calendrier entry, clicked rather than typed: a clickable destination is
  // only honest if it actually lands on the page it names.
  const calendarClicked = await evaluate(cdp, `(() => {
    const link = [...document.querySelectorAll('nav a')].find((candidate) => candidate.textContent?.trim() === "Calendrier");
    link?.click();
    return Boolean(link);
  })()`);
  assert(calendarClicked, "the shell exposes no “Calendrier” destination");
  await waitFor(
    () => evaluate(cdp, `location.pathname === "/admin/bookings" && document.querySelector("h1")?.textContent?.trim() === "Calendrier"`),
    "calendar from the admin shell",
    45_000,
  );

  // ── The operational overview (ESZ-155) ────────────────────────────────
  // `/admin` stopped being the CMS and became the overview. It is reached by
  // clicking its own first-level entry, which is the only way to prove the
  // entry is live rather than merely declared.
  const overviewClicked = await evaluate(cdp, `(() => {
    const link = [...document.querySelectorAll('nav a')].find((candidate) => candidate.textContent?.trim() === "Vue d’ensemble");
    link?.click();
    return Boolean(link);
  })()`);
  assert(overviewClicked, "the shell exposes no clickable “Vue d’ensemble” destination");
  await waitFor(
    () => evaluate(cdp, `location.pathname === "/admin" && document.querySelector("h1")?.textContent?.trim() === "Vue d’ensemble"`),
    "operational overview from the admin shell",
    45_000,
  );
  await captureBothLayouts(cdp, "admin-overview");

  const overview = await evaluate(cdp, `(() => {
    const main = document.querySelector("main");
    const actions = [...document.querySelectorAll("[data-action-key]")].map((node) => ({
      key: node.getAttribute("data-action-key"),
      status: node.getAttribute("data-action-status"),
      link: node.tagName === "A",
      href: node.getAttribute("href"),
      tabIndex: node.getAttribute("tabindex"),
    }));
    return {
      // The CMS must be gone from this route, not merely pushed below the fold.
      hasEditor: Boolean(document.getElementById("hero-title-suffix")),
      current: [...document.querySelectorAll('nav[aria-label="Navigation de l’administration"] [aria-current="page"]')].map((node) => node.textContent?.trim()),
      // The appointments band is the existing operations summary, reused whole.
      hasSummary: Boolean(document.querySelector('[aria-labelledby="summary-heading"], [aria-label="Résumé opérationnel"]')),
      panels: [...document.querySelectorAll("section[aria-label]")].map((node) => node.getAttribute("aria-label")),
      actions,
      // Nothing on the overview may report a figure the API never served.
      forbidden: /prix|tarif|revenu|chiffre d’affaires|comptab/i.test(main?.innerText ?? ""),
      overflows: main ? main.scrollWidth > main.clientWidth + 1 : true,
    };
  })()`);
  assert(!overview.hasEditor, "the content editor is still rendered at /admin");
  assert(
    JSON.stringify(overview.current) === JSON.stringify(["Vue d’ensemble"]),
    `the overview must mark exactly “Vue d’ensemble” as current, got ${JSON.stringify(overview.current)}`,
  );
  assert(overview.hasSummary, "the overview does not render the operations summary");
  for (const panel of ["Horaires du jour", "État du site", "Accès rapides"]) {
    assert(overview.panels.includes(panel), `the overview is missing the “${panel}” panel`);
  }
  assert(!overview.forbidden, "the overview renders an invented commercial metric");
  assert(!overview.overflows, "the overview overflows horizontally");
  // The quick actions must tell the same truth as the shell: the two live
  // destinations are links, and Prestations — which has no page — is inert.
  const actionsByKey = Object.fromEntries(overview.actions.map((action) => [action.key, action]));
  assert(
    actionsByKey.calendar?.link && actionsByKey.calendar.href === "/admin/bookings",
    `the Calendrier quick action does not point at the calendar: ${JSON.stringify(actionsByKey.calendar)}`,
  );
  assert(
    actionsByKey.content?.link && actionsByKey.content.href === "/admin/content",
    `the Contenu du site quick action does not point at the CMS: ${JSON.stringify(actionsByKey.content)}`,
  );
  assert(
    actionsByKey.services && !actionsByKey.services.link && actionsByKey.services.status === "pending",
    `Prestations has no route, so its quick action must be inert: ${JSON.stringify(actionsByKey.services)}`,
  );
  assert(
    actionsByKey.services.tabIndex === null,
    "the inert Prestations quick action must take no tab stop",
  );

  // The overview at tablet and phone widths. `captureBothLayouts` is a no-op
  // without a screenshot directory, so the reflow is measured here rather than
  // assumed from a screenshot that may never have been taken.
  for (const width of [768, 375]) {
    await setViewport(cdp, width, 800);
    await waitFor(
      () => evaluate(cdp, `document.documentElement.clientWidth <= ${width}`),
      `the overview reflowed to ${width} px`,
      10_000,
    );
    const reflow = await evaluate(cdp, `(() => {
      const main = document.querySelector("main");
      const actions = [...document.querySelectorAll("[data-action-key]")];
      return {
        overflows: main.scrollWidth > main.clientWidth + 1,
        documentOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        // A card narrower than roughly a third of the viewport would be the
        // "tiny multi-column card" the narrow layout must not produce.
        narrowestAction: Math.min(...actions.map((node) => node.getBoundingClientRect().width)),
        panelsReadable: [...document.querySelectorAll("section[aria-label]")].every(
          (node) => node.getBoundingClientRect().width >= 240,
        ),
      };
    })()`);
    assert(!reflow.overflows, `the overview overflows horizontally at ${width} px`);
    assert(!reflow.documentOverflows, `the page scrolls sideways at ${width} px`);
    assert(
      reflow.narrowestAction >= width / 3,
      `a quick action collapsed to ${Math.round(reflow.narrowestAction)} px at ${width} px`,
    );
    assert(reflow.panelsReadable, `an overview panel is unreadably narrow at ${width} px`);
  }
  await setViewport(cdp, 1280, 800);
  await waitFor(
    () => evaluate(cdp, `document.documentElement.clientWidth > 375`),
    "the overview restored the desktop layout",
    10_000,
  );

  const contentLinkClicked = await evaluate(cdp, `(() => {
    const link = [...document.querySelectorAll('nav a')].find((candidate) => candidate.textContent?.trim() === "Contenu du site");
    link?.click();
    return Boolean(link);
  })()`);
  assert(contentLinkClicked, "the shell exposes no “Contenu du site” destination");
  await waitFor(
    () => evaluate(cdp, `location.pathname === "/admin/content" && Boolean(document.getElementById("hero-title-suffix"))`),
    "content editor from the authenticated chrome",
    45_000,
  );
  // The active state follows the operator: it moved with the navigation, and it
  // did not stay lit on the route we left.
  await captureBothLayouts(cdp, "admin-content");
  const currentOnContent = await evaluate(cdp, `[...document.querySelectorAll('nav[aria-label="Navigation de l’administration"] [aria-current="page"]')].map((node) => node.textContent?.trim())`);
  assert(
    JSON.stringify(currentOnContent) === JSON.stringify(["Contenu du site"]),
    `the active entry did not follow the navigation: ${JSON.stringify(currentOnContent)}`,
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

  // ── 3b. ESZ-156: the CMS is a focused editor, not one long form ─────────
  //
  // The claim under test is behavioural and cannot be made by reading source:
  // one section is editable at a time, the others are *absent* from the document
  // rather than hidden, an edit survives navigating away and back, the preview
  // shows it before anything is saved, and none of that navigation writes to the
  // server.
  const readFocusedCms = `(() => {
    const nav = document.querySelector('[data-testid="cms-section-navigation"]');
    const panel = document.querySelector('[data-testid="cms-editor-panel"]');
    const entries = (role) => (nav ? [...nav.querySelectorAll('[data-cms-nav="' + role + '"]')] : []).map((node) => ({
      key: node.dataset.cmsKey,
      label: (node.textContent ?? "").trim(),
      tag: node.tagName,
      current: node.getAttribute("aria-current") === "true",
      marked: node.querySelector('[data-active-marker="true"]') !== null,
      bold: /font-semibold/.test(node.className),
      focusable: node.tabIndex >= 0,
    }));
    const frame = document.querySelector('iframe[title="Aperçu en direct du site"]');
    return {
      landmark: nav ? nav.getAttribute("aria-label") : null,
      areas: entries("area"),
      sections: entries("section"),
      selected: (document.querySelector('[data-testid="cms-selected-section"]')?.textContent ?? "").trim(),
      panelCards: panel ? [...panel.querySelectorAll('section[id^="editor-"]')].map((node) => node.id) : [],
      documentCards: [...document.querySelectorAll('section[id^="editor-"]')].map((node) => node.id),
      focusableFields: document.querySelectorAll("input:not([type=file]), textarea").length,
      heroField: document.getElementById("hero-title-suffix")?.value ?? null,
      contactField: document.getElementById("contact-title")?.value ?? null,
      hasEditorPanel: panel !== null,
      hasPreviewPanel: document.querySelector('[data-testid="cms-preview-panel"]') !== null,
      hasViewSwitch: document.querySelector('[data-testid="cms-view-switch"]') !== null,
      previewFrames: document.querySelectorAll('iframe[title="Aperçu en direct du site"]').length,
      previewText: frame && frame.contentDocument ? (frame.contentDocument.body?.textContent ?? "").slice(0, 4000) : null,
      hash: location.hash,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  })()`;

  const cmsInitial = await evaluate(cdp, readFocusedCms);
  assert(cmsInitial.landmark === "Sections du contenu", `the CMS exposes no named navigation landmark: ${JSON.stringify(cmsInitial.landmark)}`);
  assert(
    JSON.stringify(cmsInitial.areas.map((area) => area.key)) === JSON.stringify(["home", "common"]),
    `unexpected CMS areas: ${JSON.stringify(cmsInitial.areas.map((area) => area.key))}`,
  );
  const currentAreas = cmsInitial.areas.filter((area) => area.current);
  const currentSections = cmsInitial.sections.filter((section) => section.current);
  assert(currentAreas.length === 1 && currentAreas[0].key === "home", `the CMS does not mark exactly one current area: ${JSON.stringify(cmsInitial.areas)}`);
  assert(currentSections.length === 1 && currentSections[0].key === "hero", `the CMS does not mark exactly one current section: ${JSON.stringify(cmsInitial.sections.map((section) => [section.key, section.current]))}`);
  // The selected state is not conveyed by colour alone, and every entry is a
  // keyboard-operable control rather than inert text.
  assert(currentAreas[0].marked && currentAreas[0].bold, "the current CMS area is marked by colour alone");
  assert(currentSections[0].marked && currentSections[0].bold, "the current CMS section is marked by colour alone");
  assert(
    [...cmsInitial.areas, ...cmsInitial.sections].every((entry) => entry.tag === "BUTTON" && entry.focusable),
    "a CMS navigation entry is not keyboard-operable",
  );
  // One section editor in the panel, and — the part that matters for the tab
  // order — one in the whole document. Nine hidden editors would still be here.
  assert(
    JSON.stringify(cmsInitial.panelCards) === JSON.stringify(["editor-hero"]),
    `the central panel does not hold exactly the selected section: ${JSON.stringify(cmsInitial.panelCards)}`,
  );
  assert(
    JSON.stringify(cmsInitial.documentCards) === JSON.stringify(["editor-hero"]),
    `unrelated section editors are still in the document: ${JSON.stringify(cmsInitial.documentCards)}`,
  );
  assert(cmsInitial.contactField === null, "the Contact editor is rendered while Hero is selected");
  assert(cmsInitial.previewFrames === 1, `expected exactly one preview renderer, found ${cmsInitial.previewFrames}`);
  assert(cmsInitial.hash === "#editor-hero", `the CMS did not record its section in the address bar: ${JSON.stringify(cmsInitial.hash)}`);
  const focusedFieldCount = cmsInitial.focusableFields;

  // An unsaved edit in the selected section reaches the live preview.
  const FOCUS_MARKER = "ESZ-156-FOCUS";
  const heroBefore = cmsInitial.heroField ?? "";
  await setReactInput(cdp, "hero-title-suffix", `${heroBefore} ${FOCUS_MARKER}`.trim());
  try {
    await waitFor(
      () => evaluate(cdp, `(() => {
        const frame = document.querySelector('iframe[title="Aperçu en direct du site"]');
        const doc = frame && frame.contentDocument;
        return Boolean(doc && (doc.body?.textContent ?? "").includes(${JSON.stringify(FOCUS_MARKER)}));
      })()`),
      "the live preview reflecting the unsaved edit",
      20_000,
    );
  } catch {
    const diagnostic = await evaluate(cdp, `(() => {
      const frame = document.querySelector('iframe[title="Aperçu en direct du site"]');
      const doc = frame && frame.contentDocument;
      return {
        field: document.getElementById("hero-title-suffix")?.value ?? null,
        frameSrc: frame ? frame.getAttribute("src") : null,
        readyState: doc ? doc.readyState : null,
        heading: doc ? (doc.querySelector("h1")?.textContent ?? "").trim().slice(0, 200) : null,
      };
    })()`);
    fail(`the live preview does not show the unsaved edit; ${JSON.stringify(diagnostic)}`);
  }

  // Changing section is navigation: a different editor, the same draft.
  const draftDuringNavigation = await json("/api/admin/content/draft", {
    headers: { accept: "application/json", cookie: liveCookie },
  });
  assert(draftDuringNavigation.status === 200, `draft GET during CMS navigation returned ${draftDuringNavigation.status}`);
  const selectSection = async (key, label) => {
    const clicked = await evaluate(cdp, `(() => {
      const button = document.querySelector('[data-cms-nav="section"][data-cms-key=${JSON.stringify(key)}]');
      button?.click();
      return Boolean(button);
    })()`);
    assert(clicked, `the CMS navigation exposes no "${label}" section`);
    await waitFor(
      () => evaluate(cdp, `(document.querySelector('[data-testid="cms-selected-section"]')?.textContent ?? "").trim() === ${JSON.stringify(label)}`),
      `the CMS switching to ${label}`,
      15_000,
    );
  };

  await selectSection("contact", "Contact");
  const cmsOnContact = await evaluate(cdp, readFocusedCms);
  assert(
    JSON.stringify(cmsOnContact.documentCards) === JSON.stringify(["editor-contact"]),
    `changing section did not replace the editor: ${JSON.stringify(cmsOnContact.documentCards)}`,
  );
  assert(cmsOnContact.heroField === null, "the Hero editor is still rendered while Contact is selected");
  assert(typeof cmsOnContact.contactField === "string", "the Contact editor did not render its fields");
  assert(cmsOnContact.hash === "#editor-contact", `the address bar did not follow the section: ${JSON.stringify(cmsOnContact.hash)}`);
  // The preview follows the selection and still carries the unsaved Hero edit —
  // it renders the whole working document, not just the section being edited.
  assert(
    (cmsOnContact.previewText ?? "").includes(FOCUS_MARKER),
    "the preview lost the unsaved edit when the section changed",
  );

  // Nothing was written to the server by navigating.
  const draftAfterNavigation = await json("/api/admin/content/draft", {
    headers: { accept: "application/json", cookie: liveCookie },
  });
  assert(
    draftAfterNavigation.body.revision === draftDuringNavigation.body.revision,
    `changing section moved the draft revision ${draftDuringNavigation.body.revision} -> ${draftAfterNavigation.body.revision}`,
  );
  assert(
    !String(draftAfterNavigation.body.content?.hero?.title?.suffix ?? "").includes(FOCUS_MARKER),
    "changing section silently saved the unsaved edit to the server",
  );
  const publicDuringNavigation = await json("/api/content", { headers: { accept: "application/json" } });
  assert(
    !String(publicDuringNavigation.body.content?.hero?.title?.suffix ?? "").includes(FOCUS_MARKER),
    "changing section silently published the unsaved edit",
  );
  const freshnessDuringNavigation = await evaluate(cdp, `document.querySelector('[data-testid="admin-freshness"]')?.textContent?.trim() ?? ""`);
  assert(
    freshnessDuringNavigation === "Modifications non enregistrées",
    `the editor stopped reporting the edit as unsaved after navigating: ${JSON.stringify(freshnessDuringNavigation)}`,
  );

  // Back to the edited section: the value is still there.
  await selectSection("hero", "Hero");
  const cmsBackOnHero = await evaluate(cdp, readFocusedCms);
  assert(
    (cmsBackOnHero.heroField ?? "").includes(FOCUS_MARKER),
    `the edit was lost by navigating away and back: ${JSON.stringify(cmsBackOnHero.heroField)}`,
  );
  assert(
    JSON.stringify(cmsBackOnHero.documentCards) === JSON.stringify(["editor-hero"]),
    `returning to Hero did not restore exactly one editor: ${JSON.stringify(cmsBackOnHero.documentCards)}`,
  );

  // The other area, and the sections that belong to it.
  const areaSwitched = await evaluate(cdp, `(() => {
    const button = document.querySelector('[data-cms-nav="area"][data-cms-key="common"]');
    button?.click();
    return Boolean(button);
  })()`);
  assert(areaSwitched, "the CMS navigation exposes no “Éléments communs” area");
  await waitFor(
    () => evaluate(cdp, `document.querySelector('[data-cms-nav="area"][data-cms-key="common"]')?.getAttribute("aria-current") === "true"`),
    "the CMS switching area",
    15_000,
  );
  const cmsOnCommon = await evaluate(cdp, readFocusedCms);
  assert(
    JSON.stringify(cmsOnCommon.sections.map((section) => section.key)) === JSON.stringify(["navigation", "footer", "appearance"]),
    `the second area lists the wrong sections: ${JSON.stringify(cmsOnCommon.sections.map((section) => section.key))}`,
  );
  assert(cmsOnCommon.sections.filter((section) => section.current).length === 1, "changing area left no section selected");
  assert(cmsOnCommon.documentCards.length === 1, `changing area rendered ${cmsOnCommon.documentCards.length} editors`);
  await evaluate(cdp, `document.querySelector('[data-cms-nav="area"][data-cms-key="home"]')?.click()`);
  await selectSection("hero", "Hero");

  // Desktop: the preview sits beside the editor, sticky, without overlapping the
  // shell or making the page scroll sideways.
  const cmsDesktop = await evaluate(cdp, `(() => {
    const panel = document.querySelector('[data-testid="cms-editor-panel"]');
    const preview = document.querySelector('[data-testid="cms-preview-panel"]');
    const shell = document.querySelector('header');
    const panelBox = panel?.getBoundingClientRect();
    const previewBox = preview?.getBoundingClientRect();
    const shellBox = shell?.getBoundingClientRect();
    return {
      both: Boolean(panel && preview),
      sideBySide: Boolean(panelBox && previewBox && previewBox.left >= panelBox.right - 1),
      clearsShell: Boolean(previewBox && shellBox && previewBox.left >= shellBox.right - 1),
      sticky: preview ? getComputedStyle(preview).position : null,
      switchHidden: document.querySelector('[data-testid="cms-view-switch"]') === null,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  })()`);
  assert(cmsDesktop.both, "the desktop CMS does not show the editor and the preview together");
  assert(cmsDesktop.sideBySide, "the desktop preview is not beside the editor");
  assert(cmsDesktop.clearsShell, "the desktop preview overlaps the admin shell");
  assert(cmsDesktop.sticky === "sticky", `the desktop preview is not sticky: ${cmsDesktop.sticky}`);
  assert(cmsDesktop.switchHidden, "the editor/preview mode switch is rendered where both panels fit");
  assert(cmsDesktop.scrollWidth <= cmsDesktop.clientWidth + 1, `the focused CMS overflows at 1280 px: ${cmsDesktop.scrollWidth} > ${cmsDesktop.clientWidth}`);
  if (shotDir) await screenshot(cdp, shotDir, "admin-content-focused-1280");

  // Tablet and mobile: the preview becomes an explicit mode, and switching to it
  // and back keeps both the selection and the unsaved edit.
  for (const width of [834, 375]) {
    await setViewport(cdp, width, 800);
    await waitFor(
      () => evaluate(cdp, `document.documentElement.clientWidth <= ${width}`),
      `the CMS reflowing to ${width} px`,
      10_000,
    );
    const narrow = await evaluate(cdp, readFocusedCms);
    assert(narrow.hasEditorPanel && !narrow.hasPreviewPanel, `the ${width} px CMS squeezes the preview beside the editor`);
    assert(narrow.hasViewSwitch, `the ${width} px CMS offers no explicit preview mode`);
    assert(narrow.scrollWidth <= narrow.clientWidth + 1, `the CMS overflows at ${width} px: ${narrow.scrollWidth} > ${narrow.clientWidth}`);
    assert(
      narrow.documentCards.length === 1 && (narrow.heroField ?? "").includes(FOCUS_MARKER),
      `the ${width} px CMS lost the focused section or its unsaved edit`,
    );

    const switchTo = async (mode, label) => {
      const clicked = await evaluate(cdp, `(() => {
        const button = document.querySelector('[data-testid="cms-view-switch"] [data-cms-view=${JSON.stringify(mode)}]');
        button?.click();
        return Boolean(button);
      })()`);
      assert(clicked, `the ${width} px CMS exposes no "${label}" mode`);
      await waitFor(
        () => evaluate(cdp, `document.querySelector('[data-testid="cms-view-switch"] [data-cms-view=${JSON.stringify(mode)}]')?.getAttribute("aria-pressed") === "true"`),
        `the ${width} px CMS switching to ${label}`,
        15_000,
      );
    };

    await switchTo("preview", "Aperçu");
    // The preview iframe is mounted by the switch, so its document arrives a
    // beat later — the content is awaited rather than read on the same tick.
    await waitFor(
      () => evaluate(cdp, `(() => {
        const frame = document.querySelector('iframe[title="Aperçu en direct du site"]');
        const doc = frame && frame.contentDocument;
        return Boolean(doc && (doc.body?.textContent ?? "").includes(${JSON.stringify(FOCUS_MARKER)}));
      })()`),
      `the ${width} px preview showing the unsaved edit`,
      20_000,
    );
    const previewMode = await evaluate(cdp, readFocusedCms);
    assert(previewMode.hasPreviewPanel && !previewMode.hasEditorPanel, `the ${width} px preview mode did not replace the editor`);
    // The editor is gone from the document, not merely off-screen: no duplicate
    // fields left in the tab order behind the preview.
    assert(previewMode.documentCards.length === 0, `the ${width} px preview mode left ${previewMode.documentCards.length} editor(s) focusable behind it`);
    assert(previewMode.previewFrames === 1, `the ${width} px preview mode renders ${previewMode.previewFrames} previews`);
    assert(
      (previewMode.previewText ?? "").includes(FOCUS_MARKER),
      `the ${width} px preview does not show the unsaved edit`,
    );
    assert(previewMode.scrollWidth <= previewMode.clientWidth + 1, `the ${width} px preview mode overflows: ${previewMode.scrollWidth} > ${previewMode.clientWidth}`);
    if (width === 375 && shotDir) await screenshot(cdp, shotDir, "admin-content-focused-375-preview");

    await switchTo("editor", "Éditeur");
    const backToEditor = await evaluate(cdp, readFocusedCms);
    assert(backToEditor.hasEditorPanel && !backToEditor.hasPreviewPanel, `the ${width} px CMS did not return to the editor`);
    assert(backToEditor.selected === "Hero", `the ${width} px preview mode lost the selected section: ${JSON.stringify(backToEditor.selected)}`);
    assert(
      (backToEditor.heroField ?? "").includes(FOCUS_MARKER),
      `the ${width} px preview mode discarded the unsaved edit`,
    );
    assert(
      backToEditor.focusableFields === focusedFieldCount,
      `the ${width} px CMS returned with ${backToEditor.focusableFields} fields instead of the focused ${focusedFieldCount}`,
    );
    if (width === 375 && shotDir) await screenshot(cdp, shotDir, "admin-content-focused-375-editor");
  }

  await setViewport(cdp, 1280, 800);
  await waitFor(
    () => evaluate(cdp, `document.documentElement.clientWidth > 375 && Boolean(document.getElementById("hero-title-suffix"))`),
    "the CMS restoring the desktop layout",
    10_000,
  );


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
  // Waiting for the heading to *exist* is not enough: the exported page paints
  // the built-in content first and swaps in `/api/content` when the fetch lands,
  // so reading the h1 immediately races that swap.
  await navigateAndWait(cdp, `${origin}/`, "public site after publication", `Boolean(document.querySelector("h1"))`);
  try {
    await waitFor(
      () => evaluate(cdp, `(document.querySelector("h1")?.textContent ?? "").includes(${JSON.stringify(MARKER)})`),
      "the published change on the public page",
      30_000,
    );
  } catch {
    const publicH1 = await evaluate(cdp, `document.querySelector("h1")?.textContent?.trim() ?? ""`);
    fail(`the public page does not show the published change; h1: ${publicH1.slice(0, 160)}`);
  }

  // 320 px reflow on the authenticated editor.
  await navigateAndWait(cdp, `${origin}/admin/content`, "editor for 320 px reflow", `Boolean(document.getElementById("hero-title-suffix"))`);
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
  await captureBothLayouts(cdp, "admin-after-logout");
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
      // ESZ-155: signing in lands on `/admin`, which is now the operational
      // overview rather than the CMS. What this step proves is unchanged — a
      // keyboard-only sign-in reaches the authenticated admin.
      () => evaluate(cdp, `location.pathname === "/admin" && document.querySelector("h1")?.textContent?.trim() === "Vue d’ensemble"`),
      "keyboard-only login reaching the overview",
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
  const clickable = shell.entries.filter((entry) => entry.link);
  const inert = shell.entries.length - clickable.length + secondary.entries.length;
  process.stdout.write(`admin shell: ${shell.entries.length} first-level entries (${shell.entries.map((entry) => entry.label).join(" › ")}), ${clickable.length} clickable (${clickable.map((entry) => entry.href).join(", ")}) and both reached from the shell, ${inert} pending and inert with no tab stop; lower band ${secondary.order.join(" › ")} + sign-out; availability still reachable at /admin/availability and marked Calendrier; aria-current + weight ${activeEntry.weight} + painted marker on the current entry only; ${Math.round(shell.sidebarWidth)} px sticky sidebar at 1280 px, one navigation over a ${Math.round(narrowShell.chromeHeight)} px chrome and a full-width workspace at 375 px\n`);
  process.stdout.write(`overview: /admin renders Vue d’ensemble (no editor), ${overview.panels.length} labelled panels (${overview.panels.join(" › ")}) over the reused operations summary, quick actions ${overview.actions.map((action) => `${action.key}:${action.status}`).join(", ")}, no invented metric, no horizontal overflow at 1280/768/375 px; CMS reached at /admin/content and functional\n`);
  process.stdout.write(`focused CMS: /admin/content opens on “Page d’accueil › Hero” (#editor-hero) with exactly one section editor in the document; an unsaved edit reached the live preview, survived a move to Contact and back, and wrote nothing to the server (draft revision ${draftAfterNavigation.body.revision} unchanged); desktop 1280 px keeps the preview sticky beside the editor, 834 px and 375 px switch between Éditeur and Aperçu without losing the section or the edit\n`);
    process.stdout.write(`content workflow: hero suffix -> "${marker}" saved (revision ${draftBefore.body.revision} -> ${draftSaved.body.revision}; published head before: ${publishedHeadBefore}), published, public page shows ${MARKER}\n`);
  process.stdout.write("logout: 0 authenticated session rows, pre-logout cookie authenticated=false, protected reload -> login gate; keyboard-only login reached the overview\n");
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
