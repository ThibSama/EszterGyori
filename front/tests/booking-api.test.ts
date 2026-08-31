import assert from "node:assert/strict";
import test from "node:test";
import {
  createBooking,
  loadAvailability,
  loadBookableServices,
  withSubmissionLock,
  type PublicBookingRequest,
} from "../app/lib/booking-api";

const bookingRequest: PublicBookingRequest = {
  serviceKey: "brows",
  startsAtUtc: "2026-08-24T07:15:00.000Z",
  customerName: "Cliente Exemple",
  customerEmail: "cliente@example.test",
  customerPhone: "+33 6 00 00 00 00",
  customerNote: null,
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

test("malformed and failed availability responses remain recoverable failures", async () => {
  const malformed = await loadAvailability("brows", "2026-08-21", "2026-08-27", async () => Response.json({ slots: [] }));
  const rejected = await loadAvailability("brows", "2026-08-21", "2026-08-27", async () => Response.json({}, { status: 500 }));
  const network = await loadAvailability("brows", "2026-08-21", "2026-08-27", async () => { throw new Error("offline"); });

  assert.equal(malformed.ok, false);
  assert.equal(rejected.ok, false);
  assert.equal(network.ok, false);
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
