-- ESZ-161 (correction) — make the basis-evidence CHECK exclusive.
--
-- Migration 0020 stated `chk_bookings_basis_evidence` as "the privacy pair is
-- set together or not at all, and a row carries a consent instant OR a
-- privacy notice". That reads "at least one", so it admitted a hybrid row
-- carrying both a consent instant and a privacy notice presentation — which
-- the booking-domain contract and 0020's own comments forbid ("exactly one
-- basis evidence"). Migrations are append-only (an edit to an applied file is
-- a checksum failure in the Migrator), so this follow-up replaces the CHECK
-- with the exclusive statement of the invariant:
--
--   historical path: consent_at_utc NOT NULL, both privacy columns NULL;
--                    consent_notice_id NULL (pre-ESZ-142) or set (later);
--   current path:    consent_at_utc NULL, consent_notice_id NULL, both
--                    privacy columns NOT NULL.
--
-- Everything else — no evidence, a half-set privacy pair, a consent instant
-- or consent notice id beside a privacy notice — is refused. No row is
-- rewritten: every consent-era row satisfies the historical path and every
-- ESZ-161 row the current path, so the constraint holds the moment it is
-- added.
--
-- Repeat-safe per the Migrator rule: the faulty CHECK is dropped only while
-- its clause is still the 0020 one (recognised by the absence of
-- `consent_notice_id`, which only the exclusive clause names), and the new one
-- is added only while no `chk_bookings_basis_evidence` exists. A re-run after
-- either step therefore completes without touching what already succeeded.

-- 1. Drop the 0020 clause, and only that clause.
SET @esz161_drop_inclusive_basis_check = IF(
    EXISTS(
        SELECT 1 FROM information_schema.check_constraints
        WHERE constraint_schema = DATABASE()
          AND constraint_name = 'chk_bookings_basis_evidence'
          AND check_clause NOT LIKE '%consent_notice_id%'
    ),
    'ALTER TABLE bookings DROP CHECK chk_bookings_basis_evidence',
    'SET @esz161_noop = 0'
);
PREPARE esz161_c1 FROM @esz161_drop_inclusive_basis_check;
EXECUTE esz161_c1;
DEALLOCATE PREPARE esz161_c1;

-- 2. Exactly one basis evidence per booking.
SET @esz161_add_exclusive_basis_check = IF(
    EXISTS(
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND constraint_type = 'CHECK' AND constraint_name = 'chk_bookings_basis_evidence'
    ),
    'SET @esz161_noop = 0',
    'ALTER TABLE bookings ADD CONSTRAINT chk_bookings_basis_evidence CHECK (
        (
            consent_at_utc IS NOT NULL
            AND privacy_notice_id IS NULL
            AND privacy_notice_presented_at_utc IS NULL
        )
        OR (
            consent_at_utc IS NULL
            AND consent_notice_id IS NULL
            AND privacy_notice_id IS NOT NULL
            AND privacy_notice_presented_at_utc IS NOT NULL
        )
    )'
);
PREPARE esz161_c2 FROM @esz161_add_exclusive_basis_check;
EXECUTE esz161_c2;
DEALLOCATE PREPARE esz161_c2;
