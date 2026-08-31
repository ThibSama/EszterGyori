-- ESZ-070 — durable notification jobs.
--
-- The queue is a table because the alternatives are worse on this host: there is
-- no daemon to hold an in-memory queue, no broker to run one, and one cron tick
-- per minute to drain it. A row that survives the death of the process that
-- claimed it is the whole point.
--
-- Enums, transitions and indexes are frozen in
-- `contracts/generated/booking-domain.json` under `notifications`; the CHECK
-- constraints below are the same sets restated where the database can enforce
-- them. `NotificationPolicy` reads the artifact and `NotificationSchemaTest`
-- proves the two agree, so neither can drift alone.
--
-- Repeat-safe per the Migrator rule: one guarded CREATE TABLE and nothing else.

CREATE TABLE IF NOT EXISTS notification_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Caller-supplied identity. Unique across the whole table so that a repeated
  -- enqueue resolves to the same logical job instead of creating a second one;
  -- see `uq_notification_jobs_idempotency` below, which is what makes the
  -- INSERT ... ON DUPLICATE KEY UPDATE in NotificationJobRepository::enqueue()
  -- a reuse rather than a race.
  idempotency_key VARCHAR(128) COLLATE ascii_bin NOT NULL,

  booking_id BIGINT UNSIGNED NOT NULL,
  channel VARCHAR(16) COLLATE ascii_bin NOT NULL,
  job_type VARCHAR(32) COLLATE ascii_bin NOT NULL,

  -- When the notification became meaningful, and when the runner may next try.
  -- They differ: due_at_utc is a fact about the appointment and never moves,
  -- next_attempt_at_utc is scheduling state and moves with every backoff. Only
  -- the first can decide whether a reminder is too late to be worth sending.
  due_at_utc DATETIME(3) NOT NULL,
  next_attempt_at_utc DATETIME(3) NOT NULL,

  status VARCHAR(16) COLLATE ascii_bin NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,

  -- A code, never a message. The CHECK below makes it structurally incapable of
  -- holding an address, a phone number or a fragment of a body.
  last_error_code VARCHAR(64) COLLATE ascii_bin NULL DEFAULT NULL,

  sent_at_utc DATETIME(3) NULL DEFAULT NULL,

  -- Durable lease. Columns rather than a process-local flag, because the failure
  -- being defended against is the process disappearing.
  lease_owner VARCHAR(64) COLLATE ascii_bin NULL DEFAULT NULL,
  lease_expires_at_utc DATETIME(3) NULL DEFAULT NULL,

  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  status_changed_at VARCHAR(24) NOT NULL,

  PRIMARY KEY (id),

  UNIQUE KEY uq_notification_jobs_idempotency (idempotency_key),

  -- The claim scan: pending rows whose next attempt is due, oldest first. `id`
  -- is in the key so the ORDER BY the runner uses is satisfied by the index and
  -- two runners walk candidates in the same order.
  KEY ix_notification_jobs_claim (status, next_attempt_at_utc, id),

  -- Lease recovery scans processing rows by expiry, which is a different
  -- selectivity from the claim scan and would otherwise be a table scan on a
  -- queue whose pending rows vastly outnumber its processing ones.
  KEY ix_notification_jobs_lease (status, lease_expires_at_utc),

  -- Stale-reminder sweeps and per-booking history reads.
  KEY ix_notification_jobs_due (job_type, status, due_at_utc),
  KEY ix_notification_jobs_booking (booking_id, id),

  -- ON DELETE RESTRICT, deliberately not CASCADE. This table is the record of
  -- what was sent to a customer; it must not evaporate with the appointment it
  -- describes. V1 never deletes a booking, so RESTRICT costs nothing today and
  -- refuses loudly on the day someone adds a delete path.
  CONSTRAINT fk_notification_jobs_booking
    FOREIGN KEY (booking_id) REFERENCES bookings (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,

  CONSTRAINT chk_notification_jobs_idempotency_key
    CHECK (idempotency_key REGEXP '^[a-z0-9][a-z0-9_.:-]{7,127}$'),
  CONSTRAINT chk_notification_jobs_channel
    CHECK (channel IN ('email', 'sms')),
  CONSTRAINT chk_notification_jobs_type
    CHECK (job_type IN (
      'booking_confirmation', 'booking_reminder', 'booking_cancellation', 'booking_moved'
    )),
  CONSTRAINT chk_notification_jobs_status
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'skipped')),

  -- A code or nothing. `^[a-z][a-z0-9_]{2,63}$` admits `transport_transient`
  -- and rejects `smtp: 550 no mailbox for cliente@example.test`.
  CONSTRAINT chk_notification_jobs_error_code
    CHECK (last_error_code IS NULL OR last_error_code REGEXP '^[a-z][a-z0-9_]{2,63}$'),

  -- `sent` is the only status that carries a delivery instant, and it always
  -- carries one. Anything else would let "was it delivered?" have two answers.
  CONSTRAINT chk_notification_jobs_sent
    CHECK (
      (status = 'sent' AND sent_at_utc IS NOT NULL)
      OR
      (status <> 'sent' AND sent_at_utc IS NULL)
    ),

  -- A lease exists exactly while the job is claimed. A `pending` row holding a
  -- lease owner would make recovery ambiguous; a `processing` row without one
  -- would be unrecoverable.
  CONSTRAINT chk_notification_jobs_lease
    CHECK (
      (status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at_utc IS NOT NULL)
      OR
      (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at_utc IS NULL)
    ),
  CONSTRAINT chk_notification_jobs_lease_owner
    CHECK (lease_owner IS NULL OR lease_owner REGEXP '^[a-z0-9][a-z0-9_.:-]{7,63}$'),

  -- Attempts are bounded by the frozen retry policy. The database says so too,
  -- so a bug in the runner cannot produce a row that claims a seventh attempt.
  CONSTRAINT chk_notification_jobs_attempts
    CHECK (attempts BETWEEN 0 AND 5),

  -- A claimed job has been attempted at least once: the claim is what increments
  -- the counter, which is why an abandoned lease costs an attempt.
  CONSTRAINT chk_notification_jobs_processing_attempted
    CHECK (status <> 'processing' OR attempts >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
