import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  artifactFileNames,
  serializeArtifact,
} from "../scripts/generate-contract-artifacts.js";
import { parityCases, semanticRules } from "../semantic-rules.js";
import {
  ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
  ADMIN_AVAILABILITY_WEEKLY_PATH,
  ADMIN_BOOKINGS_SUMMARY_PATH,
  BOOKING_LOCAL_TIME_PATTERN,
  adminAvailabilityWeeklyReplaceRequestSchema,
  CONTENT_FILE_LIMIT_BYTES,
  MEDIA_LIBRARY_INDEX_LIMIT_BYTES,
  REQUEST_BODY_LIMIT_BYTES,
  availabilityAdminPolicy,
  bookingApiPolicy,
  contractRequestBodies,
  httpContractCases,
  rateLimitPolicy,
  storageLimitReconciliation,
} from "../http-contract.js";
import {
  BOOKING_SLOT_GRID_MINUTES,
  NOTIFICATION_BASE_BACKOFF_SECONDS,
  NOTIFICATION_LEASE_SECONDS,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_MAX_BACKOFF_SECONDS,
  NOTIFICATION_REMINDER_GRACE_MINUTES,
  notificationChannels,
  notificationForbiddenLogFields,
  notificationJobTypes,
  notificationLogFields,
  notificationPolicy,
  notificationStatusTransitions,
  notificationStatuses,
  notificationTerminalStatuses,
  BOOKING_SLOT_MAX_HORIZON_DAYS,
  BOOKING_SLOT_MAX_RESULTS,
  BOOKING_TIME_ZONE,
  bookableServiceKeys,
  bookingStateTransitions,
  bookingStates,
} from "../booking.js";

/**
 * Drift guard. The committed artifacts under `contracts/generated/` are what a
 * non-TypeScript implementation consumes, so they must never fall behind the
 * Zod sources they are derived from.
 */

const GENERATED_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "generated",
);

async function readGenerated(fileName: string): Promise<string> {
  return readFile(join(GENERATED_DIRECTORY, fileName), "utf8");
}

for (const fileName of artifactFileNames) {
  test(`generated artifact is up to date: ${fileName}`, async () => {
    const committed = await readGenerated(fileName);

    assert.equal(
      committed,
      serializeArtifact(fileName),
      `${fileName} is stale. Run \`npm run generate\` in contracts/ and commit the result.`,
    );
  });
}

test("manifest digests match the committed artifacts", async () => {
  const manifest = JSON.parse(await readGenerated("manifest.json")) as {
    artifacts: Array<{ file: string; sha256: string }>;
  };

  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.file).sort(),
    [...artifactFileNames].sort(),
  );

  for (const artifact of manifest.artifacts) {
    const contents = await readGenerated(artifact.file);
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      artifact.sha256,
      `${artifact.file}: digest mismatch. Run \`npm run generate\`.`,
    );
  }
});

test("generated schemas warn that structural validation is not sufficient", async () => {
  for (const fileName of artifactFileNames.filter((name) =>
    name.endsWith(".schema.json"),
  )) {
    const schema = JSON.parse(await readGenerated(fileName)) as Record<
      string,
      unknown
    >;

    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(String(schema["x-eszter-warning"]), /NOT sufficient/);
  }
});

test("the generated booking domain freezes service identity, timezone and states", async () => {
  const booking = JSON.parse(await readGenerated("booking-domain.json")) as {
    services: { keys: string[]; source: string };
    timezone: { iana: string; dst: { nonexistent: string; ambiguous: string } };
    availability: {
      generatedSlotsPersisted: boolean;
      exceptionPrecedence: string;
      grid: { minutes: number; alignment: string };
      limits: { maxHorizonDays: number; maxResults: number };
    };
    states: {
      values: string[];
      initial: string;
      transitions: Record<string, string[]>;
      rules: string[];
    };
  };

  assert.deepEqual(booking.services.keys, [...bookableServiceKeys]);
  assert.equal(booking.services.source, "SiteContent.services.items[].id");
  assert.equal(booking.timezone.iana, BOOKING_TIME_ZONE);
  assert.match(booking.timezone.dst.nonexistent, /Reject/);
  assert.match(booking.timezone.dst.ambiguous, /explicit numeric UTC offset/);
  assert.equal(booking.availability.generatedSlotsPersisted, false);
  assert.match(booking.availability.exceptionPrecedence, /replaces/);
  assert.equal(booking.availability.grid.minutes, BOOKING_SLOT_GRID_MINUTES);
  assert.match(booking.availability.grid.alignment, /civil midnight/);
  assert.deepEqual(booking.availability.limits, {
    maxHorizonDays: BOOKING_SLOT_MAX_HORIZON_DAYS,
    maxResults: BOOKING_SLOT_MAX_RESULTS,
  });
  assert.deepEqual(booking.states.values, [...bookingStates]);
  assert.equal(booking.states.initial, "confirmed");
  assert.deepEqual(booking.states.transitions, bookingStateTransitions);
  assert.ok(booking.states.rules.some((rule) => /never physically deletes/.test(rule)));
});

