# Backup and restore (Phase 9, ESZ-083 / ESZ-097 / ESZ-098)

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
| `var/log/` | Logs contain no clear customer PII by default, but remain operational data: the declared set excludes them, unsafe overlap with a walked media directory is refused, and logs have their own bounded retention. |
| `var/tmp/`, `data/locks/`, `.intake/`, `.staging-*` | In-flight state by definition. Every one of them exists only between two moments of a write, and restoring one means restoring a half-finished operation. |
| `app/`, `vendor/`, the rest of `public_html/` | Code and build output. They come from `dist/eszter-production.tar.gz`, which is reproducible from the repository. Including them would multiply every backup's size and let a restore silently downgrade the application. |

The set is **declared**, not discovered by walking the deployment. A declared set
omits a newly-added thing until someone adds it, which is visible in a diff; a
discovered set includes it until someone remembers to exclude it, which is not.
The declaration is `php/src/Backup/BackupSet.php`.
Before any database export, backup also refuses a topology where `paths.log` is
equal to or below either media directory. This closes the only configuration route
by which the flat media walk could otherwise collect a log file.

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

The command does not mutate durable application state. It may create/open the
excluded `data/locks/application-snapshot.lock`, but it creates, seeds and repairs
no database row, content document or media asset. A content file that is absent is
recorded as absent rather than invented.

### Coherent snapshot boundary

A **coherent snapshot** is the complete declared `BackupSet` at one application
barrier interval: every included MySQL table and its manifest row count come from
one `REPEATABLE READ` transaction started with `START TRANSACTION WITH CONSISTENT
SNAPSHOT`, while draft/published content, the media catalogue, originals and
derivatives are read before the exclusive application barrier is released. The
manifest hashes then prove the bytes of that already-coherent state; hashes are
not used as a substitute for coherence.

The barrier is local advisory `flock()` at
`data/locks/application-snapshot.lock`, compatible with PHP on Hetzner shared
hosting and dependent on `data/` being a local filesystem. A backup holds it
exclusive. Participating mutations hold it shared for their complete logical
write, so ordinary writers remain concurrent with each other but cannot cross a
backup:

- all SQL writes made by the production `Database` connection, including every
  transaction that changes the tables in `BackupSet`; migrations hold it across
  their complete run;
- draft save, publish and reset, unconditional content writes and first-use
  seeding;
- media finalisation (catalogue + original + derivative) and deletion (reference
  check + catalogue + both files); intake and staging remain excluded transient
  work until finalisation;
- restore takes the barrier exclusively across its database and filesystem
  replacement, also excluding ordinary mutations from the replacement window.

Inside the snapshot barrier, media deletion and content writes are additionally
serialised against each other by `data/locks/media-content.lock` (ESZ-100): a
content write must never commit a fresh media reference between a delete's
reference check and its removal, because the two used to lock different domains
(`media.lock` vs `content.lock`). The delete takes that boundary **exclusively**
across its whole check-to-commit critical section; every content write that can
make a media reference durable — draft save, publish, reset and the raw envelope
writers — takes it **shared**, so ordinary saves stay concurrent with each other
and queue only behind an actual delete. Media finalisation (upload) does not take
it: it never reads content. First-use seeding writes canonical, reference-free
defaults and also stays outside it.

Lock ordering is fixed: application snapshot barrier first; then the
media-content boundary; then a content or media file lock, or a MySQL
transaction. Media deletion retains its existing `media.lock` then `content.lock`
order, now inside the exclusive boundary. No production path begins a MySQL
transaction and then tries to acquire the application barrier, and no content
path takes `content.lock` — and no path takes `media.lock` or `content.lock`
before the media-content boundary — so there is no inverse order to deadlock on.
This removes the obvious barrier/transaction, boundary and barrier/content/media
deadlock cycles.

The one deliberate domain-order inversion is ESZ-147's managed-reference check:
a draft save or publish verifies, inside its exclusive `content.lock`
acquisition and still under the shared boundary, that the managed media src
values it is about to commit are all catalogued, and that catalogue read takes
`media.lock` **shared after** `content.lock`. It cannot deadlock with the
delete's `media.lock` → `content.lock` order because the delete — the only
exclusive `media.lock` holder that also waits on `content.lock` — needs the
boundary exclusively, while every content writer holds it shared across its
whole check-to-commit critical section, so the two critical sections can never
overlap; and no other `media.lock` holder ever takes `content.lock` or the
boundary. The two one-way edges sit on mutually exclusive sides of the boundary
and can never co-activate into a cycle.

Archive publication remains separate from snapshot capture. The destination file
is reserved as `<final>.partial` and restricted to `0600` before any customer data
is written; only a completed archive is atomically renamed to its final name. Any
exception releases the MySQL transaction and application barrier through `finally`
paths and never publishes a final archive.

**The destination must not be inside the document root.** The archive carries every
booking and every customer's name, e-mail address and phone number, and everything
under `public_html/` is served — the file name is a timestamp, which is not much of
a guess. The command refuses rather than trusting the operator to notice.

Treat the archive as the personal-data store it is: `0600` on the host, encrypted
at rest wherever it is copied to, and deleted from anywhere it does not need to be.

### Retention

Two retention clocks apply to the archives this command produces, and both are
frozen product policy — `contracts/generated/booking-domain.json` under
`customerDataRetention` — not statutory claims. The repo does not enforce
either by itself; the schedules below are the operator side of that policy.

