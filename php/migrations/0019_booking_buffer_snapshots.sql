-- ESZ-153 — slot coherence: a confirmed booking owns its effective interval.
--
-- Until now a booking stored its service identity (`service_key`, and since
-- ESZ-150 `combination_key`) and its exact `starts_at_utc` / `ends_at_utc`,
-- but the buffers that widen that interval into the time it *occupies* were
-- read live from `booking_services` / `booking_service_combinations` at every
-- availability computation. Editing a service's buffers therefore silently
-- changed the blocked interval of every appointment already confirmed for it.
--
-- This migration adds the booking-owned snapshot that removes that
-- retroactivity:
--
--  1. `booking_buffer_snapshots` — exactly one row per booking, keyed by the
--     booking's id, holding the before/after buffers the appointment was
--     confirmed with. The row is written once, in the booking's own creation
--     transaction, from the offer revalidated under the serialization
--     boundary, and is never updated: a move changes `starts_at_utc` /
--     `ends_at_utc` and keeps this row. The stored start→end stays the only
--     duration authority; the snapshot adds the two buffers and nothing else
--     (no label, image, price or duration copy). `origin` records how the row
--     arose — `offer` for a booking that captured its own confirmation offer,
--     `legacy` for a row frozen by the backfill below — and `frozen_at` when.
--     The foreign key is RESTRICT both ways, like every other booking child.
--  2. The legacy freeze. Old buffers cannot be reconstructed historically —
--     nothing recorded them — so every booking that predates this migration
--     is frozen, once and deterministically, to the effective buffers that
--     were authoritative for it at the instant the migration ran: its
--     combination's snapshotted buffers when it names one, otherwise its
--     service's current buffers. That is exactly what `occupiedBetween()`
--     computed for it the moment before, so no legacy booking's occupied
--     interval changes at the freeze; it merely stops following later catalog
--     edits. Service identity, start, end, state and history are untouched.
--
-- Repeat-safe per the Migrator rule: `CREATE TABLE IF NOT EXISTS`, and the
-- backfill is an `INSERT IGNORE ... SELECT` whose primary key is the booking
-- id — a second run inserts nothing for a booking already frozen, and a
-- partially applied first run completes on the next. No statement contains
-- a semicolon inside a literal.

CREATE TABLE IF NOT EXISTS booking_buffer_snapshots (
  booking_id BIGINT UNSIGNED NOT NULL,
  buffer_before_minutes SMALLINT UNSIGNED NOT NULL,
  buffer_after_minutes SMALLINT UNSIGNED NOT NULL,
  origin VARCHAR(8) COLLATE ascii_bin NOT NULL,
  frozen_at VARCHAR(24) NOT NULL,

  PRIMARY KEY (booking_id),

  CONSTRAINT fk_booking_buffer_snapshots_booking
    FOREIGN KEY (booking_id) REFERENCES bookings (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_booking_buffer_snapshots_before
    CHECK (buffer_before_minutes <= 240),
  CONSTRAINT chk_booking_buffer_snapshots_after
    CHECK (buffer_after_minutes <= 240),
  CONSTRAINT chk_booking_buffer_snapshots_origin
    CHECK (origin IN ('offer', 'legacy'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The legacy freeze. Cancelled bookings are frozen too: a row is a row, and a
-- later reader must never have to ask the catalog about any booking.
INSERT IGNORE INTO booking_buffer_snapshots
  (booking_id, buffer_before_minutes, buffer_after_minutes, origin, frozen_at)
SELECT
  b.id,
  COALESCE(c.buffer_before_minutes, s.buffer_before_minutes),
  COALESCE(c.buffer_after_minutes, s.buffer_after_minutes),
  'legacy',
  CONCAT(LEFT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%f'), 23), 'Z')
FROM bookings b
INNER JOIN booking_services s ON s.service_key = b.service_key
LEFT JOIN booking_service_combinations c ON c.combination_key = b.combination_key;
