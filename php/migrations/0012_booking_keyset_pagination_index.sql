-- ESZ-144 — deterministic keyset pagination for admin booking range reads.
--
-- The old admin range read (`listBetween`) ordered by (starts_at_utc,
-- reference) under a silent `LIMIT maxResults` clip, and its successor pages
-- over the same keyset with a pageSize+1 probe. The probe query is:
--
--   SELECT ... FROM bookings
--   WHERE starts_at_utc >= :from AND starts_at_utc < :until
--     [AND (starts_at_utc > :anchor OR (starts_at_utc = :anchor AND reference > :ar))]
--   ORDER BY starts_at_utc, reference LIMIT pageSize+1
--
-- The two existing bookings indexes lead with other columns
-- (`ix_bookings_service_start`, `ix_bookings_state_start`), so MySQL answers
-- that range scan with a full table scan plus a filesort for the ORDER BY —
-- EXPLAIN: type=ALL with a Using filesort note — and every page of a busy
-- window re-reads the whole table. The keyset pagination is only bounded
-- per-request if each page is an index-range read, so the ORDER BY columns
-- get their own index:
--
--   KEY ix_bookings_starts_reference (starts_at_utc, reference)
--
-- With it the same query is answered through that index — EXPLAIN shows
-- `range` (or `index` on a nearly empty table) with no filesort, never an
-- `ALL` table scan — and touches only the rows of the window plus the
-- pageSize+1 probe.
--
-- Repeat-safe per the Migrator rule: MySQL commits implicitly around DDL, so
-- a migration that fails part-way must run again. Every statement below is a
-- guard expressed as a prepared statement selected from
-- `information_schema`; each statement begins with `SET`, which the
-- Migrator's idempotence rule recognises as the guarded form this project
-- uses for conditional DDL. No statement contains a semicolon inside a
-- literal.

SET @esz144_add_starts_reference_index = IF(
    EXISTS(
        SELECT 1 FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND index_name = 'ix_bookings_starts_reference'
    ),
    'SET @esz144_noop = 0',
    'ALTER TABLE bookings ADD KEY ix_bookings_starts_reference (starts_at_utc, reference)'
);
PREPARE esz144_s1 FROM @esz144_add_starts_reference_index;
EXECUTE esz144_s1;
DEALLOCATE PREPARE esz144_s1;
