-- ESZ-142 — durable mapping from each booking to the consent notice accepted.
--
-- Before this migration the only stored consent fact was `consent_at_utc`:
-- the instant the visitor ticked the checkbox. Which wording that checkbox
-- showed was hardcoded in the frontend, so nothing durable could say whether
-- an old instant referred to the text displayed today or to an earlier one.
-- The booking-domain contract (booking-domain.json, `consentNotices`) now
-- freezes an immutable notice catalog — each entry pairs a stable machine id
-- with the exact user-visible French text — and this migration persists the
-- id beside the instant:
--
--  1. `bookings.consent_notice_id` — the bounded-ASCII machine id of the
--     catalog entry whose text the visitor accepted. It is nullable ONLY for
--     bookings created before the catalog existed: those rows keep their
--     `consent_at_utc` and a NULL id, and nothing ever retro-attributes a
--     notice to them. New bookings always store a non-null id, chosen by the
--     application from the same artifact the wire enum was generated from.
--  2. `chk_bookings_consent_notice_id` — the column is `ascii_bin` (non-ASCII
--     bytes cannot be stored at all) and the CHECK bounds the shape to the
--     catalog's id pattern, so no value can smuggle text, whitespace or an
--     unbounded payload into the evidence column.
--
-- `consent_at_utc` is never rewritten by this migration or by anything that
-- reads the new column. The notice id is operational evidence, not customer
-- PII: retention anonymization (ESZ-140) preserves it with the consent
-- instant when it erases the customer fields.
--
-- Repeat-safe per the Migrator rule: MySQL commits implicitly around DDL, so a
-- migration that fails part-way must run again. Every statement below is a
-- guard expressed as a prepared statement selected from `information_schema`,
-- which the Migrator's idempotence rule recognises as the guarded form this
-- project uses for conditional DDL. No statement contains a semicolon inside
-- a literal.

-- 1. The notice id column, physically beside the consent instant it
--    qualifies. One guarded ADD COLUMN: re-running the migration must be a
--    no-op, not a duplicate-column failure.
SET @esz142_add_notice_id = IF(
    EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND column_name = 'consent_notice_id'
    ),
    'SET @esz142_noop = 0',
    'ALTER TABLE bookings ADD COLUMN consent_notice_id VARCHAR(64) COLLATE ascii_bin NULL DEFAULT NULL AFTER consent_at_utc'
);
PREPARE esz142_s1 FROM @esz142_add_notice_id;
EXECUTE esz142_s1;
DEALLOCATE PREPARE esz142_s1;

-- 2. The bounded-ASCII shape. Guarded so a re-run does not duplicate the
--    constraint. NULL stays legal: it is the explicit marker of a booking
--    that predates the catalog, never a value that forgot its notice.
SET @esz142_add_notice_check = IF(
    EXISTS(
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'bookings'
          AND constraint_type = 'CHECK' AND constraint_name = 'chk_bookings_consent_notice_id'
    ),
    'SET @esz142_noop = 0',
    'ALTER TABLE bookings ADD CONSTRAINT chk_bookings_consent_notice_id CHECK (
        consent_notice_id IS NULL
        OR consent_notice_id REGEXP ''^[a-z0-9][a-z0-9_-]{0,63}$''
    )'
);
PREPARE esz142_s2 FROM @esz142_add_notice_check;
EXECUTE esz142_s2;
DEALLOCATE PREPARE esz142_s2;