test("the generated booking domain freezes the Package 7.1 notification policy", async () => {
  const document = JSON.parse(await readGenerated("booking-domain.json")) as {
    version: number;
    notifications?: typeof notificationPolicy;
  };

  // The whole block, byte for byte. PHP reads this file rather than a second
  // copy of these constants, so anything that drifts here drifts everywhere.
  assert.deepEqual(document.notifications, notificationPolicy);
  assert.equal(document.version, 3, "adding a policy block is a domain version bump");

  assert.deepEqual(document.notifications?.channels, notificationChannels);
  assert.deepEqual(document.notifications?.jobTypes, notificationJobTypes);
  assert.deepEqual(document.notifications?.statuses.transitions, notificationStatusTransitions);
  assert.deepEqual(document.notifications?.statuses.terminal, notificationTerminalStatuses);

  // Three terminal statuses, and nothing leaves any of them. A queue whose
  // `sent` could go back to `pending` would deliver twice, which is the one
  // outcome the whole package exists to make impossible.
  for (const terminal of notificationTerminalStatuses) {
    assert.deepEqual(
      notificationStatusTransitions[terminal],
      [],
      `${terminal} must be terminal`,
    );
  }

  // `processing` is reachable only from `pending`, so a job already being
  // delivered cannot be claimed out from under its owner by a status change.
  const claimants = Object.entries(notificationStatusTransitions)
    .filter(([, targets]) => (targets as readonly string[]).includes("processing"))
    .map(([from]) => from);
  assert.deepEqual(claimants, ["pending"]);

  assert.equal(document.notifications?.retry.maxAttempts, NOTIFICATION_MAX_ATTEMPTS);
  assert.equal(
    document.notifications?.retry.baseBackoffSeconds,
    NOTIFICATION_BASE_BACKOFF_SECONDS,
  );
  assert.equal(
    document.notifications?.retry.maxBackoffSeconds,
    NOTIFICATION_MAX_BACKOFF_SECONDS,
  );
  assert.equal(document.notifications?.lease.seconds, NOTIFICATION_LEASE_SECONDS);
  assert.equal(
    document.notifications?.catchUp.reminderGraceMinutes,
    NOTIFICATION_REMINDER_GRACE_MINUTES,
  );

  // The bounds have to be usable, not merely present: a backoff whose ceiling is
  // below its floor, or a lease shorter than nothing, would freeze nonsense.
  assert.ok(NOTIFICATION_BASE_BACKOFF_SECONDS < NOTIFICATION_MAX_BACKOFF_SECONDS);
  assert.ok(NOTIFICATION_LEASE_SECONDS > 0);
  assert.ok(NOTIFICATION_MAX_ATTEMPTS >= 2, "a queue with one attempt has no retry policy");
});

test("the notification diagnostics contract cannot describe customer data", async () => {
  const codePattern = new RegExp(notificationPolicy.diagnostics.errorCodePattern);

  for (const reserved of notificationPolicy.diagnostics.reservedErrorCodes) {
    assert.ok(codePattern.test(reserved), `${reserved} is not a legal code`);
  }

  // The pattern is the guarantee. Each of these is something a provider really
  // does put in an error string, and none of them is expressible as a code — so
  // "the diagnostic column carries no customer data" is structural.
  for (const leak of [
    "cliente@example.test",
    "smtp 550 no mailbox",
    "+33 6 12 34 56 78",
    "Bonjour, je voudrais",
    "Bearer sk-live-abcdef",
    "UPPER_CASE",
    "",
  ]) {
    assert.ok(!codePattern.test(leak), `${leak} passed as an error code`);
  }

  // The allowlist and the declared forbidden list must be disjoint, or the
  // declaration would be describing something other than what is enforced.
  const allowed = new Set<string>(notificationLogFields);
  for (const forbidden of notificationForbiddenLogFields) {
    assert.ok(!allowed.has(forbidden), `${forbidden} is both allowed and forbidden`);
  }

  // The opaque reference is what a log line identifies an appointment by; no
  // customer field is on the list at all.
  assert.ok(allowed.has("bookingReference"));
  for (const field of notificationLogFields) {
    assert.ok(!/^customer/.test(field), `${field} names a customer fact`);
  }
});

test("the published envelope schema keeps objects closed", async () => {
  const schema = JSON.parse(
    await readGenerated("published-content-envelope.input.schema.json"),
  ) as { additionalProperties?: boolean; required?: string[] };

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(
    [...(schema.required ?? [])].sort(),
    ["content", "publishedAt", "revision", "schemaVersion"],
  );
});

test("semantic rules and parity cases round-trip through the generated corpus", async () => {
  const corpus = JSON.parse(await readGenerated("parity-corpus.json")) as {
    cases: Array<{ id: string }>;
    bases: Record<string, unknown>;
  };
  const rules = JSON.parse(await readGenerated("semantic-rules.json")) as {
    rules: Array<{ id: string; parityCaseIds: string[] }>;
  };

  assert.deepEqual(
    corpus.cases.map((parityCase) => parityCase.id),
    parityCases.map((parityCase) => parityCase.id),
  );
  assert.deepEqual(
    rules.rules.map((rule) => rule.id),
    semanticRules.map((rule) => rule.id),
  );
  assert.ok(corpus.bases.siteContent);
  assert.ok(corpus.bases.publishedEnvelope);

  for (const rule of rules.rules) {
    assert.ok(
      rule.parityCaseIds.length > 0,
      `${rule.id} reached the generated artifact with no parity cases`,
    );
  }
});

