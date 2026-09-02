-- ESZ-140 — booking customer-data retention.
--
-- The V1 retention policy is frozen in `contracts/generated/booking-domain.json`
-- under `customerDataRetention`; this migration is the same policy written
-- where the database can enforce it:
--
--  1. `bookings.customer_data_erased_at` — set once, atomically, by the
--     retention sweep (or by the restore reconciliation) on the same row whose
--     customer fields it anonymizes. NULL means the customer data is live.
--  2. `chk_bookings_customer_data_erasure` — an erased row may hold ONLY the
--     frozen placeholders: name and e-mail are required columns, so they carry
--     fixed non-PII values (never hashes), while phone, note and cancellation
--     reason are NULL. The constraint is what makes "an admin update cannot
--     reintroduce PII into an erased booking" a schema fact rather than a
--     review habit: any write that repopulates an erased row is refused by the
--     database itself.
--  3. `notification_jobs` gains the terminal `retired` status. Retention
--     retires every pending/processing job of an erased booking to `retired`
--     with the reserved code `customer_data_erased`, in the same transaction
--     as the erasure, so nothing that survives can ever deliver from the
--     erased row. Terminal jobs (sent/failed/skipped) are delivery evidence
--     and are never rewritten.
--
-- Repeat-safe per the Migrator rule: MySQL commits implicitly around DDL, so a
-- migration that fails part-way must run again. Every statement below is either
-- an `IF NOT EXISTS` form or a guard expressed as a prepared statement selected
-- from `information_schema`; each statement therefore begins with `SET`, which
-- the Migrator's idempotence rule recognises as the guarded form this project
-- uses for conditional DDL. No statement contains a semicolon inside a literal.

-- 1. The erasure marker. One guarded ADD COLUMN: re-running the migration must
--    be a no-op, not a duplicate-column failure.
SET @esz140_add_marker = IF(
    EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND column_name = 'customer_data_erased_at'
    ),
    'SET @esz140_noop = 0',
    'ALTER TABLE bookings ADD COLUMN customer_data_erased_at DATETIME(3) NULL DEFAULT NULL AFTER cancellation_reason'
);
PREPARE esz140_s1 FROM @esz140_add_marker;
EXECUTE esz140_s1;
DEALLOCATE PREPARE esz140_s1;

-- 2. The erasure invariant. Guarded so a re-run does not duplicate the
--    constraint. The placeholder values are the ones frozen in
--    `customerDataRetention.erasedFields` of booking-domain.json;
--    `RetentionSchemaTest` fails if the three ever disagree.
SET @esz140_add_erasure_check = IF(
    EXISTS(
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND constraint_type = 'CHECK' AND constraint_name = 'chk_bookings_customer_data_erasure'
    ),
    'SET @esz140_noop = 0',
    'ALTER TABLE bookings ADD CONSTRAINT chk_bookings_customer_data_erasure CHECK (
        customer_data_erased_at IS NULL
        OR (
            customer_name = ''Deleted customer''
            AND customer_email = ''erased@example.invalid''
            AND customer_phone IS NULL
            AND customer_note IS NULL
            AND cancellation_reason IS NULL
        )
    )'
);
PREPARE esz140_s2 FROM @esz140_add_erasure_check;
EXECUTE esz140_s2;
DEALLOCATE PREPARE esz140_s2;

-- 3. The `retired` notification status. The status set is frozen in
--    booking-domain.json under `notifications.statuses.values`; this replaces
--    the CHECK that restated the old set. Dropping is guarded (the constraint
--    may already have been replaced by a partially-applied run) and adding is
--    guarded (it may already exist).
SET @esz140_drop_status_check = IF(
    EXISTS(
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'notification_jobs'
          AND constraint_type = 'CHECK' AND constraint_name = 'chk_notification_jobs_status'
    ),
    'ALTER TABLE notification_jobs DROP CHECK chk_notification_jobs_status',
    'SET @esz140_noop = 0'
);
PREPARE esz140_s3 FROM @esz140_drop_status_check;
EXECUTE esz140_s3;
DEALLOCATE PREPARE esz140_s3;

SET @esz140_add_status_check = IF(
    EXISTS(
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'notification_jobs'
          AND constraint_type = 'CHECK' AND constraint_name = 'chk_notification_jobs_status'
    ),
    'SET @esz140_noop = 0',
    'ALTER TABLE notification_jobs ADD CONSTRAINT chk_notification_jobs_status CHECK (
        status IN (''pending'', ''processing'', ''sent'', ''failed'', ''skipped'', ''retired'')
    )'
);
PREPARE esz140_s4 FROM @esz140_add_status_check;
EXECUTE esz140_s4;
DEALLOCATE PREPARE esz140_s4;
