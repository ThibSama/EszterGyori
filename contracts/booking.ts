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
 *
 * Version 8 (ESZ-149) makes the operational service catalog
 * (`booking_services`) the single authority for what can be reserved. Service
 * keys are no longer a frozen enum mirrored from `SiteContent.services.items`:
 * a key is any string matching `services.keyPattern` that names a catalog
 * row, so an administrator can create a service without a contract edit. The
 * catalog now also owns the editorial facts the reservation flow renders —
 * name, description and one managed image reference — and archival is a
 * non-destructive `is_active = 0` that removes a service from new reservation
 * choices while every historical booking keeps its stored key and times.
 *
 * Version 9 (ESZ-150) lets one appointment carry several services. The
 * administrator configures the maximum number of services per appointment
 * (`services.combinations.maxPerAppointment`, a `system_settings` row,
 * default 1); a *combination* is the canonical set of two or more active
 * service keys — sorted, joined with `+` — and exists for booking only once
 * the administrator has persisted a *validated* duration for it. The server
 * proposes a duration (the plain sum of the component durations, advisory
 * only); the persisted validated duration is the sole authority for slot
 * generation and creation and is never recomputed when a component's
 * duration changes. A booking stores its combination key beside its first
 * service key; single-service bookings, past and future, keep exactly the
 * facts they had.
 *
 * Version 10 (ESZ-151) adds the administrator's booking-time rules
 * (`availability.bookingTimeRules`): a minimum lead time before a slot may
 * start, a preferred usual finish time and the maximum overrun an appointment
 * may run past it. They live in one `system_settings` row written under the
 * availability revision and the serialization boundary, and they only ever
 * *narrow* what the weekly and date-exception windows already allow. The
 * defaults (no lead, no finish cap, no overrun) leave every existing
 * deployment offering exactly the slots it offered before.
 *
 * Version 11 (ESZ-152) adds planning constraints
 * (`availability.planningConstraints`): flexible pauses, which are planning
 * preferences and never remove a slot, and strict blockers — a timed
 * unavailability, a closure of one or several whole days, leave over an
 * inclusive date range — which block new reservations exactly the way an
 * occupied interval does. They are additive rows beside the replacing date
 * exceptions, written under the availability revision and the serialization
 * boundary, and a strict blocker never alters a confirmed booking it overlaps.
 *
 * Version 12 (ESZ-161) aligns public booking with the GDPR V1 framing. A
 * booking rests on the execution of the requested service and the
 * pre-contractual steps the visitor asks for — not on consent — so the
 * request no longer carries an acceptance boolean. What it carries instead is
 * the id of the *privacy-information notice* the form displayed
 * (`privacyNotices`, the same immutable append-only catalog discipline as the
 * ESZ-142 consent notices, which stay frozen as history for the bookings that
 * were made under them). The public reference becomes a short human-readable
 * `XXXX-XXXX` token (`publicReferences`) while every stored `bk_` reference
 * stays valid and resolvable unchanged.
 *
 * Version 13 (ESZ-163) adds the admin GDPR request register
 * (`privacyRequests`): the five frozen V1 request types, the automatic
 * three-state lifecycle, the one-month deadline derived from the reception
 * date, the register's data-minimisation rule (no requester e-mail, message
 * or identity document is ever stored — only selected booking references)
 * and the three-year retention of closed records. Executing the rights
 * themselves is ESZ-164's; this version freezes only the register.
 *
 * Version 14 (ESZ-164) executes the five rights from that register
 * (`privacyRequests.execution`): one shared export engine with a readable
 * HTML and a structured JSON representation, rectification through the
 * existing booking customer-update authority, early anonymisation through
 * the ESZ-140/162 erasure primitive, and a reversible *restriction of
 * processing* state stored on the booking (`bookings.processing_restricted_at`)
 * that the notification runner reads before every claim and before every
 * transport call. Lifting a restriction sends one informational e-mail — the
 * new `processing_restriction_lifted` job type — and never replays a
 * reminder whose window elapsed while the booking was restricted.
 */
export const BOOKING_DOMAIN_VERSION = 14;

/**
 * The business operates in metropolitan France. Rules are authored as local
 * civil time in this IANA zone; stored appointment instants are UTC.
 */
export const BOOKING_TIME_ZONE = "Europe/Paris";

/**
 * A service key is a stable, lowercase, URL-safe identifier that names one
 * `booking_services` row; it is never an editorial title. Since ESZ-149 the
 * set of keys is owned by that table alone: the wire accepts any value
 * matching {@link BOOKING_SERVICE_KEY_PATTERN} and the domain decides whether
 * it names an actively bookable service. The four keys that existed before
 * (`brows`, `eyeliner`, `lips`, `freckles`) are ordinary rows of that table
 * and keep every booking that references them.
 */
export type BookableServiceKey = string;

export const BOOKING_SERVICE_KEY_PATTERN = "^[a-z][a-z0-9-]{1,63}$";
export const BOOKING_SERVICE_LABEL_MAX_LENGTH = 160;
/**
 * ESZ-149 — the bound on the catalog's own description of a service. Same
 * ceiling as a booking note: long enough for a paragraph the reservation
 * page can show, bounded so the public discovery payload stays small.
 */
export const BOOKING_SERVICE_DESCRIPTION_MAX_LENGTH = 2000;
export const BOOKING_SERVICE_DURATION_MIN_MINUTES = 5;
export const BOOKING_SERVICE_DURATION_MAX_MINUTES = 480;
export const BOOKING_SERVICE_BUFFER_MAX_MINUTES = 240;

