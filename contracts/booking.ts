import { serviceItemIds } from "./site-content.js";

/**
 * Package 4.1/4.2/7.1 language-neutral booking-domain contract.
 *
 * Version 4 (ESZ-140) adds the V1 customer-data retention policy and the
 * `retired` notification status the retention sweep writes.
 *
 * Version 5 (ESZ-144) replaces the silent row cap on admin booking reads with
 * explicit administration bounds: range reads paginate on a fixed page size
 * with a typed keyset cursor, and the operational summary counts by dedicated
 * SQL aggregation while its detail collections are bounded and advertise their
 * own completeness. No admin surface may read a capped collection as if it
 * were exhaustive.
 *
 * Version 6 (ESZ-146) freezes one authoritative booking serialization
 * boundary: booking create/move/cancel and every bookability mutation (weekly
 * availability replacement, date exception open/close/remove, service
 * provisioning that changes `is_active`, duration or buffers) take the same
 * singleton MySQL row lock first, inside their own transaction, so no
 * create/move can confirm a slot from state a concurrently committed mutation
 * has already invalidated.
 *
 * Version 7 (ESZ-142) makes the booking contract the single authority for the
 * consent notice a visitor accepted: an immutable notice catalog
 * (`consentNotices.entries`) carries every notice ever shown with its exact
 * user-visible French text, `consentNotices.currentId` names the one the
 * current frontend renders, and `POST /api/bookings` requires the machine id
 * of the displayed notice beside `consentAccepted: true`. The request never
 * carries notice text; the server accepts only an id the catalog contains.
 */
export const BOOKING_DOMAIN_VERSION = 7;

/**
 * The business operates in metropolitan France. Rules are authored as local
 * civil time in this IANA zone; stored appointment instants are UTC.
 */
export const BOOKING_TIME_ZONE = "Europe/Paris";

/**
 * Reuse the CMS's stable business identifiers as keys; a key is never an
 * editorial title. The stored booking label (see `services.labelSource`) is
 * the matching published item's title mirrored at provisioning — a cache of
 * the SiteContent authority, never an independent copy.
 */
export const bookableServiceKeys = serviceItemIds;
export type BookableServiceKey = (typeof bookableServiceKeys)[number];

export const BOOKING_SERVICE_KEY_PATTERN = "^[a-z][a-z0-9-]{1,63}$";
export const BOOKING_SERVICE_LABEL_MAX_LENGTH = 160;
export const BOOKING_SERVICE_DURATION_MIN_MINUTES = 5;
export const BOOKING_SERVICE_DURATION_MAX_MINUTES = 480;
export const BOOKING_SERVICE_BUFFER_MAX_MINUTES = 240;
export const BOOKING_SLOT_GRID_MINUTES = 15;
export const BOOKING_SLOT_MAX_HORIZON_DAYS = 90;
export const BOOKING_SLOT_MAX_RESULTS = 1000;
export const BOOKING_DST_FOLD_OFFSETS = ["+01:00", "+02:00"] as const;

/**
 * ESZ-144 — the fixed page capacity of one admin booking range read.
 *
 * The server returns at most this many rows per request and always states
 * `hasMore` and the typed continuation cursor, so no caller can mistake a page
 * for the whole range. 200 keeps one page small enough to parse and render
 * while making a busy month a handful of round trips. It is deliberately not a
 * client parameter: a page size a caller could raise is a bound the caller
 * could remove.
 */
export const BOOKING_ADMIN_RANGE_PAGE_SIZE = 200;

/**
 * ESZ-144 — how many pages one range walk may fetch before the client must
 * stop and report the range as incomplete.
 *
 * A correct server always terminates a walk earlier than this — every page
 * strictly advances the keyset cursor and the last one clears `hasMore` — so
 * the budget exists to turn a pathological range or a misbehaving server into
 * an explicit, visible failure instead of an infinite request loop. 250 pages
 * at 200 rows each is far beyond what one practitioner can hold in a 90-day
 * window; reaching it is an error, not a workload.
 */
export const BOOKING_ADMIN_RANGE_MAX_PAGES = 250;

/**
 * ESZ-145 — the fixed page capacity of one booking history read.
 *
 * `mode=reference` returns at most this many history events per request and
 * always states `hasMore` and the typed continuation cursor, so no caller can
 * mistake a page for the whole audit trail. 50 keeps a detail response small
 * (one busy booking can hold thousands of events) while making a long trail a
 * handful of round trips. Like the range page size it is deliberately not a
 * client parameter: a page size a caller could raise is a bound the caller
 * could remove.
 */
export const BOOKING_ADMIN_HISTORY_PAGE_SIZE = 50;

