-- ESZ-044 — additional windows for one replacing date exception.
--
-- The parent availability_exceptions row remains unique per local date and owns
-- its first window. These rows hold only the second and later windows, allowing
-- an open exception to express exceptional opening or the complete set left
-- after partial unavailability without merging it with weekly rules.

CREATE TABLE IF NOT EXISTS availability_exception_windows (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  exception_id BIGINT UNSIGNED NOT NULL,
  position SMALLINT UNSIGNED NOT NULL,
  start_local TIME NOT NULL,
  end_local TIME NOT NULL,
  fold_utc_offset CHAR(6) COLLATE ascii_bin NULL DEFAULT NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_availability_exception_windows_position (exception_id, position),
  KEY ix_availability_exception_windows_order (exception_id, start_local, end_local),

  CONSTRAINT fk_availability_exception_windows_exception
    FOREIGN KEY (exception_id) REFERENCES availability_exceptions (id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT chk_availability_exception_windows_position
    CHECK (position >= 2),
  CONSTRAINT chk_availability_exception_windows_window
    CHECK (end_local > start_local),
  CONSTRAINT chk_availability_exception_windows_fold_offset
    CHECK (fold_utc_offset IS NULL OR fold_utc_offset IN ('+01:00', '+02:00'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
