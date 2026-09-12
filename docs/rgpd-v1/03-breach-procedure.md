# 3. Personal-data breach procedure (V1)

**External basis (verified public facts, verification date 2026-09-12):**

- CNIL, *« Violations de données personnelles : les règles à suivre »*.
- CNIL, *« Sécurité : Gérer les incidents et les violations »*.

Both restate GDPR art. 33 (notification to the supervisory authority) and
art. 34 (communication to the data subject). Nothing in this procedure is
automated by the application; it is the operator's procedure. Repository
facts referenced below are named by path.

## 3.1 What counts as a breach

A *personal-data breach* is any security incident, accidental or unlawful,
leading to the destruction, loss, alteration, unauthorised disclosure of, or
access to, personal data. It is qualified along three axes (a breach may hit
several):

| Axis | Examples for this deployment |
|---|---|
| **Confidentiality** | The database, a backup archive, a downloaded export, the admin mailbox or the operator's laptop read by someone unauthorised; an e-mail sent to the wrong customer; an admin session hijacked. |
| **Integrity** | Booking or customer data altered without authority (a tampered restore, an unauthorised rectification). |
| **Availability** | Loss of the database or of every backup; a ransomware event; a hosting failure with no restorable archive. |

Not every incident is a breach (a failed login burst stopped by the rate
limiter, a rejected upload). Every incident that *may* have touched personal
data is assessed as if it were one until proven otherwise.

## 3.2 Steps

1. **Detect and contain immediately.** Sources: the operator's own
   observation, the host's alerts, `app.log` / `notifications.log` /
   `retention.log` / cron logs (`var/log/`, 30-day retention), the Hetzner
   account, a customer's report. Containment options that exist today:
   rotate the admin password and log out (logout destroys the server-side
   session record; sessions are never in a backup, so a restore never
   resurrects one), rotate the database and
   SMTP credentials in `config/config.php`, rotate
   `privacy.logPseudonymizationKey` if the log fingerprints are exposed,
   restrict `.htaccess`/permissions, take the site down at the host, revoke
   the Hetzner account access that was misused. Do not delete evidence to
   contain.
2. **Qualify** the breach (confidentiality / integrity / availability) and
   establish the timeline: instant of the incident, instant the operator
   **became aware** (the 72-hour clock starts here), instant contained.
3. **Assess the impact and the risk to the persons.** Inputs specific to this
   deployment: which store was touched (live `bookings` = customers with a
   booking in the last ~90 days after lifecycle end; a backup archive = the
   customers as of that archive's day, ≤ 30 days old; the register =
   references only; logs = pseudonymous fingerprints and counters only, no
   customer PII; `rate_limit_buckets` = hashes only); which fields (name,
   e-mail, phone, free-text note — the note may contain data the customer
   typed despite the warning; appointment dates); approximate number of
   persons (the admin bookings summary and the backup manifest's per-table row
   counts give it without opening the data); the likely consequences.
   Classify the risk: **none / unlikely**, **risk**, **high risk**.
4. **Preserve evidence without copying unnecessary PII.** Keep the relevant
   log lines, the backup manifest (`BACKUP-MANIFEST.json`: hashes, row counts,
   migrations — no customer values), timestamps, screenshots of the host
   panel, and the affected archive *in place* under restricted access. Do not
   export customer rows into the incident file; refer to them by count and by
   booking reference where a specific record must be named.
5. **Record the breach in the internal breach register** — for **every**
   breach, including those not notified, with the reasons for not notifying
   (GDPR art. 33(5)). Use `03-breach-register-template.md`. The register is
   private (§3.5).
6. **Notify the CNIL** when the breach is likely to result in a **risk** to the
   rights and freedoms of the persons: **as soon as possible and at most 72
   hours after awareness**, through the CNIL's online notification service.
   Content: nature of the breach, categories and approximate number of persons
   and records, contact point, likely consequences, measures taken or
   proposed. If not everything is known at 72 hours, notify in stages: an
   initial notification, then a complement. If 72 hours are exceeded, the
   notification **states the reasons for the delay** (late-notification
   justification). If the risk is assessed as unlikely, record the decision
   and its justification in the register instead of notifying.
7. **Communicate to the affected persons** when the risk is **high**: without
   undue delay, in clear and plain language, describing the nature of the
   breach, the contact point, the likely consequences and the measures taken
   and recommended. Exceptions (art. 34(3)), each to be justified in the
   register: the data was made unintelligible to the intruder (e.g. encrypted
   with an uncompromised key); subsequent measures ensure the high risk is no
   longer likely to materialise; individual communication would involve
   disproportionate effort, in which case a public communication is made
   instead. The CNIL may require the communication in any case.
8. **Remediate and close.** Fix the cause, decide whether a restore is needed
   (`docs/backup-and-restore.md` §4 — every restore re-applies customer-data
   retention and brings back no session), review what evidence proved insufficient
   (e.g. the absence of application-level access logs is a repository fact),
   record the closure and the owner in the register.

## 3.3 Processor escalation

Every processor (hosting; the future SMTP provider — see
`04-processors-and-dpa.md`) must notify the controller of a breach affecting
the data it processes **without undue delay** (art. 33(2)); the DPA is where
that duty and its contact channel are written. On the controller's side:
treat the moment the processor's notice is received as the moment of awareness
(unless awareness came earlier), and run §3.2 from step 2. Confirm, in each
DPA, the processor's breach contact and its commitment to assist the
controller (art. 28(3)(f)).

## 3.4 What the repository provides, and what it does not

| Provided (repository fact) | Not provided (human/operational) |
|---|---|
| Secrets outside backups; sessions never restored; logs and rate-limit rows never in archives (`php/src/Backup/BackupSet.php`). | Encryption of backup archives at rest. |
| Log allowlist: no customer PII in logs (`NotificationLogContext`, `docs/security-review-v1.md`). | Application-level access audit trail of *who read which booking* (the admin is a single operator; reads are not journaled). |
| Pseudonymous login-failure fingerprints; per-address and per-identity login limits. | Host-level intrusion detection, Apache access-log retention (Hetzner account setting). |
| Row counts in the backup manifest and the admin bookings summary for impact sizing without reading PII. | The breach register itself, the CNIL account and the notification. |
| Restore with retention reconciliation (`BackupRestore`). | The decision to restore, and its communication. |

## 3.5 Where the real register lives

Real incidents, the breach register with its entries, the CNIL
correspondence and any investigation material **are stored in a private
operational register (e.g. an access-restricted document in the operator's
own storage), never committed to Git.** Only the empty template in this
repository is versioned. Committing an entry here would publish the incident
to every clone of the repository and would itself be a disclosure.
