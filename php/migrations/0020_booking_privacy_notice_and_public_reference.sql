-- ESZ-161 — align public booking with the GDPR V1 framing.
--
-- A booking rests on the execution of the requested service and the
-- pre-contractual steps the customer asks for, not on consent. The public
-- form therefore shows a privacy-information notice instead of a consent
-- checkbox, and the booking-domain contract (booking-domain.json,
-- `privacyNotices`) freezes that notice in an immutable catalog exactly as
-- ESZ-142 froze the consent notices. This migration persists the new
-- evidence additively and lets the public reference take its new shape:
--
--  1. `bookings.consent_at_utc` becomes nullable. Bookings made under the
--     consent framing keep their instant byte for byte; a booking made since
--     ESZ-161 has no consent instant, and nothing ever fabricates one.
--  2. `bookings.privacy_notice_id` — the bounded-ASCII machine id of the
--     privacy-notice catalog entry the form displayed, beside
--  3. `bookings.privacy_notice_presented_at_utc` — the instant it was
--     presented (the creation instant). Both are NULL for every booking that
--     predates ESZ-161: those rows are never retro-attributed a notice.
--  4. `chk_bookings_privacy_notice_id` bounds the id to the catalog pattern
--     (`ascii_bin`, so no non-ASCII byte can be stored at all), and
--     `chk_bookings_basis_evidence` states the invariant every row must
--     satisfy from now on: the two privacy columns are set together or not
--     at all, and a booking carries a consent instant (historical) or a
--     privacy notice presentation (current) — never neither.
--  5. `bookings.reference` becomes a VARCHAR whose CHECK admits both frozen
--     shapes: the legacy `bk_` + 32 hex reference, preserved unchanged for
--     every existing row, and the current `XXXX-XXXX` reference (eight
--     characters from the unambiguous uppercase alphabet, no 0/O, no 1/I)
--     every new booking is issued. `uq_bookings_reference` and the ESZ-144
--     keyset index carry over untouched.
--
-- Nothing is rewritten: no UPDATE, no backfill, no reference is regenerated.
--
-- Repeat-safe per the Migrator rule: MySQL commits implicitly around DDL, so a
-- migration that fails part-way must run again. Every statement below is a
-- guard expressed as a prepared statement selected from `information_schema`,
-- which the Migrator's idempotence rule recognises as the guarded form this
-- project uses for conditional DDL. No statement contains a semicolon inside
-- a literal.

-- 1. The consent instant becomes nullable. Guarded on the column's current
--    nullability so a re-run is a no-op.
SET @esz161_consent_nullable = IF(
    EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND column_name = 'consent_at_utc' AND is_nullable = 'NO'
    ),
    'ALTER TABLE bookings MODIFY COLUMN consent_at_utc DATETIME(3) NULL DEFAULT NULL',
    'SET @esz161_noop = 0'
);
PREPARE esz161_s1 FROM @esz161_consent_nullable;
EXECUTE esz161_s1;
DEALLOCATE PREPARE esz161_s1;

-- 2. The privacy notice id, physically beside the consent notice id it
--    succeeds. One guarded ADD COLUMN.
SET @esz161_add_privacy_notice_id = IF(
    EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND column_name = 'privacy_notice_id'
    ),
    'SET @esz161_noop = 0',
    'ALTER TABLE bookings ADD COLUMN privacy_notice_id VARCHAR(64) COLLATE ascii_bin NULL DEFAULT NULL AFTER consent_notice_id'
);
PREPARE esz161_s2 FROM @esz161_add_privacy_notice_id;
EXECUTE esz161_s2;
DEALLOCATE PREPARE esz161_s2;

-- 3. The presentation instant of that notice.
SET @esz161_add_privacy_presented_at = IF(
    EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND column_name = 'privacy_notice_presented_at_utc'
    ),
    'SET @esz161_noop = 0',
    'ALTER TABLE bookings ADD COLUMN privacy_notice_presented_at_utc DATETIME(3) NULL DEFAULT NULL AFTER privacy_notice_id'
);
PREPARE esz161_s3 FROM @esz161_add_privacy_presented_at;
EXECUTE esz161_s3;
DEALLOCATE PREPARE esz161_s3;

