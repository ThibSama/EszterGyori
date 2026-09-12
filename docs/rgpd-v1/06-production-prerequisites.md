# 6. Production prerequisites still requiring human confirmation

This is a **checklist, not data**. The repository intentionally starts with
*unknown* legal values rather than placeholders (`contracts/legal.ts`:
`emptyLegalInformation()` is all-`null`; the public projection drops an unset
fact rather than showing a gap). Nothing below is filled in from a guess, and
this file must never be edited to contain the real values — they are entered
by the operator in `/admin/settings > Informations juridiques` and live in the
`system_settings` row `legal.information`.

Legend: ☐ open (nothing in the repository proves it) — the private operational
file records the date each item was done.

## 6.1 Legal information (ESZ-165 authority: `contracts/legal.ts`)

Required — the admin form warns until each is set or declared not applicable
(`legalWarningFields`, `LEGAL_WARNING_MESSAGES`):

| ☐ | Field | Admin warning text | Who supplies |
|---|---|---|---|
| ☐ | `legalName` — dénomination / nom de l'exploitant | « La dénomination ou le nom de l’exploitant n’est pas renseigné. » | Esther / operator |
| ☐ | `legalForm` — forme juridique | « La forme juridique n’est pas renseignée. » | Esther / operator |
| ☐ | `siren` (9 digits, structural check only) | « Le numéro SIREN n’est pas renseigné. » | Esther / operator |
| ☐ | `siret` (14 digits, structural check only) | « Le numéro SIRET n’est pas renseigné. » | Esther / operator |
| ☐ | `vat` — either the intra-community number **or** the explicit declaration that VAT is not applicable (franchise) | « Le numéro de TVA intracommunautaire n’est pas renseigné. Indiquez-le, ou précisez que la TVA n’est pas applicable. » | Esther / operator (accountant) |
| ☐ | `activity` — activité déclarée | « L’activité n’est pas renseignée. » | Esther / operator |
| ☐ | `contact.email` — the contact address published on both legal pages and used for rights requests | « L’adresse e-mail de contact n’est pas renseignée. » | Esther / operator |
| ☐ | `hosting.name` — hébergeur | « Le nom de l’hébergeur n’est pas renseigné. » | Operator, from the Hetzner contract |
| ☐ | `hosting.address` — adresse de l'hébergeur | « L’adresse de l’hébergeur n’est pas renseignée. » | Operator, from the Hetzner contract |
| ☐ | `registeredAddress` — adresse légale (siège) | « L’adresse légale (siège) n’est pas renseignée. » | Esther / operator |
| ☐ | `salonAddress` — either the salon address **or** the explicit declaration that there is no distinct address | « L’adresse du salon n’est pas renseignée. Indiquez-la, ou précisez qu’il n’y a pas d’adresse distincte. » | Esther / operator |

Optional — no warning, published when set:

| ☐ | Field | Note |
|---|---|---|
| ☐ | `tradeName` — nom commercial | Optional. |
| ☐ | `registers[]` — up to 6 (label + reference, e.g. a trade register or the national register) | Which registers apply is a legal question for Esther / her accountant; the repository names none. |
| ☐ | `contact.phone` | Optional. |
| ☐ | `hosting.phone`, `hosting.website` | Optional; from the host's published legal information. |

## 6.2 Privacy notice and policy consistency

| ☐ | Item |
|---|---|
| ☐ | The frozen booking notice (`booking-privacy-v1`) names the controller *Eszter Gyori* and the contact `contact@esztergyori.com`. Confirm that this mailbox exists, is monitored, and matches `contact.email` in the legal document — if it does not, a new notice entry must be appended (never an edit) and `contact.email` set accordingly. |
| ☐ | Decide whether `/confidentialite` should carry an explicit statement on cookies (see `05-cookies-and-trackers.md` §5.3). Editorial/legal decision; not required by the findings. |
| ☐ | Decide whether a DPO is designated (not required by the repository; none is named). |

## 6.3 Processors (see `04-processors-and-dpa.md`)

| ☐ | Item |
|---|---|
| ☐ | Confirm/execute the **Hetzner DPA** in the customer account; keep the executed copy, the sub-processor list version and the breach contact in the private file. |
| ☐ | Select the **SMTP provider**; review/conclude its DPA; review hosting location and transfers; update the inventory. |
| ☐ | Configure SPF / DKIM / DMARC for the sending domain. |
| ☐ | Decide whether backup copies may leave the host; if a storage provider is used, treat it as a processor. |

## 6.4 Host and operations facts (Hetzner account, not the repository)

| ☐ | Item |
|---|---|
| ☐ | Apache access/error log retention setting for the domain (host-level logs are outside `LogMaintenance`). |
| ☐ | Provider-side snapshot/backup behaviour and its retention (`docs/backup-and-restore.md` §5 makes this an external policy check). |
| ☐ | Generate and install `privacy.logPseudonymizationKey` once (32 random bytes), through the private channel, never printed (`docs/deployment-runbook.md` §2). |
| ☐ | Install the four cron jobs: notification runner, daily retention sweep, daily backup after the sweep, daily log maintenance (`docs/deployment-runbook.md` §4–5, `docs/eszter-operator-guide.md`). The retention promises in `01-processing-register.md` hold only when these run. |
| ☐ | Run `php bin/preflight-production.php` and the live acceptance of `docs/deployment-runbook.md` §7. |

## 6.5 Operational policy decisions the repository leaves open

| ☐ | Decision |
|---|---|
| ☐ | Lifetime of an administrator account after the person leaves (disable vs. delete; deletion is not implemented). |
| ☐ | Retention of the operator's own correspondence about rights requests and incidents (mailbox / private register), which the application never stores. |
| ☐ | Protection of off-host backup copies, if any (the repository does not encrypt archives). |
| ☐ | Weekly review cadence of the GDPR register (`02-data-subject-rights-procedure.md` §2.4 proposes at least weekly). |

## 6.6 Breach readiness

| ☐ | Item |
|---|---|
| ☐ | Create the private breach register from `03-breach-register-template.md` outside Git. |
| ☐ | Identify who holds the CNIL notification account / who would notify, and the processor breach contacts. |
