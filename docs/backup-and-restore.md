# Backup and restore (Package 8.2, ESZ-083)

This is the operator procedure for taking a backup of a live deployment and for
putting one back. It also states, explicitly, which parts of "not losing the data"
are the hosting provider's job and which are this application's — because the gap
between those two is where sites are actually lost.

Both commands ship inside `dist/eszter-production.tar.gz` as `app/bin/backup.php`
and `app/bin/restore.php`. Neither needs Node, a shell function, `mysqldump`, a
`tar` binary or any PHP extension beyond what the application already requires.
That is deliberate: a backup tool that depends on something the hosting plan may
have removed is a tool that fails on the one day it matters.

---

## 1. What a backup contains

| Part | Where it lives | Why it is here |
|---|---|---|
| Database rows | `database/dump.sql` | Bookings, their history, availability, services, admin accounts, the notification queue. None of it can be recomputed. |
| Editorial content | `content/draft.json`, `content/published.json`, `content/media-library.json` | The words on the site. Deliberately not in SQL, so a database backup alone restores a site with nothing on it. |
| Media originals | `media-originals/` | The only copy of what the editor actually uploaded. |
| Media derivatives | `media/` | What the site serves. Included rather than rebuilt — see below. |
| Manifest | `BACKUP-MANIFEST.json` | A sha256 for every entry, the applied migrations, per-table row counts, and the exclusions by name. |

The derivatives travel even though they could in principle be regenerated from the
originals. A rebuild runs through whatever GD the restoring host happens to have:
the bytes the site serves would change, every cached copy and every hash of them
would be wrong, and a restore is the last moment anyone wants to discover their
images were quietly re-encoded.

## 2. What a backup deliberately does not contain

| Excluded | Why |
|---|---|
| `config/config.php` | The database and SMTP passwords. A secret in a backup is a secret in every copy of that backup, on every laptop it was ever downloaded to — and restoring it would also restore credentials that may since have been rotated. |
| `admin_sessions` | Live credentials in table form. A restore that brought them back would resurrect sessions somebody deliberately ended. The correct state after any restore is "everyone signs in again". |
| `rate_limit_buckets` | Ephemeral abuse counters with no meaning outside the minutes they were written in, and the one table derived from visitors rather than from the site. |
| `booking_resource_locks` | A serialization row whose only content is its own existence; the migrations recreate it. |
| `var/log/` | Customer names, addresses and phone numbers appear in booking diagnostics. Logs have their own retention and do not belong in a file that gets copied around. |
| `var/tmp/`, `data/locks/`, `.intake/`, `.staging-*` | In-flight state by definition. Every one of them exists only between two moments of a write, and restoring one means restoring a half-finished operation. |
| `app/`, `vendor/`, the rest of `public_html/` | Code and build output. They come from `dist/eszter-production.tar.gz`, which is reproducible from the repository. Including them would multiply every backup's size and let a restore silently downgrade the application. |

The set is **declared**, not discovered by walking the deployment. A declared set
omits a newly-added thing until someone adds it, which is visible in a diff; a
discovered set includes it until someone remembers to exclude it, which is not.
The declaration is `php/src/Backup/BackupSet.php`.

## 3. Taking a backup

```sh
cd /usr/home/<FTP_LOGIN>/eszter
/usr/bin/php app/bin/backup.php \
  --config=/usr/home/<FTP_LOGIN>/eszter/config/config.php \
  --to=/usr/home/<FTP_LOGIN>/eszter/backups
```

It writes `backups/eszter-backup-<YYYYMMDD-HHMMSS>.tar.gz`, mode `0600`, and
prints the entry count, the manifest digest, the applied migrations and a row
count per table.

The command is read-only with respect to the deployment. It creates nothing, seeds
nothing and repairs nothing — a file that is absent is recorded as absent rather
than invented, so two backups of an unchanged site are byte-identical and "has
anything changed?" is a digest comparison.

**The destination must not be inside the document root.** The archive carries every
booking and every customer's name, e-mail address and phone number, and everything
under `public_html/` is served — the file name is a timestamp, which is not much of
a guess. The command refuses rather than trusting the operator to notice.

Treat the archive as the personal-data store it is: `0600` on the host, encrypted
at rest wherever it is copied to, and deleted from anywhere it does not need to be.

### Retention

Not automated, and not by omission. The deployment has exactly one cron entry and
it belongs to notifications (`docs/deployment-runbook.md` §4); a second one is an
operator decision about a schedule and a retention window that this repository
cannot make on their behalf. A reasonable starting point is a daily backup kept for
thirty days plus a monthly one kept for a year, and the command is safe to run from
cron unattended — it exits non-zero and writes nothing on failure.

## 4. Restoring

