import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_CONTENT_DRAFT_PATH,
  ADMIN_CONTENT_PUBLISH_PATH,
  ADMIN_CONTENT_RESET_PATH,
  ADMIN_BOOKINGS_PATH,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_PATH,
  CONTENT_REVISION_HEADER,
  CSRF_HEADER,
  RATE_LIMIT_RETRY_AFTER_HEADER,
  defaultSiteContent,
} from "@eszter/contracts";
import {
  ADMIN_API_MESSAGES,
  createAdminApiClient,
  readRevisionHeader,
} from "../app/lib/admin-api";
import { RETRY_AFTER_MAX_SECONDS } from "../app/lib/retry-after";

/**
 * ESZ-034 — the browser half of the admin API, driven against a stub `fetch`.
 *
 * Everything here is about what the client *sends* and how it classifies what
 * comes back. The server side of each of these outcomes is already covered by
 * the Package 3.1 PHP suites; what was unproven until this package is that the
 * editor asks for them correctly and can tell them apart afterwards.
 */

interface RecordedCall {
  path: string;
  method: string;
  headers: Headers;
  body: string | null;
  credentials: string | undefined;
}

function stubFetch(
  responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const calls: RecordedCall[] = [];
  let index = 0;

  const fetchImpl = async (path: string, init?: RequestInit) => {
    calls.push({
      path,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
      credentials: init?.credentials,
    });

    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;

    const headers = new Headers(next.headers);
    if (next.body !== undefined) headers.set("content-type", "application/json");

    return new Response(
      next.body === undefined || next.status === 204
        ? null
        : JSON.stringify(next.body),
      { status: next.status, headers },
    );
  };

  return { calls, fetchImpl };
}

function draftEnvelope(revision: number) {
  return {
    schemaVersion: 1,
    revision,
    updatedAt: "2026-08-20T10:00:00.000Z",
    content: defaultSiteContent,
  };
}

function publishedEnvelope(revision: number) {
  return {
    schemaVersion: 1,
    revision,
    publishedAt: "2026-08-20T10:05:00.000Z",
    content: defaultSiteContent,
  };
}

function errorBody(code: string) {
  return { error: { code, message: "refused", requestId: "req_test" } };
}

const sessionBody = {
  authenticated: true,
  account: { email: "admin@example.com", lastLoginAt: "2026-08-20T09:00:00.000Z" },
  csrfToken: "a".repeat(43),
};

test("the session read is a plain same-origin GET that carries no token", async () => {
  const { calls, fetchImpl } = stubFetch([{ status: 200, body: sessionBody }]);
  const result = await createAdminApiClient(fetchImpl).readSession();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.account?.email, "admin@example.com");

  assert.equal(calls[0]?.path, AUTH_SESSION_PATH);
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.credentials, "same-origin");
  // `csrf.exemptFrom` names this read; sending a token here would suggest the
  // route is state-changing and make the exemption impossible to keep straight.
  assert.equal(calls[0]?.headers.get(CSRF_HEADER), null);
});

test("login posts the credential with the CSRF token in the frozen header", async () => {
  const { calls, fetchImpl } = stubFetch([{ status: 200, body: sessionBody }]);
  const result = await createAdminApiClient(fetchImpl).login(
    { email: "admin@example.com", password: "correct horse battery" },
    "token-from-anonymous-session",
  );

  assert.equal(result.ok, true);
  assert.equal(calls[0]?.path, AUTH_LOGIN_PATH);
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.headers.get(CSRF_HEADER), "token-from-anonymous-session");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "null"), {
    email: "admin@example.com",
    password: "correct horse battery",
  });
  // The token is a header, never a query parameter: `csrf.requirements` refuses
  // it from a query string, and a URL is the one place a secret gets logged by
  // something that is not this code.
  assert.doesNotMatch(calls[0]?.path ?? "", /token|csrf/i);
});

test("a rejected sign-in is one indistinguishable outcome", async () => {
  const { fetchImpl } = stubFetch([
    { status: 401, body: errorBody("INVALID_CREDENTIALS") },
  ]);
  const result = await createAdminApiClient(fetchImpl).login(
    { email: "nobody@example.com", password: "wrong" },
    "token",
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "invalid-credentials");
  assert.equal(result.failure.message, ADMIN_API_MESSAGES.invalidCredentials);
  // Unknown e-mail, wrong password and disabled account must stay one message.
  assert.doesNotMatch(result.failure.message, /compte|désactivé|inconnu/i);
});

test("a stale CSRF token is reported as recoverable, not as a bad password", async () => {
  const { fetchImpl } = stubFetch([
    { status: 403, body: errorBody("CSRF_TOKEN_INVALID") },
  ]);
  const result = await createAdminApiClient(fetchImpl).login(
    { email: "admin@example.com", password: "correct horse battery" },
    "stale",
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "forbidden");
});

