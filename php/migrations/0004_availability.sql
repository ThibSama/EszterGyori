-- ESZ-040 — rule-driven availability, never generated future slots.
--
-- weekday_iso, DATE and TIME are local civil values in Europe/Paris. They are
-- not instants and MySQL must not convert them. Package 4.2 will combine a rule
-- with the IANA timezone database, rejecting nonexistent DST wall times and
-- requiring an explicit offset for ambiguous ones, before producing UTC slots.

CREATE TABLE IF NOT EXISTS availability_rules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  weekday_iso TINYINT UNSIGNED NOT NULL,
  start_local TIME NOT NULL,
  end_local TIME NOT NULL,
  valid_from DATE NULL DEFAULT NULL,
  valid_until DATE NULL DEFAULT NULL,
  fold_utc_offset CHAR(6) COLLATE ascii_bin NULL DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_availability_rules_window
    (weekday_iso, start_local, end_local, valid_from, valid_until),
  KEY ix_availability_rules_lookup
    (is_active, weekday_iso, valid_from, valid_until, start_local),

  CONSTRAINT chk_availability_rules_weekday
    CHECK (weekday_iso BETWEEN 1 AND 7),
  CONSTRAINT chk_availability_rules_window
    CHECK (end_local > start_local),
  CONSTRAINT chk_availability_rules_dates
    CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from),
  CONSTRAINT chk_availability_rules_fold_offset
    CHECK (fold_utc_offset IS NULL OR fold_utc_offset IN ('+01:00', '+02:00')),
  CONSTRAINT chk_availability_rules_active
    CHECK (is_active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row replaces recurring availability for one local calendar date. `closed`
-- means no interval; `open` means the single replacement interval. Split-day
-- overrides are deliberately outside V1 and can be introduced by a forward
-- migration if the business needs them.
CREATE TABLE IF NOT EXISTS availability_exceptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  exception_date DATE NOT NULL,
  exception_kind VARCHAR(16) COLLATE ascii_bin NOT NULL,
  start_local TIME NULL DEFAULT NULL,
  end_local TIME NULL DEFAULT NULL,
  fold_utc_offset CHAR(6) COLLATE ascii_bin NULL DEFAULT NULL,
  note VARCHAR(255) NULL DEFAULT NULL,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_availability_exceptions_date (exception_date),

  CONSTRAINT chk_availability_exceptions_kind
    CHECK (exception_kind IN ('closed', 'open')),
  CONSTRAINT chk_availability_exceptions_window
    CHECK (
      (exception_kind = 'closed' AND start_local IS NULL AND end_local IS NULL
        AND fold_utc_offset IS NULL)
      OR
      (exception_kind = 'open' AND start_local IS NOT NULL AND end_local IS NOT NULL
        AND end_local > start_local)
    ),
  CONSTRAINT chk_availability_exceptions_fold_offset
    CHECK (fold_utc_offset IS NULL OR fold_utc_offset IN ('+01:00', '+02:00'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
