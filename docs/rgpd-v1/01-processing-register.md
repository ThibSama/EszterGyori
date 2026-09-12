# 1. Register of processing activities (V1)

Controller: the operator of the site (the ESZ-161 notice names *Eszter Gyori*;
the legal identity values are ESZ-165's and are still HUMAN prerequisites —
see `06-production-prerequisites.md`). No data-protection officer is designated
in the repository and none is required by it; that is an operator decision.

Every row below is a **repository fact** unless marked *operational policy
prerequisite* (a retention decision the repository deliberately does not
define) or *HUMAN*. "Recipients" names categories; the actual providers are in
`04-processors-and-dpa.md`.

Cross-cutting facts that apply to every family:

- Time zone of the business: `Europe/Paris`; stored instants are UTC (`contracts/booking.ts`, `BOOKING_TIME_ZONE`).
- No booking, history row or notification job is ever deleted; customer PII is *anonymised* in place (`customerDataRetentionPolicy.neverDelete`).
- Logs are an allowlist: no customer name, address, phone, note, message body or credential is ever written (`notifications.diagnostics.rule`; `php/src/Notification/NotificationLogContext.php`).
- Client IP addresses are read from `REMOTE_ADDR` only, used for rate limiting, and stored only as `sha256(scope + NUL + subject)`; they are not written to application logs (`php/src/Http/Request.php`, `docs/security-review-v1.md` §8 *Privacy*). Web-server access logs are host-owned (HUMAN: see §5 and `06-production-prerequisites.md`).
- Backups carry booking PII by design and are bounded to 30 days (§6).

---

## 1.1 Appointment / booking management

| Item | Value |
|---|---|
| Data subjects | Customers (visitors who book an appointment). |
| Data | Name (first and last name collected separately since ESZ-160, stored as `customer_name`), e-mail, optional phone, optional free-text "précision" about the appointment (the form warns against health/medical/sensitive data), service(s), appointment instants, public reference (`XXXX-XXXX`, or legacy `bk_…`), state and lifecycle instants, cancellation reason, the privacy notice id and its presentation instant (or, for bookings before ESZ-161, the consent instant and consent notice id). |
| Purpose | Organise the requested appointment: reservation, confirmation, reminder, move, cancellation. |
| Legal basis | **Contract / pre-contractual steps** (GDPR art. 6(1)(b)) — frozen in `bookingPrivacyNoticePolicy.legalBasis`; the form displays an information notice, not a consent checkbox. Bookings made under the historical ESZ-142 consent notice keep their consent evidence byte for byte (`bookingConsentNoticePolicy`). Exactly one basis evidence per row is a schema invariant (migration `0021`). |
| Source | The person, through the public booking form (`POST /api/bookings`). Admin contact edits go through the single customer-update authority (`BookingLifecycle::updateCustomerContact`). |
| Storage / system | MySQL `bookings`, `booking_history` (field names and instants only, never customer values), `booking_buffer_snapshots`; on the Hetzner host, outside the document root. |
| Recipients | The operator (admin back-office); hosting provider (database and files); e-mail delivery provider for the messages of §1.2. |
| Retention | **90 days after the lifecycle-ending instant** (`ends_at_utc` for a confirmed booking, `cancelled_at_utc` for a cancelled one), then anonymisation in place: name/e-mail replaced by frozen non-deliverable placeholders, phone/note/cancellation reason set to NULL, `customer_data_erased_at` set. Appointment facts, reference, history, notice evidence and notification evidence survive (`customerDataRetentionPolicy`, migration `0011`). Applied by the daily sweep `php bin/apply-booking-retention.php` and by every restore. |
| Security / minimisation | Optional phone and note; sensitive-data warning; strict request schema; rate-limited creation (`booking.create.address` 5/h, `booking.create.global` 60/h); erased bookings cannot be reached by e-mail search; admin updates cannot reintroduce PII into an erased booking; `.htaccess` denies private paths; CSP/Permissions-Policy (`docs/security-review-v1.md` §3). |
| Implementation authority | `contracts/booking.ts` (`bookingPrivacyNoticePolicy`, `customerDataRetentionPolicy`), `php/src/Booking/BookingLifecycle.php`, `php/src/Retention/BookingRetentionService.php`, `php/migrations/0005_bookings.sql`, `0011_booking_customer_data_retention.sql`, `0014_booking_consent_notice.sql`, `0020_booking_privacy_notice_and_public_reference.sql`, `0021_booking_basis_evidence_exclusive.sql`. |

## 1.2 Transactional notifications