test("logout sends the token and treats 204 as success without a body", async () => {
  const { calls, fetchImpl } = stubFetch([{ status: 204 }]);
  const result = await createAdminApiClient(fetchImpl).logout("token");

  assert.equal(result.ok, true);
  assert.equal(calls[0]?.path, AUTH_LOGOUT_PATH);
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.headers.get(CSRF_HEADER), "token");
});

test("booking contact update patches the admin route with the exact nullable body and returns server state", async () => {
  const requestBody = {
    action: "update" as const,
    reference: "bk_00000000000000000000000000000000",
    expectedUpdatedAt: "2026-08-22T10:00:00.000Z",
    customerName: "Nouvelle Représentante",
    customerEmail: "representante@example.test",
    customerPhone: null,
    customerNote: null,
  };
  const serverBooking = {
    reference: requestBody.reference,
    serviceKey: "brows",
    state: "cancelled",
    startsAtUtc: "2026-08-24T08:00:00.000Z",
    endsAtUtc: "2026-08-24T08:30:00.000Z",
    timezone: "Europe/Paris",
    customerName: requestBody.customerName,
    customerEmail: requestBody.customerEmail,
    customerPhone: null,
    customerNote: null,
    consentAtUtc: "2026-08-20T10:00:00.000Z",
    cancelledAtUtc: "2026-08-21T10:00:00.000Z",
    cancellationReason: "Indisponible",
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
    history: [
      { type: "created", actor: "public", occurredAt: "2026-08-20T10:00:00.000Z" },
      { type: "cancelled", actor: "admin", occurredAt: "2026-08-21T10:00:00.000Z" },
      { type: "customer_updated", actor: "admin", occurredAt: "2026-08-22T10:00:00.000Z" },
    ],
  };
  const { calls, fetchImpl } = stubFetch([{ status: 200, body: { booking: serverBooking } }]);

  const result = await createAdminApiClient(fetchImpl).mutateBooking(requestBody, "contact-csrf-token");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, serverBooking);
  assert.equal(calls[0]?.path, ADMIN_BOOKINGS_PATH);
  assert.equal(calls[0]?.method, "PATCH");
  assert.equal(calls[0]?.headers.get(CSRF_HEADER), "contact-csrf-token");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "null"), requestBody);
});

test("a stale booking mutation is a conflict that names REVISION_CONFLICT", async () => {
  const { fetchImpl } = stubFetch([{ status: 409, body: errorBody("REVISION_CONFLICT") }]);
  const result = await createAdminApiClient(fetchImpl).mutateBooking(
    {
      action: "move",
      reference: "bk_00000000000000000000000000000000",
      expectedUpdatedAt: "2026-08-22T10:00:00.000Z",
      startsAtUtc: "2026-08-24T09:00:00.000Z",
    },
    "csrf",
  );

  assert.equal(result.ok, false);
  if (result.ok || result.failure.kind !== "conflict") return;
  assert.equal(result.failure.errorCode, "REVISION_CONFLICT");
});

test("a booking slot that was taken is a conflict, never a stale-data one", async () => {
  // ESZ-139: SLOT_UNAVAILABLE and REVISION_CONFLICT are both 409 conflicts,
  // but the calendar must tell them apart — the copy and the recovery differ.
  const { fetchImpl } = stubFetch([{ status: 409, body: errorBody("SLOT_UNAVAILABLE") }]);
  const result = await createAdminApiClient(fetchImpl).mutateBooking(
    {
      action: "move",
      reference: "bk_00000000000000000000000000000000",
      expectedUpdatedAt: "2026-08-22T10:00:00.000Z",
      startsAtUtc: "2026-08-24T09:00:00.000Z",
    },
    "csrf",
  );

  assert.equal(result.ok, false);
  if (result.ok || result.failure.kind !== "conflict") return;
  assert.equal(result.failure.errorCode, "SLOT_UNAVAILABLE");
});

test("the draft read returns the validated server envelope", async () => {
  const { calls, fetchImpl } = stubFetch([{ status: 200, body: draftEnvelope(7) }]);
  const result = await createAdminApiClient(fetchImpl).readDraft();

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.revision, 7);
  assert.equal(calls[0]?.path, ADMIN_CONTENT_DRAFT_PATH);
  assert.equal(calls[0]?.method, "GET");
});