```sh
cd /usr/home/<FTP_LOGIN>/eszter
/usr/bin/php app/bin/restore.php \
  --config=/usr/home/<FTP_LOGIN>/eszter/config/config.php \
  --from=/usr/home/<FTP_LOGIN>/eszter/backups/eszter-backup-20260821-020000.tar.gz \
  --overwrite --allow-production
```

### Order of operations

1. Read the archive and parse its manifest.
2. Check **every** entry against its recorded sha256, in both directions: nothing
   declared may be missing or altered, and nothing undeclared may be present.
3. Run migrations, so the target is on a schema this application built.
4. Check the safety refusals.
5. Only now: empty the declared tables and load the dump, in one transaction; then
   write the content and media files, each through a temporary name and a rename.

Nothing in the target changes until steps 1–4 have all passed. A restore that
discovered corruption in the last file would already have replaced the database
with the first, which is how a bad backup becomes a lost site.

### The two refusals

| Flag | Required when | The mistake it catches |
|---|---|---|
| `--overwrite` | The target already holds data | The accident: you meant the staging configuration and typed the production one. Emptiness is judged by rows and by `published.json`'s revision, so a freshly-migrated database is empty and a real site never is. |
| `--allow-production` | The configuration names a production environment | The deliberate act that still deserves a second sentence, because "restore production from last night" and "restore production from last night onto the wrong host" look identical until afterwards. |

Neither has a default that says yes, and neither has a short form.

### Schema direction

The dump carries **rows only**; the schema comes from `migrations/`. So a backup
taken at migration 9 restores cleanly onto the code of migration 10 — the new
column arrives with its declared default. A backup from a *newer* schema than the
target is refused instead: it may carry columns this code has nowhere to put, and
dropping them silently would be data loss reported as success. Restore it with the
release it was taken from.

### After a restore

- **Everyone signs in again.** Sessions are not in the backup.
- **Check the notification queue before the next cron tick.** Jobs come back in the
  state they were saved in, and the runner will resume them. A restore that rolls
  the site back by a day can leave confirmations that have already been sent, or
  reminders whose window has passed — the runner retires stale reminders on its own
  (ESZ-072), but look before letting a tick fire at real customers.
- **Rate limits start empty.** Expected, and harmless: an empty bucket is
  indistinguishable from one idle for a full period.

## 5. Who is responsible for what

This is the division that gets assumed rather than agreed, so it is written down.

**The hosting provider owns the infrastructure copy.** Hetzner Web Hosting keeps
its own snapshots of the account's filesystem and databases, on its own schedule
and its own retention, restorable through konsoleH. That is what covers a failed
disk, a lost host or a filesystem-level accident, and none of it is something this
application can do or should try to replace.

Two things it does *not* cover, and both are why the tool above exists:

- **Granularity and portability.** A provider restore is of the account, at a
  moment the provider chose, into the provider's own environment. It cannot give
  you the content JSON as it was on Tuesday while leaving today's bookings alone,
  and it cannot be restored anywhere else — including onto a laptop, which is where
  a restore should be rehearsed.
- **Coherence.** This deployment's state is split across MySQL and the filesystem
  by design (`docs/hetzner-target-architecture.md` §4). A copy of each taken
  independently can disagree: a booking with no content revision to render it, or a
  `media-library.json` naming a file the filesystem snapshot predates. The archive
  is taken by one process in one pass, and its manifest is what proves the halves
  belong together.

**The deployment owner owns everything else**: running the backup on a schedule,
keeping the archives somewhere other than the host they came from, keeping them
encrypted, deleting them when their retention expires, and — the part that is
always skipped — rehearsing a restore into a scratch database before the day it is
needed for real.

**This repository owns the proof that a restore works.** `sql:backup-restore` takes
a realistic deployment, backs it up, restores it into a second empty database and a
second empty directory, and then checks the things a person would actually notice:
the published headline, the booking with its accented customer name and phone
number, the history events, the notification jobs, the availability rules, and both
media files byte for byte. A backup that has never been restored is a hypothesis,
so the gate is the deliverable and the command is only how it is used.

## 6. Rehearsing a restore

Do this before you need it, and do it somewhere disposable.

```sh
# A scratch database whose name ends in `_test`, and a scratch directory.
# Point a copy of config.php at both, leave `environment` as `test`, then:
/usr/bin/php app/bin/restore.php --config=/path/to/scratch-config.php --from=<archive>
```

No flags are needed against an empty target, which is the point: if the restore
asks for `--overwrite`, the target was not empty and the rehearsal would not have
proved anything.

## 7. What is still deployment-owned

- The provider-side snapshot schedule and retention, which is a konsoleH setting.
- Where archives are stored off-host, and their encryption at rest.
- The cron entry, if backups are automated.
- One rehearsed restore on the real host before launch.

None of these can be proved from this repository, and none of them is claimed here.