| Item | Value |
|---|---|
| Data subjects | Customers with a booking. |
| Data | For each e-mail: the customer's e-mail address (resolved from `bookings` at delivery time), the customer name and the appointment facts rendered into the message; the queue row itself holds only booking id, channel, job type, timing, status, attempt count and a reserved error code — no address, no body (`php/migrations/0009_notification_jobs.sql`). |
| Purpose | Confirmation, one reminder at T-24h, cancellation, move, and one informational e-mail when a restriction of processing is lifted (ESZ-164). |
| Legal basis | Same as §1.1 — performance of the requested service. The reminder and the restriction-lifted message are part of organising the appointment, not marketing. |
| Source | Derived from the booking. |
| Storage / system | MySQL `notification_jobs`; delivery through a provider-neutral transport; production selects SMTP over mandatory STARTTLS or implicit TLS (`docs/deployment-runbook.md` §2). `notifications.log` on the host (allowlisted fields only). |
| Recipients | E-mail delivery provider (SMTP) — **not yet selected**, see `04-processors-and-dpa.md`. SMS: the `sms` channel exists as a column and is off by default; **no SMS transport and no SMS provider exist in V1** (`notifications.runner.transport`; `docs/hetzner-target-architecture.md` §11 records SMS as a future integration boundary). |
| Retention | Terminal jobs (sent/failed/skipped/retired) are delivery evidence and are never deleted (`notifications.retention.bookingRelation`). They carry no PII. Non-terminal jobs of an erased booking are retired under the erasure transaction; delivery to an erased booking is refused (`customer_data_erased`). Restricted bookings are never claimed and are re-checked before transport (`notifications.restriction`). |
| Security / minimisation | Log allowlist with a mechanical choke point; error codes cannot express customer data; no recipient address stored in the queue; provider messages never enter job errors or logs. |
| Implementation authority | `contracts/booking.ts` (`notifications.*`), `php/src/Notification/NotificationRunner.php`, `NotificationJobRepository.php`, `NotificationLogContext.php`, `SmtpNotificationTransport.php`. |

## 1.3 GDPR request administration (the register, ESZ-163/164)

| Item | Value |
|---|---|
| Data subjects | Customers exercising a right. |
| Data | Internal id, request type (one of access / rectification / erasure / restriction / portability), reception date, derived deadline date, status, closure instant, the explicitly selected booking references, creation/update instants. **Never stored:** requester e-mail, message, identity document, or any copy of booking customer data (`privacyRequestPolicy.register.neverStored`). |
| Purpose | Record, execute and prove the handling of data-subject requests. |
| Legal basis | Legal obligation of the controller (GDPR art. 12–22) — this framing is the dossier's; the repository states the register's purpose and minimisation, not an article number. |
| Source | The operator, after identifying the requester by a booking reference or an e-mail search; the register stores the selection, not the search input. |
| Storage / system | MySQL `privacy_requests`, `privacy_request_bookings` (migration `0022`); `bookings.processing_restricted_at` (migration `0023`); the export document is generated on request, returned in the response and never persisted. |
| Recipients | The operator; hosting provider. The requester receives the export/answer outside the application (the application does not send it). |
| Retention | **Closed records: three years after `closed_at_utc`**, purged by the daily retention sweep. Open (`received`, `in_progress`) records are never age-purged (`privacyRequestPolicy.retention`). |
| Security / minimisation | Authenticated session + CSRF on every route; explicit scope selection (a shared e-mail never implies every booking); erased bookings excluded from search; anonymisation and lift behind explicit confirmations; register purge never touches a booking and vice versa. |
| Implementation authority | `contracts/booking.ts` (`privacyRequestPolicy`), `php/src/Privacy/*`, `php/migrations/0022_privacy_requests.sql`, `0023_privacy_rights.sql`; procedure in `02-data-subject-rights-procedure.md`. |

## 1.4 Administration, authentication and admin accounts

| Item | Value |
|---|---|
| Data subjects | The site's administrator(s). |
| Data | `admin_accounts`: e-mail, password hash (`password_hash()`, Argon2id/bcrypt), enabled flag, `last_login_at`, timestamps (migration `0001`). `admin_sessions`: opaque id, account id, CSRF token, created / last-seen / idle-expiry / absolute-expiry instants — no IP, no user agent (migration `0002`). Failed logins write a reason and an HMAC-SHA256 fingerprint of the submitted identity keyed by `privacy.logPseudonymizationKey` (required in production), never the address in clear (`php/src/Auth/Authenticator.php`, `php/src/Support/LoginIdentityPseudonymizer.php`). |
| Purpose | Authenticate the operator; protect the back-office; investigate lockouts. |
| Legal basis | Legitimate interest of the controller in securing its own administration surface (dossier framing; the repository states the security rationale in `docs/security-review-v1.md` §7). |
| Source | Account provisioning by the operator (CLI); the administrator's own logins. |
| Storage / system | MySQL, outside the document root; `app.log` on the host. |
| Recipients | Hosting provider only. |
| Retention | Sessions: idle timeout and absolute lifetime are configuration values (example: 60 min idle, 720 min absolute, `php/config/config.example.php`); expired rows are deleted by the bounded garbage collector. Sessions are excluded from backups. Logs: 30 calendar days (§1.5). **Admin account rows: no retention rule is defined** — disabling keeps the row for audit; deletion is not implemented. *Operational policy prerequisite:* decide what happens to an account when an administrator leaves. |
| Security / minimisation | `__Host-` cookie, `HttpOnly`, `Secure`, `SameSite=Strict`, host-only (`contracts/http-contract.ts` `sessionCookie`); id rotated on login; logout destroys the server record first; CSRF token bound to the (anonymous or authenticated) session; login failure indistinguishable across causes; per-address and per-identity login rate limits. |
| Implementation authority | `contracts/http-contract.ts` (`sessionCookie`, `csrfContract`, `loginFailureOutcome`), `php/src/Auth/*`, `php/migrations/0001_admin_accounts.sql`, `0002_admin_sessions.sql`, `0013_session_gc_absolute_expiry_index.sql`. |