test("the generated HTTP contract carries every frozen case", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    cases: Array<{ id: string }>;
    errorCodes: string[];
    endpoints: Array<{ path: string; methods: string[] }>;
  };

  assert.deepEqual(
    contract.cases.map((httpCase) => httpCase.id),
    httpContractCases.map((httpCase) => httpCase.id),
  );
  assert.deepEqual(
    contract.endpoints.map((endpoint) => endpoint.path).sort(),
    [
      "/",
      "/api/admin/availability/exceptions",
      "/api/admin/availability/query",
      "/api/admin/availability/weekly",
      "/api/admin/bookings",
      "/api/admin/bookings/move-availability",
      "/api/admin/bookings/query",
      "/api/admin/bookings/summary",
      "/api/admin/content/draft",
      "/api/admin/content/publish",
      "/api/admin/content/reset",
      "/api/admin/media",
      "/api/auth/login",
      "/api/auth/logout",
      "/api/auth/session",
      "/api/booking/availability",
      "/api/booking/services",
      "/api/bookings",
      "/api/content",
      "/api/health",
    ],
  );

  // `/` accepts HEAD and the JSON surface does not. That difference is deliberate
  // (`page.head.ok`): the page is a document crawlers and monitors probe with
  // HEAD, whereas a 405 on HEAD /api/health has never mattered to anyone.
  const methodsByPath = Object.fromEntries(
    contract.endpoints.map((endpoint) => [endpoint.path, endpoint.methods]),
  );
  assert.deepEqual(methodsByPath["/api/health"], ["GET"]);
  assert.deepEqual(methodsByPath["/api/content"], ["GET"]);
  assert.deepEqual(methodsByPath["/"], ["GET", "HEAD"]);

  // ESZ-025. `/api/auth/session` is a GET because it reads state; the other two
  // change it and are POST-only, so a `<img src>` or a top-level navigation
  // cannot reach them at all before CSRF is even consulted.
  assert.deepEqual(methodsByPath["/api/auth/session"], ["GET"]);
  assert.deepEqual(methodsByPath["/api/auth/login"], ["POST"]);
  assert.deepEqual(methodsByPath["/api/auth/logout"], ["POST"]);

  // Package 3.1. The draft is a resource that is read and replaced whole, so it
  // is GET + PUT on one path. Publish and reset are neither reads nor
  // replacements of the thing they are posted to — they are operations on the
  // draft — so they are POST on their own paths rather than verbs smuggled into
  // a body the draft route would have to branch on.
  assert.deepEqual(methodsByPath["/api/admin/content/draft"], ["GET", "PUT"]);
  assert.deepEqual(methodsByPath["/api/admin/content/publish"], ["POST"]);
  assert.deepEqual(methodsByPath["/api/admin/content/reset"], ["POST"]);

  // Package 3.3. One path, three verbs, and no `{id}` segment: `Router` is
  // exact-path by construction, and the delete carries its id in the body for
  // the reason `mediaDeleteRequestSchema` documents.
  assert.deepEqual(methodsByPath["/api/admin/media"], ["GET", "POST", "DELETE"]);

  assert.deepEqual(methodsByPath["/api/booking/availability"], ["POST"]);
  assert.deepEqual(methodsByPath["/api/booking/services"], ["GET"]);
  assert.deepEqual(methodsByPath["/api/bookings"], ["POST"]);
  assert.deepEqual(methodsByPath["/api/admin/bookings/query"], ["POST"]);
  assert.deepEqual(methodsByPath["/api/admin/bookings/move-availability"], ["POST"]);
  assert.deepEqual(methodsByPath["/api/admin/bookings"], ["PATCH"]);

  // ESZ-063/064/065. `/summary` and `/availability/query` are reads and carry
  // their bounded window in a body, so they are POST for the same reason the
  // booking query is: a GET whose meaning depends on a body is a route nobody
  // can cache correctly. `/availability/weekly` is a PUT because it replaces the
  // whole recurring schedule, and that is the shape that makes the replacement
  // atomic rather than a sequence a client could interrupt halfway.
  assert.deepEqual(methodsByPath["/api/admin/bookings/summary"], ["POST"]);
  assert.deepEqual(methodsByPath["/api/admin/availability/query"], ["POST"]);
  assert.deepEqual(methodsByPath["/api/admin/availability/weekly"], ["PUT"]);
  assert.deepEqual(methodsByPath["/api/admin/availability/exceptions"], ["PATCH"]);

  assert.ok(contract.errorCodes.includes("STORAGE_FAILURE"));
  assert.ok(contract.errorCodes.includes("PAYLOAD_TOO_LARGE"));
  assert.ok(contract.errorCodes.includes("MEDIA_REFERENCED"));
});

test("the generated HTTP contract freezes booking transaction and mutation policy", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    booking?: { policy?: typeof bookingApiPolicy };
  };

  assert.deepEqual(contract.booking?.policy, bookingApiPolicy);
  assert.match(contract.booking?.policy?.creation ?? "", /singleton primary resource row/);
  assert.deepEqual(contract.booking?.policy?.adminMutableFields.update, [
    "customerName",
    "customerEmail",
    "customerPhone",
    "customerNote",
  ]);
  assert.match(contract.booking?.policy?.history ?? "", /bookings row remains authoritative/);
});

