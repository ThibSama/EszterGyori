-- ESZ-150 — several services in one appointment: validated combinations.
--
-- Until now one booking named exactly one `booking_services` row and its
-- interval was that row's duration. This migration adds the *additive*
-- persistence that lets an appointment carry a validated combination of
-- services without touching what any existing booking stores:
--
--  1. `booking_service_combinations` — one row per combination the
--     administrator has explicitly validated. The primary key is the
--     combination's canonical identity: its member service keys sorted
--     bytewise and joined with `+` (A+B and B+A are one row; labels and
--     images take no part). `duration_minutes` is the duration the
--     administrator persisted and the only duration a slot computation reads
--     for the combination; `proposed_duration_minutes` records the advisory
--     sum of the component durations *as it was when validated*, so the
--     back-office can show that the proposal has since moved without the
--     validated value ever being recomputed. Buffers are snapshotted at
--     validation time (largest member before-buffer, largest after-buffer).
--     `is_active = 0` is "disabled for new bookings": non-destructive, like a
--     service's archive. Every member key is bounded to the frozen service-key
--     shape by the key CHECK, and each member must name a catalog row — which
--     the application verifies at write time; a single-column foreign key
--     cannot express a multi-member reference and the catalog never deletes a
--     row, so the reference cannot dangle.
--  2. `bookings.combination_key` — nullable, NULL for every existing row and
--     for every future single-service booking. A combination booking stores
--     its canonical combination key here beside its first canonical member in
--     the existing NOT NULL `service_key`, so every read that joins
--     `booking_services` on `service_key` keeps working unchanged. The
--     foreign key is RESTRICT both ways: a combination row that a booking
--     names can never disappear.
--
-- Nothing here rewrites a value of any existing row, seeds a combination or
-- recalculates a stored start or end. The configured maximum number of
-- services per appointment is a `system_settings` row
-- (`booking.max_services_per_appointment`) the application creates on first
-- write; an absent row means the contract default of 1.
--
-- Repeat-safe per the Migrator rule: the table is `CREATE TABLE IF NOT
-- EXISTS` and every ALTER is guarded by an `information_schema` check
-- executed as a prepared statement. No statement contains a semicolon inside
-- a literal.

CREATE TABLE IF NOT EXISTS booking_service_combinations (
  combination_key VARCHAR(259) COLLATE ascii_bin NOT NULL,
  proposed_duration_minutes SMALLINT UNSIGNED NOT NULL,
  duration_minutes SMALLINT UNSIGNED NOT NULL,
  buffer_before_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  buffer_after_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,

  PRIMARY KEY (combination_key),
  KEY ix_booking_service_combinations_active (is_active, combination_key),

  CONSTRAINT chk_booking_service_combinations_key
    CHECK (combination_key REGEXP '^[a-z][a-z0-9-]{1,63}([+][a-z][a-z0-9-]{1,63}){1,3}$'),
  CONSTRAINT chk_booking_service_combinations_proposed
    CHECK (proposed_duration_minutes BETWEEN 5 AND 1920),
  CONSTRAINT chk_booking_service_combinations_duration
    CHECK (duration_minutes BETWEEN 5 AND 480),
  CONSTRAINT chk_booking_service_combinations_buffer_before
    CHECK (buffer_before_minutes <= 240),
  CONSTRAINT chk_booking_service_combinations_buffer_after
    CHECK (buffer_after_minutes <= 240),
  CONSTRAINT chk_booking_service_combinations_active
    CHECK (is_active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The nullable combination reference on bookings. One guarded ADD COLUMN:
-- re-running the migration must be a no-op, not a duplicate-column failure.
SET @esz150_add_combination = IF(
    EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND column_name = 'combination_key'
    ),
    'SET @esz150_noop = 0',
    'ALTER TABLE bookings ADD COLUMN combination_key VARCHAR(259) COLLATE ascii_bin NULL DEFAULT NULL AFTER service_key'
);
PREPARE esz150_s1 FROM @esz150_add_combination;
EXECUTE esz150_s1;
DEALLOCATE PREPARE esz150_s1;

-- The foreign key, guarded the same way so a re-run does not duplicate it.
SET @esz150_add_combination_fk = IF(
    EXISTS(
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND constraint_type = 'FOREIGN KEY' AND constraint_name = 'fk_bookings_combination'
    ),
    'SET @esz150_noop = 0',
    'ALTER TABLE bookings ADD CONSTRAINT fk_bookings_combination FOREIGN KEY (combination_key) REFERENCES booking_service_combinations (combination_key) ON DELETE RESTRICT ON UPDATE RESTRICT'
);
PREPARE esz150_s2 FROM @esz150_add_combination_fk;
EXECUTE esz150_s2;
DEALLOCATE PREPARE esz150_s2;