/**
 * ESZ-144 — the bound on each confirmed-entry detail collection of the
 * operational summary.
 *
 * Counts are exact over the whole window by SQL aggregation; only the *listed*
 * entries are bounded, and the response says whether each partition is
 * complete so the operator always knows the count is authoritative and the
 * list may not be. The value sits above the busiest realistic day — 100 would
 * need a grid-aligned confirmed day beyond what the domain allows — so an
 * ordinary summary is complete; the bound exists to keep a pathological
 * horizon (a 90-day window can hold thousands of rows) from becoming one
 * unbounded array, and the completeness flags keep that bound honest.
 */
export const BOOKING_ADMIN_SUMMARY_MAX_LISTED_ENTRIES = 100;

/**
 * Smallest V1 appointment lifecycle. Completion and no-show are intentionally
 * absent until their operational semantics and actor permissions are designed.
 */
export const bookingStates = ["confirmed", "cancelled"] as const;
export type BookingStateValue = (typeof bookingStates)[number];
export const BOOKING_INITIAL_STATE: BookingStateValue = "confirmed";

export const bookingStateTransitions = {
  confirmed: ["cancelled"],
  cancelled: [],
} as const satisfies Record<BookingStateValue, readonly BookingStateValue[]>;

/**
 * Package 7.1 notification policy (ESZ-070/071/072).
 *
 * Frozen here rather than in PHP for the same reason the booking states are: the
 * enum set, the transition graph and the retry arithmetic are the things a second
 * reader has to agree with exactly, and a constant that lives in one language is
 * a constant that drifts the day a second consumer appears.
 *
 * There is deliberately no HTTP surface for notifications in this package. Jobs
 * are enqueued in-process by the booking repository and drained by one CLI cron
 * runner; nothing about them is reachable from the browser.
 */

/** How a notification reaches a customer. Neither implies a provider. */
export const notificationChannels = ["email", "sms"] as const;
export type NotificationChannel = (typeof notificationChannels)[number];

/** What the notification is about. One per booking-lifecycle fact worth telling. */
export const notificationJobTypes = [
  "booking_confirmation",
  "booking_reminder",
  "booking_cancellation",
  "booking_moved",
] as const;
export type NotificationJobType = (typeof notificationJobTypes)[number];

/**
 * The types whose value expires. A confirmation is still worth sending late; a
 * reminder for an appointment that has already started is worse than silence,
 * which is what the catch-up policy below exists to prevent.
 */
export const notificationTimeSensitiveJobTypes = ["booking_reminder"] as const;

export const notificationStatuses = [
  "pending",
  "processing",
  "sent",
  "failed",
  "skipped",
  "retired",
] as const;
export type NotificationStatus = (typeof notificationStatuses)[number];

export const NOTIFICATION_INITIAL_STATUS: NotificationStatus = "pending";

/**
 * `sent`, `failed`, `skipped` and `retired` are terminal: nothing leaves them,
 * ever.
 */
export const notificationStatusTransitions = {
  pending: ["processing", "skipped", "retired"],
  processing: ["sent", "pending", "failed", "skipped", "retired"],
  sent: [],
  failed: [],
  skipped: [],
  retired: [],
} as const satisfies Record<NotificationStatus, readonly NotificationStatus[]>;

export const notificationTerminalStatuses = [
  "sent",
  "failed",
  "skipped",
  "retired",
] as const;

/**
 * Retry arithmetic. Deterministic on purpose: no jitter, because with one cron
 * runner there is no thundering herd to spread and a random delay would make the
 * integration tests assert a range instead of a value. Jitter belongs to the
 * package that introduces a real provider and more than one sender.
 */
export const NOTIFICATION_MAX_ATTEMPTS = 5;
export const NOTIFICATION_BASE_BACKOFF_SECONDS = 60;
export const NOTIFICATION_MAX_BACKOFF_SECONDS = 3600;

/**
 * How long a claim stays valid without a heartbeat.
 *
 * Long enough that an ordinary delivery finishes inside it; short enough that a
 * runner killed mid-delivery does not strand its job until the next deploy. The
 * lease is durable — a column, not a process-local flag — so recovery survives
 * the death of the process that took it.
 */
export const NOTIFICATION_LEASE_SECONDS = 120;

/**
 * How late a time-sensitive notification may still be delivered.
 *
 * Past this, the job becomes terminally `skipped` and is never sent. One hour is
 * the point at which a reminder stops being a reminder: the customer has either
 * already left or already missed the appointment, and a late message reads as a
 * system that lost track of time rather than as a courtesy.
 */
export const NOTIFICATION_REMINDER_GRACE_MINUTES = 60;

/** One run's bounded appetite. A cron tick drains a batch, never the world. */
export const NOTIFICATION_DEFAULT_BATCH_SIZE = 50;
export const NOTIFICATION_MAX_BATCH_SIZE = 200;

/**
 * Caller-supplied job identity. Deriving it from stable booking facts is what
 * makes an enqueue repeat-safe: the second call finds the first job rather than
 * creating a second one.
 */