test("the generated HTTP contract freezes availability administration and the summary", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    booking?: {
      paths?: Record<string, string>;
      availabilityAdministration?: typeof availabilityAdminPolicy;
    };
    cases: Array<{ id: string; auth?: { session?: string; csrf?: string }; expect: { status: number } }>;
    invariants: Array<{ id: string }>;
  };

  assert.deepEqual(contract.booking?.availabilityAdministration, availabilityAdminPolicy);
  assert.equal(contract.booking?.paths?.adminAvailabilityWeekly, ADMIN_AVAILABILITY_WEEKLY_PATH);
  assert.equal(
    contract.booking?.paths?.adminAvailabilityExceptions,
    ADMIN_AVAILABILITY_EXCEPTIONS_PATH,
  );
  assert.equal(contract.booking?.paths?.adminSummary, ADMIN_BOOKINGS_SUMMARY_PATH);

  // The whole point of the PUT shape: say so in the artifact, not only in a
  // comment the server can drift away from.
  assert.match(
    contract.booking?.availabilityAdministration?.weeklyReplacement ?? "",
    /one transaction/,
  );
  assert.match(
    contract.booking?.availabilityAdministration?.adoptServerState ?? "",
    /No optimistic local schedule/,
  );
  assert.match(
    contract.booking?.availabilityAdministration?.summary ?? "",
    /never inflate a confirmed one/,
  );

  const invariantIds = contract.invariants.map((invariant) => invariant.id);
  for (const id of [
    "availability.weeklyReplacementIsAllOrNothing",
    "availability.globalOptimisticConcurrency",
    "availability.exceptionRemovalRestoresWeekly",
    "availability.exceptionWindowsAreDstChecked",
    "summary.cancelledNeverInflatesConfirmed",
  ]) {
    assert.ok(invariantIds.includes(id), `${id} is missing from the generated invariants`);
  }

  // Every one of the four new routes is proved to refuse an anonymous caller,
  // and every state-changing one is proved to refuse a session without CSRF.
  // Asserting this over the corpus is what stops a later case list from quietly
  // shipping an availability route with no negative coverage at all.
  const byId = new Map(contract.cases.map((httpCase) => [httpCase.id, httpCase]));
  for (const id of [
    "admin.bookings.summary.post.unauthenticated",
    "admin.availability.query.post.unauthenticated",
    "admin.availability.weekly.put.unauthenticated",
    "admin.availability.exceptions.patch.unauthenticated",
  ]) {
    assert.equal(byId.get(id)?.expect.status, 401, `${id} must be a 401`);
  }
  for (const id of [
    "admin.availability.weekly.put.csrfOmitted",
    "admin.availability.exceptions.patch.csrfOmitted",
  ]) {
    assert.equal(byId.get(id)?.expect.status, 403, `${id} must be a 403`);
  }
  for (const id of [
    "admin.availability.weekly.put.staleRevision",
    "admin.availability.exceptions.patch.staleRevision",
  ]) {
    assert.equal(byId.get(id)?.expect.status, 409, `${id} must be a 409`);
  }

  // And the reads are exempt from CSRF, which is only meaningful if a passing
  // case actually omits the token rather than happening to send one.
  for (const id of ["admin.bookings.summary.post.ok", "admin.availability.query.post.ok"]) {
    assert.equal(byId.get(id)?.auth?.csrf, "omitted", `${id} must prove the read needs no CSRF`);
    assert.equal(byId.get(id)?.expect.status, 200);
  }
});

test("the wire type for civil time is the 24-hour clock, not a shape", async () => {
  // Before this was tightened the pattern was `\\d{2}:\\d{2}`, so 25:00 satisfied
  // every structural gate — the Zod schema, the generated JSON Schema, and the
  // PHP validator reading that JSON Schema — and was caught only once the domain
  // parsed it. That made the wire type weaker than the value it describes.

  assert.equal(BOOKING_LOCAL_TIME_PATTERN, "^([01][0-9]|2[0-3]):[0-5][0-9]$");

  const accepted = ["00:00", "00:01", "00:59", "01:00", "09:30", "10:00", "19:45", "23:00", "23:59"];
  const rejected = [
    "24:00", // the classic end-of-day convention; not a value this API has
    "25:00", // what the loose pattern used to admit
    "29:99",
    "09:60", // the minute field is bounded too
    "99:99",
    "9:30", // always refused: the hour is two digits
    "09:00:00",
    "0:0",
    " 09:00",
    "09:00 ",
    "",
  ];

  const clock = new RegExp(BOOKING_LOCAL_TIME_PATTERN);
  for (const value of accepted) assert.ok(clock.test(value), `${value} must be accepted`);
  for (const value of rejected) assert.ok(!clock.test(value), `${value} must be rejected`);

  // The same verdicts through the schema an endpoint actually parses with, so
  // the constant and the schema cannot drift apart.
  const rule = (startLocal: string, endLocal: string) => ({
    expectedRevision: 0,
    rules: [
      {
        weekdayIso: 2,
        startLocal,
        endLocal,
        foldUtcOffset: null,
        validFrom: null,
        validUntil: null,
        isActive: true,
      },
    ],
  });

  assert.ok(adminAvailabilityWeeklyReplaceRequestSchema.safeParse(rule("00:00", "23:59")).success);
  for (const value of ["24:00", "25:00", "09:60"]) {
    assert.ok(
      !adminAvailabilityWeeklyReplaceRequestSchema.safeParse(rule("09:00", value)).success,
      `${value} must be refused structurally, not only by the domain`,
    );
  }

  // And through every generated schema that carries a civil time, so a new
  // endpoint cannot reintroduce the loose spelling by hand.
  let carriers = 0;
  for (const fileName of artifactFileNames) {
    if (!fileName.endsWith(".schema.json")) continue;
    const source = await readGenerated(fileName);
    if (!source.includes(":[0-5][0-9]$")) continue;
    carriers += 1;
    assert.ok(
      !/\\\\d\{2\}:\\\\d\{2\}/.test(source),
      `${fileName} still carries the loose civil-time pattern`,
    );
  }
  assert.ok(carriers > 0, "no generated schema carries a civil time at all");
});

