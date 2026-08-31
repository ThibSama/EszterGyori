-- ESZ-041 — canonical operational configuration for reservable services.
--
-- Rows are never seeded by a migration or at boot. An operator provisions them
-- explicitly from the stable SiteContent service keys published by
-- booking-domain.json. Editorial descriptions and media stay in SiteContent;
-- this table owns only facts needed to reserve time.

CREATE TABLE IF NOT EXISTS booking_services (
  service_key VARCHAR(64) COLLATE ascii_bin NOT NULL,
  booking_label VARCHAR(160) NOT NULL,
  duration_minutes SMALLINT UNSIGNED NOT NULL,
  buffer_before_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  buffer_after_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,

  PRIMARY KEY (service_key),
  KEY ix_booking_services_active_key (is_active, service_key),

  CONSTRAINT chk_booking_services_key
    CHECK (service_key REGEXP '^[a-z][a-z0-9-]{1,63}$'),
  CONSTRAINT chk_booking_services_label
    CHECK (CHAR_LENGTH(TRIM(booking_label)) BETWEEN 1 AND 160),
  CONSTRAINT chk_booking_services_duration
    CHECK (duration_minutes BETWEEN 5 AND 480),
  CONSTRAINT chk_booking_services_buffer_before
    CHECK (buffer_before_minutes <= 240),
  CONSTRAINT chk_booking_services_buffer_after
    CHECK (buffer_after_minutes <= 240),
  CONSTRAINT chk_booking_services_active
    CHECK (is_active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
