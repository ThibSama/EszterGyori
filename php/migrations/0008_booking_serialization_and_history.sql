-- ESZ-047/048 — one database-owned V1 resource lock and append-only history.
--
-- Every creation and move locks the same singleton row with SELECT ... FOR
-- UPDATE inside its transaction. It therefore serializes conflicting requests
-- across service keys and buffer configurations on every PHP process and host.

CREATE TABLE IF NOT EXISTS booking_resource_locks (
  resource_key VARCHAR(32) COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (resource_key),
  CONSTRAINT chk_booking_resource_locks_key CHECK (resource_key = 'primary')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO booking_resource_locks (resource_key) VALUES ('primary');

CREATE TABLE IF NOT EXISTS booking_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(32) COLLATE ascii_bin NOT NULL,
  actor_type VARCHAR(16) COLLATE ascii_bin NOT NULL,
  details_json JSON NOT NULL,
  occurred_at VARCHAR(24) NOT NULL,

  PRIMARY KEY (id),
  KEY ix_booking_history_booking_order (booking_id, id),

  CONSTRAINT fk_booking_history_booking
    FOREIGN KEY (booking_id) REFERENCES bookings (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_booking_history_event
    CHECK (event_type IN ('created', 'moved', 'cancelled', 'customer_updated')),
  CONSTRAINT chk_booking_history_actor
    CHECK (actor_type IN ('public', 'admin'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