test("the contract case list proves the civil-time boundary end to end", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    cases: Array<{ id: string; request: { rawBody?: string }; expect: { status: number } }>;
  };
  const byId = new Map(contract.cases.map((httpCase) => [httpCase.id, httpCase]));

  const accepted = byId.get("admin.availability.weekly.put.civilDayBoundsAccepted");
  assert.equal(accepted?.expect.status, 200, "00:00–23:59 must still be an ordinary window");
  assert.match(accepted?.request.rawBody ?? "", /"startLocal":"00:00"/);
  assert.match(accepted?.request.rawBody ?? "", /"endLocal":"23:59"/);

  for (const id of [
    "admin.availability.weekly.put.hourAboveTwentyThree",
    "admin.availability.weekly.put.minuteAboveFiftyNine",
    "admin.availability.weekly.put.malformedTime",
  ]) {
    assert.equal(byId.get(id)?.expect.status, 400, `${id} must be a 400`);
  }
});

test("the generated HTTP contract carries the auth and CSRF boundary", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    auth?: {
      sessionCookie: {
        name: string;
        httpOnly: boolean;
        secure: boolean;
        sameSite: string;
        path: string;
        domain: null;
      };
      csrf: { header: string; failure: { status: number; errorCode: string } };
      loginFailure: { status: number; errorCode: string; appliesTo: string[] };
      identity: { pattern: string; passwordMinLength: number };
    };
    errorCodes: string[];
  };

  // ESZ-025/026 read their whole security posture out of this block rather than
  // agreeing with the frontend out of band, exactly as ESZ-021 does for the
  // injection ids above.
  const auth = contract.auth;
  assert.ok(auth, "http-contract.json declares no auth block");

  assert.equal(auth.sessionCookie.name, "__Host-eszter_session");
  assert.equal(auth.sessionCookie.httpOnly, true);
  assert.equal(auth.sessionCookie.secure, true);
  assert.equal(auth.sessionCookie.sameSite, "Strict");
  assert.equal(auth.sessionCookie.path, "/");
  assert.equal(auth.sessionCookie.domain, null);

  assert.equal(auth.csrf.header, "x-csrf-token");
  assert.equal(auth.csrf.failure.status, 403);
  assert.equal(auth.csrf.failure.errorCode, "CSRF_TOKEN_INVALID");

  // The three login failures share one outcome. If this list ever shrinks, one of
  // them has grown a distinguishable answer and become an enumeration oracle.
  assert.equal(auth.loginFailure.status, 401);
  assert.equal(auth.loginFailure.errorCode, "INVALID_CREDENTIALS");
  assert.deepEqual(auth.loginFailure.appliesTo, [
    "unknown email",
    "wrong password",
    "disabled account",
  ]);

  assert.ok(auth.identity.passwordMinLength >= 12);

  for (const code of [
    "VALIDATION_FAILED",
    "INVALID_CREDENTIALS",
    "UNAUTHENTICATED",
    "CSRF_TOKEN_INVALID",
  ]) {
    assert.ok(contract.errorCodes.includes(code), `${code} is missing from errorCodes`);
  }
});

test("the generated HTTP contract carries the public-page injection boundary", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    publicPage?: {
      path: string;
      contentType: string;
      bootstrap: { contentElementId: string; appearanceElementId: string };
      fallback: { status: number };
    };
  };

  // ESZ-021 moved `/` from "not ours" to a contracted endpoint. A PHP
  // implementation reads the element ids from here rather than agreeing with the
  // frontend out of band, which is the whole point of the artifact.
  const publicPage = contract.publicPage;
  assert.ok(publicPage, "http-contract.json declares no publicPage block");
  assert.equal(publicPage.path, "/");
  assert.equal(publicPage.contentType, "text/html; charset=utf-8");
  assert.equal(publicPage.bootstrap.contentElementId, "__ESZTER_CONTENT__");
  assert.equal(publicPage.bootstrap.appearanceElementId, "__ESZTER_APPEARANCE__");

  // The page degrades to 200 with the baked defaults where the API answers 500.
  assert.equal(publicPage.fallback.status, 200);
});

