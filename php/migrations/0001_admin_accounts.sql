-- ESZ-024 — the canonical admin identity.
--
-- One row per person who may edit the site. There is no roles column and no
-- permissions table: the surface has exactly one privilege level, and inventing a
-- second one before anything needs it would be a schema to maintain and a code
-- path nothing exercises.
--
-- No row is ever created by a migration. Provisioning is an explicit, operator-run
-- step (`php bin/provision-admin.php`), because a migration that seeded a known
-- account would put the same credentials on every deployment of this application
-- that ever runs.

CREATE TABLE IF NOT EXISTS admin_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Normalised per http-contract.json `auth.identity`: trimmed, ASCII-lower-cased.
  --
  -- COLLATE utf8mb4_bin, deliberately, against the table default. The unique index
  -- below is what makes "one address, one person" true, and under the table's
  -- utf8mb4_unicode_ci that index would also be accent-insensitive — `e@x.test`
  -- and `é@x.test` would collide and one of two legitimate people would be unable
  -- to have an account. Binary collation makes identity exactly the normalised
  -- bytes, and the case-folding that *should* happen already happened in PHP.
  email VARCHAR(254) COLLATE utf8mb4_bin NOT NULL,

  -- password_hash() output. 255 rather than 60: bcrypt is 60 bytes but Argon2id
  -- is ~97 and grows with its parameters, and PHP_PASSWORD_DEFAULT is explicitly
  -- allowed to change between releases. A column sized to today's algorithm is a
  -- silent truncation on the day it changes.
  password_hash VARCHAR(255) NOT NULL,

  -- Disabling is not deleting. A disabled account keeps its row, so its audit
  -- trail and its sessions stay attributable, and it is rejected at every request
  -- rather than only at login.
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,

  -- The canonical wire timestamp (`Y-m-d\TH:i:s.v\Z`), stored verbatim as text.
  -- Not DATETIME: this application has exactly one timestamp format, asserted by
  -- `envelope.isoTimestampRoundTrip`, and a DATETIME round-trip would reintroduce
  -- a second one that differs by the server's time zone setting.
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  last_login_at VARCHAR(24) NULL DEFAULT NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_accounts_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