export const NOTIFICATION_IDEMPOTENCY_KEY_PATTERN = "^[a-z0-9][a-z0-9_.:-]{7,127}$";

/**
 * Diagnostic failure codes are codes, not messages.
 *
 * The pattern is the guarantee: a value matching it cannot contain an `@`, a
 * space, a digit-string phone number with punctuation, or any part of a message
 * body. That makes "the error column carries no customer data" a schema fact
 * rather than a review habit.
 */
export const NOTIFICATION_ERROR_CODE_PATTERN = "^[a-z][a-z0-9_]{2,63}$";

export const NOTIFICATION_LEASE_OWNER_PATTERN = "^[a-z0-9][a-z0-9_.:-]{7,63}$";

/**
 * The frozen code retention writes when it retires a job or refuses fact
 * resolution for an erased booking (ESZ-140). A code, never a message: it is
 * one of the reserved codes below and therefore cannot express customer data.
 */
export const NOTIFICATION_CUSTOMER_DATA_ERASURE_CODE = "customer_data_erased";

/** Reserved codes the runner and retention write themselves. Transports may add their own. */
export const notificationReservedErrorCodes = [
  "lease_expired",
  "lease_lost",
  "reminder_window_expired",
  "reminder_superseded",
  "booking_cancelled",
  "superseded_by_move",
  "superseded_by_cancellation",
  "channel_disabled",
  "transport_transient",
  "transport_permanent",
  "attempts_exhausted",
  NOTIFICATION_CUSTOMER_DATA_ERASURE_CODE,
] as const;

/**
 * ESZ-131 — codes the booking lifecycle writes when a transition makes an
 * earlier, still-undelivered lifecycle notification wrong. A move retires the
 * pending confirmation and any pending earlier move with `superseded_by_move`;
 * a cancellation retires both with `superseded_by_cancellation`. The runner
 * stores the same codes when a claimed job is re-checked at delivery time and
 * found obsolete, so the terminal outcome of an obsolete job never depends on
 * whether the transition caught it pending or already claimed.
 */
export const notificationLifecycleSupersessionCodes = [
  "superseded_by_move",
  "superseded_by_cancellation",
] as const;

/**
 * Everything a notification log line may carry, and nothing else.
 *
 * The list is short because the alternative is a redaction filter, and a
 * redaction filter is a promise that every future field will be remembered. An
 * allowlist fails closed: a field nobody listed simply does not appear.
 *
 * `bookingReference` is on the list and the customer's name is not, because the
 * reference is already the opaque public handle for the appointment — it is what
 * `POST /api/bookings` returns instead of customer data.
 */
export const notificationLogFields = [
  "jobId",
  "bookingReference",
  "channel",
  "jobType",
  "status",
  "attempts",
  "errorCode",
  "leaseOwner",
  "dueAtUtc",
  "nextAttemptAtUtc",
  "durationMs",
  "batchSize",
  "claimed",
  "recovered",
  "skipped",
] as const;

/** Named so a test can assert the negative rather than imply it. */
export const notificationForbiddenLogFields = [
  "customerName",
  "customerEmail",
  "customerPhone",
  "customerNote",
  "body",
  "subject",
  "message",
  "recipient",
  "password",
  "apiKey",
  "token",
  "credentials",
] as const;

