-- ESZ-040 — non-secret operational settings needed by later booking packages.
--
-- No row is seeded here. Package 4.1 freezes Europe/Paris in the booking-domain
-- contract and schema; a setting becomes meaningful only when a later feature
-- defines its key, JSON shape and explicit provisioning path.

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key VARCHAR(64) COLLATE ascii_bin NOT NULL,
  value_json JSON NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,

  PRIMARY KEY (setting_key),

  CONSTRAINT chk_system_settings_key
    CHECK (setting_key REGEXP '^[a-z][a-z0-9_.-]{1,63}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
