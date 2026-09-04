# Production deployment runbook (Package 8.1)

This is the operator procedure for the Hetzner Web Hosting target. It prepares and
proves the deployable inputs; it does not claim that a host, domain, database, SMTP
account or cron entry exists. Replace every `<PLACEHOLDER>` below with a value from the
hosting account. Never put those values in Git or in the production archive.

## 1. Build the deterministic artifact

On the build machine, from the repository root:

```sh
npm ci --prefix front
composer install --working-dir=php --no-interaction
npm run package:production
npm run verify:production-artifact
```

The result is `dist/eszter-production.tar.gz`. The build uses the committed frontend
and Composer lock files. Composer is installed into the staging tree with `--no-dev`
and an authoritative class map. The verifier checks every staged file against
`ARTIFACT-MANIFEST.json`, checks that a second archive is byte-identical, and rejects
development packages, tests, caches, source maps, Node modules, configuration files
and environment files. Node and Composer are build-time tools only.

Upload the archive outside the document root, create the release directory and extract
the archive's single top-level directory into it (use the hosting file manager or the
equivalent shell commands):

```sh
mkdir /usr/home/<FTP_LOGIN>/eszter
tar -xzf /usr/home/<FTP_LOGIN>/eszter-production.tar.gz --strip-components=1 -C /usr/home/<FTP_LOGIN>/eszter
```

Configure the domain's document root as:

```text
/usr/home/<FTP_LOGIN>/eszter/public_html
```

The extracted layout is:

```text
eszter/
├── public_html/                 only web-reachable directory
│   ├── index.html, _next/, …    static Next export
│   ├── api/index.php            only web-exposed PHP file
│   ├── media/.htaccess          inert, whitelisted derivatives
│   └── .htaccess                routing and hardening
├── app/
│   ├── bin/                     production operator commands
│   ├── contracts/               generated runtime contracts
│   ├── migrations/              ordered SQL migrations
│   ├── src/                     PHP application
│   └── vendor/                  production Composer set
├── config/                      empty until the operator creates config.php
├── data/content/                writable application state
├── data/media-originals/.intake/ writable, never web-served
├── data/locks/                  writable locks
├── var/log/                     writable logs
├── var/tmp/                     writable atomic-write staging
└── backups/                     private retention location
```

Keep directories `0750` and private files `0640` — the content JSON finals
(`draft.json`, `published.json`, `media-library.json`) and the stored media
originals. `config/` is `0700` and `config/config.php` must be `0600`. The
upload intake and the application log file (`var/log/app.log`) are `0600`, as
are the backup archives. `public_html/` directories/files are `0755`/`0644`,
served media derivatives included.
The hosting account's PHP process must own, or have write permission to,
`public_html/media`, `data/content`, `data/media-originals`, `data/locks`, `var/log`,
and `var/tmp`.
`data/` and `var/tmp/` must remain on the same filesystem so atomic renames stay atomic.

Do not move `app`, `config`, `data`, `var` or `backups` below `public_html`. The
artifact verifier establishes this separation offline; a deployed private-path HTTP
check remains mandatory before launch.

## 2. Create production configuration

Copy `php/config/config.example.php` from the repository through a secure operator
channel to `/usr/home/<FTP_LOGIN>/eszter/config/config.php`, replace all placeholders,
then set mode `0600`. The example deliberately ships outside the artifact so a real
configuration cannot be mistaken for a packaged default.

Required production values include the MySQL DSN/user/password and the SMTP host,
port, encryption mode, authentication choice and credentials, sender address/name,
bounded timeout, and canonical customer instructions/contact. No Hetzner endpoint,
credential or mail tariff is assumed. Production configuration validation refuses
empty values, placeholders, insecure session cookies, an unreadable/over-permissive
config file, invalid paths, invalid database settings and incomplete SMTP settings.
SMTP encryption is part of that boundary: production accepts `starttls` (mandatory
STARTTLS — never an opportunistic downgrade to plaintext) or `smtps` (implicit TLS)
only, and a production `notifications.email.encryption = none` is refused at
configuration load, before the runner can claim or deliver anything. `none` exists
for development/test relays only, where plaintext SMTP is deliberate.

After installing the release and its private `0600` configuration, run the required
host-side production preflight as the same runtime identity that serves PHP:

