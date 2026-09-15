-- Domain version 15 — combinations become a default-allow policy with
-- explicit exceptions.
--
-- Until now `booking_service_combinations` was an *allowlist*: a selection of
-- two or more services was bookable only when a row existed for exactly that
-- canonical membership. The corrected business rule is the opposite: every set
-- of up to the configured `maxServicesPerAppointment` *active* services is
-- bookable by default, for the plain sum of its component durations, and a row
-- exists only to override that default. Two additive changes make the existing
-- schema able to say that:
--
--  1. `duration_minutes` becomes NULLable. NULL now means "this membership has
--     no custom duration — the automatic sum of its components applies", which
--     is what an absent row already means. A non-null value keeps exactly the
--     meaning it had: the authoritative custom duration the administrator
--     validated for that membership, never recomputed when a component moves.
--     Every existing row keeps its stored value, so every duration Esther has
--     already validated stays authoritative, and every existing `is_active = 0`
--     row stays disabled. Nothing is rewritten, seeded or re-enabled here.
--
--     The state table after this migration:
--
--       no row                          -> bookable, summed duration
--       is_active = 1, duration NULL    -> bookable, summed duration (a row
--                                          that was disabled and re-enabled;
--                                          exactly equivalent to no row)
--       is_active = 1, duration NOT NULL-> bookable, that custom duration
--       is_active = 0                   -> not bookable, whatever the duration
--
--  2. `fk_bookings_combination` is dropped. A booking of an implicit
--     combination stores its canonical combination key (so the appointment
--     still knows every service it is for) while no override row exists for
--     that membership, which the RESTRICT foreign key forbade. Nothing else
--     depended on it: no read joins the two tables — `Booking::serviceKeys()`
--     splits the stored key itself — and the application never deletes a
--     combination row, so the reference it protected could not dangle anyway.
--     The column, its values and every stored booking are untouched.
--
-- Repeat-safe per the Migrator rule: both statements are guarded by an
-- `information_schema` check executed as a prepared statement, so a re-run is a
-- no-op rather than a failure. No statement contains a semicolon inside a
-- literal.

-- 1. duration_minutes NULLable. Guarded on IS_NULLABLE so the second run does
-- not re-issue the MODIFY (which would be a full table rebuild each time).
SET @esz150v15_null_duration = IF(
    EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'booking_service_combinations'
          AND column_name = 'duration_minutes' AND IS_NULLABLE = 'YES'
    ),
    'SET @esz150v15_noop = 0',
    'ALTER TABLE booking_service_combinations MODIFY COLUMN duration_minutes SMALLINT UNSIGNED NULL DEFAULT NULL'
);
PREPARE esz150v15_s1 FROM @esz150v15_null_duration;
EXECUTE esz150v15_s1;
DEALLOCATE PREPARE esz150v15_s1;

-- 2. Drop the bookings -> combinations foreign key, so a booking may name an
-- implicit combination that has no override row.
SET @esz150v15_drop_fk = IF(
    EXISTS(
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND constraint_type = 'FOREIGN KEY' AND constraint_name = 'fk_bookings_combination'
    ),
    'ALTER TABLE bookings DROP FOREIGN KEY fk_bookings_combination',
    'SET @esz150v15_noop = 0'
);
PREPARE esz150v15_s2 FROM @esz150v15_drop_fk;
EXECUTE esz150v15_s2;
DEALLOCATE PREPARE esz150v15_s2;