test("no contract case is exempted from any implementation", () => {
  // ESZ-015 left exactly one exemption: `/` was not the PHP front controller's to
  // answer. ESZ-021 made it PHP's, so the case became a real endpoint and the
  // exemption went with it. The set is empty and must stay empty — an exemption is
  // a contract change, not a way to quiet a failing runtime.
  const exempted = httpContractCases
    .filter((httpCase) => (httpCase.exemptions?.length ?? 0) > 0)
    .map((httpCase) => httpCase.id);

  assert.deepEqual(exempted, []);
});

test("every public-page HTML case states which document it must render", () => {
  for (const httpCase of httpContractCases) {
    if (httpCase.expect.body !== "publicPageHtml") continue;

    assert.ok(
      httpCase.expect.pageContent === "published" || httpCase.expect.pageContent === "defaults",
      `${httpCase.id} asserts publicPageHtml without saying which document it carries`,
    );
  }
});

test("the generated HTTP contract carries the media boundary", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    media?: {
      path: string;
      cacheControl: string;
      assetIdPattern: string;
      publicPathPrefix: string;
      publicPathPattern: string;
      formats: Array<{ mimeType: string; extension: string }>;
      upload: { fieldName: string; contentType: string; limitBytes: number };
      dimensions: { maxDimension: number; maxPixels: number };
      storage: {
        intake: { webReachable: boolean };
        original: { webReachable: boolean };
        managed: { webReachable: boolean };
      };
      ingest: { pipeline: string[]; requirements: string[] };
      delete: { refusal: { status: number; errorCode: string }; requirements: string[] };
    };
    errorCodes: string[];
    cases: Array<{ id: string; endpoint: string; request: { body?: string } }>;
  };

  const media = contract.media;
  assert.ok(media, "http-contract.json declares no media block");

  assert.equal(media.path, "/api/admin/media");
  // The library is a map of unpublished editorial work, exactly like the draft.
  assert.equal(media.cacheControl, "no-store");

  // The V1 allowlist, asserted as a set rather than as a length, so adding a
  // format is a deliberate edit to this line and not a silent widening. SVG in
  // particular is a scriptable document, not a bitmap, and must stay out.
  assert.deepEqual(
    media.formats.map((format) => format.mimeType).sort(),
    ["image/jpeg", "image/png", "image/webp"],
  );
  assert.deepEqual(
    media.formats.map((format) => format.extension).sort(),
    ["jpg", "png", "webp"],
  );
  for (const format of media.formats) {
    assert.ok(
      !/svg|xml/i.test(format.mimeType),
      "SVG is not a bitmap and must not be on the media allowlist",
    );
  }

  // Only the derivative is reachable. If either of the other two ever became
  // reachable, an unverified byte sequence would be addressable.
  assert.equal(media.storage.intake.webReachable, false);
  assert.equal(media.storage.original.webReachable, false);
  assert.equal(media.storage.managed.webReachable, true);

  // Every stored name is server-generated: the pattern admits no separator, no
  // dot beyond the extension and no client-supplied byte at all.
  assert.equal(media.assetIdPattern, "^med_[0-9a-f]{32}$");
  assert.equal(media.publicPathPrefix, "/media/");
  const publicPath = new RegExp(media.publicPathPattern);
  assert.ok(publicPath.test(`/media/med_${"0".repeat(32)}.jpg`));
  assert.ok(!publicPath.test(`/media/../med_${"0".repeat(32)}.jpg`));
  assert.ok(!publicPath.test(`/media/med_${"0".repeat(32)}.php.jpg`));
  assert.ok(!publicPath.test(`/media/med_${"0".repeat(32)}.svg`));

  // The route's own limit, and the global one it must not have moved.
  assert.equal(media.upload.fieldName, "file");
  assert.equal(media.upload.contentType, "multipart/form-data");
  assert.equal(media.upload.limitBytes, 8 * 1024 * 1024);
  assert.ok(contract.errorCodes.includes("PAYLOAD_TOO_LARGE"));
  assert.ok(contract.errorCodes.includes("MEDIA_REFERENCED"));

  // Dimensions are bounded before a decoder runs, which is the only ordering
  // that stops a decompression bomb rather than surviving one.
  const detect = media.ingest.pipeline.indexOf("boundDimensions");
  const decode = media.ingest.pipeline.indexOf("decode");
  assert.ok(detect >= 0 && decode >= 0);
  assert.ok(detect < decode, "dimensions must be bounded before decoding");

  // And the bytes decide the type, before the allowlist is consulted.
  const fromBytes = media.ingest.pipeline.indexOf("detectTypeFromBytes");
  const allowlist = media.ingest.pipeline.indexOf("assertAllowlisted");
  assert.ok(fromBytes >= 0 && fromBytes < allowlist);
  assert.ok(media.ingest.pipeline.indexOf("csrf") < fromBytes);

  // The delete refusal is its own code: a referenced asset is neither a
  // validation failure nor a revision conflict, and the recovery differs.
  assert.equal(media.delete.refusal.status, 409);
  assert.equal(media.delete.refusal.errorCode, "MEDIA_REFERENCED");
  assert.ok(
    media.delete.requirements.some((requirement) =>
      /draft/.test(requirement) && /published/.test(requirement),
    ),
    "the reference check must cover both the draft and the published document",
  );

  // Every media case that names a body names one the runner knows how to build.
  const named = new Set(contractRequestBodies as readonly string[]);
  for (const httpCase of contract.cases) {
    if (httpCase.endpoint !== "/api/admin/media") continue;
    if (httpCase.request.body === undefined) continue;
    assert.ok(
      named.has(httpCase.request.body),
      `${httpCase.id} names an unbuildable body ${httpCase.request.body}`,
    );
  }
});