test("a save states its precondition and returns the new revision", async () => {
  const { calls, fetchImpl } = stubFetch([{ status: 200, body: draftEnvelope(8) }]);
  const result = await createAdminApiClient(fetchImpl).saveDraft(
    { content: defaultSiteContent, expectedRevision: 7 },
    "token",
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.revision, 8);

  assert.equal(calls[0]?.method, "PUT");
  assert.equal(calls[0]?.headers.get(CSRF_HEADER), "token");
  const body = JSON.parse(calls[0]?.body ?? "null");
  // `optimisticConcurrency.requirements`: the field is required, and an absent
  // one is a 400 rather than an unconditional write. The client never omits it.
  assert.equal(body.expectedRevision, 7);
  assert.deepEqual(Object.keys(body).sort(), ["content", "expectedRevision"]);
});

test("a stale save is a conflict carrying the server head, not a generic error", async () => {
  const { fetchImpl } = stubFetch([
    {
      status: 409,
      body: errorBody("REVISION_CONFLICT"),
      headers: { [CONTENT_REVISION_HEADER]: "11" },
    },
  ]);
  const result = await createAdminApiClient(fetchImpl).saveDraft(
    { content: defaultSiteContent, expectedRevision: 7 },
    "token",
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "conflict");
  if (result.failure.kind !== "conflict") return;
  // `concurrency.requirements`: the head travels with the 409 so recovery needs
  // no second round trip.
  assert.equal(result.failure.currentRevision, 11);
});

test("a conflict without a revision header yields no revision rather than zero", async () => {
  const { fetchImpl } = stubFetch([
    { status: 409, body: errorBody("REVISION_CONFLICT") },
  ]);
  const result = await createAdminApiClient(fetchImpl).saveDraft(
    { content: defaultSiteContent, expectedRevision: 7 },
    "token",
  );

  assert.equal(result.ok, false);
  if (result.ok || result.failure.kind !== "conflict") return;
  // A default of 0 would be indistinguishable from a real head of 0, and the
  // editor would rebase onto a revision that may not exist.
  assert.equal(result.failure.currentRevision, null);
});

test("an expired session is classified as expiry on any admin call", async () => {
  const { fetchImpl } = stubFetch([
    { status: 401, body: errorBody("UNAUTHENTICATED") },
  ]);
  const api = createAdminApiClient(fetchImpl);

  for (const result of [
    await api.readDraft(),
    await api.saveDraft({ content: defaultSiteContent, expectedRevision: 1 }, "t"),
    await api.publish({ expectedRevision: 1 }, "t"),
    await api.resetDraft({ expectedRevision: 1 }, "t"),
  ]) {
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.failure.kind, "unauthenticated");
  }
});

test("a 429 RATE_LIMITED session read is a rate-limited value, never an auth result", async () => {
  // ESZ-130: the anonymous session bootstrap can be throttled before any
  // session exists, so a 429 says nothing about who the caller is. The client
  // must classify it as recoverable rate-limiting — the session provider turns
  // it into the unavailable state with a manual retry, never into signed-in or
  // signed-out, and nothing here retries automatically.
  const { calls, fetchImpl } = stubFetch([
    { status: 429, body: errorBody("RATE_LIMITED") },
  ]);
  const api = createAdminApiClient(fetchImpl);

  const result = await api.readSession();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "rate-limited");
  assert.equal(result.failure.message, ADMIN_API_MESSAGES.rateLimited);

  // The request was a plain cookie-less GET on the session path — nothing that
  // could be mistaken for a login or a state-changing call.
  assert.equal(calls[0]?.path, AUTH_SESSION_PATH);
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.headers.get(CSRF_HEADER), null);
});

test("a 429 on a login is reported as rate-limiting too", async () => {
  const { fetchImpl } = stubFetch([
    { status: 429, body: errorBody("RATE_LIMITED") },
  ]);
  const result = await createAdminApiClient(fetchImpl).login(
    { email: "admin@example.com", password: "whatever" },
    "token",
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "rate-limited");
  assert.equal(result.failure.message, ADMIN_API_MESSAGES.rateLimited);
});

test("a 429 with a usable Retry-After carries the bounded seconds on every admin call", async () => {
  const envelope429 = {
    status: 429,
    body: errorBody("RATE_LIMITED"),
    headers: { [RATE_LIMIT_RETRY_AFTER_HEADER]: "120" },
  };
  const api = createAdminApiClient(stubFetch([envelope429]).fetchImpl);
  const sessionApi = createAdminApiClient(stubFetch([envelope429]).fetchImpl);
  const draftApi = createAdminApiClient(stubFetch([envelope429]).fetchImpl);

  for (const result of [
    await api.login({ email: "a@example.com", password: "x" }, "token"),
    await sessionApi.readSession(),
    await draftApi.readDraft(),
  ]) {
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.failure.kind, "rate-limited");
    if (result.failure.kind !== "rate-limited") continue;
    assert.equal(result.failure.retryAfterSeconds, 120);
  }
});