/**
 * ESZ-150 — the ceiling of the administrator's "services per appointment"
 * setting, and the floor/default that keeps every existing deployment a
 * single-service booking flow until Esther raises it. The ceiling bounds the
 * combination key (`BOOKING_SERVICE_COMBINATION_KEY_PATTERN`), the request
 * arrays and the number of candidate combinations the back-office lists.
 */
export const BOOKING_MAX_SERVICES_PER_APPOINTMENT_LIMIT = 4;
export const BOOKING_MAX_SERVICES_PER_APPOINTMENT_DEFAULT = 1;
/** The `system_settings` row that holds the configured maximum (`{"max": n}`). */
export const BOOKING_MAX_SERVICES_SETTING_KEY = "booking.max_services_per_appointment";

/**
 * ESZ-150 — a combination's identity: its member service keys, sorted
 * bytewise and joined with `+`, so A+B and B+A are one row. Labels and
 * images never take part. Two to `BOOKING_MAX_SERVICES_PER_APPOINTMENT_LIMIT`
 * members.
 */
export const BOOKING_SERVICE_COMBINATION_KEY_PATTERN =
  `^[a-z][a-z0-9-]{1,63}([+][a-z][a-z0-9-]{1,63}){1,${BOOKING_MAX_SERVICES_PER_APPOINTMENT_LIMIT - 1}}$`;

/**
 * ESZ-150 — the bound on candidate (not yet validated) combinations one
 * admin catalog read lists. Every persisted combination is always listed;
 * candidates are enumerated in catalog order up to this many, and the
 * response states whether the enumeration was complete.
 */
export const BOOKING_SERVICE_COMBINATION_CANDIDATES_MAX = 300;
/**
 * ESZ-161 — the public booking reference.
 *
 * Before ESZ-161 a reference was `bk_` plus 128 bits of hex: unforgeable, but
 * 35 characters that no customer can read back over the phone. The current
 * format is eight significant characters from an unambiguous uppercase
 * alphabet (no `0`/`O`, no `1`/`I`), displayed and stored as `XXXX-XXXX`
 * (e.g. `XG73-UVK9`): 40 bits of randomness, a `UNIQUE KEY` on the column and
 * a bounded collision retry make it unique, and it stays an opaque public
 * handle that reveals nothing about the customer or the internal numeric id.
 *
 * Both formats are frozen. A legacy `bk_` reference stored before ESZ-161 is
 * never rewritten and stays accepted everywhere a reference is read — the
 * admin exact lookup, the history read, notification idempotency keys — so
 * {@link BOOKING_REFERENCE_PATTERN}, the shape every wire field accepts, is
 * the union of the two, and {@link BOOKING_REFERENCE_CURRENT_PATTERN} is what
 * every *new* booking is issued.
 */
export const BOOKING_REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const BOOKING_REFERENCE_SIGNIFICANT_CHARACTERS = 8;
export const BOOKING_REFERENCE_CURRENT_PATTERN = "^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$";
export const BOOKING_REFERENCE_LEGACY_PATTERN = "^bk_[0-9a-f]{32}$";
export const BOOKING_REFERENCE_PATTERN = "^(bk_[0-9a-f]{32}|[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})$";
/** How many fresh candidates creation may draw before it refuses instead of looping. */
export const BOOKING_REFERENCE_GENERATION_MAX_ATTEMPTS = 8;

export const bookingPublicReferencePolicy = {
  accepted: BOOKING_REFERENCE_PATTERN,
  current: {
    pattern: BOOKING_REFERENCE_CURRENT_PATTERN,
    alphabet: BOOKING_REFERENCE_ALPHABET,
    significantCharacters: BOOKING_REFERENCE_SIGNIFICANT_CHARACTERS,
    display: "XXXX-XXXX",
    example: "XG73-UVK9",
    generation:
      "Eight characters drawn with a cryptographically secure generator from the 32-character unambiguous alphabet, grouped 4-4 with a hyphen. The hyphenated form is the stored value and the displayed value; there is no separate canonical form to normalise.",
    uniqueness:
      "bookings.reference stays UNIQUE. Creation draws a candidate, refuses one already stored and retries a duplicate-key insert with a fresh candidate, bounded by generationMaxAttempts; exhausting the bound fails the creation without writing anything rather than looping.",
    generationMaxAttempts: BOOKING_REFERENCE_GENERATION_MAX_ATTEMPTS,
  },
  legacy: {
    pattern: BOOKING_REFERENCE_LEGACY_PATTERN,
    compatibility:
      "Every bk_ reference issued before ESZ-161 is preserved byte for byte and remains resolvable by the admin exact lookup, the history read, the range keyset cursor and notification fact resolution. No migration rewrites a stored reference, and no new booking is ever issued the legacy shape.",
  },
  separation:
    "The public reference is the only handle a customer ever sees. The internal numeric bookings.id stays a private row identity used by foreign keys and history; it never appears on the wire.",
  customerGuidance:
    "The confirmation e-mail tells the customer explicitly to keep the reference: it identifies the appointment in every later exchange without exposing any personal data.",
} as const;

export const BOOKING_SLOT_GRID_MINUTES = 15;
export const BOOKING_SLOT_MAX_HORIZON_DAYS = 90;
export const BOOKING_SLOT_MAX_RESULTS = 1000;
export const BOOKING_DST_FOLD_OFFSETS = ["+01:00", "+02:00"] as const;

/**
 * ESZ-151 — the administrator's booking-time rules, stored as one
 * `system_settings` row (`{"minimumLeadMinutes", "preferredFinishLocal",
 * "maxOverrunMinutes"}`) and read by every slot computation.
 *
 * The bounds are technical, not editorial. A lead longer than the public
 * horizon could never be satisfied, so the horizon is its ceiling; an overrun
 * longer than the longest possible appointment can never matter, so the
 * duration ceiling is its ceiling. The defaults are the pre-ESZ-151 behaviour:
 * no lead, no preferred finish, no overrun — nothing narrows until Esther
 * configures it.
 */