export const notificationPolicy = {
  scope:
    "Package 7.1 durable notification jobs, one CLI cron runner and catch-up policy. No HTTP surface.",
  channels: notificationChannels,
  jobTypes: notificationJobTypes,
  timeSensitiveJobTypes: notificationTimeSensitiveJobTypes,
  statuses: {
    values: notificationStatuses,
    initial: NOTIFICATION_INITIAL_STATUS,
    terminal: notificationTerminalStatuses,
    transitions: notificationStatusTransitions,
    semantics: {
      pending: "Due or waiting for its next attempt. The only status a runner may claim.",
      processing:
        "Claimed under a durable expiring lease. Exactly one runner owns it until the lease expires.",
      sent: "Delivered once. Terminal; a job is never delivered twice.",
      failed:
        "Terminal. Either the transport refused permanently, or the bounded retries were exhausted.",
      skipped:
        "Terminal, and deliberate: the notification was considered and consciously not sent. Stale reminders and disabled channels land here so the decision is recorded rather than inferred from an absence.",
      retired:
        "Terminal, written by customer-data retention (ESZ-140): while the job was pending or processing, its booking's customer data was erased under the retention policy. The job was never delivered and never will be; last_error_code carries the frozen retention code. sent/failed/skipped jobs are evidence of what already happened and are never rewritten.",
    },
  },
  identity: {
    idempotencyKeyPattern: NOTIFICATION_IDEMPOTENCY_KEY_PATTERN,
    uniqueness:
      "The idempotency key is unique across the whole table. A repeated enqueue resolves to the same logical job rather than creating a second one, and a key reused with different booking, channel or type facts is a caller error rather than a silent overwrite.",
    derivation:
      "Built from stable booking facts — reference, channel, type and, for recurring types, the occurrence — so the same intent produces the same key on every process.",
  },
  lease: {
    seconds: NOTIFICATION_LEASE_SECONDS,
    ownerPattern: NOTIFICATION_LEASE_OWNER_PATTERN,
    claim:
      "A conditional UPDATE from pending to processing, guarded on the status and the due time. The row lock makes the transition atomic, so of two concurrent runners exactly one sees a row affected and the other sees none.",
    durability:
      "The owner and the expiry are columns. A runner that dies mid-delivery leaves them behind, and the next run reclaims the job once the lease has expired.",
    recovery:
      "Expired leases return to pending without resetting attempts, so an abandoned job costs one attempt and cannot loop forever.",
    externalDelivery:
      "No database transaction is held while a transport is called. The claim commits, delivery happens outside it, and the outcome is written as its own statement.",
  },
  retry: {
    maxAttempts: NOTIFICATION_MAX_ATTEMPTS,
    baseBackoffSeconds: NOTIFICATION_BASE_BACKOFF_SECONDS,
    maxBackoffSeconds: NOTIFICATION_MAX_BACKOFF_SECONDS,
    backoff:
      "min(baseBackoffSeconds * 2^(attempts - 1), maxBackoffSeconds), deterministic and without jitter.",
    exhaustion:
      "A transient failure on the last permitted attempt becomes terminal `failed`; it is never retried a sixth time.",
    permanent: "A permanent transport refusal is terminal immediately, whatever the attempt count.",
  },
  catchUp: {
    reminderGraceMinutes: NOTIFICATION_REMINDER_GRACE_MINUTES,
    staleReminder:
      "A time-sensitive job whose due time is older than the grace window becomes terminally skipped and is never delivered. Enforced twice: swept before claiming, and re-checked after claiming, because a queue that was drained slowly can cross the boundary between the two.",
    noBackfill:
      "Re-enabling a channel never creates jobs for windows that have already passed. An enqueue for a disabled channel is recorded immediately as skipped, so there is no backlog to flush and re-enabling changes only what happens next.",
    burstControl:
      "One run claims at most its batch size, so even a large recovered backlog is drained across ticks rather than in one burst.",
  },
  lifecycle: {
    marker:
      "Each lifecycle job stores lifecycle_event_id: the booking_history row id of the event that made it meaningful — `created` for a booking_confirmation, `moved` for a booking_moved, `cancelled` for a booking_cancellation. booking_history is append-only with monotonic ids and every transition appends its event in the same transaction as the job it schedules, so the marker is an internal ordering identity, never customer PII. Reminders carry no marker: they are time-windowed, not lifecycle-versioned.",
    supersede:
      "A move makes every still-pending confirmation and every still-pending earlier move obsolete; a cancellation makes every still-pending confirmation and move obsolete. The transition supersedes them to the terminal `skipped` status with the frozen code (superseded_by_move / superseded_by_cancellation) inside its own transaction, so only the newest applicable move — or the cancellation — remains pending. `sent` jobs are delivery evidence and `processing` jobs already belong to a runner; neither is rewritten by a transition.",
    deliveryTimeRelevance:
      "A lifecycle job that was already claimed when the superseding transition committed is re-checked before the transport boundary: it is obsolete exactly when a `moved` or `cancelled` booking_history event with a greater id exists for its booking, and it is then terminally skipped with the same frozen code the transition would have stored. Delayed cron runs and transient retries therefore re-evaluate relevance on every attempt, and an obsolete job is never rendered with facts that no longer describe its event. No database transaction or row lock is held across the transport.",
    cancellation:
      "A booking_cancellation remains deliverable for its own cancellation: no lifecycle transition can follow a cancelled booking, so nothing supersedes it; customer-data retention (ESZ-140) remains the only path that retires it.",
    reminders:
      "Reminders keep their own rules untouched: catch-up decisions, the stale grace window and move-time rescheduling of the reminder of the superseded occurrence.",
  },
  runner: {
    defaultBatchSize: NOTIFICATION_DEFAULT_BATCH_SIZE,
    maxBatchSize: NOTIFICATION_MAX_BATCH_SIZE,
    transport:
      "Delivery goes through a provider-neutral transport interface resolved per channel. Package 7.1 ships no SMTP or SMS client; a channel with no registered transport stops the run before anything is claimed rather than burning jobs.",
  },
  diagnostics: {
    errorCodePattern: NOTIFICATION_ERROR_CODE_PATTERN,
    reservedErrorCodes: notificationReservedErrorCodes,
    logFields: notificationLogFields,
    forbiddenLogFields: notificationForbiddenLogFields,
    rule:
      "Notification logging is an allowlist. No customer name, address, phone number, note, message body or credential is ever written to a log line or to the stored diagnostic column.",
  },
  retention: {
    bookingRelation:
      "notification_jobs.booking_id references bookings with ON DELETE RESTRICT. Notification history is evidence of what was sent and must not disappear with the appointment it describes; V1 never deletes a booking anyway, and this makes that a schema guarantee rather than a convention.",
    erasure:
      "When customer-data retention erases a booking (ESZ-140), every non-terminal job of that booking is retired to the terminal `retired` status with the reserved code `customer_data_erased`, under the same transaction as the erasure, so no job survives that could deliver after the erasure. Terminal jobs — sent, failed, skipped — are delivery evidence and are never rewritten.",
    factResolution:
      "Notification delivery resolves the current customer e-mail from bookings at delivery time. A booking whose customer data has been erased is refused: the provider throws a permanent delivery failure with the code `customer_data_erased`, so even a job that somehow survived erasure can never deliver from the erased row.",
  },
} as const;

