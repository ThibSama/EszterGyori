# 2. Data-subject rights — operating procedure (V1)

V1 offers exactly five rights, frozen in `contracts/booking.ts`
(`privacyRequestTypes`): **access, rectification, erasure, restriction,
portability**. Opposition is deliberately absent from V1 (the basis is the
contract, not legitimate interest or consent). The rights are executed from the
admin GDPR request centre (`Traitement RGPD` block on the admin overview,
ESZ-163/164). Everything in this file that describes application behaviour is a
**repository fact**; the deadline-extension and escalation rules are the
operator's procedure and are stated as such.

## 2.1 Where requests arrive

Requests reach the operator outside the application — by e-mail to the contact
address published in the booking notice and on `/confidentialite`, or in
person. The application does not receive, store or answer requests by itself:
the requester's message, e-mail and any identity document are **never
stored** in the register (`privacyRequestPolicy.register.neverStored`). The
operator keeps the correspondence in their own mailbox under their own
retention.

## 2.2 Workflow (as implemented)

```
identification → explicit booking selection → register entry → execution → closure
```

1. **Identification** (`Nouvelle demande` → type → identification → search).
   The requester is identified by a public booking reference (`XXXX-XXXX` or
   legacy `bk_…`, exactly one booking) or by an e-mail address (every live
   booking whose stored e-mail matches, case-insensitively, paginated with an
   explicit *hasMore* so no match is silently dropped). An erased booking is
   never matched — the frozen placeholder address can never reconnect
   anonymised bookings. Route: `POST /api/admin/privacy-requests/search`.
   *Operator judgement:* the search proves that a booking exists under that
   reference or address; it does not prove who is asking. When the request
   comes from an address that is not the one stored on the booking, or the
   identity is doubtful, ask for reasonable additional confirmation before
   recording, and do not disclose booking facts in the exchange.
2. **Explicit booking selection** (scope review). The administrator ticks the
   bookings concerned. A shared e-mail never implies every booking; an empty
   scope is recorded only after an explicit confirmation. At most 50
   references; each must resolve to a stored, non-erased booking at record
   time.
3. **Register entry** (`POST /api/admin/privacy-requests`). Stored: type,
   reception date (defaults to today, editable before creation), the derived
   deadline, status `received`, the selected references. The deadline is
   **one calendar month after the reception date**, clamped to the last day of
   the month when the day does not exist (`privacyRequestPolicy.deadline`). It
   is stored and never moves.
4. **Execution** (`POST /api/admin/privacy-requests/actions`, from the
   request detail). Each action acts on the stored references only:

   | Right | Action | What happens | Confirmation |
   |---|---|---|---|
   | Access | `export` (HTML by default) | One document per request: held data of each selected non-anonymised booking, appointment facts, non-personal history, basis as stored, purposes, retention, recipients, source, rights. Built on request, returned in the response, **never persisted**. | none |
   | Portability | `export` (JSON by default) | The same document as structured JSON; either representation may be produced for either type. | none |
   | Rectification | `rectify` | Per-booking contact fields through the single customer-update authority (`BookingLifecycle::updateCustomerContact`), all selected bookings in one transaction with the closure, or none. | none (validated form) |
   | Erasure | `anonymize` | Early anonymisation through the ESZ-140/162 primitive: frozen placeholders, phone/note/reason cleared, `customer_data_erased_at` set, pending/processing notification jobs retired. Appointment and reference kept; calendar shows *Cliente anonymisée — rendez-vous maintenu*. Irreversible. | explicit ticked confirmation |
   | Restriction | `restrict` | Sets `bookings.processing_restricted_at`; calendar shows *Traitement limité*; no reminder e-mail/SMS is claimed or delivered while set (claim join + delivery-time re-check). | none |
   | Restriction — lift | `lift` | Clears the marker, appends `processing_restriction_lifted`, schedules **one** immediate informational e-mail per lifted booking. A reminder whose window elapsed during the restriction is never replayed. | explicit ticked confirmation |

   A reference anonymised since the request was recorded is listed as
   anonymised and is never rectified, restricted, notified or reconnected to a
   former identity; nothing is reconstructed from history, backups or
   notification evidence (`privacyRequestPolicy.execution.scope`).
5. **Closure.** Statuses are automatic, never chosen: `received` →
   `in_progress` → `closed`. An export closes the request once the document is
   built (and may be exported again afterwards); rectification, erasure and
   restriction close it in the same transaction as their booking writes, so a
   failed action leaves the request open and the bookings untouched. A lift
   acts on a `restriction` request whatever its status and changes it no
   further. `closed_at_utc` is written with the status. Closed records are
   purged three years after closure by the daily sweep.

The answer to the person (sending the export, confirming the rectification or
anonymisation, explaining a restriction) is sent by the operator outside the
application. Send the export through a channel the requester controls
(reply to their verified address); do not paste booking data into an
unverified conversation.

## 2.3 Deadlines

- **Normal deadline: one month from receipt** (GDPR art. 12(3)). The
  application stores `deadlineDate` beside `receivedDate` and shows it in the
  request detail. Reception date is the date the request reached the operator,
  not the date it was recorded — record promptly and correct the date before
  creation if needed.
- **Extension for complex or numerous requests (GDPR art. 12(3), CNIL
  guidance):** the period may be extended by **up to two further months**, but
  the person must be **informed within the original one month**, with the
  reasons for the delay. V1 does **not** automate this: there is no extension
  field, no second deadline and no reminder. An extension is a human decision;
  the justification and the date the person was informed are recorded in the
  operator's own correspondence, and the register's stored deadline keeps
  showing the original month.
- **Refusal or no action:** if the operator does not act on a request (e.g.
  identity cannot be established, or a rectification is unfounded), the
  person must be informed within the same one month of the reasons and of the
  possibility to lodge a complaint with the CNIL. This is likewise a human
  step outside the application.

## 2.4 Escalation (operator procedure — conservative)

| Situation | Rule |
|---|---|
| Open request (`received` or `in_progress`) approaching its stored deadline | Requires controller review: the operator checks `Historique` at least weekly and treats any open request within seven days of its deadline as due now. |
| Open request past its stored deadline | **Immediately escalated** to the controller: the request is answered, or the person is informed of the delay and the reasons, on the same day it is noticed; the delay is documented in the correspondence. |
| Extension | A human decision requiring a documented justification (complexity or number of requests) **and** a communication to the person before the original deadline. It is never an automatic state transition, and the application does not represent it. |
| Request cannot be linked to any booking | Record with an explicitly confirmed empty scope so the obligation is evidenced, answer the person that no personal data is held under the identification provided, and close by exporting the (empty) document. |
| Identity doubtful | Ask for confirmation before recording a scope; do not disclose data; the one-month clock still runs from receipt. |

## 2.5 What V1 does not do (by design)

- No requester-facing portal, ticketing, e-mail or automated acknowledgement.
- No opposition right (not applicable to the contractual basis in V1).
- No automated extension, reminder or overdue alert.
- No storage of correspondence or identity evidence.
- No export persistence: a download exists only in the response and on the
  requester's side.

Implementation authority: `contracts/booking.ts` (`privacyRequestPolicy`),
`php/src/Privacy/PrivacyRequestAdministration.php`,
`PrivacyRightsExecution.php`, `PrivacyDataExport.php`,
`front/app/components/admin/admin-privacy-centre.tsx`. Evidence:
`07-implementation-evidence.md` §7.3–7.5.
