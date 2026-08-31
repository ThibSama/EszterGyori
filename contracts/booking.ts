import { serviceItemIds } from "./site-content.js";

/** Package 4.1/4.2/7.1 language-neutral booking-domain contract. */
export const BOOKING_DOMAIN_VERSION = 3;

/**
 * The business operates in metropolitan France. Rules are authored as local
 * civil time in this IANA zone; stored appointment instants are UTC.
 */
export const BOOKING_TIME_ZONE = "Europe/Paris";

/** Reuse the CMS's stable business identifiers; never copy editorial titles. */
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
] as const;
export type NotificationStatus = (typeof notificationStatuses)[number];

export const NOTIFICATION_INITIAL_STATUS: NotificationStatus = "pending";

/** `sent`, `failed` and `skipped` are terminal: nothing leaves them, ever. */
export const notificationStatusTransitions = {
  pending: ["processing", "skipped"],
  processing: ["sent", "pending", "failed", "skipped"],
  sent: [],
  failed: [],
  skipped: [],
} as const satisfies Record<NotificationStatus, readonly NotificationStatus[]>;

export const notificationTerminalStatuses = ["sent", "failed", "skipped"] as const;

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

/** Reserved codes the runner itself writes. Transports may add their own. */
export const notificationReservedErrorCodes = [
  "lease_expired",
  "lease_lost",
  "reminder_window_expired",
  "reminder_superseded",
  "booking_cancelled",
  "channel_disabled",
  "transport_transient",
  "transport_permanent",
  "attempts_exhausted",
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
  },
} as const;

export const bookingDomainContract = {
  version: BOOKING_DOMAIN_VERSION,
  scope: "Package 4.1/4.2 booking domain and dynamic slot computation; no booking HTTP API.",
  services: {
    keys: bookableServiceKeys,
    source: "SiteContent.services.items[].id",
    keyPattern: BOOKING_SERVICE_KEY_PATTERN,
    labelMaxLength: BOOKING_SERVICE_LABEL_MAX_LENGTH,
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
  notifications: notificationPolicy,
} as const;
