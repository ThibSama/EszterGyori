-- ESZ-163 — the admin GDPR request register.
--
-- The register records that a data-subject request was received and which
-- bookings its reviewed scope names. It is frozen in
-- `contracts/generated/booking-domain.json` under `privacyRequests`, and this
-- migration is the same policy written where the database can enforce it:
--
--  1. `privacy_requests` — one row per request: an internal id (never a
--     handle a requester sees), the frozen type, the reception date the
--     administrator entered and the deadline derived from it (one calendar
--     month, clamped to the month's end), the automatic status, the closure
--     instant, and the audit instants. Nothing else. There is no column for
--     the requester's e-mail, message or identity document, and none for any
--     copied booking customer field — data minimisation is a schema fact.
--  2. `chk_privacy_requests_type` and `chk_privacy_requests_status` bound the
--     enums to the frozen lists; `chk_privacy_requests_closure` ties the
--     closure instant to the status — a closed row carries one, an open row
--     never does — so the two cannot be written out of step.
--  3. `privacy_request_bookings` — the explicitly selected booking
--     references, by reference and never by customer data, in selection
--     order. `ON DELETE CASCADE` from the request row: the three-year purge
--     deletes a request and its references together. No foreign key onto
--     `bookings`: a reference is an identifier, the domain resolves it
--     against a live booking at record time, and the register stays
--     restorable independently of the bookings table's order.
--  4. `ix_privacy_requests_purge` serves the sweep's predicate
--     (`status = 'closed' AND closed_at_utc <= cutoff`) and nothing else.
--
-- Repeat-safe per the Migrator rule: `CREATE TABLE IF NOT EXISTS` only. No
-- statement contains a semicolon inside a literal.

CREATE TABLE IF NOT EXISTS privacy_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_type VARCHAR(16) COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) COLLATE ascii_bin NOT NULL,
  received_date DATE NOT NULL,
  deadline_date DATE NOT NULL,
  closed_at_utc DATETIME(3) NULL DEFAULT NULL,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,

  PRIMARY KEY (id),
  KEY ix_privacy_requests_purge (status, closed_at_utc),

  CONSTRAINT chk_privacy_requests_type
    CHECK (request_type IN ('access', 'rectification', 'erasure', 'restriction', 'portability')),
  CONSTRAINT chk_privacy_requests_status
    CHECK (status IN ('received', 'in_progress', 'closed')),
  CONSTRAINT chk_privacy_requests_deadline
    CHECK (deadline_date > received_date),
  CONSTRAINT chk_privacy_requests_closure
    CHECK (
      (status = 'closed' AND closed_at_utc IS NOT NULL)
      OR
      (status <> 'closed' AND closed_at_utc IS NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS privacy_request_bookings (
  request_id BIGINT UNSIGNED NOT NULL,
  booking_reference VARCHAR(35) COLLATE ascii_bin NOT NULL,
  position SMALLINT UNSIGNED NOT NULL,

  PRIMARY KEY (request_id, booking_reference),
  UNIQUE KEY uq_privacy_request_bookings_position (request_id, position),

  CONSTRAINT fk_privacy_request_bookings_request
    FOREIGN KEY (request_id) REFERENCES privacy_requests (id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT chk_privacy_request_bookings_reference
    CHECK (booking_reference REGEXP '^(bk_[0-9a-f]{32}|[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