```sh
cd /usr/home/<FTP_LOGIN>/eszter/app && /usr/bin/php bin/preflight-production.php \
  --config=/usr/home/<FTP_LOGIN>/eszter/config/config.php
```

`preflight:production PASS` proves that the configured application log can be
created, opened for append, restricted to exactly `0600`, written completely and
flushed. It leaves one context-free probe line in `var/log/app.log`. A non-zero exit
blocks deployment completion; correct the named host component and rerun it.

## 3. Provision or update the database

Create the empty database and account in the Hetzner control panel, then put the
issued values in `config/config.php`. No manual schema SQL is part of deployment. Use
this one command both for a blank database and every later deployment:

```sh
cd /usr/home/<FTP_LOGIN>/eszter && /usr/bin/php app/bin/migrate.php --config=/usr/home/<FTP_LOGIN>/eszter/config/config.php
```

Select PHP 8.2 or newer for the domain in konsoleH. `/usr/bin/php` then uses that
configured version. The command acquires the migration lock, validates checksums,
applies pending files in order and records them. On an already-current database it
prints `Already up to date; nothing was applied.` and exits successfully. Missing or
invalid configuration, connectivity failures and migration drift exit non-zero with
credential-safe diagnostics. `--status` is read-only and may be used to list applied
and pending versions.

After migrations, provision application records with the dedicated commands only as
needed; they are not schema steps:

```sh
/usr/bin/php app/bin/provision-booking-service.php --config=/usr/home/<FTP_LOGIN>/eszter/config/config.php --key=brows --duration=90 --buffer-before=15 --buffer-after=15
/usr/bin/php app/bin/provision-admin.php --config=/usr/home/<FTP_LOGIN>/eszter/config/config.php
```

The admin password is read interactively or from standard input, never an argument.
Repeat `provision-booking-service.php` per service key to update or disable
(`--disable`) it.

The booking command takes no `--label` (AUD-14): the stored booking label is the
title of the matching item in the *published* SiteContent document — the item whose
`id` is the `--key` — so the CMS stays the single label authority and re-provisioning
after a published title change refreshes the stored copy. The command therefore
refuses, without touching `booking_services`, when the key is unknown or when no
published content exists yet: publish the site content from the admin editor (or let
the first site request initialize the content store with the canonical defaults)
before first provisioning. Unknown keys, invalid published content and the now-rejected
`--label` option all exit non-zero and change no row.

## 4. Configure SMTP and the cron entries

Do not send a probe message until the deployment owner has supplied an approved SMTP
account and recipient. The application uses Symfony Mailer and the production runner
explicitly selects `smtp`; production refuses the development logging transport.

In konsoleH's Cron Job Manager create one job with:

- cadence: every minute (`* * * * *`);
- mode: **exclusive** (Hetzner requires this for intervals shorter than two hours);
- working directory: `/usr/home/<FTP_LOGIN>/eszter/app`;
- PHP version: the domain's configured PHP, at least 8.2;
- command:

```sh
cd /usr/home/<FTP_LOGIN>/eszter/app && /usr/bin/php bin/run-notification-jobs.php --config=/usr/home/<FTP_LOGIN>/eszter/config/config.php --transport=smtp >> /usr/home/<FTP_LOGIN>/eszter/var/log/notification-cron.log 2>&1
```

Absolute paths are intentional: Hetzner cron does not infer the application's working
directory. One tick recovers leases, retires stale reminders, claims a bounded batch
and exits; database leases also make overlap safe. A non-zero exit or output in the
cron log requires attention. After creating the live entry, run it once from the Cron
Job Manager, inspect its output and confirm that the next scheduled run occurred.
Hetzner notes that the panel reporting a cron execution does not itself prove the
command succeeded, so inspect the command output/log.

A second job runs the **customer-data retention sweep** (ESZ-140). Daily is the
right cadence: bookings only become eligible 90 days after their lifecycle ends,
and the sweep is idempotent, so even a missed or doubled run is harmless:

- cadence: daily (e.g. `15 3 * * *`);
- mode: no exclusivity requirement applies at this cadence;
- working directory: `/usr/home/<FTP_LOGIN>/eszter/app`;
- PHP version: the domain's configured PHP, at least 8.2;
- command:

