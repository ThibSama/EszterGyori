import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const appRoot = join(process.cwd(), "app");
const flow = readFileSync(join(appRoot, "components", "reservation", "reservation-flow.tsx"), "utf8");
const details = readFileSync(join(appRoot, "components", "reservation", "reservation-details.tsx"), "utf8");

test("desktop, mobile and service cards expose the reservation entry", () => {
  const navigation = readFileSync(join(appRoot, "components", "navigation.tsx"), "utf8");
  const mobile = readFileSync(join(appRoot, "components", "mobile-nav.tsx"), "utf8");
  const site = readFileSync(join(appRoot, "components", "site-preview.tsx"), "utf8");
  assert.match(navigation, /href="\/reservation"/);
  assert.match(mobile, /href="\/reservation"/);
  assert.match(site, /`\/reservation\?service=\$\{item\.id\}`/);
});

test("reservation exposes accessible progress, navigation, errors and exact slot times", () => {
  assert.match(flow, /href="#reservation-main"/);
  assert.match(flow, /<main id="reservation-main" tabIndex=\{-1\}/);
  assert.match(flow, /aria-label="Navigation des dates"/);
  assert.match(flow, /aria-pressed=\{selected\}/);
  assert.match(flow, /role="alert"/);
  assert.match(flow, /aria-live="polite"/);
  assert.match(flow, /<time dateTime=\{slot\.startsAtUtc\}>/);
  assert.match(flow, /indisponible/);
  assert.match(flow, /Aucun créneau disponible/);
});

test("the completed flow stays responsive and delegates booking submission", () => {
  assert.match(flow, /grid-cols-1[^\n]*sm:grid-cols-2/);
  assert.match(flow, /grid-cols-2[^\n]*md:grid-cols-7/);
  assert.match(flow, /grid-cols-2[^\n]*md:grid-cols-4/);
  assert.match(flow, /createBooking\(request\)/);
  assert.doesNotMatch(`${flow}\n${details}`, /localStorage|sessionStorage/);
  assert.match(details, /sm:grid-cols-2/);
});

