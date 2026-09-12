# 4. Processors and DPA inventory (V1)

A *processor* here is a third party that processes customer or administrator
personal data on the controller's behalf in **production**. Development, CI
and build tooling that never sees production personal data is listed
separately so it is not mistaken for a processor.

Legend: **Repository fact** / **Verified public fact (2026-09-12)** /
**HUMAN** prerequisite.

## 4.1 Confirmed architecture provider

### Hetzner (webhosting) — hosting of the site, the PHP runtime, MySQL, files, backups, cron

| Question | Answer | Kind |
|---|---|---|
| Is it the production architecture? | Yes: `docs/hetzner-target-architecture.md` — static frontend + PHP on Hetzner webhosting (Apache + PHP-FPM, MySQL, konsoleH cron). No Node runs on the host. | Repository fact |
| Personal data processed | Everything in `01-processing-register.md`: bookings, notification queue, admin accounts and sessions, privacy requests, logs, backup archives. | Repository fact |
| Art. 28 data-processing agreement | Hetzner's official documentation states that a data-processing agreement (DPA, *AVV*) under GDPR art. 28 is available and is concluded through the Hetzner customer account. | Verified public fact, 2026-09-12 |
| Sub-processors and TOMs | Hetzner publishes its subcontractor (sub-processor) list and its technical and organisational measures (TOM) documentation. | Verified public fact, 2026-09-12 |
| Has the DPA been concluded for the operator's account? | **Unknown to the repository.** No private-account evidence exists in the repository, and this dossier does not claim it. | **HUMAN** |
| Data location / transfers | Not asserted here; to be read from the DPA and the subcontractor list at conclusion time and recorded in the private inventory. | **HUMAN** |
| Breach contact | To be taken from the DPA and recorded in the private breach register (see `03-breach-procedure.md` §3.3). | **HUMAN** |

**Production prerequisite (HUMAN): confirm/execute the Hetzner DPA in the
customer account before production**, keep the executed copy and the
subcontractor list version in the private operational file, and record the
date in `06-production-prerequisites.md`'s private counterpart.

## 4.2 Deployment-selected, externally configurable providers

### SMTP e-mail delivery — provider deliberately not selected

| Question | Answer | Kind |
|---|---|---|
| What the code does | Delivery through a provider-neutral transport; production selects `smtp` (Symfony Mailer) with mandatory STARTTLS or implicit TLS; a production `encryption = none` is refused at configuration load. | Repository fact (`php/src/Notification/SmtpNotificationTransport.php`, `docs/deployment-runbook.md` §2, §4) |
| Provider in committed configuration | **None.** `php/config/config.example.php` ships `smtp.example.invalid`; the runbook states *"No Hetzner endpoint, credential or mail tariff is assumed"* and *"Do not send a probe message until the deployment owner has supplied an approved SMTP account."* | Repository fact |
| Personal data the provider will see | Customer e-mail address and name, appointment facts, the operator's sender address — in every transactional message. | Repository fact |
| Is it a processor today? | **No processor exists yet** because no provider exists yet. This dossier does not name one and does not call any candidate a processor. | — |

**Production prerequisites (HUMAN), all before the first production message:**

1. Identify the SMTP provider (it may be Hetzner's own mail service or a third party — the repository does not decide).
2. Review and, where applicable, conclude that provider's DPA / art. 28 terms.
3. Review the provider's hosting location and any international transfer, and the safeguards relied on.
4. Add the provider to this inventory (§4.1-style row) and to the recipients wording if the category "e-mail delivery provider" would no longer describe it.
5. Configure SPF/DKIM/DMARC for the sending domain (`docs/hetzner-target-architecture.md` §11).

### SMS — no V1 processor

| Question | Answer | Kind |
|---|---|---|
| Does V1 send SMS? | No. The `sms` channel is a column and a setting that is **off by default and never enabled by the application**; no SMS transport is registered; enabling the channel without a transport stops the runner before it claims anything. | Repository fact (`contracts/booking.ts` `notifications`, `php/src/Notification/NotificationTransportRegistry.php`) |
| Does the production target depend on SMS? | No. `docs/hetzner-target-architecture.md` §11 records SMS as a future integration boundary whose provider, endpoint and cost are unconfirmed. | Repository fact |
| Processor | **None.** Do not list one. If SMS is ever enabled, the provider becomes a processor and this inventory, the notice recipients and the register must be updated first. | — |

## 4.3 Not-yet-selected production providers

| Provider role | Status | Prerequisite |
|---|---|---|
| SMTP e-mail delivery | Not selected (§4.2). | HUMAN: selection + DPA + transfer review + inventory update. |
| Off-host backup storage (if the operator keeps copies outside the Hetzner `backups/` directory) | Not defined by the repository; `docs/backup-and-restore.md` §3 makes off-host copies an operator responsibility on the same 30-day clock. | HUMAN / operational policy: decide whether copies leave the host; if a storage provider is used it is a processor and needs a DPA. |
| Domain registrar / DNS | Not in the repository. | HUMAN: not a personal-data processor unless it also relays mail; record for completeness. |

## 4.4 Not processors — development, preview and build tooling

| Tool | What it touches | Why it is not a production processor |
|---|---|---|
| **Vercel** (historical preview / build) | Front-end builds and previews of the static export. `front/README.md` §"Vercel (historique)" states the previewed runtime configuration no longer exists; `.github/workflows/quality-gate.yml` has *"no Vercel coupling"*; `docs/hetzner-target-architecture.md` says the Vercel plan is *"no longer the production plan"*. | Production hosting is Hetzner / static PHP. A preview build has no production database, no bookings and no customer data. If a preview is still used, it must never be pointed at production data or credentials. |
| **GitHub** (repository, CI) | Source code, contract artifacts, tests with fixture data. | No production personal data is committed (this dossier's rule in `03-breach-procedure.md` §3.5 keeps it that way). |
| **Google Fonts via `next/font/google`** | Font files are fetched **at build time** and self-hosted in the export; the committed CSP is `font-src 'self'`. | No visitor request reaches Google at runtime (`05-cookies-and-trackers.md` §5.3). |
| **Instagram** (outgoing links in site content) | The visitor's own navigation after clicking. | An outgoing link is not a processing on the controller's behalf. No embed, no pixel, no script. |
| Local development (`compose.dev.yml` MySQL, the logging transport, `encryption = none`) | Developer machines only. | Production refuses the development transport and plaintext SMTP. |

## 4.5 Summary table

| Provider | Role | Personal data | DPA status | Outstanding HUMAN action |
|---|---|---|---|---|
| Hetzner | Production hosting, DB, files, backups, cron | All | DPA **available** via customer account (verified 2026-09-12); **conclusion not evidenced** | Confirm/execute the DPA in the account before production; record sub-processor list version and breach contact. |
| SMTP provider | Transactional e-mail | Customer e-mail, name, appointment facts | **No provider selected** | Select, review/conclude DPA, transfer review, inventory update. |
| SMS provider | — | — | **Not applicable in V1** | None (do not add). |
| Vercel | Preview/build tooling | None in production | Not a production processor | Keep previews away from production data. |