/**
 * ESZ-146 — the one authoritative serialization boundary of booking and
 * bookability.
 *
 * Before ESZ-146, booking create and move locked the singleton
 * `booking_resource_locks.primary` row first and then re-read service and
 * availability state inside their transaction, but the bookability mutations —
 * weekly availability replacement, date exception open/close/remove, and
 * service provisioning changing `is_active`, duration or buffers — only took
 * their own revision/row locks. An in-flight create/move could therefore
 * validate a slot from pre-mutation state while one of those mutations
 * committed concurrently, and confirm a booking the mutation had just made
 * invalid.
 */
export const bookingSerializationPolicy = {
  boundary:
    "The singleton row booking_resource_locks.primary, taken with SELECT ... FOR UPDATE as the first statement of the owning MySQL transaction. A plain InnoDB row lock: no Redis, daemon or process-local mutex, so it serializes across every PHP process and host of a shared-hosting deployment.",
  members: [
    "booking create, move and cancel",
    "weekly availability replacement",
    "date exception open, close and remove",
    "service provisioning that changes is_active, duration, buffer-before or buffer-after",
  ],
  lockOrder:
    "booking_resource_locks.primary, acquired inside the owning transaction and before any other mutable row lock, then the availability revision / service / booking rows, then writes.",
  linearization:
    "The operation that acquires the boundary first is ordered first. If a bookability mutation commits first, a create/move that started concurrently acquires the boundary only afterwards, re-reads the new service/availability state and may confirm only if the requested slot is still valid. If create/move owns the boundary first it may commit first, and the mutation then follows; both sides finish without deadlock because the boundary is their only shared lock order.",
  optimisticConcurrency:
    "ESZ-137 is preserved: a stale expectedRevision still fails deterministically with a revision conflict and writes nothing, after the boundary has been acquired.",
  bookingRowToken:
    "ESZ-139 — a booking row carries its own optimistic-concurrency token, the canonical UTC millisecond updatedAt exposed by admin responses; no separate revision column exists. Admin update, move and cancel send it back as expectedUpdatedAt, and inside the mutation transaction after the authoritative row lock the server compares it byte-for-byte with the current updatedAt before any write, history append or notification scheduling. A mismatch is 409 REVISION_CONFLICT and writes nothing; a matching token lets the mutation store a single derived updatedAt strictly later than the token it was granted against — the derivation compares the application clock against the row's own token, so the same frozen millisecond or a backward clock can never mint an equal or older updatedAt. The row lock is the authority for update-vs-update and update-vs-lifecycle races; create, move and cancel additionally hold the boundary first, preserving the ESZ-146 order.",
  scope:
    "Package 4.2/6.2/ESZ-146 concurrency invariant of the booking domain; ESZ-139 adds the expectedUpdatedAt precondition to the admin mutation request shape and keeps the error envelope closed (the frozen 409 REVISION_CONFLICT code, no new field).",
} as const;

/**
 * ESZ-142 — the immutable consent-notice catalog.
 *
 * ## Why the notice is a contract value, not a component string
 *
 * Before ESZ-142 the consent checkbox copy lived only in the React component
 * and the server stored only `consent_at_utc`, so nothing durable said which
 * wording a visitor actually accepted. A wording that later changes would
 * make an old `consent_at_utc` mean whatever the current screen happens to
 * say — a silent rewrite of history.
 *
 * The catalog below is the single authority for both. Each entry pairs a
 * stable machine id with the exact user-visible French text of one notice;
 * `BOOKING_CONSENT_CURRENT_NOTICE_ID` names the entry the shipped frontend
 * renders and must send. The React checkbox renders `entries` text and never
 * carries a private duplicate, and the booking request sends only the id —
 * never notice text, which the server refuses to trust by never accepting
 * it.
 *
 * ## Immutability policy
 *
 * Entries are append-only and never edited or removed: a stored id keeps
 * naming exactly the text the visitor accepted, forever. Changing the
 * wording is a new entry plus moving the current pointer; old stored ids are
 * untouched, and because acceptance is catalog membership, an id issued in
 * the past remains accepted unchanged — it is never silently remapped to the
 * new notice. The first entry exists from the introduction of the catalog
 * (ESZ-142) onward: bookings created before it carry no notice id at all and
 * are never retro-attributed one (their stored `consent_at_utc` is all the
 * provenance that exists).
 *
 * The id is a machine token (bounded ASCII, `BOOKING_CONSENT_NOTICE_ID_PATTERN`)
 * and the notice text itself is not customer PII, so ESZ-140 anonymization
 * preserves both the consent instant and the notice id of an erased booking.
 */

