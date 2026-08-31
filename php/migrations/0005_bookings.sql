-- ESZ-040 / ESZ-042 — appointment facts and the explicit V1 lifecycle.
--
-- Appointment instants are stored as UTC DATETIME(3), never as server-local
-- TIMESTAMP values. timezone_name records the civil-time policy used to obtain
-- them. Audit timestamps use the repository-wide canonical UTC ISO text form.
-- Cancellation changes state and records when; it never deletes the row.

CREATE TABLE IF NOT EXISTS bookings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference CHAR(35) COLLATE ascii_bin NOT NULL,
  service_key VARCHAR(64) COLLATE ascii_bin NOT NULL,
  state VARCHAR(16) COLLATE ascii_bin NOT NULL,

  starts_at_utc DATETIME(3) NOT NULL,
  ends_at_utc DATETIME(3) NOT NULL,
  timezone_name VARCHAR(64) COLLATE ascii_bin NOT NULL,

  customer_name VARCHAR(160) NOT NULL,
  customer_email VARCHAR(254) COLLATE utf8mb4_bin NOT NULL,
  customer_phone VARCHAR(32) NULL DEFAULT NULL,
  customer_note VARCHAR(2000) NULL DEFAULT NULL,
  consent_at_utc DATETIME(3) NOT NULL,

  cancelled_at_utc DATETIME(3) NULL DEFAULT NULL,
  cancellation_reason VARCHAR(500) NULL DEFAULT NULL,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  state_changed_at VARCHAR(24) NOT NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_bookings_reference (reference),
  KEY ix_bookings_service_start (service_key, starts_at_utc),
  KEY ix_bookings_state_start (state, starts_at_utc),

  CONSTRAINT fk_bookings_service
    FOREIGN KEY (service_key) REFERENCES booking_services (service_key)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_bookings_reference
    CHECK (reference REGEXP '^bk_[0-9a-f]{32}$'),
  CONSTRAINT chk_bookings_state
    CHECK (state IN ('confirmed', 'cancelled')),
  CONSTRAINT chk_bookings_interval
    CHECK (ends_at_utc > starts_at_utc),
  CONSTRAINT chk_bookings_timezone
    CHECK (timezone_name = 'Europe/Paris'),
  CONSTRAINT chk_bookings_customer_name
    CHECK (CHAR_LENGTH(TRIM(customer_name)) BETWEEN 1 AND 160),
  CONSTRAINT chk_bookings_customer_email
    CHECK (CHAR_LENGTH(TRIM(customer_email)) BETWEEN 3 AND 254),
  CONSTRAINT chk_bookings_cancellation
    CHECK (
      (state = 'confirmed' AND cancelled_at_utc IS NULL AND cancellation_reason IS NULL)
      OR
      (state = 'cancelled' AND cancelled_at_utc IS NOT NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
