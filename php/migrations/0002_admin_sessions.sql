-- ESZ-025 — server-side session records.
--
-- The session id in the cookie is a lookup key and nothing else; everything that
-- decides authorization lives in this table, on the server. That is the whole
-- difference from the JWT this replaces (`docs/hetzner-target-architecture.md`
-- §6): a JWT stays valid until it expires because nobody can un-issue it, whereas
-- a row can be deleted, and logout deletes it.

CREATE TABLE IF NOT EXISTS admin_sessions (
  -- 256 bits of randomness, hex-encoded. COLLATE ascii_bin so that lookup is
  -- case-sensitive and byte-exact: under the table's case-insensitive default an
  -- id differing only in case would match a live session.
  id CHAR(64) COLLATE ascii_bin NOT NULL,

  -- Null while the session is anonymous. An anonymous session is a real row
  -- because it carries the CSRF token that POST /api/auth/login requires, which is
  -- what closes login CSRF.
  account_id BIGINT UNSIGNED NULL DEFAULT NULL,

  -- The CSRF token bound to this session (ESZ-026). A column rather than part of
  -- an opaque serialised payload, because it is the only other thing a session
  -- holds and a column can be compared and reasoned about in SQL.
  --
  -- It is a secret, but not a credential: holding it without the session id
  -- authorises nothing, and holding the session id without it authorises no
  -- write. That is the whole point of there being two.
  csrf_token CHAR(64) COLLATE ascii_bin NOT NULL,

  created_at VARCHAR(24) NOT NULL,
  last_seen_at VARCHAR(24) NOT NULL,

  -- The idle deadline, recomputed on each request. Expiry is enforced by reading
  -- this column, never by the cookie's Max-Age, which the client controls.
  expires_at VARCHAR(24) NOT NULL,

  -- The absolute ceiling, fixed when the session was created and never extended,
  -- so a continuously-used stolen session still dies.
  absolute_expires_at VARCHAR(24) NOT NULL,

  PRIMARY KEY (id),

  -- Supports the expiry sweep.
  KEY ix_admin_sessions_expires_at (expires_at),

  -- Supports "sign this account out everywhere", which is what disabling an
  -- account must do to be worth anything.
  KEY ix_admin_sessions_account_id (account_id),

  CONSTRAINT fk_admin_sessions_account
    FOREIGN KEY (account_id) REFERENCES admin_accounts (id)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
