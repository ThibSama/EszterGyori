-- ESZ-149 — booking_services becomes the operational service catalog.
--
-- Until now the table owned only the facts needed to reserve time (label,
-- duration, buffers, activity) and the editorial description and image of a
-- service lived in SiteContent.services, whose four fixed item ids doubled as
-- the only service keys the booking contract admitted. Administering the
-- catalog — adding a service, editing what the reservation page shows for it,
-- archiving it — therefore required a source edit. This migration gives the
-- table the two editorial columns the reservation flow renders, so one row is
-- the whole authority for one service:
--
--  1. `description` — the catalog's own text for the service. NOT NULL with an
--     empty default: an existing row gains an empty description, never a
--     fabricated one. The application seeds it from the published SiteContent
--     item of the same key only through the explicit provisioning CLI, and the
--     administrator owns it afterwards.
--  2. `image_src` — ONE reference to a managed media asset, as the public path
--     the media library serves (`/media/med_<32 hex>.<ext>`), or NULL. The
--     bytes stay in the media library: the same stored asset feeds the admin
--     list thumbnail, the edit form and the public reservation page, and the
--     media delete route refuses an asset a service row references. The
--     column is `ascii_bin` (a managed path is pure ASCII) and the CHECK
--     restates the frozen public-path pattern, so the column cannot smuggle an
--     arbitrary path, an external URL or an unbounded payload.
--
-- Nothing here touches `is_active`, the primary key or the bookings foreign
-- key: archiving is `is_active = 0` on the existing column, the four existing
-- rows keep their keys, and every booking keeps its stored service_key.
-- The migration seeds no row and rewrites no value of any existing row.
--
-- Repeat-safe per the Migrator rule: MySQL commits implicitly around DDL, so a
-- migration that fails part-way must run again. Every statement below is a
-- guard expressed as a prepared statement selected from `information_schema`,
-- which the Migrator's idempotence rule recognises as the guarded form this
-- project uses for conditional DDL. No statement contains a semicolon inside
-- a literal.

-- 1. The description column. One guarded ADD COLUMN: re-running the migration
--    must be a no-op, not a duplicate-column failure.
SET @esz149_add_description = IF(
    EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'booking_services'
          AND column_name = 'description'
    ),
    'SET @esz149_noop = 0',
    'ALTER TABLE booking_services ADD COLUMN description VARCHAR(2000) NOT NULL DEFAULT '''' AFTER booking_label'
);
PREPARE esz149_s1 FROM @esz149_add_description;
EXECUTE esz149_s1;
DEALLOCATE PREPARE esz149_s1;

-- 2. The managed image reference, nullable: NULL is the explicit "no image"
--    state, never a placeholder path.
SET @esz149_add_image = IF(
    EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'booking_services'
          AND column_name = 'image_src'
    ),
    'SET @esz149_noop = 0',
    'ALTER TABLE booking_services ADD COLUMN image_src VARCHAR(80) COLLATE ascii_bin NULL DEFAULT NULL AFTER description'
);
PREPARE esz149_s2 FROM @esz149_add_image;
EXECUTE esz149_s2;
DEALLOCATE PREPARE esz149_s2;

-- 3. The managed-path shape (the media contract's MEDIA_PUBLIC_PATH_PATTERN).
--    Guarded so a re-run does not duplicate the constraint.
SET @esz149_add_image_check = IF(
    EXISTS(
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'booking_services'
          AND constraint_type = 'CHECK' AND constraint_name = 'chk_booking_services_image_src'
    ),
    'SET @esz149_noop = 0',
    'ALTER TABLE booking_services ADD CONSTRAINT chk_booking_services_image_src CHECK (
        image_src IS NULL
        OR image_src REGEXP ''^/media/med_[0-9a-f]{32}[.](jpg|png|webp)$''
    )'
);
PREPARE esz149_s3 FROM @esz149_add_image_check;
EXECUTE esz149_s3;
DEALLOCATE PREPARE esz149_s3;
