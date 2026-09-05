-- ESZ-131 — non-PII lifecycle identity on notification jobs.
--
-- A notification job used to know only *what* it was (type, channel, booking)
-- and *when* it was due, not *which booking lifecycle event* made it
-- meaningful. BookingLifecycle already supersedes pending reminders when a
-- booking moves or is cancelled, but nothing superseded the lifecycle jobs
-- themselves: a delayed or retried confirmation — or an older move — could
-- therefore survive a later move or cancellation and be delivered with facts
-- reloaded from the current booking row, under an event type that no longer
-- describes the appointment.
--
-- The fix freezes a lifecycle ordering the database already owns instead of
-- copying customer PII into the queue: `booking_history` is append-only with
-- monotonic ids, and every create/move/cancel appends exactly one event in the
-- same transaction as the job it makes meaningful. This migration records on
-- each lifecycle job the id of the booking_history event that spawned it:
--
--  1. `notification_jobs.lifecycle_event_id` — nullable BIGINT UNSIGNED, the
--     `booking_history.id` of the job's own lifecycle event. A pending
--     confirmation or move is then obsolete exactly when a later `moved` or
--     `cancelled` event exists for the same booking, and a claimed job can be
--     re-checked at delivery time against the same rule. Reminders carry no
--     marker (NULL): they are time-windowed, not lifecycle-versioned, and keep
--     their catch-up/stale/rescheduling rules untouched.
--
-- The value is an internal row id of an append-only audit table — not a
-- customer name, address, phone number or note — so no PII is added to the
-- queue and the notification log allowlist needs no new field.
--
-- Repeat-safe per the Migrator rule: MySQL commits implicitly around DDL, so a
-- migration that fails part-way must run again. The statement below is a guard
-- expressed as a prepared statement selected from `information_schema`, which
-- the Migrator's idempotence rule recognises as the guarded form this project
-- uses for conditional DDL. No statement contains a semicolon inside a literal.

-- 1. The lifecycle marker column. One guarded ADD COLUMN: re-running the
--    migration must be a no-op, not a duplicate-column failure.
SET @esz131_add_lifecycle_event = IF(
    EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'notification_jobs'
          AND column_name = 'lifecycle_event_id'
    ),
    'SET @esz131_noop = 0',
    'ALTER TABLE notification_jobs ADD COLUMN lifecycle_event_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER booking_id'
);
PREPARE esz131_s1 FROM @esz131_add_lifecycle_event;
EXECUTE esz131_s1;
DEALLOCATE PREPARE esz131_s1;
