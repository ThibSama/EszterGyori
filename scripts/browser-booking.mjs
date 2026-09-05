#!/usr/bin/env node
/**
 * ESZ-113 — the project-owned `browser:booking` runner.
 *
 * A real same-origin production-shaped stack (Apache applying the committed
 * generated `.htaccess`, the PHP front controller, an isolated MySQL 8.4)
 * and real headless Chrome tabs prove the composed booking scenario that
 * `browser:booking` declared but no runner executed:
 *
 *   1. deterministic bookable availability exists — the development
 *      provisioning really created six active weekly rules (Monday–Saturday,
 *      09:00–17:00, Paris) with no exception window, and the public
 *      availability endpoint answers deterministic slots for them;
 *   2. a valid booking completes entirely through the public browser UI —
 *      service, date, slot, details, review, confirmation with its
 *      `bk_…` reference;
 *   3. persistence is visible through the real API, the real MySQL rows
 *      (booking + history + consent), and the authenticated admin calendar;
 *   4. the lifecycle notification jobs are enqueued exactly per the current
 *      contract: one pending `booking_confirmation` (due at creation) and
 *      one pending `booking_reminder` (due T−24 h), nothing sent, no SMTP
 *      anywhere in the stack;
 *   5. invalid customer input writes nothing — the refusal is client-side,
 *      announced and focus-moving, and every entered value survives;
 *   6. one stale/unavailable-slot recovery path — a second real browser tab
 *      holding the same slot confirms after the first tab booked it, is
 *      refused 409 SLOT_UNAVAILABLE by the real backend, shows the recovery
 *      notice, and creates no duplicate booking and no duplicate
 *      notification; the customer's details survive for the next attempt.
 *
 * The same browser asserts the repository's accessibility contract on the
 * exercised controls: the reservation skip-link (keyboard reachable, focus
 * lands on main), keyboard reachability of the booking controls, the
 * promised focus movements (review heading, confirmation heading, first
 * invalid field, slot-heading notice), live `role=status` semantics, field
 * labels/aria-invalid/aria-describedby, no fake grid ARIA, and 320 px
 * reflow without document overflow.
 *
 * Requires, like the other browser gates: docker, google-chrome (overridable
 * with ESZTER_BROWSER_BOOKING_CHROME), a built `front/out`, and `php/vendor`.
 * Every container, network, profile and temp file is removed on every exit
 * path; nothing ever leaves 127.0.0.1 and the persistent `eszter_dev`
 * deployment is never touched.
 */

import {
  makeProof,
  startApacheStack,
  launchChrome,
  openTab,
  setViewport,
  navigateAndWait,
  waitFor,
  evaluate,
  setReactInput,
  clickCheckbox,
  clickButton,
  clickButtonWhere,
  pressTab,
  pressEnter,
  activeElement,
  parisToday,
  addParisDays,
  parisDayCellPrefix,
  stopProcessQuietly,
  signIn,
  sessionCookie,
} from "./browser-stack.mjs";

const { fail, assert } = makeProof("browser:booking");

const chromeBinary = process.env.ESZTER_BROWSER_BOOKING_CHROME ?? "google-chrome";
const sessionCookieName = "eszter_session"; // non-Secure dev build drops __Host-
const csrfHeader = "x-csrf-token";
const consentNoticeId = "booking-consent-v1"; // the catalog's current id (ESZ-142)
const customerA = {
  name: "Adelaide Preuve ESZ113",
  email: "adelaide.preuve@example.test",
  phone: "+33601020304",
  note: "Preuve navigateur ESZ-113, rendez-vous A.",
};
const customerB = {
  name: "Bertrand Preuve ESZ113",
  email: "bertrand.preuve@example.test",
  phone: "+33605060708",
  note: "Preuve navigateur ESZ-113, onglet concurrent.",
};
let chrome = null;
let stack = null;

