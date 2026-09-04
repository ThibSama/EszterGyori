import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOKING_CONSENT_CURRENT_NOTICE_ID,
  bookingConsentCurrentNotice,
  RATE_LIMIT_RETRY_AFTER_HEADER,
} from "@eszter/contracts";
import {
  BOOKING_API_MESSAGES,
  createBooking,
  loadAvailability,
  loadBookableServices,
  withSubmissionLock,
  type PublicBookingRequest,
} from "../app/lib/booking-api";
import { RETRY_AFTER_MAX_SECONDS } from "../app/lib/retry-after";

const bookingRequest: PublicBookingRequest = {
  serviceKey: "brows",
  startsAtUtc: "2026-08-24T07:15:00.000Z",
  customerName: "Cliente Exemple",
  customerEmail: "cliente@example.test",
  customerPhone: "+33 6 00 00 00 00",
  customerNote: null,
  consentNoticeId: BOOKING_CONSENT_CURRENT_NOTICE_ID,
  consentAccepted: true,
};

test("active services come only from the frozen discovery endpoint", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const result = await loadBookableServices(async (input, init) => {
    calls.push({ input: String(input), init });
    return Response.json({ services: [{ key: "brows", label: "Sourcils", durationMinutes: 30 }] });
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].input, "/api/booking/services");
  assert.equal(calls[0].init?.method, "GET");
});

test("availability posts the selected key and exact visible range", async () => {
  let body = "";
  const result = await loadAvailability(
    "brows",
    "2026-08-21",
    "2026-08-27",
    async (input, init) => {
      assert.equal(String(input), "/api/booking/availability");
      assert.equal(init?.method, "POST");
      body = String(init?.body);
      return Response.json({
        serviceKey: "brows",
        timezone: "Europe/Paris",
        fromDate: "2026-08-21",
        untilDate: "2026-08-27",
        slots: [{
          localDate: "2026-08-24",
          localStart: "09:15",
          foldUtcOffset: null,
          startsAtUtc: "2026-08-24T07:15:00.000Z",
          endsAtUtc: "2026-08-24T07:45:00.000Z",
        }],
      });
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(body), {
    serviceKey: "brows",
    fromDate: "2026-08-21",
    untilDate: "2026-08-27",
  });
  if (result.ok) assert.equal(result.value.slots[0].startsAtUtc, "2026-08-24T07:15:00.000Z");
});

test("malformed, rejected, network and rate-limited availability failures stay distinct", async () => {
  const malformed = await loadAvailability("brows", "2026-08-21", "2026-08-27", async () => Response.json({ slots: [] }));
  const rejected = await loadAvailability("brows", "2026-08-21", "2026-08-27", async () => Response.json({}, { status: 500 }));
  const network = await loadAvailability("brows", "2026-08-21", "2026-08-27", async () => { throw new Error("offline"); });
  const rateLimited = await loadAvailability("brows", "2026-08-21", "2026-08-27", async () =>
    Response.json(
      { error: { code: "RATE_LIMITED", message: "refusé", requestId: "req_test" } },
      { status: 429, headers: { [RATE_LIMIT_RETRY_AFTER_HEADER]: "30" } },
    ));

  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.failure.kind, "malformed");
  // A 500 is the generic service failure; a 429 must never collapse into it.
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.failure.kind, "rejected");
  assert.equal(network.ok, false);
  if (!network.ok) assert.equal(network.failure.kind, "network");
  assert.equal(rateLimited.ok, false);
  if (!rateLimited.ok) {
    assert.equal(rateLimited.failure.kind, "rate-limited");
    if (rateLimited.failure.kind !== "rate-limited") return;
    assert.equal(rateLimited.failure.retryAfterSeconds, 30);
    assert.equal(rateLimited.failure.message, BOOKING_API_MESSAGES.rateLimited);
  }
});

test("an availability 429 stays explicitly rate-limited without a usable Retry-After", async () => {
  // Missing and unusable header values: still rate-limited, no trusted timer.
  const missing = await loadAvailability("brows", "2026-08-21", "2026-08-27", async () =>
    Response.json(
      { error: { code: "RATE_LIMITED", message: "refusé", requestId: "req_test" } },
      { status: 429 },
    ));
  const absurd = await loadAvailability("brows", "2026-08-21", "2026-08-27", async () =>
    Response.json(
      { error: { code: "RATE_LIMITED", message: "refusé", requestId: "req_test" } },
      { status: 429, headers: { [RATE_LIMIT_RETRY_AFTER_HEADER]: "86400" } },
    ));
  const bare = await loadAvailability("brows", "2026-08-21", "2026-08-27", async () =>
    new Response("slow down", { status: 429 }));

  for (const result of [missing, bare]) {
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.failure.kind, "rate-limited");
    if (result.failure.kind !== "rate-limited") continue;
    assert.equal(result.failure.retryAfterSeconds, null);
  }
  assert.equal(absurd.ok, false);
  if (!absurd.ok) {
    assert.equal(absurd.failure.kind, "rate-limited");
    if (absurd.failure.kind !== "rate-limited") return;
    assert.equal(absurd.failure.retryAfterSeconds, RETRY_AFTER_MAX_SECONDS);
  }
});