/**
 * The ids ever issued, in issuance order. This tuple is the catalog's spine:
 * {@link bookingConsentNoticeTexts} is a `Record` over it, so adding an id
 * without its text (or vice versa) is a compile error.
 */
export const bookingConsentNoticeIds = ["booking-consent-v1"] as const;

export type BookingConsentNoticeId = (typeof bookingConsentNoticeIds)[number];

/** Bounded-ASCII shape every notice id must satisfy (mirrored by migration 0014's CHECK). */
export const BOOKING_CONSENT_NOTICE_ID_PATTERN = "^[a-z0-9][a-z0-9_-]{0,63}$";

/**
 * The exact user-visible text of each notice, keyed by id. The typographic
 * apostrophe is part of the frozen text.
 */
export const bookingConsentNoticeTexts: Record<BookingConsentNoticeId, string> = {
  "booking-consent-v1":
    "J’accepte que mes coordonnées soient utilisées pour traiter cette demande de rendez-vous.",
};

/** The one notice the shipped frontend displays and sends today. */
export const BOOKING_CONSENT_CURRENT_NOTICE_ID: BookingConsentNoticeId = "booking-consent-v1";

/** The current notice's full entry: `id` for the request, `text` for the checkbox. */
export const bookingConsentCurrentNotice: {
  id: BookingConsentNoticeId;
  text: string;
} = {
  id: BOOKING_CONSENT_CURRENT_NOTICE_ID,
  text: bookingConsentNoticeTexts[BOOKING_CONSENT_CURRENT_NOTICE_ID],
};

export const bookingConsentNoticePolicy = {
  entries: bookingConsentNoticeIds.map((id) => ({ id, text: bookingConsentNoticeTexts[id] })),
  idPattern: BOOKING_CONSENT_NOTICE_ID_PATTERN,
  currentId: BOOKING_CONSENT_CURRENT_NOTICE_ID,
  requestShape:
    "POST /api/bookings requires consentNoticeId (one of entries[].id, structurally bounded by the id pattern) plus consentAccepted: true. The request never carries notice text and the server never accepts any.",
  acceptance:
    "An id is accepted exactly when the catalog contains it. Entries are never removed, so a historical stored id remains accepted unchanged and is never silently remapped to the current notice; moving currentId changes what new clients send, not what old ids mean.",
  legacy:
    "Bookings created before the catalog (ESZ-142) have no consent_notice_id: their stored consent_at_utc is the only provenance that exists, and no migration or reader invents one for them. New bookings always store the non-null id of the notice they displayed.",
  future:
    "Changing the wording appends a new id and text to the catalog and moves currentId. Old entries and every stored id stay immutable; the database column and retention anonymization preserve the stored id byte for byte.",
  retention:
    "The notice id is operational evidence of which text was accepted, not customer PII: ESZ-140 erasure replaces the customer fields and leaves consent_at_utc and consent_notice_id untouched.",
} as const;

/**
 * ESZ-140 — the V1 customer-data retention policy.
 *
 * This is a product policy of this application, frozen as a contract so the
 * sweep, the schema and the documentation cannot drift apart. It is not a
 * claim about any statute: the terms that happen to be named in it are the
 * product's own chosen retention periods, not a transcription of a legal
 * requirement.
 */