async function main() {
  stack = await startApacheStack({ gate: "browser:booking", tag: "esz113booking", chromeBinary });
  const { origin, credentials, workRoot, mysqlExec, mysqlJson } = stack;
  const chromeProfile = `${workRoot}/chrome-profile`;
  const browser = await launchChrome(chromeBinary, chromeProfile);
  chrome = browser.chrome;
  const cdp = browser.cdp;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await setViewport(cdp, 1280, 900);

  const json = async (path, init = {}) => {
    const response = await fetch(`${origin}${path}`, init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  // ── 1. Deterministic bookable availability was really created ───────────
  const rules = mysqlJson(`SELECT JSON_ARRAYAGG(JSON_OBJECT('weekday_iso', weekday_iso, 'start_local', TIME_FORMAT(start_local, '%H:%i:%s'), 'end_local', TIME_FORMAT(end_local, '%H:%i:%s'), 'is_active', is_active)) AS items FROM availability_rules`);
  assert(Array.isArray(rules) && rules.length === 6, `expected six availability rules, got ${JSON.stringify(rules)}`);
  for (const rule of rules) {
    assert(rule.is_active === 1 && rule.start_local === "09:00:00" && rule.end_local === "17:00:00", `unexpected availability rule: ${JSON.stringify(rule)}`);
  }
  assert(new Set(rules.map((rule) => rule.weekday_iso)).size === 6, "the weekly rules do not cover six distinct weekdays");
  const exceptions = mysqlExec("SELECT COUNT(*) FROM availability_exceptions");
  assert(exceptions === "0", `unexpected availability exception windows: ${exceptions}`);
  const today = parisToday();
  const servicesResponse = await json("/api/booking/services", { headers: { accept: "application/json" } });
  assert(servicesResponse.status === 200 && servicesResponse.body?.services?.length > 0, "public bookable services are not available");
  const contentResponse = await json("/api/content", { headers: { accept: "application/json" } });
  assert(contentResponse.status === 200 && Array.isArray(contentResponse.body?.content?.services?.items), "published content is not available");
  const serviceKeys = new Set(servicesResponse.body.services.map((service) => service.key));
  const serviceKey = contentResponse.body.content.services.items.find((item) => serviceKeys.has(item.id))?.id
    ?? servicesResponse.body.services[0].key;
  assert(typeof serviceKey === "string", "no bookable service key could be resolved");

  // Earliest *future* day (tomorrow..+6, then today only as a fallback) that
  // really has slots. A future day keeps the whole browser run far from the
  // slot-boundary races that a same-day slot could hit while the two tabs
  // interact, and the weekly rules guarantee several bookable weekdays in any
  // seven-day window.
  let targetDate = null;
  let slotsByDate = null;
  for (const offset of [1, 2, 3, 4, 5, 6, 0]) {
    const candidate = offset === 0 ? today : addParisDays(today, offset);
    const availability = await json("/api/booking/availability", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ serviceKey, fromDate: candidate, untilDate: candidate }),
    });
    assert(availability.status === 200, `availability query failed for ${candidate}`);
    if (availability.body.slots?.length > 0) {
      targetDate = candidate;
      slotsByDate = availability.body.slots;
      break;
    }
  }
  assert(targetDate !== null && Array.isArray(slotsByDate), "no real slot was available in the next seven days");
  const targetSlots = slotsByDate.filter((slot) => slot.localDate === targetDate).sort((a, b) => a.startsAtUtc.localeCompare(b.startsAtUtc));
  assert(targetSlots.length >= 1, "the chosen day has no slot");
  const chosenSlot = targetSlots[0];
  const targetOffset = (() => {
    let days = 0;
    for (let date = today; date < targetDate; date = addParisDays(date, 1)) days++;
    return days;
  })();
  process.stdout.write(`availability: ${rules.length} active weekly rules (Mon-Sat 09:00-17:00), first real slot ${targetDate} ${chosenSlot.localStart} (${chosenSlot.startsAtUtc})\n`);

  // ── Reservation page, keyboard skip-link ────────────────────────────────
  await navigateAndWait(cdp, `${origin}/reservation`, "reservation page", `Boolean(document.getElementById("reservation-main"))`);
  await pressTab(cdp);
  const skipFocus = await activeElement(cdp);
  assert(
    skipFocus.tag === "a" && skipFocus.text === "Aller au choix du rendez-vous",
    `Tab did not reach the reservation skip-link: ${JSON.stringify(skipFocus)}`,
  );
  await pressEnter(cdp);
  await waitFor(
    () => evaluate(cdp, `document.activeElement?.id === "reservation-main"`),
    "skip-link focus landing on main",
  );

  // A11y shape of the exercised surface, asserted before any interaction.
  const surfaceA11y = await evaluate(cdp, `(() => ({
    gridCount: document.querySelectorAll('[role="grid"], [role="gridcell"], [role="columnheader"], [role="row"]').length,
    ariaSelectedCount: document.querySelectorAll("[aria-selected]").length,
    mainCount: document.querySelectorAll("main").length,
  }))()`);
  assert(surfaceA11y.gridCount === 0, "the reservation surface claims a grid pattern it does not implement");
  assert(surfaceA11y.ariaSelectedCount === 0, "the reservation surface uses aria-selected on non-grid controls");
  assert(surfaceA11y.mainCount === 1, "the reservation page has no single main landmark");

  // ── Tab A: select service → date → slot (the race slot stays free) ──────
  // The first service card under "La prestation" (published content order).
  // The cards only render once the real services bootstrap has resolved, so
  // wait for the control before clicking it.
  const serviceCardSource = `candidate.closest("section")?.querySelector("h2")?.textContent?.trim() === "La prestation" && candidate.getAttribute("aria-pressed") === "false"`;
  await waitFor(
    () => evaluate(cdp, `(() => {
      const button = [...document.querySelectorAll("button")].find((candidate) => (${serviceCardSource}));
      return Boolean(button && !button.disabled);
    })()`),
    "first bookable service card",
    45_000,
  );
  const serviceClicked = await clickButtonWhere(cdp, serviceCardSource);
  assert(serviceClicked, "could not select the first bookable service");
  const dateGridSource = `[role="group"][aria-label="Jours disponibles"] button`;
  await waitFor(
    () => evaluate(cdp, `(() => {
      const buttons = [...document.querySelectorAll(${JSON.stringify(dateGridSource)})];
      const target = buttons[${targetOffset}];
      return Boolean(target && !target.disabled);
    })()`),
    `available day ${targetDate} in the grid`,
    45_000,
  );
  const dateClicked = await evaluate(cdp, `(() => {
    const buttons = [...document.querySelectorAll(${JSON.stringify(dateGridSource)})];
    const target = buttons[${targetOffset}];
    if (!target || target.disabled) return false;
    target.click();
    return true;
  })()`);
  assert(dateClicked, `could not open the available day ${targetDate}`);
  await waitFor(
    () => evaluate(cdp, `(() => {
      const slot = [...document.querySelectorAll("time")].find((node) => node.textContent?.trim() === ${JSON.stringify(chosenSlot.localStart)} && !node.closest("button")?.disabled);
      return Boolean(slot);
    })()`),
    `slot ${chosenSlot.localStart} in the slot grid`,
    30_000,
  );
  const slotClicked = await clickButtonWhere(cdp, `candidate.querySelector("time")?.textContent?.trim() === ${JSON.stringify(chosenSlot.localStart)}`);
  assert(slotClicked, `could not select the slot ${chosenSlot.localStart}`);
  await waitFor(
    () => evaluate(cdp, `document.body?.innerText?.includes("Créneau sélectionné : ")`),
    "selected-slot status live region",
  );
  const selectionA11y = await evaluate(cdp, `(() => {
    const pressedTotal = [...document.querySelectorAll("button[aria-pressed='true']")].length;
    const statusLive = [...document.querySelectorAll('[role="status"]')].some((node) => node.textContent?.includes("Créneau sélectionné"));
    const statusPolite = [...document.querySelectorAll('[role="status"][aria-live="polite"]')].some((node) => node.textContent?.includes("Créneau sélectionné"));
    const selectedSlotText = [...document.querySelectorAll('[role="status"]')].map((node) => node.textContent?.trim()).find((text) => text?.includes("Créneau sélectionné")) ?? null;
    return { pressedTotal, statusLive, statusPolite, selectedSlotText };
  })()`);
  assert(selectionA11y.pressedTotal === 3, `expected exactly service+date+slot pressed, saw ${selectionA11y.pressedTotal}`);
  assert(selectionA11y.statusLive && selectionA11y.statusPolite, "the selected slot is not announced through a polite role=status live region");
  assert(
    selectionA11y.selectedSlotText?.includes(chosenSlot.localStart),
    `the live region does not name the chosen time: ${selectionA11y.selectedSlotText}`,
  );

  // ── 5. Invalid customer input writes nothing and preserves the form ─────
  await setReactInput(cdp, "customer-name", "");
  await setReactInput(cdp, "customer-email", customerA.email);
  await setReactInput(cdp, "customer-phone", customerA.phone);
  await setReactInput(cdp, "customer-note", customerA.note);
  await clickCheckbox(cdp, "consent-accepted");
  await waitFor(() => evaluate(cdp, `document.getElementById("consent-accepted")?.checked === true`), "consent checkbox");
  const creationPosts = [];
  cdp.on("Network.requestWillBeSent", ({ request }) => {
    if (request.method === "POST" && new URL(request.url).pathname === "/api/bookings") {
      creationPosts.push(request.url);
    }
  });
  const bookingsBeforeInvalid = mysqlExec("SELECT COUNT(*) FROM bookings");
  await clickButton(cdp, "Vérifier ma demande");
  await waitFor(
    () => evaluate(cdp, `Boolean(document.getElementById("name-error")?.offsetParent) && document.activeElement?.id === "customer-name"`),
    "invalid-name refusal with focus on the first invalid field",
  );
  const invalidState = await evaluate(cdp, `(() => {
    const name = document.getElementById("customer-name");
    const email = document.getElementById("customer-email");
    const phone = document.getElementById("customer-phone");
    const note = document.getElementById("customer-note");
    const consent = document.getElementById("consent-accepted");
    return {
      nameValue: name?.value,
      emailValue: email?.value,
      phoneValue: phone?.value,
      noteValue: note?.value,
      consentChecked: consent?.checked,
      nameInvalid: name?.getAttribute("aria-invalid"),
      nameDescribedBy: name?.getAttribute("aria-describedby"),
      errorText: document.getElementById("name-error")?.textContent?.trim() ?? null,
      fieldType: email?.getAttribute("type"),
      autoComplete: { email: email?.getAttribute("autoComplete"), name: name?.getAttribute("autoComplete"), phone: phone?.getAttribute("autoComplete") },
      noValidate: Boolean(document.querySelector("form")?.getAttribute("novalidate") === "" || document.querySelector("form")?.noValidate),
    };
  })()`);
  assert(invalidState.nameInvalid === "true" && invalidState.nameDescribedBy === "name-error", "the invalid name field does not report aria-invalid/aria-describedby");
  assert(invalidState.errorText === "Indiquez votre nom (160 caractères maximum).", `unexpected name error copy: ${invalidState.errorText}`);
  assert(invalidState.emailValue === customerA.email && invalidState.phoneValue === customerA.phone && invalidState.noteValue === customerA.note, "the refused submit lost entered values");
  assert(invalidState.consentChecked === true, "the refused submit lost the consent state");
  assert(invalidState.fieldType === "email" && invalidState.autoComplete.email === "email" && invalidState.autoComplete.name === "name" && invalidState.autoComplete.phone === "tel", "the customer fields lost their type/autoComplete");
  assert(invalidState.noValidate, "noValidate is not paired with the aria error wiring");
  await new Promise((resolveWait) => setTimeout(resolveWait, 800));
  assert(creationPosts.length === 0, `the invalid submit reached /api/bookings: ${creationPosts.length}`);
  const bookingsAfterInvalid = mysqlExec("SELECT COUNT(*) FROM bookings");
  assert(bookingsAfterInvalid === bookingsBeforeInvalid && bookingsBeforeInvalid === "0", `the invalid submit wrote ${bookingsAfterInvalid} booking row(s)`);

  // ── Tab B: same slot selected while still free, held on the review step ─
  const cdpB = await openTab(browser.debugPort);
  await cdpB.send("Page.enable");
  await cdpB.send("Runtime.enable");
  await cdpB.send("Network.enable");
  await setViewport(cdpB, 1280, 900);
  await navigateAndWait(cdpB, `${origin}/reservation`, "reservation page (tab B)", `Boolean(document.getElementById("reservation-main"))`);
  await waitFor(
    () => evaluate(cdpB, `(() => {
      const button = [...document.querySelectorAll("button")].find((candidate) => (${serviceCardSource}));
      return Boolean(button && !button.disabled);
    })()`),
    "tab B: first bookable service card",
    45_000,
  );
  const serviceClickedB = await clickButtonWhere(cdpB, serviceCardSource);
  assert(serviceClickedB, "tab B could not select the bookable service");
  await waitFor(
    () => evaluate(cdpB, `(() => {
      const buttons = [...document.querySelectorAll(${JSON.stringify(dateGridSource)})];
      const target = buttons[${targetOffset}];
      return Boolean(target && !target.disabled);
    })()`),
    `tab B: available day ${targetDate}`,
    45_000,
  );
  const dateClickedB = await evaluate(cdpB, `(() => {
    const buttons = [...document.querySelectorAll(${JSON.stringify(dateGridSource)})];
    const target = buttons[${targetOffset}];
    if (!target || target.disabled) return false;
    target.click();
    return true;
  })()`);
  assert(dateClickedB, "tab B could not open the same day");
  await waitFor(
    () => evaluate(cdpB, `(() => {
      const slot = [...document.querySelectorAll("time")].find((node) => node.textContent?.trim() === ${JSON.stringify(chosenSlot.localStart)} && !node.closest("button")?.disabled);
      return Boolean(slot);
    })()`),
    `tab B: slot ${chosenSlot.localStart}`,
    30_000,
  );
  const slotClickedB = await clickButtonWhere(cdpB, `candidate.querySelector("time")?.textContent?.trim() === ${JSON.stringify(chosenSlot.localStart)}`);
  assert(slotClickedB, "tab B could not select the same slot");
  await waitFor(
    () => evaluate(cdpB, `document.body?.innerText?.includes("Vos coordonnées")`),
    "tab B: customer details step",
  );
  await setReactInput(cdpB, "customer-name", customerB.name);
  await setReactInput(cdpB, "customer-email", customerB.email);
  await setReactInput(cdpB, "customer-phone", customerB.phone);
  await setReactInput(cdpB, "customer-note", customerB.note);
  await clickCheckbox(cdpB, "consent-accepted");
  await waitFor(() => evaluate(cdpB, `document.getElementById("consent-accepted")?.checked === true`), "tab B consent checkbox");
  await clickButton(cdpB, "Vérifier ma demande");
  await waitFor(
    () => evaluate(cdpB, `document.getElementById("review-heading") && document.activeElement?.id === "review-heading"`),
    "tab B: review step with focus on the review heading",
  );
  const reviewCopy = await evaluate(cdpB, `document.getElementById("review-heading")?.textContent?.trim() ?? ""`);
  assert(reviewCopy === "Vérifiez votre demande", `tab B review heading mismatch: ${reviewCopy}`);
  const bPressed = await evaluate(cdpB, `[...document.querySelectorAll("button[aria-pressed='true']")].length`);
  assert(bPressed === 3, `tab B holds ${bPressed} pressed choices, expected service+date+slot`);

  // ── 2. Tab A: valid booking completes through the browser ───────────────
  await setReactInput(cdp, "customer-name", customerA.name);
  await clickButton(cdp, "Vérifier ma demande");
  await waitFor(
    () => evaluate(cdp, `document.getElementById("review-heading") && document.activeElement?.id === "review-heading"`),
    "review step with focus on the review heading (tab A)",
  );
  await clickButton(cdp, "Confirmer le rendez-vous");
  await waitFor(
    () => evaluate(cdp, `document.body?.innerText?.includes("Votre rendez-vous est bien enregistré")`),
    "booking confirmation",
    45_000,
  );
  const confirmation = await evaluate(cdp, `(() => ({
    activeId: document.activeElement?.id ?? null,
    heading: document.querySelector('[id="confirmation-heading"]')?.textContent?.trim() ?? null,
    reference: (document.body?.innerText?.match(/bk_[0-9a-f]{32}/) ?? [null])[0],
  }))()`);
  assert(confirmation.activeId === "confirmation-heading", `focus did not move to the confirmation heading: ${confirmation.activeId}`);
  assert(confirmation.reference && /^bk_[0-9a-f]{32}$/.test(confirmation.reference), "no booking reference on the confirmation screen");
  const referenceA = confirmation.reference;
  const bookingsAfterA = mysqlExec("SELECT COUNT(*) FROM bookings");
  assert(bookingsAfterA === "1", `expected exactly one booking after the browser confirmation, got ${bookingsAfterA}`);

  // ── 6. Tab B confirms the now-stale slot: recovery, no duplicates ───────
  await clickButton(cdpB, "Confirmer le rendez-vous");
  // The refusal first announces "Ce créneau vient d'être réservé. Vos
  // coordonnées sont conservées…", then the automatic availability refresh
  // replaces it with "Ce créneau n'est plus disponible. Choisissez un nouvel
  // horaire." once the slot is gone from the server-side picture.
  await waitFor(
    () => evaluate(cdpB, `/nouvel horaire/i.test(document.body?.innerText ?? "")`),
    "stale-slot recovery notice (tab B)",
    45_000,
  );
  const recoveryState = await evaluate(cdpB, `(() => {
    const notice = [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent?.trim());
    return { notices: notice };
  })()`);
  assert(
    recoveryState.notices.some((text) => text?.includes("conservées") || /nouvel horaire/i.test(text ?? "")),
    "the stale-slot refusal is not announced via role=alert",
  );
  await waitFor(
    () => evaluate(cdpB, `document.activeElement?.id === "slot-heading"`),
    "focus on the slot heading after the recovery notice",
  );
  const bookingsAfterStale = mysqlExec("SELECT COUNT(*) FROM bookings");
  assert(bookingsAfterStale === "1", `the stale confirmation created a duplicate booking: ${bookingsAfterStale} rows`);
  const staleCustomerB = mysqlExec(`SELECT COUNT(*) FROM bookings WHERE customer_email = '${customerB.email}'`);
  assert(staleCustomerB === "0", "the stale confirmation wrote customer B's booking");
  const staleJobs = mysqlExec("SELECT COUNT(*) FROM notification_jobs");
  assert(staleJobs === "2", `the stale confirmation enqueued extra notification jobs: ${staleJobs} rows`);
  const jobsForA = mysqlExec(`SELECT COUNT(*) FROM notification_jobs WHERE booking_id = (SELECT id FROM bookings WHERE reference = '${referenceA}')`);
  assert(jobsForA === "2", `booking A does not own exactly two notification jobs: ${jobsForA}`);

  // The recovery path preserves the form: choose the next free slot and the
  // details come back with customer B's values intact.
  const nextDate = await evaluate(cdpB, `(() => {
    const enabled = [...document.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-pressed") === "false" && candidate.closest('[role="group"][aria-label="Jours disponibles"]') && !candidate.disabled);
    if (enabled) enabled.click();
    return Boolean(enabled);
  })()`);
  assert(nextDate, "no alternative available day after the recovery");
  await waitFor(
    () => evaluate(cdpB, `(() => {
      const enabled = [...document.querySelectorAll('[role="group"] button[type="button"]')].find((candidate) => candidate.querySelector("time") && !candidate.disabled && candidate.getAttribute("aria-pressed") !== "true");
      if (enabled) enabled.click();
      return Boolean(enabled);
    })()`),
    "alternative slot selection after the recovery",
  );
  await waitFor(
    () => evaluate(cdpB, `Boolean(document.getElementById("customer-name")) && document.activeElement?.id === "details-heading"`),
    "details step after the recovery with focus on the details heading",
  );
  const preservedB = await evaluate(cdpB, `(() => {
    const value = (id) => document.getElementById(id)?.value ?? null;
    return {
      name: value("customer-name"),
      email: value("customer-email"),
      phone: value("customer-phone"),
      note: value("customer-note"),
      consent: document.getElementById("consent-accepted")?.checked ?? null,
    };
  })()`);
  for (const [field, expected] of Object.entries(customerB)) {
    assert(preservedB[field] === expected, `the recovery lost customer B's ${field}`);
  }
  assert(preservedB.consent === true, "the recovery lost customer B's consent");
  const bookingsFinal = mysqlExec("SELECT COUNT(*) FROM bookings");
  assert(bookingsFinal === "1", `the recovery reselect created a booking: ${bookingsFinal} rows`);

  // ── 3. Persistence: real API + real DB + the admin calendar ─────────────
  const adminCdp = cdpB;
  await signIn(adminCdp, origin, credentials.email, credentials.password);
  await navigateAndWait(adminCdp, `${origin}/admin/bookings`, "admin booking calendar", `document.querySelector("h1")?.textContent?.trim() === "Calendrier"`);

  // Open the booking's day (navigating months if the slot crossed a border).
  // The month grid only exists once the real range query has finished, so the
  // first step is to wait for the grid to render — clicking "Mois suivant"
  // while the grid is still loading would move to a month that never shows
  // the target day.
  const cellPrefix = parisDayCellPrefix(targetDate);
  const targetYear = targetDate.slice(0, 4);
  const gridRendered = () => evaluate(adminCdp, `(() => {
    if (document.body?.innerText?.includes("Chargement des rendez-vous")) return false;
    const cells = [...document.querySelectorAll("button")].filter((candidate) => (candidate.getAttribute("aria-label") ?? "").includes(${JSON.stringify(targetYear)}));
    return cells.length >= 1;
  })()`);
  await waitFor(gridRendered, "admin calendar month grid", 45_000);
  const clickDayCell = () => evaluate(adminCdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label")?.startsWith(${JSON.stringify(cellPrefix)}));
    button?.click();
    return Boolean(button);
  })()`);
  let dayCell = await clickDayCell();
  for (let attempt = 0; !dayCell && attempt < 3; attempt++) {
    const moved = await clickButtonWhere(adminCdp, `candidate.textContent?.trim() === "Mois suivant"`);
    assert(moved, "could not navigate the calendar month");
    await waitFor(gridRendered, `calendar month grid after navigation`, 30_000);
    dayCell = await clickDayCell();
  }
  assert(dayCell, `calendar day cell ${targetDate} not found`);
  await waitFor(
    () => evaluate(adminCdp, `[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Jour" && button.getAttribute("aria-pressed") === "true")`),
    "day view activation",
  );
  await waitFor(
    () => evaluate(adminCdp, `[...document.querySelectorAll("button")].some((button) => button.textContent?.includes(${JSON.stringify(customerA.name)}))`),
    `day-view booking ${customerA.name}`,
  );
  const calendarA11y = await evaluate(adminCdp, `(() => {
    const gridRoles = document.querySelectorAll('[role="grid"], [role="gridcell"], [role="columnheader"]').length;
    const viewPressed = Object.fromEntries([...document.querySelectorAll('[aria-label="Vue du calendrier"] button')].map((button) => [button.textContent?.trim(), button.getAttribute("aria-pressed")]));
    return { gridRoles, viewPressed };
  })()`);
  assert(calendarA11y.gridRoles === 0, "the admin calendar claims a grid pattern it does not implement");
  assert(calendarA11y.viewPressed?.Jour === "true" && calendarA11y.viewPressed?.Mois === "false", "the calendar view toggle contradicts the actual view");
  const opened = await evaluate(adminCdp, `(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(${JSON.stringify(customerA.name)}));
    button?.click();
    return Boolean(button);
  })()`);
  assert(opened, `could not open booking ${customerA.name}`);
  await waitFor(
    () => evaluate(adminCdp, `document.querySelector('aside[aria-label="Détail du rendez-vous"] h2')?.textContent?.trim() === ${JSON.stringify(customerA.name)}`),
    `booking detail ${customerA.name}`,
  );
  const detail = await evaluate(adminCdp, `(() => {
    const aside = document.querySelector('aside[aria-label="Détail du rendez-vous"]');
    return {
      emailHref: aside?.querySelector('a[href^="mailto:"]')?.getAttribute("href") ?? null,
      telHref: aside?.querySelector('a[href^="tel:"]')?.getAttribute("href") ?? null,
      body: aside?.textContent ?? "",
    };
  })()`);
  assert(detail.emailHref === `mailto:${customerA.email}`, `calendar detail email mismatch: ${detail.emailHref}`);
  assert(detail.telHref === `tel:${customerA.phone}`, `calendar detail phone mismatch: ${detail.telHref}`);
  assert(detail.body.includes(customerA.note), "calendar detail note is missing");

  // Real API: the admin query surface returns the persisted booking.
  const adminCookie = await sessionCookie(adminCdp, origin, sessionCookieName);
  const session = await json("/api/auth/session", { headers: { accept: "application/json", cookie: adminCookie } });
  assert(session.body.authenticated === true && typeof session.body.csrfToken === "string", "the admin API session was not authenticated");
  const query = await json("/api/admin/bookings/query", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", cookie: adminCookie, [csrfHeader]: session.body.csrfToken },
    body: JSON.stringify({ mode: "reference", reference: referenceA }),
  });
  assert(query.status === 200 && query.body?.booking?.reference === referenceA, `admin query by reference failed: ${query.status}`);
  const serverContact = {
    customerName: customerA.name,
    customerEmail: customerA.email,
    customerPhone: customerA.phone,
    customerNote: customerA.note,
  };
  for (const [field, expected] of Object.entries(serverContact)) {
    assert(query.body.booking[field] === expected, `admin query field ${field} mismatch`);
  }
  assert(query.body.booking.state === "confirmed", "the admin query does not report the booking confirmed");

  // Real DB: booking row, history, consent, notification jobs exactly per contract.
  const bookingRow = mysqlJson(`SELECT JSON_OBJECT('state', state, 'service_key', service_key, 'customer_email', customer_email, 'consent_notice_id', consent_notice_id, 'starts_at_utc', DATE_FORMAT(starts_at_utc, '%Y-%m-%d %H:%i:%s.%f'), 'consent_at_utc', consent_at_utc) FROM bookings WHERE reference = '${referenceA}'`);
  assert(bookingRow?.state === "confirmed" && bookingRow.service_key === serviceKey, "the persisted booking row disagrees with the confirmation");
  assert(bookingRow.customer_email === customerA.email, "the persisted booking row lost the customer email");
  assert(bookingRow.consent_notice_id === consentNoticeId, `the persisted booking lost the consent notice id: ${bookingRow.consent_notice_id}`);
  const historyEvents = mysqlExec(`SELECT COUNT(*) FROM booking_history WHERE booking_id = (SELECT id FROM bookings WHERE reference = '${referenceA}') AND event_type = 'created'`);
  assert(historyEvents === "1", `expected one created history event, got ${historyEvents}`);
  const jobs = mysqlJson(`SELECT JSON_ARRAYAGG(JSON_OBJECT('job_type', job_type, 'status', status, 'attempts', attempts, 'sent_at_utc', sent_at_utc, 'lease_owner', lease_owner, 'due_at_utc', DATE_FORMAT(due_at_utc, '%Y-%m-%d %H:%i:%s.%f'))) AS items FROM notification_jobs WHERE booking_id = (SELECT id FROM bookings WHERE reference = '${referenceA}') ORDER BY job_type`);
  assert(Array.isArray(jobs) && jobs.length === 2, `expected exactly two notification jobs, got ${JSON.stringify(jobs)}`);
  const byType = Object.fromEntries(jobs.map((job) => [job.job_type, job]));
  assert(byType.booking_confirmation?.status === "pending", `confirmation job is not pending: ${JSON.stringify(byType.booking_confirmation)}`);
  assert(byType.booking_reminder?.status === "pending", `reminder job is not pending: ${JSON.stringify(byType.booking_reminder)}`);
  const expectedReminderDue = mysqlExec(`SELECT DATE_FORMAT(DATE_SUB(starts_at_utc, INTERVAL 24 HOUR), '%Y-%m-%d %H:%i:%s.%f') FROM bookings WHERE reference = '${referenceA}'`);
  assert(byType.booking_reminder.due_at_utc === expectedReminderDue, `reminder due ${byType.booking_reminder.due_at_utc} != start-24h ${expectedReminderDue}`);
  for (const job of jobs) {
    assert(job.attempts === 0 && job.sent_at_utc === null && job.lease_owner === null, `job ${job.job_type} was touched: ${JSON.stringify(job)}`);
  }
  process.stdout.write(`booking: ${referenceA} confirmed through the browser UI, slot ${chosenSlot.startsAtUtc}\n`);
  process.stdout.write("jobs: booking_confirmation pending (due at creation) + booking_reminder pending (due T-24h), attempts 0, nothing sent — no SMTP in the stack\n");
  process.stdout.write(`stale tab: refused 409-equivalent, recovery notice shown, ${bookingsAfterStale} booking and ${staleJobs} jobs total — no duplicates\n`);

  // ── 320 px reflow on the reservation page ───────────────────────────────
  await setViewport(cdp, 320, 720);
  await navigateAndWait(cdp, `${origin}/reservation`, "reservation at 320 px", `Boolean(document.getElementById("reservation-main"))`);
  await waitFor(
    () => evaluate(cdp, `(() => {
      const button = [...document.querySelectorAll("button")].find((candidate) => (${serviceCardSource}));
      return Boolean(button && !button.disabled);
    })()`),
    "service card at 320 px",
    45_000,
  );
  const reservation320 = await evaluate(cdp, `(() => {
    const html = document.documentElement;
    const serviceCard = [...document.querySelectorAll("main button")].find((candidate) => (${serviceCardSource}));
    const rect = serviceCard?.getBoundingClientRect();
    return {
      scrollWidth: html.scrollWidth,
      clientWidth: html.clientWidth,
      cardUsable: Boolean(rect && rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= html.clientWidth + 1),
    };
  })()`);
  assert(reservation320.scrollWidth <= reservation320.clientWidth + 1, `the reservation page overflows at 320 px: ${reservation320.scrollWidth} > ${reservation320.clientWidth}`);
  assert(reservation320.cardUsable, "the service cards are not usable at 320 px");

  cdp.close();
  cdpB.close();
  process.stdout.write("browser:booking proof: PASS\n");
  process.stdout.write("accessibility: skip-link keyboard focus, review/confirmation/invalid/recovery focus moves, polite status live regions, labels + aria-invalid/describedby, no fake grid ARIA, 320 px without overflow\n");
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
    process.stderr.write(`browser:booking cleanup failed: ${cleanupError.message}\n`);
  }
}

if (failure) {
  process.stderr.write(`${failure.stack ?? failure}\n`);
  process.exit(1);
}