-- 4a. The bounded-ASCII shape of the privacy notice id. NULL stays legal: it
--     is the explicit marker of a booking that predates ESZ-161.
SET @esz161_add_privacy_notice_check = IF(
    EXISTS(
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND constraint_type = 'CHECK' AND constraint_name = 'chk_bookings_privacy_notice_id'
    ),
    'SET @esz161_noop = 0',
    'ALTER TABLE bookings ADD CONSTRAINT chk_bookings_privacy_notice_id CHECK (
        privacy_notice_id IS NULL
        OR privacy_notice_id REGEXP ''^[a-z0-9][a-z0-9_-]{0,63}$''
    )'
);
PREPARE esz161_s4 FROM @esz161_add_privacy_notice_check;
EXECUTE esz161_s4;
DEALLOCATE PREPARE esz161_s4;

-- 4b. Exactly one basis evidence per booking: the privacy pair is set
--     together or not at all, and a row without a consent instant must carry
--     a privacy notice. Every pre-existing row has a consent instant, so the
--     constraint holds for them the moment it is added.
SET @esz161_add_basis_check = IF(
    EXISTS(
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND constraint_type = 'CHECK' AND constraint_name = 'chk_bookings_basis_evidence'
    ),
    'SET @esz161_noop = 0',
    'ALTER TABLE bookings ADD CONSTRAINT chk_bookings_basis_evidence CHECK (
        ((privacy_notice_id IS NULL) = (privacy_notice_presented_at_utc IS NULL))
        AND (consent_at_utc IS NOT NULL OR privacy_notice_id IS NOT NULL)
    )'
);
PREPARE esz161_s5 FROM @esz161_add_basis_check;
EXECUTE esz161_s5;
DEALLOCATE PREPARE esz161_s5;

-- 5a. The legacy-only reference CHECK goes first, because the column it
--     names is about to change type and the new shape must be admitted.
SET @esz161_drop_legacy_reference_check = IF(
    EXISTS(
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND constraint_type = 'CHECK' AND constraint_name = 'chk_bookings_reference'
    ),
    'ALTER TABLE bookings DROP CHECK chk_bookings_reference',
    'SET @esz161_noop = 0'
);
PREPARE esz161_s6 FROM @esz161_drop_legacy_reference_check;
EXECUTE esz161_s6;
DEALLOCATE PREPARE esz161_s6;

-- 5b. A variable-length column: the current reference is nine characters
--     and the legacy one thirty-five, and neither must be space-padded.
--     Stored values, the UNIQUE key and the keyset index carry over as they
--     are.
SET @esz161_reference_varchar = IF(
    EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND column_name = 'reference' AND data_type = 'char'
    ),
    'ALTER TABLE bookings MODIFY COLUMN reference VARCHAR(35) COLLATE ascii_bin NOT NULL',
    'SET @esz161_noop = 0'
);
PREPARE esz161_s7 FROM @esz161_reference_varchar;
EXECUTE esz161_s7;
DEALLOCATE PREPARE esz161_s7;

-- 5c. Both frozen shapes, and nothing else.
SET @esz161_add_reference_check = IF(
    EXISTS(
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND constraint_type = 'CHECK' AND constraint_name = 'chk_bookings_reference_shape'
    ),
    'SET @esz161_noop = 0',
    'ALTER TABLE bookings ADD CONSTRAINT chk_bookings_reference_shape CHECK (
        reference REGEXP ''^(bk_[0-9a-f]{32}|[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})$''
    )'
);
PREPARE esz161_s8 FROM @esz161_add_reference_check;
EXECUTE esz161_s8;
DEALLOCATE PREPARE esz161_s8;
