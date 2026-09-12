-- ESZ-164 — executing the GDPR data-subject rights.
--
-- Three additive facts, each the schema half of a rule the domain enforces:
--
--  1. `bookings.processing_restricted_at` — the authoritative, reversible
--     *restriction of processing* state (GDPR art. 18). NULL means the
--     booking is processed normally; an instant means the booking and its
--     data are kept but no notification may be delivered for it. It is set
--     and cleared only through the GDPR request centre, and the notification
--     claim scan joins on it (`booking-domain.json` notifications.restriction).
--     No index: the claim reads the booking by primary key, and the marker is
--     never a scan predicate of its own.
--  2. `chk_notification_jobs_type` gains `processing_restriction_lifted` — the
--     one informational e-mail a lift sends. The CHECK is dropped and re-added
--     under information_schema guards, the ESZ-140 pattern for the status
--     CHECK, so the migration is repeat-safe and a re-run changes nothing.
--  3. `chk_booking_history_event` gains the three non-personal trail events
--     the rights leave behind: `customer_data_erased`, `processing_restricted`
--     and `processing_restriction_lifted`. Their details never carry a
--     customer value — the history repository refuses anything but field
--     names, instants and the request id.
--
-- Nothing is rewritten: no UPDATE, no DELETE, and every statement is guarded.
-- No statement contains a semicolon inside a literal.

SET @esz164_add_restriction = IF(
    EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND column_name = 'processing_restricted_at'
    ),
    'SET @esz164_noop = 0',
    'ALTER TABLE bookings ADD COLUMN processing_restricted_at DATETIME(3) NULL DEFAULT NULL AFTER customer_data_erased_at'
);
PREPARE esz164_s1 FROM @esz164_add_restriction;
EXECUTE esz164_s1;
DEALLOCATE PREPARE esz164_s1;

SET @esz164_drop_type_check = IF(
    EXISTS(
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_schema = DATABASE()
          AND constraint_name = 'chk_notification_jobs_type'
          AND check_clause NOT LIKE '%processing_restriction_lifted%'
    ),
    'ALTER TABLE notification_jobs DROP CHECK chk_notification_jobs_type',
    'SET @esz164_noop = 0'
);
PREPARE esz164_s2 FROM @esz164_drop_type_check;
EXECUTE esz164_s2;
DEALLOCATE PREPARE esz164_s2;

SET @esz164_add_type_check = IF(
    EXISTS(
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'notification_jobs'
          AND constraint_type = 'CHECK' AND constraint_name = 'chk_notification_jobs_type'
    ),
    'SET @esz164_noop = 0',
    'ALTER TABLE notification_jobs ADD CONSTRAINT chk_notification_jobs_type CHECK (
        job_type IN (
            ''booking_confirmation'', ''booking_reminder'', ''booking_cancellation'', ''booking_moved'',
            ''processing_restriction_lifted''
        )
    )'
);
PREPARE esz164_s3 FROM @esz164_add_type_check;
EXECUTE esz164_s3;
DEALLOCATE PREPARE esz164_s3;

SET @esz164_drop_history_check = IF(
    EXISTS(
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_schema = DATABASE()
          AND constraint_name = 'chk_booking_history_event'
          AND check_clause NOT LIKE '%processing_restriction_lifted%'
    ),
    'ALTER TABLE booking_history DROP CHECK chk_booking_history_event',
    'SET @esz164_noop = 0'
);
PREPARE esz164_s4 FROM @esz164_drop_history_check;
EXECUTE esz164_s4;
DEALLOCATE PREPARE esz164_s4;

SET @esz164_add_history_check = IF(
    EXISTS(
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'booking_history'
          AND constraint_type = 'CHECK' AND constraint_name = 'chk_booking_history_event'
    ),
    'SET @esz164_noop = 0',
    'ALTER TABLE booking_history ADD CONSTRAINT chk_booking_history_event CHECK (
        event_type IN (
            ''created'', ''moved'', ''cancelled'', ''customer_updated'',
            ''customer_data_erased'', ''processing_restricted'', ''processing_restriction_lifted''
        )
    )'
);
PREPARE esz164_s5 FROM @esz164_add_history_check;
EXECUTE esz164_s5;
DEALLOCATE PREPARE esz164_s5;