export const customerDataRetentionPolicy = {
  /**
   * A booking is erased when it has reached the end of its lifecycle and the
   * retention period has passed since the lifecycle-ending instant: 90 days
   * after `ends_at_utc` for a confirmed booking, 90 days after
   * `cancelled_at_utc` for a cancelled one. Non-expired bookings are never
   * touched.
   */
  confirmedExpiryDaysAfterEndsAtUtc: 90,
  cancelledExpiryDaysAfterCancelledAtUtc: 90,
  erasedAtColumn: "bookings.customer_data_erased_at",
  /**
   * What erasure does to the booking row. name/e-mail are required columns, so
   * they hold fixed placeholders — never hashes, which would still be
   * personally identifying in a brute-force sense — and phone, note and
   * cancellation reason become NULL.
   */
  erasedFields: {
    customerName: "Deleted customer",
    customerEmail: "erased@example.invalid",
    customerPhone: null,
    customerNote: null,
    cancellationReason: null,
  },
  /** The frozen code written to retired jobs and used to refuse delivery for an erased booking. */
  erasureJobCode: NOTIFICATION_CUSTOMER_DATA_ERASURE_CODE,
  emailPlaceholderIsNonDeliverable:
    "The placeholder domain is `example.invalid`, reserved by RFC 2606 and unrouteable, so the placeholder address can never be delivered to.",
  retainedFields: [
    "id and reference",
    "service and appointment instants and timezone",
    "state and lifecycle timestamps (created, updated, state changed, consent, cancellation)",
    "consent notice id (ESZ-142: which accepted wording the consent instant refers to)",
    "erasure timestamp",
    "non-PII booking history facts",
    "notification delivery metadata (terminal jobs)",
  ],
  neverDelete:
    "Retention never deletes a booking, a history row or a notification job: evidence of the appointment, its history and what was sent survives anonymized.",
  /**
   * Application backup archives carry booking PII by design, so an archive is
   * itself a personal-data store with a bounded life: at most 30 days. Archive
   * pruning is an operator schedule, not a repo-enforced job; this is the
   * policy the operator schedule and the documentation state. Provider-side
   * snapshots are an external policy check and are not governed here.
   */
  backupArchiveRetentionDays: 30,
  scope:
    "V1 product policy. Non-expired bookings are untouched; erased rows keep their identity and appointment facts; no booking, history or notification evidence is deleted.",
} as const;