test("429 header values that are unusable never become trusted timers, yet stay rate-limited", async () => {
  // Each response is a genuine 429 RATE_LIMITED whose Retry-After is missing
  // or unusable: the failure must remain explicitly rate-limited, and only
  // the bounded seconds may differ (null = no trusted delay, capped = the
  // documented client bound).
  const cases: Array<{ raw: string | null; expected: number | null }> = [
    { raw: null, expected: null },
    { raw: "abc", expected: null },
    { raw: "-5", expected: null },
    { raw: "1.5", expected: null },
    { raw: "99999999999999999999999999999", expected: null },
    { raw: "86400", expected: RETRY_AFTER_MAX_SECONDS },
  ];

  for (const { raw, expected } of cases) {
    const headers: Record<string, string> = {};
    if (raw !== null) headers[RATE_LIMIT_RETRY_AFTER_HEADER] = raw;
    const { fetchImpl } = stubFetch([
      { status: 429, body: errorBody("RATE_LIMITED"), headers },
    ]);
    const result = await createAdminApiClient(fetchImpl).login(
      { email: "admin@example.com", password: "whatever" },
      "token",
    );

    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.failure.kind, "rate-limited");
    if (result.failure.kind !== "rate-limited") continue;
    assert.equal(result.failure.message, ADMIN_API_MESSAGES.rateLimited);
    assert.equal(result.failure.retryAfterSeconds, expected, `Retry-After: ${raw ?? "(absent)"}`);
  }
});

test("a bare 429 without an error envelope is rate-limited, never a generic server failure", async () => {
  const { fetchImpl } = stubFetch([{ status: 429 }]);
  const result = await createAdminApiClient(fetchImpl).readSession();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "rate-limited");
  if (result.failure.kind !== "rate-limited") return;
  assert.equal(result.failure.retryAfterSeconds, null);
});

test("only 429 is rate-limited; other refusals keep their own kinds", async () => {
  const { fetchImpl } = stubFetch([
    { status: 500, body: errorBody("INTERNAL_ERROR") },
    { status: 401, body: errorBody("UNAUTHENTICATED") },
  ]);
  const api = createAdminApiClient(fetchImpl);

  const server = await api.readDraft();
  const expired = await api.readSession();

  assert.equal(server.ok, false);
  if (!server.ok) assert.equal(server.failure.kind, "server");
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.failure.kind, "unauthenticated");
});

test("publish sends the precondition and no content at all", async () => {
  const { calls, fetchImpl } = stubFetch([
    { status: 200, body: publishedEnvelope(8) },
  ]);
  const result = await createAdminApiClient(fetchImpl).publish(
    { expectedRevision: 8 },
    "token",
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.revision, 8);

  assert.equal(calls[0]?.path, ADMIN_CONTENT_PUBLISH_PATH);
  // `adminContent.publish.source`: publish takes what is stored, never the
  // request body. A client that sent content would be describing a different
  // operation from the one the server performs.
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "null"), { expectedRevision: 8 });
});

test("reset names its source, which is the only one the contract defines", async () => {
  const { calls, fetchImpl } = stubFetch([{ status: 200, body: draftEnvelope(9) }]);
  const result = await createAdminApiClient(fetchImpl).resetDraft(
    { expectedRevision: 8 },
    "token",
  );

  assert.equal(result.ok, true);
  assert.equal(calls[0]?.path, ADMIN_CONTENT_RESET_PATH);
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "null"), {
    expectedRevision: 8,
    source: "published",
  });
});

test("a 200 whose body is not the frozen envelope is never handed to the editor", async () => {
  const { fetchImpl } = stubFetch([
    { status: 200, body: { schemaVersion: 1, revision: -3, updatedAt: "nope" } },
  ]);
  const result = await createAdminApiClient(fetchImpl).readDraft();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "malformed-response");
});

test("a transport failure is a value, and its message names no request target", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed: https://admin.example/api/admin/content/draft");
  };
  const result = await createAdminApiClient(fetchImpl).readDraft();

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "network");
  assert.equal(result.failure.message, ADMIN_API_MESSAGES.network);
  assert.doesNotMatch(result.failure.message, /https?:/);
});

test("an unparseable revision header is treated as absent", () => {
  assert.equal(readRevisionHeader(new Headers()), null);
  assert.equal(
    readRevisionHeader(new Headers({ [CONTENT_REVISION_HEADER]: "abc" })),
    null,
  );
  assert.equal(
    readRevisionHeader(new Headers({ [CONTENT_REVISION_HEADER]: "-1" })),
    null,
  );
  assert.equal(
    readRevisionHeader(new Headers({ [CONTENT_REVISION_HEADER]: "0" })),
    0,
  );
});