test("booking creation posts the exact validated customer, consent and returned instant", async () => {
  let submitted: unknown;
  const result = await createBooking(bookingRequest, async (input, init) => {
    assert.equal(String(input), "/api/bookings");
    assert.equal(init?.method, "POST");
    submitted = JSON.parse(String(init?.body));
    return Response.json({
      reference: "bk_00000000000000000000000000000000",
      serviceKey: "brows",
      state: "confirmed",
      startsAtUtc: bookingRequest.startsAtUtc,
      endsAtUtc: "2026-08-24T07:45:00.000Z",
    }, { status: 201 });
  });

  assert.deepEqual(submitted, bookingRequest);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.reference, "bk_00000000000000000000000000000000");
});

test("the client refuses to post a request whose notice id is not the displayed one", async () => {
  // ESZ-142: the request's id must be the very notice the checkbox renders.
  assert.equal(bookingRequest.consentNoticeId, bookingConsentCurrentNotice.id);

  // Malformed wire payloads, deliberately smuggled past the literal types the
  // schema would otherwise enforce at compile time: the runtime safeParse is
  // the guard under test.
  const wire = (body: unknown) => body as PublicBookingRequest;

  let calls = 0;
  const missing = await createBooking(
    wire({ ...bookingRequest, consentNoticeId: undefined }),
    async () => { calls += 1; throw new Error("must not be sent"); },
  );
  assert.equal(calls, 0);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.failure.kind, "validation");

  const unknown = await createBooking(
    wire({ ...bookingRequest, consentNoticeId: "booking-consent-9999" }),
    async () => { calls += 1; throw new Error("must not be sent"); },
  );
  assert.equal(calls, 0);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.failure.kind, "validation");

  const refused = await createBooking(
    wire({ ...bookingRequest, consentAccepted: false }),
    async () => { calls += 1; throw new Error("must not be sent"); },
  );
  assert.equal(calls, 0);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.failure.kind, "validation");
});

test("only a matching confirmed server response is success", async () => {
  const mismatched = await createBooking(bookingRequest, async () => Response.json({
    reference: "bk_00000000000000000000000000000000",
    serviceKey: "lips",
    state: "confirmed",
    startsAtUtc: bookingRequest.startsAtUtc,
    endsAtUtc: "2026-08-24T07:45:00.000Z",
  }, { status: 201 }));

  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.equal(mismatched.failure.kind, "uncertain");
});

test("stale, validation, server and uncertain creation failures remain distinct", async () => {
  const envelope = (code: "SLOT_UNAVAILABLE" | "VALIDATION_FAILED" | "INTERNAL_ERROR") => ({
    error: { code, message: "Erreur", requestId: "req_test" },
  });
  const stale = await createBooking(bookingRequest, async () => Response.json(envelope("SLOT_UNAVAILABLE"), { status: 409 }));
  const validation = await createBooking(bookingRequest, async () => Response.json(envelope("VALIDATION_FAILED"), { status: 400 }));
  const server = await createBooking(bookingRequest, async () => Response.json(envelope("INTERNAL_ERROR"), { status: 500 }));
  const network = await createBooking(bookingRequest, async () => { throw new Error("connection lost"); });

  assert.equal(stale.ok ? "success" : stale.failure.kind, "slot-unavailable");
  assert.equal(validation.ok ? "success" : validation.failure.kind, "validation");
  assert.equal(server.ok ? "success" : server.failure.kind, "server");
  assert.equal(network.ok ? "success" : network.failure.kind, "uncertain");
  if (!network.ok) assert.match(network.failure.message, /peut-être été enregistrée/);
});

test("a 429 on booking creation is rate-limited, never server, slot, validation or uncertain", async () => {
  const envelope429 = {
    error: { code: "RATE_LIMITED", message: "refusé", requestId: "req_test" },
  };
  const withHeader = await createBooking(bookingRequest, async () =>
    Response.json(envelope429, {
      status: 429,
      headers: { [RATE_LIMIT_RETRY_AFTER_HEADER]: "120" },
    }));
  const withoutHeader = await createBooking(bookingRequest, async () =>
    Response.json(envelope429, { status: 429 }));
  const bare = await createBooking(bookingRequest, async () =>
    new Response("slow down", { status: 429 }));

  for (const result of [withHeader, withoutHeader, bare]) {
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.failure.kind, "rate-limited");
    if (result.failure.kind !== "rate-limited") continue;
    assert.equal(result.failure.message, BOOKING_API_MESSAGES.rateLimited);
  }
  assert.equal(withHeader.ok, false);
  if (!withHeader.ok && withHeader.failure.kind === "rate-limited") {
    assert.equal(withHeader.failure.retryAfterSeconds, 120);
  }
  assert.equal(withoutHeader.ok, false);
  if (!withoutHeader.ok && withoutHeader.failure.kind === "rate-limited") {
    assert.equal(withoutHeader.failure.retryAfterSeconds, null);
  }
});

test("a booking creation 429 with an oversized Retry-After stays within the documented bound", async () => {
  const result = await createBooking(bookingRequest, async () =>
    Response.json(
      { error: { code: "RATE_LIMITED", message: "refusé", requestId: "req_test" } },
      { status: 429, headers: { [RATE_LIMIT_RETRY_AFTER_HEADER]: "86400" } },
    ));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "rate-limited");
  if (result.failure.kind !== "rate-limited") return;
  assert.equal(result.failure.retryAfterSeconds, RETRY_AFTER_MAX_SECONDS);
});

test("the immediate submission lock prevents duplicate concurrent posts", async () => {
  const lock = { current: false };
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const operation = async () => { calls += 1; await pending; return calls; };

  const first = withSubmissionLock(lock, operation);
  const duplicate = await withSubmissionLock(lock, operation);
  assert.equal(duplicate, null);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 1);
  assert.equal(lock.current, false);
});
