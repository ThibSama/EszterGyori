-- ESZ-084 — the durable store behind `rateLimitPolicy`.
--
-- ## Why this is a table and not a static, an APCu key or a session
--
-- The target is Hetzner shared hosting, where every request is its own PHP
-- process. Nothing held in process memory survives to the next request, so a
-- limiter built on a static counts to one and stays there — it does not throttle,
-- it only looks like it does, which is worse than no limiter because it is
-- believed. APCu is not guaranteed present on the plan and is per-pool even when
-- it is; `$_SESSION` is per-caller and an abuser simply sends no cookie. The
-- database is the one store every process on this host can see, and every route
-- that is limited already opens it.
--
-- ## One row, one timestamp
--
-- The algorithm is GCRA (`rateLimitPolicy.algorithm`), whose entire state per
-- bucket is a single theoretical-arrival-time. A counter-plus-window design would
-- need two columns and a read-then-write to decide anything; this needs one
-- column and one conditional UPDATE, and MySQL's row lock is what makes two
-- simultaneous processes presenting the last allowance admit exactly one.
--
-- Milliseconds since the Unix epoch as a BIGINT, not a formatted string. The
-- comparison in that UPDATE is arithmetic — `tat_ms <= now + tolerance` — and
-- every other timestamp in this schema is a VARCHAR precisely because it is only
-- ever compared for equality or ordering. This one is not, so it is a number.

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  -- sha256(scope + NUL + subject), raw bytes.
  --
  -- Hashed, and stored as bytes rather than hex, so this table holds no client
  -- address and no e-mail address in clear. That is not decoration: a counter
  -- store that also happens to be a durable record of who visited and when is a
  -- personal-data store, and it would then need the retention and disclosure
  -- treatment the log file gets. Hashing keeps it a counter store.
  --
  -- BINARY(32) with the implicit binary collation: comparison is byte-exact, so
  -- no collation change can ever make two different buckets share a row.
  bucket_key BINARY(32) NOT NULL,

  -- The bucket's scope, in clear, for the operator alone. It is one of the fixed
  -- keys in `rateLimitPolicy.buckets` and therefore reveals nothing about any
  -- caller, while making "which rule is refusing people right now" a question
  -- that can be answered without reversing a hash.
  scope VARCHAR(64) COLLATE ascii_bin NOT NULL,

  -- The theoretical arrival time: the instant at which this bucket will next be
  -- exactly at its long-run rate. Admission compares against it and admission
  -- advances it; nothing else writes it.
  tat_ms BIGINT NOT NULL,

  -- When this row stops meaning anything and may be swept. Derived from tat_ms
  -- plus the bucket's own period, so a wide bucket is retained longer than a
  -- narrow one without the sweeper needing to know any policy.
  --
  -- Losing a row early only forgives allowance; it can never grant more than the
  -- policy allows, because a missing row is indistinguishable from a bucket that
  -- has been idle for a full period — which is exactly what it is.
  expires_at_ms BIGINT NOT NULL,

  PRIMARY KEY (bucket_key),

  -- Supports the sweep, which is the only query that does not name a key.
  KEY ix_rate_limit_buckets_expires (expires_at_ms),

  CONSTRAINT chk_rate_limit_buckets_scope
    CHECK (scope REGEXP '^[a-z][a-z0-9._-]{1,63}$'),

  -- An expiry at or before the arrival time would make the row sweepable while
  -- still in force, which is the one way this table could hand out allowance it
  -- had already spent.
  CONSTRAINT chk_rate_limit_buckets_expiry
    CHECK (expires_at_ms > tat_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
