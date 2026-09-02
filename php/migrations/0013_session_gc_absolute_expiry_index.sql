-- ESZ-130 — index the absolute session deadline for the bounded expiry sweep.
--
-- The session sweep (`PdoSessionStore::collectGarbage()`, called on every
-- admitted anonymous `GET /api/auth/session`) deletes rows past either
-- deadline in two bounded passes. The idle deadline was already indexed
-- (`ix_admin_sessions_expires_at`, migration 0002); the absolute deadline had
-- no index of its own, so the absolute-expiry pass of the sweep would have
-- been answered with a full table scan plus a filesort for its ORDER BY —
-- EXPLAIN: type=ALL with a Using filesort note — and every sweep would have
-- re-read the whole table. The sweep must stay a cheap index-range delete
-- because it runs on a request's own path:
--
--   KEY ix_admin_sessions_absolute_expires_at (absolute_expires_at)
--
-- With it the absolute-expiry pass is answered through that index (EXPLAIN
-- shows `range`, never `ALL`) and touches only the expired rows up to the
-- batch bound.
--
-- Repeat-safe per the Migrator rule: MySQL commits implicitly around DDL, so
-- a migration that fails part-way must run again. The statement below is a
-- guard expressed as a prepared statement selected from
-- `information_schema`; it begins with `SET`, which the Migrator's
-- idempotence rule recognises as the guarded form this project uses for
-- conditional DDL. No statement contains a semicolon inside a literal.

SET @esz130_add_absolute_expires_index = IF(
    EXISTS(
        SELECT 1 FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'admin_sessions'
          AND index_name = 'ix_admin_sessions_absolute_expires_at'
    ),
    'SET @esz130_noop = 0',
    'ALTER TABLE admin_sessions ADD KEY ix_admin_sessions_absolute_expires_at (absolute_expires_at)'
);
PREPARE esz130_s1 FROM @esz130_add_absolute_expires_index;
EXECUTE esz130_s1;
DEALLOCATE PREPARE esz130_s1;
