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
  assert.match(details, /htmlFor="customer-name"/);
  assert.match(details, /type="email"/);
  assert.match(details, /type="tel"/);
  assert.match(details, /name="consentAccepted" type="checkbox"/);
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