export const BOOKING_TIME_RULES_SETTING_KEY = "booking.time_rules";
export const BOOKING_MINIMUM_LEAD_MAX_MINUTES = BOOKING_SLOT_MAX_HORIZON_DAYS * 24 * 60;
export const BOOKING_MAX_OVERRUN_MAX_MINUTES = BOOKING_SERVICE_DURATION_MAX_MINUTES;
export const BOOKING_TIME_RULES_DEFAULTS = {
  minimumLeadMinutes: 0,
  preferredFinishLocal: null,
  maxOverrunMinutes: 0,
} as const;

/**
 * ESZ-152 — planning constraints: the four kinds Esther can place on the
 * calendar and the two enforcements they resolve to. The enforcement is a
 * property of the kind — a pause is the only flexible one — and is stored and
 * exposed explicitly so a flexible preference and a strict blocker can never
 * be confused by a reader that does not know the kinds.
 */
export const planningConstraintKinds = ["pause", "unavailability", "closure", "leave"] as const;
export const planningConstraintEnforcements = ["flexible", "strict"] as const;
export const PLANNING_CONSTRAINT_ENFORCEMENT_BY_KIND = {
  pause: "flexible",
  unavailability: "strict",
  closure: "strict",
  leave: "strict",
} as const;
/** The longest inclusive date range one closure or leave may span. */
export const PLANNING_CONSTRAINT_MAX_DAYS = 400;

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
  /**
   * ESZ-164 — the one informational e-mail sent when a restriction of
   * processing is lifted. Not time-sensitive: it is meaningful whenever it
   * arrives, and there is never more than one per lift.
   */
  "processing_restriction_lifted",
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
/** ESZ-161 — the single customer reminder is due this many hours before the appointment starts. */
export const NOTIFICATION_REMINDER_LEAD_HOURS = 24;

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

/**
 * ESZ-164 — the code the runner writes when it releases a claimed job because
 * its booking is under a restriction of processing. The job goes back to
 * `pending` (the claim is refunded: no transport was called, so no attempt
 * was made) and stays unclaimable until the restriction is lifted. A code,
 * never a message, like every other reserved code.
 */
