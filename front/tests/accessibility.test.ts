import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const appRoot = join(process.cwd(), "app");

test("public page exposes a skip link and one main landmark", () => {
  const sitePreviewSource = readFileSync(
    join(appRoot, "components", "site-preview.tsx"),
    "utf8",
  );

  assert.match(sitePreviewSource, /href="#main-content"/);
  assert.match(sitePreviewSource, /<main\s+id="main-content"\s+tabIndex=\{-1\}/);
  assert.equal((sitePreviewSource.match(/<main\s/g) ?? []).length, 1);
});

test("public heading hierarchy includes a hidden reassurance h2 before h3 cards", () => {
  const sitePreviewSource = readFileSync(
    join(appRoot, "components", "site-preview.tsx"),
    "utf8",
  );

  assert.match(sitePreviewSource, /<h1\b/);
  assert.match(sitePreviewSource, /<h2 className="sr-only">Pourquoi choisir Eszter Gyori<\/h2>/);
});

test("navigation has accessible labels and the closed mobile menu is not rendered", () => {
  const navigationSource = readFileSync(
    join(appRoot, "components", "navigation.tsx"),
    "utf8",
  );
  const mobileNavSource = readFileSync(
    join(appRoot, "components", "mobile-nav.tsx"),
    "utf8",
  );

  assert.match(navigationSource, /aria-label="Navigation principale"/);
  assert.match(navigationSource, /aria-label="Retour au début de la page"/);
  assert.match(mobileNavSource, /aria-controls=\{menuId\}/);
  assert.match(mobileNavSource, /aria-expanded=\{open\}/);
  assert.match(mobileNavSource, /event\.key !== "Escape"/);
  assert.match(mobileNavSource, /buttonRef\.current\?\.focus\(\)/);
  assert.match(mobileNavSource, /open &&[\s\S]*createPortal/);
  assert.match(mobileNavSource, /aria-hidden="true"/);
  assert.doesNotMatch(mobileNavSource, /pointer-events-none/);
});

