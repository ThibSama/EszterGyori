import assert from "node:assert/strict";
import test from "node:test";
import {
  RETRY_AFTER_MAX_SECONDS,
  isRetryBlocked,
  parseRetryAfterSeconds,
  retryAllowedAtEpochMs,
  retryWaitLabel,
  retryWaitSeconds,
} from "../app/lib/retry-after";

/**
 * ESZ-136 — the shared `Retry-After` parser and retry gate.
 *
 * Every assertion uses injected timestamps: the gate stores an absolute epoch
 * deadline, and each helper takes `nowEpochMs` explicitly, so no test sleeps.
 */

test("the client honours at most the documented finite cap", () => {
  // The frozen buckets' widest refusal interval is one emission interval of
  // booking.create.address (3600 s / 5 = 720 s); the cap is above it so every
  // genuine refusal fits, and below anything a broken or hostile header could
  // use to park a visitor.
  assert.equal(RETRY_AFTER_MAX_SECONDS, 900);
  assert.ok(RETRY_AFTER_MAX_SECONDS > 720);
});

test("only ASCII whole seconds parse; valid values are capped at the bound", () => {
  assert.equal(parseRetryAfterSeconds("30"), 30);
  assert.equal(parseRetryAfterSeconds("0"), 0);
  assert.equal(parseRetryAfterSeconds("120"), 120);
  assert.equal(parseRetryAfterSeconds("720"), 720);
  // At the cap and above: honoured, but never beyond the documented bound.
  assert.equal(parseRetryAfterSeconds("900"), RETRY_AFTER_MAX_SECONDS);
  assert.equal(parseRetryAfterSeconds("86400"), RETRY_AFTER_MAX_SECONDS);
});

test("missing, malformed, negative and absurd values never become trusted timers", () => {
  assert.equal(parseRetryAfterSeconds(null), null);
  assert.equal(parseRetryAfterSeconds(""), null);
  // Not whole seconds: the contract's unit is seconds, and nothing else is it.
  assert.equal(parseRetryAfterSeconds("abc"), null);
  assert.equal(parseRetryAfterSeconds("1.5"), null);
  assert.equal(parseRetryAfterSeconds("-5"), null);
  assert.equal(parseRetryAfterSeconds("+5"), null);
  assert.equal(parseRetryAfterSeconds(" 30"), null);
  assert.equal(parseRetryAfterSeconds("30 "), null);
  assert.equal(parseRetryAfterSeconds("30s"), null);
  assert.equal(parseRetryAfterSeconds("1e3"), null);
  assert.equal(parseRetryAfterSeconds("0x10"), null);
  // Too large to be a safe integer: absurd magnitude, refused outright.
  assert.equal(parseRetryAfterSeconds("99999999999999999999999999999"), null);
});

test("a trusted delay is an absolute deadline computed from the receipt instant", () => {
  assert.equal(retryAllowedAtEpochMs(1_000, 30), 31_000);
  assert.equal(retryAllowedAtEpochMs(1_000, 0), 1_000);
  // No usable header means no deadline at all, never an invented one.
  assert.equal(retryAllowedAtEpochMs(1_000, null), null);
});

test("the gate is closed strictly before the deadline and open from it on", () => {
  const deadline = 100_000;
  assert.equal(isRetryBlocked(deadline, 99_999), true);
  assert.equal(isRetryBlocked(deadline, 100_000), false);
  assert.equal(isRetryBlocked(deadline, 100_001), false);
  // Without a trusted delay the retry control stays open (a 429 without a
  // usable Retry-After is still explicitly rate-limited, just not blocked).
  assert.equal(isRetryBlocked(null, 0), false);
});

test("the remaining wait counts up in whole seconds and ends at zero", () => {
  const deadline = 100_000;
  assert.equal(retryWaitSeconds(deadline, 100_000 - 29_500), 30);
  assert.equal(retryWaitSeconds(deadline, 100_000 - 1), 1);
  assert.equal(retryWaitSeconds(deadline, 100_000), 0);
  assert.equal(retryWaitSeconds(deadline, 100_500), 0);
  assert.equal(retryWaitSeconds(null, 0), null);
});

test("the wait copy is exact, and disappears once the retry is allowed", () => {
  const deadline = 100_000;
  assert.equal(retryWaitLabel(deadline, 100_000 - 45_000), "Réessayez dans 45 s");
  assert.equal(retryWaitLabel(deadline, 100_000 - 1), "Réessayez dans 1 s");
  // Whole minutes round up so the label never promises an earlier retry than
  // the deadline it announces.
  assert.equal(retryWaitLabel(deadline, 100_000 - 60_000), "Réessayez dans 1 min");
  assert.equal(retryWaitLabel(deadline, 100_000 - 90_000), "Réessayez dans 2 min");
  assert.equal(retryWaitLabel(deadline, 100_000), null);
  assert.equal(retryWaitLabel(null, 0), null);
});

test("expiration re-enables the manual retry; nothing fires automatically", () => {
  const receivedAt = 1_000;
  const deadline = retryAllowedAtEpochMs(receivedAt, 30);
  assert.equal(deadline, 31_000);
  // During the trusted delay the retry is blocked…
  assert.equal(isRetryBlocked(deadline, receivedAt + 29_999), true);
  // …once it has elapsed the caller may retry by hand…
  assert.equal(isRetryBlocked(deadline, deadline), false);
  // …and the helpers themselves never perform or schedule anything: the only
  // way a request happens is the caller acting on this answer.
  assert.equal(retryWaitLabel(deadline, deadline), null);
});