export const bookingDomainContract = {
  version: BOOKING_DOMAIN_VERSION,
  scope: "Package 4.1/4.2 booking domain and dynamic slot computation; no booking HTTP API.",
  services: {
    keys: bookableServiceKeys,
    source: "SiteContent.services.items[].id",
    keyPattern: BOOKING_SERVICE_KEY_PATTERN,
    labelMaxLength: BOOKING_SERVICE_LABEL_MAX_LENGTH,
    /**
     * AUD-14 — where a stored booking label may come from. There is exactly one
     * authority: the *published* SiteContent services item whose `id` is the
     * service key. Provisioning persists exactly that item's title (trimmed of
     * boundary whitespace only) and re-provisioning after a published title
     * change refreshes the stored label; an operator-supplied `--label`, a
     * draft, the canonical defaults or a pre-existing row are never an
     * authority, and a missing key or unreadable published content refuses
     * provisioning before any row changes.
     */
    labelSource:
      "The booking label stored beside a service key is that item's title from the validated published SiteContent document, mirrored at provisioning time; re-provisioning after a published title change updates it. It is never operator-supplied and never falls back to a draft, the defaults or an existing row.",
    durationMinutes: {
      min: BOOKING_SERVICE_DURATION_MIN_MINUTES,
      max: BOOKING_SERVICE_DURATION_MAX_MINUTES,
    },
    bufferMinutes: { min: 0, max: BOOKING_SERVICE_BUFFER_MAX_MINUTES },
    provisioning:
      "Explicit, repeat-safe operator action. Migrations and application boot seed no service rows.",
  },
  timezone: {
    iana: BOOKING_TIME_ZONE,
    availabilityStorage:
      "ISO weekday, DATE applicability bounds and TIME wall-clock values interpreted only in Europe/Paris.",
    appointmentStorage:
      "bookings.starts_at_utc and bookings.ends_at_utc are UTC DATETIME(3); timezone_name records Europe/Paris.",
    conversion:
      "Convert local wall time with IANA timezone rules before persistence; never consult the PHP, MySQL or host default timezone.",
    dst: {
      nonexistent:
        "Reject local wall times skipped by the spring-forward transition.",
      ambiguous:
        "Require an explicit numeric UTC offset and verify it is one of Europe/Paris's offsets for that wall time.",
      foldOffsets: BOOKING_DST_FOLD_OFFSETS,
    },
  },
  availability: {
    generatedSlotsPersisted: false,
    weekly:
      "Multiple non-overlapping local windows per ISO weekday; nullable validity bounds are inclusive.",
    exceptionPrecedence:
      "At most one exception exists per local date. Closed yields no windows. Open replaces the weekly result with its complete ordered window set; weekly and exception windows are never merged.",
    partialUnavailability:
      "Represent partial unavailability by storing the complete remaining open-window set in that date's replacing open exception.",
    grid: {
      minutes: BOOKING_SLOT_GRID_MINUTES,
      alignment:
        "Appointment starts align to fixed increments from local civil midnight, not from each availability-window start.",
    },
    fit:
      "The half-open resource interval [start-bufferBefore, start+duration+bufferAfter) must fit within one effective window and not overlap an occupied resource interval; touching boundaries are allowed.",
    cancellation: "Only non-cancelled bookings occupy time.",
    limits: {
      maxHorizonDays: BOOKING_SLOT_MAX_HORIZON_DAYS,
      maxResults: BOOKING_SLOT_MAX_RESULTS,
    },
  },
  states: {
    values: bookingStates,
    initial: BOOKING_INITIAL_STATE,
    transitions: bookingStateTransitions,
    semantics: {
      confirmed:
        "The appointment is accepted and occupies its UTC interval until explicitly cancelled.",
      cancelled:
        "Terminal V1 state. The row and original appointment facts remain stored; cancellation never deletes it.",
    },
    rules: [
      "Every state change is requested explicitly and checked by the central state machine.",
      "A transition to the current state is invalid rather than an implicit success.",
      "No UI value, elapsed clock time or read operation changes state.",
      "Cancellation sets cancelled_at_utc and never physically deletes the booking.",
    ],
  },
  /**
   * ESZ-144 — how the admin booking surfaces stay bounded without ever hiding
   * data silently. The pre-ESZ-144 read applied the public slot-engine result
   * cap (`availability.limits.maxResults`) to `bookings` rows: >1000 rows in a
   * valid range were clipped with nothing saying so, cancelled rows could
   * consume the cap and hide confirmed appointments, and the summary counted
   * from that same capped mixed-state list. Every bound below is therefore
   * explicit on the wire, and no consumer may treat a bounded collection as
   * exhaustive.
   */
  adminViews: {
    rangeRead: {
      pageSize: BOOKING_ADMIN_RANGE_PAGE_SIZE,
      membership:
        "A range read returns the bookings whose start instant falls in the half-open Paris-civil window [fromDate 00:00, (untilDate+1) 00:00). A booking that began before the window is never in it, however late it ends: the calendar shows bookings on the civil day of their start, and pagination pages over starts, so the two cannot disagree.",
      ordering:
        "Deterministic keyset order on (starts_at_utc, reference), the stable tie-break for equal instants.",
      cursor:
        "A typed continuation cursor {startsAtUtc, reference} naming the last returned row's keys. The server validates the cursor's shape, parses its instant and refuses one that does not lie inside the requested window; the row strictly after the cursor keys is where the next page begins, so re-sending a cursor cannot loop and equal instants cannot duplicate or skip.",
      hasMore:
        "The server fetches pageSize+1 rows and reports hasMore from the surplus row; a page is never silently clipped to a smaller answer than the range holds.",
      maxPages: BOOKING_ADMIN_RANGE_MAX_PAGES,
      termination:
        "A client may walk at most the maxPages pages per range before it must stop and report the range as incomplete; a correct server always terminates earlier because every page strictly advances the cursor.",
      exactReference:
        "mode=reference stays an exact lookup by booking reference and is unaffected by range pagination.",
    },
    historyPage: {
      pageSize: BOOKING_ADMIN_HISTORY_PAGE_SIZE,
      membership:
        "Only mode=reference carries history, as one fixed page of the booking's own append-only events in chronological order; range reads and mutation responses carry current-state booking facts only and never a history array, so a page of 200 bookings costs a constant number of queries and no per-booking history read.",
      ordering:
        "History events are ordered by the monotonic booking_history row id, which is also the continuation key: chronological order with a stable tie-break is impossible to fake because the id is assigned by the row itself.",
      cursor:
        "An optional typed history cursor {eventId} names the id of the last event the previous page exposed. The next page begins strictly after it (id > eventId), so re-sending a cursor cannot loop and paging cannot duplicate or skip an event; an absent cursor is the first page. The server validates the cursor's shape and refuses a non-positive id before reading.",
      hasMore:
        "The server fetches pageSize+1 events and reports hasMore from the surplus row; when more events exist the response says so and hands back the strictly advancing cursor of its last exposed event, so a page is never silently truncated.",
    },
    summary: {
      counts:
        "today/upcoming confirmed and cancelled counts are dedicated SQL aggregations over the whole window, never arithmetic over a capped detail list, so a bounded list cannot make a count wrong.",
      nextConfirmed:
        "nextConfirmedStartsAtUtc is the SQL minimum confirmed start instant at or after now within the window: exact over the full period, and never hidden by cancelled rows preceding it.",
      listedEntriesMax: BOOKING_ADMIN_SUMMARY_MAX_LISTED_ENTRIES,
      listedEntries:
        "today and upcoming carry only confirmed entries, earliest first, each collection capped at listedEntriesMax. listings.todayComplete / listings.upcomingComplete state whether that partition was fully listed; when false the operator is told the list is partial and the counts remain the authority. Cancelled rows never appear in either list and cannot displace a confirmed entry from it.",
    },
  },
  notifications: notificationPolicy,
  serialization: bookingSerializationPolicy,
  consentNotices: bookingConsentNoticePolicy,
  customerDataRetention: customerDataRetentionPolicy,
} as const;
