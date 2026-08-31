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