test("customer form, review and confirmation expose accessible semantics and focus targets", () => {
  assert.match(details, /<form onSubmit=\{showReview\} noValidate/);
  assert.doesNotMatch(details, /customer-name"/);
  assert.match(details, /htmlFor="customer-first-name"/);
  assert.match(details, /id="customer-first-name" name="firstName" autoComplete="given-name" required/);
  assert.match(details, /htmlFor="customer-last-name"/);
  assert.match(details, /id="customer-last-name" name="lastName" autoComplete="family-name" required/);
  assert.match(details, /aria-describedby=\{describedBy\("firstName"\)\}/);
  assert.match(details, /aria-describedby=\{describedBy\("lastName"\)\}/);
  assert.match(details, /id="firstName-error"/);
  assert.match(details, /id="lastName-error"/);
  assert.match(details, /firstName: firstNameInput,\s*lastName: lastNameInput,/);
  assert.match(details, /type="email"/);
  assert.match(details, /type="tel"/);
  // ESZ-161: no consent checkbox exists any more.
  assert.doesNotMatch(details, /type="checkbox"/);
  assert.doesNotMatch(details, /consentAccepted/);
  assert.match(details, /aria-describedby=\{describedBy/);
  assert.match(details, /aria-invalid=\{Boolean/);
  assert.match(details, /role="alert"/);
  assert.match(details, /aria-live="polite"/);
  assert.match(details, /\.current\?\.focus\(\)/);
  assert.match(details, /Vérifiez votre demande/);
  assert.match(details, /Rendez-vous confirmé/);
});

test("stale slots refresh without automatic replacement or automatic creation retry", () => {
  const staleBranch = flow.slice(
    flow.indexOf('result.failure.kind === "slot-unavailable"'),
    flow.indexOf('dispatch({ type: "submit-failed"'),
  );
  assert.match(flow, /failure\.kind === "slot-unavailable"/);
  assert.match(flow, /type: "booking-slot-unavailable"/);
  assert.match(flow, /setRefreshVersion/);
  assert.doesNotMatch(flow, /createBooking\(request\)[\s\S]*createBooking\(request\)/);
  assert.doesNotMatch(staleBranch, /select-slot|createBooking/);
});

// --- ESZ-136: rate-limited availability and creation -----------------------

test("an availability 429 is dispatched distinctly with a trusted retry deadline", () => {
  assert.match(flow, /failure\.kind === "rate-limited"/);
  assert.match(flow, /type: "rate-limited"/);
  assert.match(flow, /retryAtEpochMs: retryAllowedAtEpochMs\(/);
  assert.match(flow, /BOOKING_API_MESSAGES\.rateLimited|result\.failure\.message/);
  assert.match(flow, /dispatch\(\{ type: "failed", message: result\.failure\.message \}\)/);
  // The generic failure dispatch must sit after the rate-limited branch's own
  // return, so a 429 can never fall through to the generic copy.
  const rateLimitedBranch = flow.slice(
    flow.indexOf('if (result.failure.kind === "rate-limited")'),
    flow.indexOf('dispatch({ type: "failed", message: result.failure.message })'),
  );
  assert.match(rateLimitedBranch, /return;/);
  assert.doesNotMatch(rateLimitedBranch, /type: "failed"/);
});

test("availability refetch is skipped while a trusted delay runs, with no timer-triggered request", () => {
  // The availability effect refuses to start a request while the gate is
  // closed, so no automatic re-request can fire during the delay.
  assert.match(flow, /isRetryBlocked\(state\.availabilityRetryAtEpochMs, Date\.now\(\)\)/);
  // The one countdown interval only advances the render clock: it must not
  // dispatch, fetch or submit anything.
  const intervalBody = flow.slice(
    flow.indexOf("const interval = window.setInterval"),
    flow.indexOf("}, 1000)"),
  );
  assert.match(intervalBody, /setNowEpochMs/);
  assert.doesNotMatch(intervalBody, /dispatch|loadAvailability|createBooking|fetch|submit/);
});

test("the availability error and slot notices expose a gated manual retry", () => {
  assert.match(flow, /disabled=\{availabilityRetryBlocked\}/);
  assert.match(flow, /Réessayer/);
  assert.match(flow, /Actualiser les disponibilités/);
  // While blocked, the UI shows how long the wait lasts (role="status").
  assert.match(flow, /\{availabilityRetryCopy && \(/);
  assert.match(flow, /retryWaitLabel/);
});

test("a rate-limited creation keeps the review step and closes the confirm control", () => {
  // The submission handler branches the 429 onto submit-failed with the
  // trusted deadline, and guards the handler itself.
  assert.match(flow, /failure\.kind === "rate-limited"/);
  assert.match(flow, /retryAtEpochMs: retryAllowedAtEpochMs\(/);
  assert.match(flow, /isRetryBlocked\(state\.submissionRetryAtEpochMs, Date\.now\(\)\)/);
  assert.match(details, /submissionRetryBlocked/);
  assert.match(details, /disabled=\{state\.phase === "submitting" \|\| submissionRetryBlocked/);
  assert.match(details, /\{submissionRetryCopy && \(/);
  assert.match(details, /submissionError\.message/);
  // No automatic resubmission after the wait: the details surface re-enables
  // the control and nothing calls onSubmit by itself.
  assert.doesNotMatch(details, /setInterval/);
});

// --- ESZ-161: the privacy notice is the contract's, not the component's ----

test("the form renders the current catalog privacy notice instead of a consent checkbox", () => {
  // The displayed statements must come from the immutable booking-domain
  // catalog — the same artifact the server validates ids against — so a
  // wording change is one catalog edit, never a hunt through components.
  assert.match(
    details,
    /import { bookingPrivacyCurrentNotice } from "@eszter\/contracts";/,
  );
  assert.match(details, /data-privacy-notice-id=\{bookingPrivacyCurrentNotice\.id\}/);
  for (const statement of ["controller", "legalBasis", "retention", "recipients", "rights", "contact"]) {
    assert.match(
      details,
      new RegExp(`\\{bookingPrivacyCurrentNotice\\.content\\.${statement}\\}`),
      `the ${statement} statement is not rendered from the catalog`,
    );
  }
  assert.match(details, /href=\{bookingPrivacyCurrentNotice\.content\.privacyPolicy\.href\}/);
  // Information is not consent: no checkbox, no acceptance, no required
  // marker on the notice, and no consent wording anywhere in the component.
  assert.doesNotMatch(details, /type="checkbox"/);
  assert.doesNotMatch(details, /bookingConsentCurrentNotice/);
  assert.doesNotMatch(details, /J’accepte/);
  assert.doesNotMatch(details, /Consentement/);
});

test("the free field is the optional « précision » with a placeholder and a sensitive-data warning", () => {
  assert.match(details, /Précision sur le rendez-vous <span className="font-normal text-warm-500">— facultatif<\/span>/);
  assert.match(details, /id="customer-note" name="note"[^>]*placeholder="Ex\. : une question sur la prestation, une contrainte d’horaire…"/);
  assert.match(details, /id="note-hint"[^>]*>N’indiquez ici aucune information médicale, de santé ou autre donnée sensible\.<\/p>/);
  assert.match(details, /aria-describedby=\{describedBy\("note", "note-hint"\)\}/);
  // The note is never `required`.
  assert.doesNotMatch(details, /name="note"[^>]*required/);
});

test("the phone stays optional and is announced as transactional-only", () => {
  assert.match(details, /Téléphone <span className="font-normal text-warm-500">\(facultatif\)<\/span>/);
  assert.doesNotMatch(details, /name="phone"[^>]*required/);
  assert.match(details, /id="phone-hint"[^>]*>Utilisé uniquement pour les échanges liés à votre rendez-vous\.<\/p>/);
  assert.match(details, /aria-describedby=\{describedBy\("phone", "phone-hint"\)\}/);
});

test("the confirmation tells the visitor to keep the reference", () => {
  assert.match(details, /\{state\.confirmation\.reference\}/);
  assert.match(details, /Conservez précieusement cette référence/);
});