export const NOTIFICATION_PROCESSING_RESTRICTED_CODE = "processing_restricted";

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
  NOTIFICATION_PROCESSING_RESTRICTED_CODE,
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
  /**
   * ESZ-161 — the V1 reminder policy, frozen so the producer, the channel
   * setting and the GDPR framing cannot drift apart. One reminder, e-mail
   * first; SMS only ever rides on the existing `notifications.channels`
   * setting and on a phone the customer chose to give.
   */
  reminders: {
    count: 1,
    leadHours: NOTIFICATION_REMINDER_LEAD_HOURS,
    email:
      "Every confirmed booking schedules exactly one e-mail reminder due leadHours before its start, under the catch-up rules (stale window, move rescheduling) above.",
    sms:
      "An SMS reminder is scheduled only when both hold at the transition that schedules it: the booking stores a customer phone, and the sms channel is enabled in the existing notifications.channels setting (off by default, never enabled by the application itself). Otherwise no SMS row is written at all — a booking without a phone has no SMS recipient, and a disabled channel means the notification was never intended. There is no parallel SMS setting and no SMS provider in V1: enabling the channel without a registered transport stops the runner before it claims anything.",
    phone:
      "The customer phone is optional and is used only for transactional messages about the appointment; it is never a prerequisite of booking and never used for anything else.",
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
  /**
   * ESZ-164 — restriction of processing (GDPR art. 18) as the queue sees
   * it. The authoritative state is `bookings.processing_restricted_at`, not
   * a queue status: a restricted booking's jobs are simply not claimable,
   * and lifting the restriction makes them claimable again with no replay
   * of anything whose window elapsed in between.
   */
  restriction: {
    state: "bookings.processing_restricted_at",
    claim:
      "The claim scan joins bookings and selects only jobs whose booking carries no processing_restricted_at. A pending job of a restricted booking — any channel, any type — is never claimed; it stays pending, unchanged, for as long as the restriction lasts.",
    deliveryTimeRecheck:
      "A job that was already claimed when the restriction was written is re-checked by the runner before the transport boundary: when its booking is restricted at that instant the runner releases it — status back to pending, lease cleared, the attempt the claim charged refunded, last_error_code processing_restricted — and delivers nothing. The re-check happens after the stale-reminder and lifecycle-relevance checks, so a stale reminder is still terminally skipped first.",
    noReplay:
      "The stale-reminder sweep and the claim-time isStale check run unchanged while a booking is restricted: a reminder whose grace window closes during the restriction becomes terminally skipped (reminder_window_expired) and is never delivered after the lift. Only a reminder whose window is still open when the restriction is lifted resumes, because it simply becomes claimable again.",
    lift:
      "Lifting is an explicit, confirmed admin action from the GDPR request detail. It clears processing_restricted_at and, in the same transaction, schedules exactly one processing_restriction_lifted e-mail job due immediately (idempotent on the booking's reference and the lift instant). An anonymised booking is never restricted, never lifted and never notified.",
    liftJobType: "processing_restriction_lifted",
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
    "weekly availability replacement, including the ESZ-151 booking-time rules it may carry",
    "date exception open, close and remove",
    "planning constraint create, update and remove (ESZ-152)",
    "service provisioning or an admin service mutation (create, update, archive, restore) that changes is_active, duration, buffer-before or buffer-after",
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
 * ESZ-142 — the immutable consent-notice catalog (historical since ESZ-161).
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
 * stable machine id with the exact user-visible French text of one notice.
 * The booking request sent only the id — never notice text, which the server
 * refused to trust by never accepting it.
 *
 * ## Immutability policy
 *
 * Entries are append-only and never edited or removed: a stored id keeps
 * naming exactly the text the visitor accepted, forever. Bookings created
 * before the catalog (ESZ-142) carry no notice id at all and are never
 * retro-attributed one (their stored `consent_at_utc` is all the provenance
 * that exists).
 *
 * ## ESZ-161 — consent is no longer the basis of a booking
 *
 * Since ESZ-161 the public form displays no consent checkbox and the request
 * carries no `consentAccepted` / `consentNoticeId`: a booking rests on the
 * execution of the requested service and the pre-contractual steps the
 * visitor asks for, and the proof of information is the *privacy notice*
 * catalog below ({@link bookingPrivacyNoticePolicy}). This consent catalog is
 * kept exactly as it was so the bookings made under it keep meaning what they
 * meant: `consent_at_utc` and `consent_notice_id` are preserved byte for byte,
 * never rewritten, and no new booking is ever given a consent instant or a
 * consent notice id. {@link BOOKING_CONSENT_CURRENT_NOTICE_ID} therefore
 * names the last consent notice the frontend ever displayed, not one it
 * displays today.
 *
 * The id is a machine token (bounded ASCII, `BOOKING_CONSENT_NOTICE_ID_PATTERN`)
 * and the notice text itself is not customer PII, so ESZ-140 anonymization
 * preserves both the consent instant and the notice id of an erased booking.
 */

/**
 * The ids ever issued, in issuance order. This tuple is the catalog's spine:
 * {@link bookingConsentNoticeTexts} is a `Record` over it, so adding an id
 * without its text (or vice versa) is a compile error. Frozen since ESZ-161:
 * no consent notice is displayed or accepted for a new booking any more.
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

/** The last consent notice the frontend displayed (ESZ-142 → ESZ-161); none is displayed today. */
export const BOOKING_CONSENT_CURRENT_NOTICE_ID: BookingConsentNoticeId = "booking-consent-v1";

/** The last consent notice's full entry: `id` as it was stored, `text` as it was shown. */
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
  status: "historical",
  requestShape:
    "Historical (ESZ-142 → ESZ-161): POST /api/bookings used to require consentNoticeId (one of entries[].id) plus consentAccepted: true. Since ESZ-161 neither field exists on the wire — a request carrying one is refused by the strict schema — and new bookings carry a privacy notice id instead (privacyNotices).",
  acceptance:
    "A stored id is evidence of the text that was accepted at the time. Entries are never removed, so a historical stored id keeps naming its exact wording and is never remapped; no new booking is issued a consent notice id.",
  legacy:
    "Bookings created before the catalog (ESZ-142) have no consent_notice_id: their stored consent_at_utc is the only provenance that exists, and no migration or reader invents one for them. Bookings created between ESZ-142 and ESZ-161 store the non-null id of the notice they displayed beside their consent_at_utc. Bookings created since ESZ-161 store NULL for both — never a fabricated consent instant.",
  future:
    "The catalog is closed: no entry is ever added, edited or removed, and the database column and retention anonymization preserve every stored id byte for byte.",
  retention:
    "The notice id is operational evidence of which text was accepted, not customer PII: ESZ-140 erasure replaces the customer fields and leaves consent_at_utc and consent_notice_id untouched.",
} as const;

/**
 * ESZ-161 — the immutable privacy-information notice catalog.
 *
 * ## Legal basis
 *
 * A booking is the customer asking for an appointment: the personal data it
 * carries is processed to execute that service and to take the
 * pre-contractual steps the customer requests (GDPR art. 6(1)(b)), not under
 * consent. A consent checkbox would therefore be the wrong instrument — it
 * suggests a right to withdraw that does not exist for data the contract
 * needs — so the form shows *information* instead: who the controller is, on
 * what basis and for how long the data is kept, who receives it, which rights
 * the customer has and where to exercise them.
 *
 * ## Why the notice is a contract value
 *
 * Exactly the ESZ-142 discipline: each entry pairs a stable machine id with
 * the exact user-visible French text of one notice, the request carries only
 * the id of the notice the form displayed (never notice text), and the
 * server accepts only an id this catalog contains. A booking therefore proves
 * *which* privacy information its customer was shown, and a wording change
 * is a new entry plus a moved current pointer — never an edit of an old one.
 *
 * ## What the notice may and may not contain
 *
 * Only repository-owned facts: the trade name and contact address the public
 * site already publishes, the ESZ-140 retention policy, the technical
 * recipient categories the architecture already names. No registration
 * number, no postal address, no data-protection officer and no production
 * fact ESZ-165 owns is invented here; the full legal page is ESZ-165's, and
 * the notice only points at its frozen destination.
 */

/**
 * The ids ever issued, in issuance order — the catalog's spine, exactly as
 * for the consent catalog.
 */
export const bookingPrivacyNoticeIds = ["booking-privacy-v1"] as const;

export type BookingPrivacyNoticeId = (typeof bookingPrivacyNoticeIds)[number];

/** Bounded-ASCII shape every privacy notice id must satisfy (mirrored by migration 0020's CHECK). */
export const BOOKING_PRIVACY_NOTICE_ID_PATTERN = "^[a-z0-9][a-z0-9_-]{0,63}$";

/**
 * The frozen destination of the privacy policy the notice links to. ESZ-165
 * owns the page itself; the path is frozen here so the notice text and the
 * future page cannot drift apart.
 */
export const BOOKING_PRIVACY_POLICY_PATH = "/confidentialite";

/**
 * One notice, as the form renders it: short labelled statements rather than
 * one paragraph, so a visitor can actually read them. `text` below is the
 * exact concatenation and is what the catalog freezes.
 */
export interface BookingPrivacyNoticeContent {
  readonly controller: string;
  readonly legalBasis: string;
  readonly retention: string;
  readonly recipients: string;
  readonly rights: string;
  readonly contact: string;
  readonly privacyPolicy: { readonly label: string; readonly href: string };
}

export const bookingPrivacyNoticeContents: Record<BookingPrivacyNoticeId, BookingPrivacyNoticeContent> = {
  "booking-privacy-v1": {
    controller: "Responsable du traitement : Eszter Gyori.",
    legalBasis:
      "Vos coordonnées servent uniquement à organiser le rendez-vous que vous demandez (exécution de la prestation et démarches précontractuelles). Aucun consentement n’est requis pour cela.",
    retention:
      "Elles sont conservées jusqu’à 90 jours après la fin ou l’annulation du rendez-vous, puis anonymisées.",
    recipients:
      "Elles ne sont transmises qu’aux prestataires techniques nécessaires (hébergement, envoi des e-mails).",
    rights:
      "Vous disposez d’un droit d’accès, de rectification, d’effacement, de limitation et de portabilité, et pouvez saisir la CNIL.",
    contact: "Pour l’exercer : contact@esztergyori.com.",
    privacyPolicy: { label: "Politique de confidentialité", href: BOOKING_PRIVACY_POLICY_PATH },
  },
};

/** The exact user-visible text of each notice: its statements in display order, space-joined. */
export const bookingPrivacyNoticeTexts: Record<BookingPrivacyNoticeId, string> = Object.fromEntries(
  bookingPrivacyNoticeIds.map((id) => {
    const content = bookingPrivacyNoticeContents[id];
    return [
      id,
      [
        content.controller,
        content.legalBasis,
        content.retention,
        content.recipients,
        content.rights,
        content.contact,
        `${content.privacyPolicy.label} : ${content.privacyPolicy.href}`,
      ].join(" "),
    ];
  }),
) as Record<BookingPrivacyNoticeId, string>;

/** The one notice the shipped frontend displays and sends today. */
export const BOOKING_PRIVACY_CURRENT_NOTICE_ID: BookingPrivacyNoticeId = "booking-privacy-v1";

/** The current notice's full entry: `id` for the request, `content` for the form. */
export const bookingPrivacyCurrentNotice: {
  id: BookingPrivacyNoticeId;
  content: BookingPrivacyNoticeContent;
  text: string;
} = {
  id: BOOKING_PRIVACY_CURRENT_NOTICE_ID,
  content: bookingPrivacyNoticeContents[BOOKING_PRIVACY_CURRENT_NOTICE_ID],
  text: bookingPrivacyNoticeTexts[BOOKING_PRIVACY_CURRENT_NOTICE_ID],
};

export const bookingPrivacyNoticePolicy = {
  entries: bookingPrivacyNoticeIds.map((id) => ({
    id,
    legalBasis: "contract",
    text: bookingPrivacyNoticeTexts[id],
  })),
  idPattern: BOOKING_PRIVACY_NOTICE_ID_PATTERN,
  currentId: BOOKING_PRIVACY_CURRENT_NOTICE_ID,
  privacyPolicyPath: BOOKING_PRIVACY_POLICY_PATH,
  legalBasis:
    "Execution of the requested service and pre-contractual steps taken at the customer's request. A booking is never based on consent: the request carries no acceptance boolean, the form shows no checkbox, and no consent instant is ever fabricated for a booking made since ESZ-161.",
  requestShape:
    "POST /api/bookings requires privacyNoticeId (one of entries[].id, structurally bounded by the id pattern): the id of the notice the form displayed. The request never carries notice text and the server never accepts any; consentAccepted and consentNoticeId are not fields of the request and are refused by the strict schema.",
  acceptance:
    "An id is accepted exactly when this catalog contains it. Entries are never removed, so a stored id keeps naming its exact wording; moving currentId changes what new clients send, not what old ids mean.",
  persistence:
    "A new booking stores the non-null id of the notice it displayed (bookings.privacy_notice_id) and the instant it was presented (bookings.privacy_notice_presented_at_utc, the creation instant). Both are additive columns beside the ESZ-142 consent columns, which stay NULL for it. Every booking therefore carries exactly one basis evidence: a consent instant (before ESZ-161) or a privacy notice presentation (since).",
  minimisation:
    "The form collects a name, an e-mail, an optional phone used only for transactional messages about the appointment, and an optional free text about the appointment that explicitly warns against entering health, medical or other sensitive data.",
  future:
    "Changing the wording appends a new id and text and moves currentId. Old entries and every stored id stay immutable; the database column and retention anonymization preserve the stored id byte for byte.",
  retention:
    "The notice id and its presentation instant are operational evidence, not customer PII: ESZ-140 erasure replaces the customer fields and leaves them untouched.",
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
    "privacy notice id and presentation instant (ESZ-161: which privacy information the customer was shown)",
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


/**
 * ESZ-163 — the admin GDPR request register.
 *
 * The five V1 request types are frozen here and nowhere else: the wire enum,
 * the database CHECK and the back-office labels all derive from this list.
 * Opposition is deliberately absent — V1 does not offer it — and adding a
 * type is a domain version bump, not an edit.
 */
export const privacyRequestTypes = [
  "access",
  "rectification",
  "erasure",
  "restriction",
  "portability",
] as const;
export type PrivacyRequestType = (typeof privacyRequestTypes)[number];

/**
 * The automatic lifecycle. There is no free status selector anywhere: a
 * record is `received` when it is created, becomes `in_progress` when the
 * execution of the right starts (ESZ-164) and `closed` only when that action
 * completes, which sets the closure instant in the same write.
 */
export const privacyRequestStatuses = ["received", "in_progress", "closed"] as const;
export type PrivacyRequestStatus = (typeof privacyRequestStatuses)[number];
export const PRIVACY_REQUEST_INITIAL_STATUS: PrivacyRequestStatus = "received";
export const privacyRequestStatusTransitions = {
  received: ["in_progress"],
  in_progress: ["closed"],
  closed: [],
} as const satisfies Record<PrivacyRequestStatus, readonly PrivacyRequestStatus[]>;

/** The answer is due one calendar month after the reception date. */
export const PRIVACY_REQUEST_DEADLINE_MONTHS = 1;
/** A closed record is kept three years after its closure, then purged. */
export const PRIVACY_REQUEST_CLOSED_RETENTION_YEARS = 3;
/** One page of an e-mail scope search; completeness is always on the wire. */
export const PRIVACY_REQUEST_SEARCH_PAGE_SIZE = 20;
/** One page of the register's history. */
export const PRIVACY_REQUEST_HISTORY_PAGE_SIZE = 50;
/** The most booking references one recorded request may name. */
export const PRIVACY_REQUEST_MAX_BOOKING_REFERENCES = 50;

export const privacyRequestPolicy = {
  types: privacyRequestTypes,
  statuses: {
    values: privacyRequestStatuses,
    initial: PRIVACY_REQUEST_INITIAL_STATUS,
    transitions: privacyRequestStatusTransitions,
    rule:
      "Statuses are automatic, never chosen. Creation stores received; ESZ-164 moves a record to in_progress when the execution of the right starts and to closed only when the action completes, writing closed_at_utc atomically in the same statement. A record never goes backwards and closed is terminal.",
  },
  deadline: {
    months: PRIVACY_REQUEST_DEADLINE_MONTHS,
    rule:
      "deadlineDate is derived from receivedDate: the same day of the month one calendar month later, clamped to the last day of that month when the day does not exist (2026-01-31 → 2026-02-28). It is stored beside the reception date so the register can be read without recomputing it, and it never moves after creation.",
  },
  register: {
    stored: [
      "internal id (never shown to a requester)",
      "request type (one of types)",
      "reception date (editable before creation, defaulting to today)",
      "status and closure instant",
      "the explicitly selected booking references, in the order they were selected",
      "creation and update instants",
    ],
    neverStored: [
      "the requester's e-mail address",
      "the free-form message of the request",
      "any identity document",
      "any copy of booking customer data (name, e-mail, phone, note)",
    ],
    minimisation:
      "The register names bookings by reference only. Everything about the customer stays in the booking rows it already lives in, under ESZ-140 retention; a purge of the register never touches a booking and an erasure of a booking never touches the register.",
  },
  scope: {
    identification:
      "The requester is identified by a public booking reference (current XXXX-XXXX or legacy bk_ shape, exactly one booking) or by an e-mail address (every live booking whose stored e-mail matches, case-insensitively, one bounded page at a time with hasMore and a typed continuation cursor so a match is never silently dropped).",
    erasedBookings:
      "An e-mail search never matches an erased booking: rows carrying customer_data_erased_at are excluded before the e-mail is compared, so the frozen placeholder address can never reconnect anonymised bookings to one another or to a requester.",
    explicitSelection:
      "Recording a request stores exactly the references the administrator ticked in the scope review. A shared e-mail never implies every booking: the search lists matches, the administrator selects, and an empty selection is recorded only after an explicit confirmation that no booking is concerned.",
    validation:
      "Every selected reference must resolve to a stored, non-erased booking at record time (404 NOT_FOUND otherwise); duplicates are refused and the list is bounded at maxBookingReferences.",
    searchPageSize: PRIVACY_REQUEST_SEARCH_PAGE_SIZE,
    maxBookingReferences: PRIVACY_REQUEST_MAX_BOOKING_REFERENCES,
  },
  history: {
    pageSize: PRIVACY_REQUEST_HISTORY_PAGE_SIZE,
    ordering:
      "Newest first by internal id, the register's own monotonic key; the continuation cursor {id} names the last exposed record and the next page begins strictly before it.",
  },
  retention: {
    closedRetentionYears: PRIVACY_REQUEST_CLOSED_RETENTION_YEARS,
    rule:
      "A closed record is purged, with its selected references, once closed_at_utc is at least closedRetentionYears years in the past. received and in_progress records are never age-purged: an open request is evidence of an obligation, whatever its age.",
    path:
      "The purge runs inside the existing daily retention sweep (php bin/apply-booking-retention.php), after the booking erasure, and reports a count only.",
  },
  recordingIsNotExecution:
    "ESZ-163 records the reviewed scope and nothing else: no export, no rectification, no anonymisation, no restriction and no notification change happens when a request is recorded. Those actions are ESZ-164's, and they are what move a record through in_progress to closed.",
  /**
   * ESZ-164 — how each right is executed from a recorded request. Every
   * action operates on the request's stored booking links and on nothing
   * else, and the register keeps holding references only: no export body,
   * no customer value and no free text is ever written to it.
   */
  execution: {
    scope:
      "An action reads the request's stored booking references and acts on exactly those bookings. A reference that has been anonymised since the request was recorded is listed as anonymised and is never rectified, restricted, notified or reconnected to a former identity; its former data is not reconstructed from history, backups or notification evidence.",
    access: {
      representation: "html",
      rule:
        "One shared export engine builds one structured document per request — the held data of each selected non-anonymised booking (name, e-mail, phone, note), the appointment facts, the non-personal history events, the basis (execution of the requested service and pre-contractual steps; the privacy notice shown, or the historical consent instant), the purposes, the retention periods, the recipient categories, the source (the customer, through the public booking form) and the five V1 rights. The readable HTML representation renders that document; it is generated on request, returned in the response and never persisted.",
    },
    portability: {
      representation: "json",
      rule:
        "The same engine's document, as structured JSON (the machine-readable, commonly used format). The two representations are built from one document: a field cannot be present in one and absent from the other. Either representation may be produced for an access or a portability request; the request type only sets the default.",
    },
    rectification: {
      rule:
        "Applied only to explicitly selected, non-anonymised bookings, through the same customer-update authority as the calendar's contact edit: the row lock, the expectedUpdatedAt comparison, the field validation and the customer_updated history event are the existing ones. All selected bookings of one rectification are written in one transaction with the request's closure, or none is. There is no second customer UPDATE path.",
    },
    erasure: {
      rule:
        "Early anonymisation of the selected bookings, future or past, confirmed or cancelled: the ESZ-140 erasure primitive — the same transaction that the scheduled retention sweep uses — writes the frozen placeholders, clears phone, note and cancellation reason, sets customer_data_erased_at and retires every pending or processing notification job of the booking with customer_data_erased. The appointment, its service, its instants, its state, its public reference and its non-personal history are kept. It is irreversible, requires an explicit destructive confirmation, and an already anonymised booking is left untouched.",
      historyEvent: "customer_data_erased",
      adminLabel: "Cliente anonymisée — rendez-vous maintenu",
    },
    restriction: {
      rule:
        "Sets bookings.processing_restricted_at on the selected non-anonymised bookings and appends a processing_restricted history event. The booking and its data are kept; the calendar shows the booking as Traitement limité; no reminder e-mail or SMS is delivered while the state is set (notifications.restriction). The state is authoritative and reversible, never frontend-only.",
      lift:
        "Lifting requires an explicit confirmation from the request's history/detail view. It clears processing_restricted_at, appends processing_restriction_lifted and schedules one immediate informational e-mail per lifted booking, all in one transaction. A reminder whose window elapsed during the restriction is never replayed; only still-future reminders resume.",
      adminLabel: "Traitement limité",
      historyEvents: ["processing_restricted", "processing_restriction_lifted"],
    },
    lifecycle:
      "An export moves a received request through in_progress to closed in one write once the document is built, and a closed access or portability request may be exported again (it changes nothing). Rectification, erasure and restriction move the request to closed in the same transaction as their booking writes, so a failed action leaves the request open and the bookings untouched. A lift acts on a request of type restriction whatever its status and changes the request's status no further.",
  },
} as const;

export const bookingDomainContract = {
  version: BOOKING_DOMAIN_VERSION,
  scope: "Package 4.1/4.2 booking domain and dynamic slot computation; no booking HTTP API.",
  services: {
    /**
     * ESZ-149 — the catalog is the authority. There is no frozen key list:
     * `booking_services.service_key` is the complete set of keys and the
     * wire admits any value of the frozen shape, which the domain then
     * resolves against that table.
     */
    keyAuthority: "booking_services.service_key",
    keyPattern: BOOKING_SERVICE_KEY_PATTERN,
    labelMaxLength: BOOKING_SERVICE_LABEL_MAX_LENGTH,
    descriptionMaxLength: BOOKING_SERVICE_DESCRIPTION_MAX_LENGTH,
    /**
     * ESZ-149 — where the name, description and image of a service come
     * from. The catalog row is the single authority for all three: the
     * administrator edits them in the back-office, the public reservation
     * flow reads them from the catalog and never matches a service against
     * the fixed `SiteContent.services.items` again. The image is one
     * reference to a managed media asset (`MEDIA_PUBLIC_PATH_PATTERN`, or
     * null): the same stored bytes serve the admin list thumbnail, the edit
     * form and the public reservation page, and a referenced asset cannot be
     * deleted from the media library.
     */
    catalogAuthority:
      "booking_services owns the name (booking_label), description and one managed image reference of every reservable service. The public reservation flow consumes this catalog; SiteContent.services stays the marketing copy of the home page and is not a reservation authority.",
    keyDerivation:
      "A new service's key is derived server-side from its name (lowercase ASCII slug matching keyPattern, de-duplicated with a numeric suffix) and is immutable afterwards.",
    archive:
      "Archiving sets is_active = 0 and nothing else: the row, its key and every booking that references it survive, the service leaves public discovery and can no longer be booked, and it can be restored. No service row is ever hard-deleted.",
    durationMinutes: {
      min: BOOKING_SERVICE_DURATION_MIN_MINUTES,
      max: BOOKING_SERVICE_DURATION_MAX_MINUTES,
    },
    bufferMinutes: { min: 0, max: BOOKING_SERVICE_BUFFER_MAX_MINUTES },
    provisioning:
      "Explicit, repeat-safe operator action or an authenticated admin mutation. Migrations and application boot seed no service rows; the operator CLI seeds a new row's editorial facts from the published SiteContent item of the same key when one exists and never overwrites an existing row's admin-owned name, description or image.",
    futureBookabilityOnly:
      "Activation, archival and duration changes affect future bookability only: an existing booking keeps its stored service key, start and end instants.",
    /**
     * ESZ-150 — several services in one appointment. The rules are stated
     * once here; PHP reads the numbers from the artifact and restates none
     * of them.
     */
    combinations: {
      keyAuthority: "booking_service_combinations.combination_key",
      keyPattern: BOOKING_SERVICE_COMBINATION_KEY_PATTERN,
      keyDerivation:
        "The member service keys sorted bytewise and joined with '+'. Membership is canonical: the same set of keys in any order names the same combination. Labels, descriptions and images take no part in the identity.",
      maxPerAppointment: {
        min: 1,
        max: BOOKING_MAX_SERVICES_PER_APPOINTMENT_LIMIT,
        default: BOOKING_MAX_SERVICES_PER_APPOINTMENT_DEFAULT,
        settingKey: BOOKING_MAX_SERVICES_SETTING_KEY,
        rule:
          "The administrator's configured maximum number of services per appointment. Absent setting row means the default. Public discovery advertises it; availability and creation refuse a selection larger than it, and a persisted combination larger than it stays stored but is not bookable while the maximum is lower.",
      },
      proposedDuration:
        "Advisory only: the plain sum of the current component durations, computed at read time with no weighting or percentage heuristic. It is shown to the administrator beside the validated duration and is never used to compute a slot.",
      validatedDuration:
        "The duration the administrator explicitly persisted for the combination, within services.durationMinutes. It alone shapes availability and creation for that combination. A later change to a component's duration updates the proposal and never rewrites the validated duration; only a new explicit validation does.",
      buffers:
        "A combination's buffers are snapshotted at validation time as the largest before-buffer and largest after-buffer among its members.",
      bookability:
        "A selection of two or more services is bookable only when a combination row with exactly that canonical membership exists, is active (not disabled), has a validated duration, every member service is active, and the member count is within the configured maximum. Anything else fails closed with 400 VALIDATION_FAILED; there is no implicit combination.",
      archive:
        "Disabling a combination or archiving one of its members removes it from public discovery and from bookability for new reservations only. The row, its key and every booking that references it survive; restoring the member or enabling the combination brings it back. No combination row is ever hard-deleted.",
      existingBookings:
        "A booking stores its combination key beside its first (canonical) service key, its own start and end. Bookings created before this version carry a null combination key and are never migrated, recomputed or re-attributed.",
      candidatesListedMax: BOOKING_SERVICE_COMBINATION_CANDIDATES_MAX,
    },
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
    /**
     * ESZ-151 — the configurable booking-time rules. Stated once here; PHP
     * reads the key and the bounds from the artifact and React reproduces
     * none of the semantics.
     */
    bookingTimeRules: {
      settingKey: BOOKING_TIME_RULES_SETTING_KEY,
      defaults: BOOKING_TIME_RULES_DEFAULTS,
      minimumLeadMinutes: { min: 0, max: BOOKING_MINIMUM_LEAD_MAX_MINUTES },
      maxOverrunMinutes: { min: 0, max: BOOKING_MAX_OVERRUN_MAX_MINUTES },
      lead:
        "No slot is offered, and no slot passes transactional revalidation, whose start is earlier than now + minimumLeadMinutes; with the default lead of 0 this still refuses every start in the past.",
      finish:
        "preferredFinishLocal is the usual finish boundary, a local Europe/Paris wall time or null. Within one effective window the boundary is the earlier of the window's end and preferredFinishLocal: no appointment starts at or after it, and the appointment's own end (without after-buffer) may run past it by at most maxOverrunMinutes, never past the window's end. With a null preferredFinishLocal the window's end is the boundary and maxOverrunMinutes has no effect.",
      windowsAuthoritative:
        "Weekly rules and date exceptions stay authoritative. The rules only narrow an effective window; a shorter exceptional window is never widened by the general finish or overrun setting, and the resource interval [start-bufferBefore, start+duration+bufferAfter) must still fit inside the window.",
      offerDuration:
        "The end an appointment is judged by is start + the real offer duration: the service's duration or the persisted validated duration of an ESZ-150 combination.",
      persistence:
        "One system_settings row under the availability revision: it is replaced through the weekly availability PUT, under the ESZ-146 serialization boundary, and slot reads and transactional revalidation read the same stored row. Changing it never moves, shortens or recomputes an existing booking.",
    },
    /**
     * ESZ-152 — planning constraints. Stated once here; PHP reads the kinds,
     * the enforcement map and the span bound from the artifact, and React
     * reproduces none of the blocking semantics.
     */
    planningConstraints: {
      kinds: planningConstraintKinds,
      enforcements: planningConstraintEnforcements,
      enforcementByKind: PLANNING_CONSTRAINT_ENFORCEMENT_BY_KIND,
      maxDays: PLANNING_CONSTRAINT_MAX_DAYS,
      shape:
        "pause and unavailability are one local date with a start/end wall-time window (foldUtcOffset only on the autumn fall-back date); closure and leave are an inclusive local date range with no times. startDate equals endDate for timed kinds; endDate is never before startDate; a range longer than maxDays is refused.",
      flexible:
        "A pause is a planning preference. It is persisted and shown on the calendar but it never removes a public slot, never fails transactional revalidation and never warns about the appointments it overlaps.",
      strict:
        "unavailability, closure and leave block new reservations. Their UTC intervals — the timed window, or local midnight to local midnight of the day after endDate — feed the same slot computation and the same transactional revalidation booking create and move run, as blocking intervals beside the occupied ones: no resource interval [start-bufferBefore, start+duration+bufferAfter) may overlap them.",
      existingBookings:
        "A strict constraint may overlap confirmed appointments. The write is allowed, the response lists those appointments as conflicts so the operator is warned, and none of them is moved, shortened, cancelled or otherwise altered. Editing or removing a constraint changes future bookability only.",
      persistence:
        "Additive availability_constraints rows beside availability_exceptions, which keep their one-replacing-exception-per-date meaning. Every write takes the ESZ-146 serialization boundary and the availability revision; reads are bounded to the requested local date window.",
      dst: "Timed boundaries are converted with the Europe/Paris IANA rules at store time: a spring-forward gap is refused and an autumn fall-back overlap requires the explicit fold offset.",
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
  privacyNotices: bookingPrivacyNoticePolicy,
  publicReferences: bookingPublicReferencePolicy,
  customerDataRetention: customerDataRetentionPolicy,
  privacyRequests: privacyRequestPolicy,
} as const;