```sh
cd /usr/home/<FTP_LOGIN>/eszter/app && /usr/bin/php bin/apply-booking-retention.php --config=/usr/home/<FTP_LOGIN>/eszter/config/config.php >> /usr/home/<FTP_LOGIN>/eszter/var/log/retention-cron.log 2>&1
```

The sweep erases — per the frozen policy in `contracts/generated/booking-domain.json`
(`customerDataRetention`) — the customer data of bookings past their 90-day period
and retires their pending/processing notification jobs; it never deletes a booking,
a history row or a notification job. It prints and logs counts and the cutoff only:
no booking reference and no customer value ever reaches its stdout or
`var/log/retention.log`, which is what makes the cron log safe to keep and to read.
A non-zero exit requires attention, and a failure changes nothing: each booking is
erased in its own transaction.

These path, interpreter and scheduling rules come from Hetzner's official
[Cron Job Manager documentation](https://docs.hetzner.com/managed/administration-on-konsoleh/cronmanager/).
The relationship between `/usr/bin/php` and the version selected in konsoleH is
documented in Hetzner's official
[PHP configuration guide](https://docs.hetzner.com/de/managed/webserver/php-configuration/).

The cron jobs and a mailbox receipt are deployment-owned acceptance checks. They are
not simulated with invented credentials. SMS is deferred post-V1 and has no cron or
configuration requirement here.

## 5. Backups

Two commands ship with the artifact:

```sh
cd /usr/home/<FTP_LOGIN>/eszter
/usr/bin/php app/bin/backup.php --config=<CONFIG> --to=/usr/home/<FTP_LOGIN>/eszter/backups
/usr/bin/php app/bin/restore.php --config=<CONFIG> --from=<ARCHIVE> [--overwrite] [--allow-production]
```

`backup.php` is read-only with respect to the deployment and writes one `0600`
archive holding the database rows, the content JSON and the media originals and
derivatives, with a sha256 for every entry. It refuses a destination inside the
document root: the archive carries every customer's name, e-mail address and phone
number, and everything under `public_html/` is served.

It never carries configuration, secrets, logs, locks, temporary files, in-flight
uploads, sessions, rate-limit counters or application code — code comes from this
artifact, which is reproducible from the repository.

`restore.php` verifies every entry against the manifest and migrates the schema
**before** writing anything, and refuses a populated target without `--overwrite`
and a production configuration without `--allow-production`. After any restore,
every admin session is gone. Restored bookings whose customer-data retention
period had already expired at restore time are anonymized — and their
pending/processing notification jobs retired — inside the restore, before it
reports success (ESZ-140); the remaining notification queue should be inspected
before the next cron tick.

The full procedure, the exclusion rationale, retention policy (a 30-day ceiling
for application archives, 90-day booking customer-data erasure) and the split
between provider-owned and application-owned responsibility are in
`docs/backup-and-restore.md`. Rehearse a restore into a scratch database before
launch; a backup that has never been restored is a hypothesis.

## 6. Configure the abuse limits (nothing to do)

ESZ-084's rate limiter needs no configuration. Its buckets are frozen in
`http-contract.json` and its state lives in the `rate_limit_buckets` table, created
by migration `0010` in step 3. It charges the connection's `REMOTE_ADDR` and never
a forwarding header, so putting this application behind a proxy that rewrites the
client address would silently collapse every per-address bucket into one — do not,
without the contract change that would make it safe.

## 7. Live acceptance still required

Before launch, prove on the actual host: the required production preflight above
reports `preflight:production PASS`; Apache applies both `.htaccess` files; HTTPS and
security headers are present — including the `Content-Security-Policy` and
`Permissions-Policy` ESZ-084 added, which need `mod_headers`; private sibling paths
are unreachable; the PHP version/extensions match; config mode is `0600`; a migration
second run is a no-op; the exclusive cron runs on schedule; one approved SMTP message
reaches its mailbox; and one backup has been taken and restored into a scratch
database. The host-side preflight is required before deployment or acceptance can be
completed. A passing HTTP readiness probe proves serving dependencies only and, by
itself, must never declare production acceptable. The repository's browser and
deployed-origin smoke gates remain `NOT RUN` until those prerequisites exist.

Enable the HTTPS redirect and HSTS only once a certificate exists. Both are committed
commented-out rather than omitted, because a browser remembers HSTS long after the
header is withdrawn and sending it early is an outage nobody can take back.