## 1.5 Security, rate-limit and application logs

| Item | Value |
|---|---|
| Data subjects | Visitors (rate limiting), the administrator (login diagnostics). |
| Data | `rate_limit_buckets`: `sha256(scope + NUL + subject)` keys, GCRA counters, expiry — **no address and no e-mail in clear** (migration `0010`; `docs/security-review-v1.md` §8). `app.log`, `notifications.log`, `retention.log`, `*-cron.log`: allowlisted operational fields, request diagnostics, login rejection reason + pseudonymous fingerprint, counts. |
| Purpose | Abuse limiting; operations and incident investigation. |
| Legal basis | Legitimate interest in the security and availability of the service (dossier framing). |
| Source | HTTP requests (`REMOTE_ADDR` only, never forwarded headers); application events. |
| Storage / system | MySQL (`rate_limit_buckets`, excluded from backups); `var/log/` on the host, mode `0600`, excluded from backups. |
| Recipients | Hosting provider only. |
| Retention | Rate-limit rows: pruned by the limiter's own expiry sweep (`PdoRateLimiter`). Logs: **30 calendar days**, rotated and pruned by `php bin/maintain-logs.php` (`php/src/Support/LogMaintenance.php`, `RETENTION_DAYS = 30`; operator cron in `docs/eszter-operator-guide.md`). |
| Security / minimisation | Hashing of limiter subjects; pseudonymisation key mandatory in production; allowlisted log fields; logs outside the document root; failing closed. **Host-level Apache access/error logs are not governed by the repository** (*HUMAN*: confirm the Hetzner log retention setting for the domain). |
| Implementation authority | `php/src/Security/*`, `php/src/Support/Logger.php`, `LogMaintenance.php`, `LoginIdentityPseudonymizer.php`, `docs/security-review-v1.md`. |

## 1.6 Backups and restoration

| Item | Value |
|---|---|
| Data subjects | Everyone in §1.1–1.4 (customers, administrators). |
| Data | Database dump (bookings with their customer data as of the archive instant, history, availability, services, admin accounts, notification queue, privacy requests), editorial content JSON, media originals and derivatives, manifest. **Excluded:** `config/config.php` (secrets), `admin_sessions`, `rate_limit_buckets`, `booking_resource_locks`, `var/log/`, in-flight directories (`docs/backup-and-restore.md` §2, `php/src/Backup/BackupSet.php`). |
| Purpose | Restore the service after loss or corruption. |
| Legal basis | Same bases as the data backed up; a backup is a copy, not a new purpose. |
| Source | The live deployment. |
| Storage / system | `eszter-backup-YYYYMMDD-HHMMSS.tar.gz` in the private `backups/` directory on the host, daily after the retention sweep. |
| Recipients | Hosting provider; the operator (downloads). |
| Retention | **Archive policy: at most 30 days** (`backupArchiveRetentionDays`), enforced on the host by `BackupRotation` after each successful backup (ESZ-162). Every restore applies the customer-data retention before reporting success, so restored rows past their cutoff come back anonymised. Copies made elsewhere (operator laptop, other storage) must be deleted on the same clock by the operator; provider-side snapshots are *not* governed by the repository (*HUMAN*: confirm Hetzner snapshot/backup behaviour and its retention for the account). |
| Security / minimisation | Secrets never enter an archive; sessions never restored; symlink/non-regular refusals; a failed backup cannot prune; declared (not discovered) set. Archive encryption at rest is **not** implemented by the repository — the archive is protected by the host's private directory permissions only (*operational policy prerequisite:* decide whether off-host copies are permitted and how they are protected). |
| Implementation authority | `docs/backup-and-restore.md`, `php/src/Backup/*`, `php/bin/backup.php`, `docs/deployment-runbook.md` §5. |

---

## Retention summary

| Data | Rule | Status |
|---|---|---|
| Booking customer PII | 90 days after lifecycle end, then anonymised in place | Repository fact, enforced |
| Booking appointment evidence, history, notification evidence | Kept, non-personal after anonymisation | Repository fact |
| Closed GDPR request records | 3 years after closure, then purged | Repository fact, enforced |
| Open GDPR request records | Never age-purged | Repository fact |
| Backup archives | ≤ 30 days on the host | Repository fact, enforced |
| Application logs | 30 calendar days | Repository fact, enforced by operator cron |
| Admin sessions | Idle / absolute lifetime from configuration | Repository fact |
| Rate-limit rows | Expire with their window | Repository fact |
| Admin account rows | No rule defined | **Operational policy prerequisite** |
| Off-host backup copies, provider snapshots, Apache access logs | Outside the repository | **HUMAN / operational policy prerequisite** |