test("the generated HTTP contract carries the admin content boundary", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    adminContent?: {
      paths: { draft: string; publish: string; reset: string };
      cacheControl: string;
      revisionHeader: string;
      revision: {
        invariant: string;
        transitions: { saveDraft: string; publish: string; resetDraft: string };
      };
      concurrency: {
        field: string;
        failure: { status: number; errorCode: string };
        ignoredHeaders: string[];
        appliesTo: string[];
      };
      resetSources: string[];
      requestBodies: string[];
      staleRevisionFixture: number;
    };
    errorCodes: string[];
  };

  const admin = contract.adminContent;
  assert.ok(admin, "http-contract.json declares no adminContent block");

  assert.equal(admin.paths.draft, "/api/admin/content/draft");
  assert.equal(admin.paths.publish, "/api/admin/content/publish");
  assert.equal(admin.paths.reset, "/api/admin/content/reset");

  // Unpublished editorial work must not be storable by a browser or a proxy.
  // `no-cache` would permit exactly that and merely require revalidation.
  assert.equal(admin.cacheControl, "no-store");
  assert.equal(admin.revisionHeader, "x-content-revision");

  // The single shared sequence (ESZ-031/032/033). Publish setting
  // `published.revision` *to* the draft head — rather than incrementing a
  // counter of its own — is what makes a retry idempotent and what keeps the
  // published revision traceable to the draft it came from.
  assert.match(admin.revision.invariant, /published\.revision <= draft\.revision/);
  assert.match(admin.revision.transitions.saveDraft, /head \+ 1/);
  assert.match(admin.revision.transitions.publish, /published\.revision = draft\.revision/);
  // Reset is a draft mutation like any other; a head that did not move would
  // make it the one write the concurrency check cannot see.
  assert.match(admin.revision.transitions.resetDraft, /head \+ 1/);

  // Exactly one optimistic-concurrency mechanism, and the negative half is part
  // of the contract: a second way to state the precondition is a hole, because a
  // client using the one the server ignores is protected by nothing.
  assert.equal(admin.concurrency.field, "expectedRevision");
  assert.equal(admin.concurrency.failure.status, 409);
  assert.equal(admin.concurrency.failure.errorCode, "REVISION_CONFLICT");
  assert.ok(contract.errorCodes.includes("REVISION_CONFLICT"));
  for (const header of ["if-match", "if-unmodified-since", "if-none-match"]) {
    assert.ok(
      admin.concurrency.ignoredHeaders.includes(header),
      `${header} must be declared ignored on the admin content surface`,
    );
  }

  // All three writing routes are covered, so none of them is a lighter
  // operation that skips the precondition.
  assert.deepEqual([...admin.concurrency.appliesTo].sort(), [
    "POST /api/admin/content/publish",
    "POST /api/admin/content/reset",
    "PUT /api/admin/content/draft",
  ]);

  // A closed source enum: a destructive operation names what it resets to.
  assert.deepEqual(admin.resetSources, ["published"]);

  assert.ok(admin.requestBodies.length > 0);
  assert.ok(Number.isInteger(admin.staleRevisionFixture));
});

test("every admin content case names a body the runner can build", () => {
  const named = new Set(contractRequestBodies);

  for (const httpCase of httpContractCases) {
    if (!httpCase.request.path.startsWith("/api/admin/content/")) continue;

    const { body, rawBody } = httpCase.request;

    // Mutually exclusive: a case that supplied both would leave the runner to
    // pick, and the two would silently disagree about what was sent.
    assert.ok(
      !(body !== undefined && rawBody !== undefined),
      `${httpCase.id} supplies both a named body and a raw body`,
    );

    if (body !== undefined) {
      assert.ok(named.has(body), `${httpCase.id} names an unknown request body: ${body}`);
    }

    // A method that carries a body must say what it is, or the case proves
    // nothing about the route it exercises.
    if (["PUT", "POST"].includes(httpCase.request.method)) {
      assert.ok(
        body !== undefined || rawBody !== undefined,
        `${httpCase.id} is a ${httpCase.request.method} with no body at all`,
      );
    }
  }
});

test("every admin content write case states what it did to storage", () => {
  for (const httpCase of httpContractCases) {
    if (!httpCase.request.path.startsWith("/api/admin/content/")) continue;
    if (!["PUT", "POST"].includes(httpCase.request.method)) continue;
    // A malformed body is rejected before routing, so it is not a statement
    // about this surface's storage behaviour.
    if (httpCase.request.rawBody !== undefined) continue;

    assert.ok(
      httpCase.expect.storageAfter !== undefined,
      `${httpCase.id} writes to a mutating route without asserting the effect on storage`,
    );

    // The load-bearing half: every non-2xx on a write route must leave storage
    // alone. If one of these ever stopped saying `unchanged`, a rejected
    // request would have started mutating content.
    if (httpCase.expect.status >= 400) {
      assert.equal(
        httpCase.expect.storageAfter,
        "unchanged",
        `${httpCase.id} is a ${httpCase.expect.status} that does not leave storage unchanged`,
      );
    }
  }
});

