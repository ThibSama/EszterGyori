# GDPR V1 compliance dossier (ESZ-166)

**Scope.** The V1 application in this repository at ESZ-165 (`74dbfbac`,
branch `polish/v1-visual-review`): the public site, the booking flow, the
transactional notifications, the admin back-office, the GDPR request centre,
backups and the scheduled maintenance. Target production topology: Hetzner
webhosting, static export + PHP, as `docs/hetzner-target-architecture.md`
describes.

**Date.** 2026-09-12. External public documents cited in this dossier were
verified on that date; the verification date is stated next to each citation.

**Nature.** ESZ-166 is a documentation-and-evidence checkpoint. It adds no
product code. Every statement below is one of three kinds, and each file says
which:

| Kind | Meaning |
|---|---|
| **Repository fact** | Derived from committed code, contracts, migrations, tests or documentation, with the path named. |
| **Verified public fact** | Taken from a provider's or authority's public document, with its title and verification date. |
| **HUMAN prerequisite** | Requires a private account, a production credential, a legal identity value or a provider selection. Not known to the repository; never converted into a compliance claim here. |

The dossier does not restate implementation documents that are already
authoritative. It links to them:

- `docs/hetzner-target-architecture.md` — topology, filesystem, configuration and secrets, cron.
- `docs/backup-and-restore.md` — backup content, exclusions, both retention clocks, restore reconciliation.
- `docs/deployment-runbook.md` — production configuration, SMTP, cron entries, backups, live acceptance.
- `docs/eszter-operator-guide.md` — the operator's day-to-day guide (French).
- `docs/security-review-v1.md` — rate limiting, CSP, logging decisions.
- `contracts/booking.ts` — frozen privacy notice catalog, retention policy, privacy request register and execution semantics.
- `contracts/legal.ts` — the legal-information model and the two public legal pages.

## Files

| # | File | Content |
|---|---|---|
| 1 | [01-processing-register.md](01-processing-register.md) | Register of processing activities: six V1 processing families, data, purpose, basis, storage, recipients, retention, controls. |
| 2 | [02-data-subject-rights-procedure.md](02-data-subject-rights-procedure.md) | Operating procedure for the five V1 rights, the one-month deadline, the extension rule and escalation. |
| 3 | [03-breach-procedure.md](03-breach-procedure.md) | Personal-data breach procedure grounded in CNIL guidance. |
| 3b | [03-breach-register-template.md](03-breach-register-template.md) | Empty internal breach-register template. Real entries are never committed to Git. |
| 4 | [04-processors-and-dpa.md](04-processors-and-dpa.md) | Processor / DPA inventory: confirmed, configurable, and not-yet-selected providers. |
| 5 | [05-cookies-and-trackers.md](05-cookies-and-trackers.md) | Cookies, browser storage and tracker review of the committed frontend. |
| 6 | [06-production-prerequisites.md](06-production-prerequisites.md) | Every human-owned confirmation still outstanding before production. |
| 7 | [07-implementation-evidence.md](07-implementation-evidence.md) | Traceability matrix: GDPR concern → implementation authority → committed test → commit. |

## Status at 2026-09-12

The application-side obligations frozen for V1 (information without consent,
bounded retention, executable rights, restriction of processing, legal pages)
are implemented and covered by committed tests (file 7). What remains is
human-owned: the legal identity values (file 6), the Hetzner DPA in the
customer account, the production SMTP provider and its DPA (file 4), and the
operational retention decisions the repository deliberately leaves open
(file 1, marked *operational policy prerequisite*).