**Booking customer data.** Confirmed bookings keep their customer data for 90
days after `ends_at_utc`; cancelled bookings for 90 days after
`cancelled_at_utc`. Past that, the customer fields (name, e-mail, phone, note,
cancellation reason) are erased to the frozen placeholders and the row carries
a `customer_data_erased_at` timestamp; the booking, its history and its
notification evidence are never deleted. Erasure is applied by the retention
sweep (`app/bin/apply-booking-retention.php`, see
`docs/deployment-runbook.md` §4) and — critically for this document — by every
restore, before the restore reports success.

**Application archives.** An archive carries every booking's customer data by
design, so an archive is itself a personal-data store with a bounded life: at
**most 30 days**. Delete archives older than that from the host and from
anywhere they were copied to. The previous suggestion of a monthly archive kept
for a year is withdrawn: it contradicts the 30-day ceiling. A reasonable
starting point is a daily backup deleted after 30 days. Provider-side
snapshots are an external policy check, not governed here and not enforced by
this repository.

The command is safe to run from cron unattended — it exits non-zero and writes
nothing on failure.

## 4. Restoring

```sh
cd /usr/home/<FTP_LOGIN>/eszter
/usr/bin/php app/bin/restore.php \
  --config=/usr/home/<FTP_LOGIN>/eszter/config/config.php \
  --from=/usr/home/<FTP_LOGIN>/eszter/backups/eszter-backup-20260821-020000.tar.gz \
  --overwrite --allow-production
```

### Order of operations

1. Authorize production explicitly, then read the archive under its entry-count,
   per-entry and cumulative uncompressed limits.
2. Parse the manifest and check **every** entry against its sha256 in both
   directions: nothing declared may be missing or altered, and nothing undeclared
   may be present.
3. Fully parse the SQL as hostile input. Every executable line must be exactly one
   `INSERT` into a table in `BackupSet::TABLES`, with exporter-shaped columns and
   literals, one terminator and no trailing statement. The target migration rows
   are retained rather than imported.
4. Validate schema direction, overwrite safety, content envelopes, media catalogue,
   catalogue/file agreement, media types, dimensions and storage ceilings. This is
   also a read-only check for pending migrations. A populated target with any
   pending migration is refused; restore never applies DDL to it.
5. Write and sync every restored file into private staging directories beside its
   destination. No live file has changed yet. An empty target may now run pending
   migrations.
6. Begin the database replacement transaction. Move each existing restore-owned
   file to a private rollback directory, install staged files, and move stale owned
   files absent from the archive aside. Commit SQL only after file installation is
   complete. Any throwable before that commit rolls SQL back and moves every old
   file back before reporting failure.
7. **Apply customer-data retention to the restored rows** (ESZ-140), still inside
   the replacement transaction and before any success is reported. An archive may
   carry booking PII whose 90-day period expired while the archive was sitting in
   `backups/`; the same retention sweep that runs on a schedule runs here against
   the restored rows, retiring the pending/processing notification jobs of the
   bookings it erases. A reconciliation failure is a restore failure: it rolls the
   rows, the erasures and the moved files back through the same compensation path,
   so a restore can never report success while expired PII is live or while a job
   that could deliver from an erased row is pending.

This is explicit cross-store compensation, not global atomic rename: individual
renames are atomic only for their own paths. Deterministic failure injection proves
failures before DB replacement, after row replacement and during installation all
return the database, draft/published JSON, media catalogue, originals and
derivatives to the complete old state.

An uncatchable process or host failure during the short live-file installation
window can leave the private rollback material on disk and requires operator
recovery; MySQL and POSIX filesystems do not provide one transaction across both
stores. The application does not mislabel per-file rename as global atomicity, and
does not require provider snapshots to make ordinary restore failures safe.

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

### Restore ownership and overwrite reconciliation

Restore owns only the three declared content names and flat media files whose names
match the frozen media asset-id and extension contract. On overwrite, owned files
that are absent from the verified archive are removed through the same reversible
installation transaction. This removes stale catalogue files, originals and
derivatives without walking or replacing the rest of the deployment. Other names,
subdirectories, transient intake/staging files and symlinks are not claimed;
unrelated files are preserved, and a symlink collision at an owned target is a
refusal.

### Archive expansion bounds

Tar size headers must be canonical POSIX octal and fit a PHP integer. They are
validated before body allocation. A member is limited to 128 MiB, retained member
bytes to 512 MiB in total, and an archive to 10,000 entries; decompressed header and
padding bytes are bounded too. Duplicate paths, overflow or malformed sizes,
unsupported types, truncated padding, oversized members and cumulative expansion
are all fail-closed refusals.

### After a restore

- **Everyone signs in again.** Sessions are not in the backup.
- **Retention was already reconciled.** Restored bookings whose customer data was
  past the 90-day retention cutoff at restore time were anonymized — and their
  pending/processing notification jobs retired — inside the restore, before it
  reported success. Their history and their terminal notification evidence
  survived, anonymized rows included.
- **Check the remaining notification queue before the next cron tick.** Jobs of
  live bookings come back in the state they were saved in, and the runner will
  resume them. A restore that rolls the site back by a day can leave confirmations
  that have already been sent, or reminders whose window has passed — the runner
  retires stale reminders on its own (ESZ-072), but look before letting a tick
  fire at real customers.
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
  by design (`docs/hetzner-target-architecture.md` §4). Provider copies may take
  the halves independently. The application archive instead uses the explicit
  barrier and MySQL snapshot described above; its manifest proves byte integrity
  after that coordination has proved which logical state the bytes belong to.

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