test("no rejected admin content request reports the revision header", () => {
  // `content.rejectedRequestsNeverReachStorage`: a 401 or a 403 is decided
  // before the lock is taken, so it cannot know the head — and must not leak
  // that one exists. A 409 is the deliberate exception: it *is* the mechanism's
  // answer, and it carries the head so the caller can rebase.
  for (const httpCase of httpContractCases) {
    if (!httpCase.request.path.startsWith("/api/admin/content/")) continue;
    if (![401, 403].includes(httpCase.expect.status)) continue;
    if (httpCase.expect.contentRevision === undefined) continue;

    assert.equal(
      httpCase.expect.contentRevision,
      "absent",
      `${httpCase.id} is a ${httpCase.expect.status} that reports a content revision`,
    );
  }
});

test("ESZ-084: the storage caps and the request limit are reconciled, not merely adjacent", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    requestBodyLimitBytes: number;
    storageLimits: typeof storageLimitReconciliation;
  };

  assert.deepEqual(contract.storageLimits, storageLimitReconciliation);

  // The invariant the block exists to state, asserted rather than described. A
  // storage cap at or below the request limit would accept a save and then refuse
  // to read it back, which is content loss caused by the rule meant to prevent it.
  assert.ok(
    CONTENT_FILE_LIMIT_BYTES > REQUEST_BODY_LIMIT_BYTES,
    "the content file cap must stay strictly above the request body limit",
  );
  assert.equal(contract.storageLimits.invariant, "contentFileLimitBytes > requestBodyLimitBytes");
  assert.equal(contract.requestBodyLimitBytes, REQUEST_BODY_LIMIT_BYTES);

  // The media catalogue is the one cap a caller can actually reach, so it is the
  // one that has to be enforced before the write rather than on the next read.
  assert.deepEqual(contract.storageLimits.enforcedOnWrite, ["mediaLibraryIndexLimitBytes"]);
  assert.equal(
    contract.storageLimits.mediaLibraryIndexLimitBytes,
    MEDIA_LIBRARY_INDEX_LIMIT_BYTES,
  );
  assert.equal(contract.storageLimits.overSizedMediaLibraryOutcome.status, 413);
});

test("ESZ-084: the rate-limit policy is frozen, deterministic and store-backed", async () => {
  const contract = JSON.parse(await readGenerated("http-contract.json")) as {
    errorCodes: string[];
    errorMessages: Record<string, string>;
    rateLimit: typeof rateLimitPolicy;
  };

  assert.deepEqual(contract.rateLimit, rateLimitPolicy);
  assert.ok(contract.errorCodes.includes("RATE_LIMITED"));
  assert.ok((contract.errorMessages.RATE_LIMITED ?? "").length > 0);

  // The three properties that make the limiter enforceable on shared hosting,
  // where every request is a fresh process. Any of them drifting turns the
  // limiter into a counter that reaches one and stays there.
  assert.equal(contract.rateLimit.store, "database");
  assert.equal(contract.rateLimit.clock, "application");
  assert.equal(contract.rateLimit.algorithm, "gcra");

  // A header the caller writes must never decide which bucket they are charged
  // to, or the limit is opt-out.
  assert.equal(contract.rateLimit.forwardedHeadersTrusted, false);
  assert.equal(contract.rateLimit.clientAddressSource, "REMOTE_ADDR");

  assert.equal(contract.rateLimit.refusal.status, 429);
  assert.equal(contract.rateLimit.refusal.errorCode, "RATE_LIMITED");
  assert.equal(contract.rateLimit.refusal.retryAfterHeader, "Retry-After");

  const buckets = Object.entries(contract.rateLimit.buckets);
  assert.ok(buckets.length > 0);

  for (const [key, bucket] of buckets) {
    // The key and the scope it names must agree: the scope is what the PHP
    // limiter hashes into the row key, and a mismatch would silently give two
    // rules one bucket.
    assert.equal(bucket.scope, key, `bucket ${key} disagrees with its scope`);
    assert.ok(bucket.limit > 0, `${key} has a non-positive limit`);
    assert.ok(bucket.periodSeconds > 0, `${key} has a non-positive period`);
    assert.ok(bucket.burst >= 1, `${key} allows no burst at all`);

    // GCRA needs a whole-millisecond emission interval to stay exactly
    // reproducible between the contract, PHP and a test that moves the clock.
    const emissionMs = (bucket.periodSeconds * 1000) / bucket.limit;
    assert.equal(
      emissionMs,
      Math.trunc(emissionMs),
      `${key} has a fractional emission interval and cannot be reproduced exactly`,
    );
  }

  // The asymmetry that keeps throttling from becoming a lockout weapon: the
  // per-identity login budget must stay wider than the per-address one, or an
  // anonymous caller can shut the only administrator out by failing logins for
  // them.
  assert.ok(
    contract.rateLimit.buckets["auth.login.identity"].limit >
      contract.rateLimit.buckets["auth.login.address"].limit,
  );
});