test("focus visibility and reduced motion are globally covered", () => {
  const globalsSource = readFileSync(join(appRoot, "globals.css"), "utf8");
  const sitePreviewSource = readFileSync(
    join(appRoot, "components", "site-preview.tsx"),
    "utf8",
  );

  assert.match(globalsSource, /\.skip-link/);
  assert.match(globalsSource, /:focus-visible/);
  assert.match(globalsSource, /outline: 3px solid var\(--site-primary, #63726C\) !important/);
  assert.match(globalsSource, /prefers-reduced-motion: reduce/);
  assert.match(globalsSource, /scroll-behavior: auto !important/);
  assert.match(sitePreviewSource, /<footer[\s\S]*text-warm-600/);
});

test("admin forms and editor messages expose live feedback", () => {
  const loginFormSource = readFileSync(
    join(appRoot, "components", "admin", "admin-login-form.tsx"),
    "utf8",
  );
  const sessionSource = readFileSync(
    join(appRoot, "components", "admin", "admin-session-provider.tsx"),
    "utf8",
  );
  const contentEditorSource = readFileSync(
    join(appRoot, "components", "admin", "content-editor.tsx"),
    "utf8",
  );

  // ESZ-020 replaced the login form with a static notice, and this test asserted
  // the absence of a form because there was nothing in the export that could
  // check a credential — `role="alert"` would have been announcing nothing.
  //
  // ESZ-034 restores the form against `/api/auth/login`, so the assertion the old
  // comment promised comes back with it: a rejected sign-in interrupts, because
  // an admin who cannot see the field is otherwise left waiting on a form that
  // silently did nothing. Progress stays polite.
  assert.match(loginFormSource, /<form/);
  assert.match(loginFormSource, /type="password"/);
  assert.match(loginFormSource, /role="alert"/);
  assert.match(loginFormSource, /aria-live="polite"/);

  // The session bootstrap replaces the whole screen while it resolves, so its
  // notice has to be announced rather than silently swapped in.
  assert.match(sessionSource, /role="status"/);
  assert.match(sessionSource, /aria-live="polite"/);

  assert.match(contentEditorSource, /role="status"/);
  assert.match(contentEditorSource, /aria-live="polite"/);
  assert.match(contentEditorSource, /role="alert"/);
});

// ── ESZ-085: the reservation and admin surfaces ─────────────────────────────
//
// Packages 5.x through 7.x added the first screens on this site that are forms
// with server-decided errors rather than pages of copy, and they are where every
// remaining accessibility risk now lives: a field whose error is announced to
// nobody, a step change that moves focus nowhere, a control that is a `<div>` with
// a click handler.
//
// These are source assertions, like the ones above, and they are exact about what
// that does and does not prove. It proves the attribute is *there*, which is what
// regresses when a component is refactored; it does not prove a screen reader says
// the right thing. The browser half of that gap is covered by the Stage 9 runners
// since ESZ-113 (`browser:public`, `browser:admin`, `browser:booking` drive the
// real DOM with real keyboard events); the assistive-technology half remains
// deployment-owned. A source grep still stands in for neither.

const reservationDetails = readFileSync(
  join(appRoot, "components", "reservation", "reservation-details.tsx"),
  "utf8",
);
const reservationFlow = readFileSync(
  join(appRoot, "components", "reservation", "reservation-flow.tsx"),
  "utf8",
);
const bookingCalendar = readFileSync(
  join(appRoot, "components", "admin", "admin-booking-calendar.tsx"),
  "utf8",
);
const availabilityEditor = readFileSync(
  join(appRoot, "components", "admin", "admin-availability-editor.tsx"),
  "utf8",
);
const operationsSummary = readFileSync(
  join(appRoot, "components", "admin", "admin-operations-summary.tsx"),
  "utf8",
);

test("every reservation field is labelled, typed and described by its own error", () => {
  // A field whose error lives in a paragraph somewhere below it is an error only
  // a sighted user has. `aria-describedby` is what attaches the message to the
  // input, and `aria-invalid` is what says the input is the one that is wrong.
  for (const field of ["name", "email", "phone", "note", "consentAccepted"]) {
    assert.match(
      reservationDetails,
      new RegExp(`aria-invalid=\\{Boolean\\(errorFor\\("${field}"\\)\\)\\}`),
      `${field} does not report its own validity`,
    );
    assert.match(
      reservationDetails,
      new RegExp(`aria-describedby=\\{describedBy\\("${field}"\\)\\}`),
      `${field} is not described by its own error`,
    );
  }

  // Every visible control has a programmatic label. Placeholder text is not a
  // label: it disappears on focus, which is the moment it is needed.
  assert.equal((reservationDetails.match(/htmlFor=/g) ?? []).length, 5);

  // `type` and `autoComplete` are accessibility features, not conveniences. They
  // are what gives a phone the right keyboard and what lets someone with a motor
  // impairment fill the form from stored values instead of typing it.
  assert.match(reservationDetails, /type="email"[\s\S]*?autoComplete="email"|autoComplete="email"[\s\S]*?type="email"/);
  assert.match(reservationDetails, /autoComplete="name"/);
  assert.match(reservationDetails, /autoComplete="tel"/);
  assert.match(reservationDetails, /inputMode="tel"/);
});

test("the reservation form validates itself rather than deferring to the browser", () => {
  // `noValidate` is deliberate. The browser's own bubbles are unstyled, are not
  // announced consistently, vanish on the next interaction, and are in the
  // browser's language rather than the site's. Turning them off is what lets the
  // form own its errors — and it is only correct *because* the fields above carry
  // aria-invalid and aria-describedby instead.
  assert.match(reservationDetails, /noValidate/);
  assert.match(reservationDetails, /role="alert"/);
});

test("a rejected reservation moves focus to the problem instead of announcing it into empty air", () => {
  // Someone using a screen reader or a keyboard has no idea a submit failed
  // unless focus goes somewhere. `aria-live` alone leaves them on the button they
  // just pressed, with the form apparently unchanged.
  assert.match(reservationDetails, /\.focus\(\)/);
  assert.match(reservationDetails, /aria-busy/);

  // The step change is the same problem one level up: the flow replaces the whole
  // panel, so focus has to follow it to the new heading.
  assert.match(reservationFlow, /tabIndex=\{-1\}/);
  assert.match(reservationFlow, /\.focus\(\)/);
  assert.match(reservationFlow, /aria-live/);
});

test("reservation slot and service choices are buttons that report their pressed state", () => {
  // Selection has to be conveyed by state rather than by colour. `aria-pressed`
  // is what makes "this slot is chosen" audible, and a real `<button>` is what
  // makes it reachable by keyboard at all — a `<div onClick>` is neither
  // focusable nor operable with a keyboard.
  assert.match(reservationFlow, /aria-pressed=/);
  assert.match(reservationFlow, /role="group"/);
  assert.match(reservationFlow, /aria-labelledby=/);
  assert.doesNotMatch(reservationFlow, /<div[^>]*onClick=/);
  assert.doesNotMatch(reservationDetails, /<div[^>]*onClick=/);
});

test("admin editors attach server-decided errors to the row that broke", () => {
  // The availability editor's whole value is attributing a refusal to one rule.
  // If the attribution is only visual, the person who most needs it does not get
  // it.
  assert.match(availabilityEditor, /aria-invalid=/);
  assert.match(availabilityEditor, /aria-describedby=/);
  assert.match(availabilityEditor, /role="alert"/);
  assert.match(availabilityEditor, /aria-live=/);
  assert.match(availabilityEditor, /<fieldset/);
  assert.match(availabilityEditor, /<legend/);

  // Destructive confirmations move focus, or the confirmation is a thing that
  // appeared somewhere off-screen.
  assert.match(availabilityEditor, /tabIndex=\{-1\}/);
  assert.match(availabilityEditor, /\.focus\(\)/);
});

test("the booking calendar claims no ARIA pattern it does not implement", () => {
  // ESZ-085 removed role="grid"/"gridcell"/"columnheader" from the month view.
  // They were applied without any role="row" between them, which is not a grid,
  // and role="grid" additionally promises arrow-key navigation between cells that
  // this component does not implement. A pattern claimed and not honoured is
  // worse than no pattern: someone relying on it navigates as though the promise
  // held.
  assert.doesNotMatch(bookingCalendar, /role="grid"/);
  assert.doesNotMatch(bookingCalendar, /role="gridcell"/);
  assert.doesNotMatch(bookingCalendar, /role="columnheader"/);
  assert.doesNotMatch(bookingCalendar, /aria-selected/);
});

test("every calendar day says what day it is and how busy it is", () => {
  // The visible text of a day cell is a bare number and up to three truncated
  // names. As an accessible name that is neither a date nor a summary, so the
  // cell carries its own label and the decorative contents are hidden from the
  // accessibility tree rather than read out twice.
  assert.match(bookingCalendar, /aria-label=\{dayCellLabel\(date, items\.length\)\}/);
  assert.match(bookingCalendar, /function dayCellLabel/);
  assert.match(bookingCalendar, /aria-current=\{selectedDate === date \? "date" : undefined\}/);
  assert.match(bookingCalendar, /aria-hidden="true" className="text-sm font-medium"/);
});

test("admin views are operable from the keyboard alone", () => {
  // Two failure modes, one assertion each: a control that cannot be focused, and
  // a focus ring that has been removed without a replacement. `focus:outline-none`
  // is legitimate only when a visible `focus:ring-*` takes its place, and the
  // pairing is what makes it legitimate.
  for (const [name, source] of [
    ["booking calendar", bookingCalendar],
    ["availability editor", availabilityEditor],
    ["operations summary", operationsSummary],
  ] as const) {
    assert.doesNotMatch(source, /<div[^>]*onClick=/, `${name} has a click handler on a non-focusable element`);
    assert.doesNotMatch(source, /<span[^>]*onClick=/, `${name} has a click handler on a non-focusable element`);

    const suppressed = (source.match(/focus:outline-none/g) ?? []).length;
    const replaced = (source.match(/focus:ring-/g) ?? []).length;

    assert.ok(
      replaced >= suppressed,
      `${name} removes the default focus outline ${suppressed} time(s) but only supplies ${replaced} visible replacement(s)`,
    );
  }
});

test("every asynchronous admin view announces its loading and error states", () => {
  // A view that swaps its contents when a fetch resolves is a view that changes
  // silently unless it says so. `aria-busy` covers the wait; `role="status"` and
  // `role="alert"` cover the outcome, and the difference between them is whether
  // the person needs to be interrupted.
  for (const [name, source] of [
    ["booking calendar", bookingCalendar],
    ["availability editor", availabilityEditor],
    ["operations summary", operationsSummary],
  ] as const) {
    assert.match(source, /role="status"/, `${name} never announces progress`);
  }

  assert.match(bookingCalendar, /aria-busy=\{loading\}/);
  assert.match(operationsSummary, /role="alert"/);
});
