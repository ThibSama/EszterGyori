-- ESZ-152 — pauses, unavailability, closures and leave: planning constraints.
--
-- `availability_exceptions` keeps its meaning untouched: at most one row per
-- local date that *replaces* the weekly result for that date. This table is
-- the additive store for everything a replacing exception cannot say — a
-- constraint that may span several dates, that may overlap other constraints,
-- and, for a pause, that is a planning *preference* rather than a prohibition.
--
--   kind             enforcement   shape
--   pause            flexible      one date, start_local/end_local window
--   unavailability   strict        one date, start_local/end_local window
--   closure          strict        inclusive date range, no times
--   leave            strict        inclusive date range, no times
--
-- `enforcement` is a property of the kind and is stored explicitly so a reader
-- of the table can tell a preference from a blocker without knowing the
-- kinds; the CHECK keeps the two columns from ever disagreeing. Timed kinds
-- have start_date = end_date and both times; all-day kinds have no time and
-- no fold offset. `fold_utc_offset` means what it means everywhere else in
-- this schema: the explicit Europe/Paris offset of an ambiguous autumn wall
-- time, NULL otherwise.
--
-- Nothing here rewrites a row of any other table, seeds a constraint or
-- touches a booking: a strict constraint that overlaps a confirmed appointment
-- is stored beside it and the appointment keeps every fact it has. Repeat-safe
-- per the Migrator rule (CREATE TABLE IF NOT EXISTS; no ALTER).

CREATE TABLE IF NOT EXISTS availability_constraints (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  constraint_kind VARCHAR(16) COLLATE ascii_bin NOT NULL,
  enforcement VARCHAR(8) COLLATE ascii_bin NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  start_local TIME NULL DEFAULT NULL,
  end_local TIME NULL DEFAULT NULL,
  fold_utc_offset CHAR(6) COLLATE ascii_bin NULL DEFAULT NULL,
  reason VARCHAR(255) NULL DEFAULT NULL,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,

  PRIMARY KEY (id),
  KEY ix_availability_constraints_range (start_date, end_date),

  CONSTRAINT chk_availability_constraints_kind
    CHECK (constraint_kind IN ('pause', 'unavailability', 'closure', 'leave')),
  CONSTRAINT chk_availability_constraints_enforcement
    CHECK (
      (constraint_kind = 'pause' AND enforcement = 'flexible')
      OR
      (constraint_kind IN ('unavailability', 'closure', 'leave') AND enforcement = 'strict')
    ),
  CONSTRAINT chk_availability_constraints_dates
    CHECK (end_date >= start_date),
  CONSTRAINT chk_availability_constraints_shape
    CHECK (
      (constraint_kind IN ('pause', 'unavailability') AND start_date = end_date
        AND start_local IS NOT NULL AND end_local IS NOT NULL AND end_local > start_local)
      OR
      (constraint_kind IN ('closure', 'leave') AND start_local IS NULL AND end_local IS NULL
        AND fold_utc_offset IS NULL)
    ),
  CONSTRAINT chk_availability_constraints_fold_offset
    CHECK (fold_utc_offset IS NULL OR fold_utc_offset IN ('+01:00', '+02:00'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
