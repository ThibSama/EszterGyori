"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAdminSession } from "./admin-session-provider";
import { useServiceLabel } from "./admin-service-catalog-provider";
import type {
  AdminApiFailure,
  AdminBookingsCursor,
  AdminPrivacyRequest,
  AdminPrivacyRequestMatch,
  AdminPrivacyRequestType,
} from "../../lib/admin-api";
import {
  ADMIN_PRIVACY_MESSAGES,
  PRIVACY_REQUEST_STATUS_LABELS,
  PRIVACY_REQUEST_TYPE_LABELS,
  PRIVACY_REQUEST_TYPES,
  classifyIdentification,
  describeScopeCompleteness,
  mergeMatches,
  privacyFailureMessage,
  scopeIsRecordable,
  toggleReference,
  type PrivacyRequestStep,
} from "../../lib/admin-privacy-requests";
import { formatParisDate, formatParisTime, parisLocalDate } from "../../lib/admin-booking-calendar";

/**
 * The GDPR request centre on the overview (ESZ-163).
 *
 * One block, two modals, no navigation entry: `Nouvelle demande` records a
 * data-subject request through the common flow — type → identification →
 * search → scope review → record — and `Historique` reads the register.
 *
 * ## What recording is, and is not
 *
 * Recording stores the frozen type, the reception date and exactly the
 * booking references the administrator ticked. It changes no booking, no
 * customer field, exports nothing and sends nothing: executing the right is
 * ESZ-164's, and that is what will move a record from `Reçue` through
 * `En cours` to `Clôturée`. The status is never chosen here — there is no
 * selector to choose it with.
 *
 * ## What the register never holds
 *
 * The requester's e-mail address is typed to *find* bookings and is not sent
 * with the record; the register's request shape has no field for it, nor for
 * a message or an identity document. What the search shows — a name, a date,
 * a service — is what the calendar already shows, and it is shown to select
 * from, never stored again.
 *
 * ## A shared address never means "all bookings"
 *
 * An e-mail search lists its matches one page at a time and says whether
 * more exist. Recording requires the whole list to be loaded and an explicit
 * selection — or an explicit confirmation that no booking is concerned.
 */
export function AdminPrivacyCentre() {
  const [open, setOpen] = useState<"new" | "history" | null>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(null);
    openerRef.current?.focus();
  }, []);

  return (
    <section aria-label="Traitement RGPD" className="admin-panel rounded-3xl p-5 sm:p-6">
      <h2 className="admin-text font-display text-2xl">Traitement RGPD</h2>
      <p className="admin-text-muted mt-2 text-sm">
        Demandes d’exercice des droits : accès, rectification, effacement, limitation,
        portabilité. Le registre ne conserve que le type, les dates et les références des
        réservations concernées — jamais l’adresse e-mail ni le message de la personne.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          ref={openerRef}
          onClick={() => setOpen("new")}
          className="admin-btn-primary rounded-full px-4 py-2 text-sm font-medium">
          Nouvelle demande
        </button>
        <button
          type="button"
          onClick={() => setOpen("history")}
          className="admin-btn-secondary rounded-full px-4 py-2 text-sm font-medium">
          Historique
        </button>
      </div>

      {open === "new" ? <NewRequestModal onClose={close} /> : null}
      {open === "history" ? <HistoryModal onClose={close} /> : null}
    </section>
  );
}

// --- The modal frame ---------------------------------------------------------

/**
 * A dialog over the overview. Escape and the close control both leave it;
 * focus lands on the heading when it opens, so a screen reader announces
 * where it is, and returns to the opener when it closes.
 */
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="admin-panel admin-theme max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-t-3xl p-5 sm:rounded-3xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="admin-text font-display text-2xl focus:outline-none">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="admin-btn-quiet rounded-full px-3 py-1.5 text-sm">
            Fermer
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

function Notice({ message, alert }: { message: string; alert: boolean }) {
  return (
    <p
      role={alert ? "alert" : "status"}
      className={`rounded-2xl px-4 py-3 text-sm ${alert ? "admin-note-danger" : "admin-note-ok"}`}>
      {message}
    </p>
  );
}

const STEP_LABELS: Record<PrivacyRequestStep, string> = {
  type: "Type de demande",
  identification: "Identification",
  search: "Résultats",
  scope: "Périmètre",
  recorded: "Enregistrée",
};

function Steps({ current }: { current: PrivacyRequestStep }) {
  const steps: PrivacyRequestStep[] = ["type", "identification", "search", "scope", "recorded"];
  return (
    <ol className="admin-text-muted flex flex-wrap gap-x-3 gap-y-1 text-xs uppercase tracking-wide">
      {steps.map((step, index) => (
        <li
          key={step}
          aria-current={step === current ? "step" : undefined}
          className={step === current ? "admin-text-accent font-semibold" : undefined}>
          {index + 1}. {STEP_LABELS[step]}
        </li>
      ))}
    </ol>
  );
}

// --- Nouvelle demande --------------------------------------------------------

type SearchState = {
  identification: { kind: "reference"; reference: string } | { kind: "email"; email: string };
  matches: AdminPrivacyRequestMatch[];
  hasMore: boolean;
  nextCursor: AdminBookingsCursor | null;
};

function NewRequestModal({ onClose }: { onClose: () => void }) {
  const { api, csrfToken, markExpired, refreshSession } = useAdminSession();
  const serviceLabel = useServiceLabel();

  const [step, setStep] = useState<PrivacyRequestStep>("type");
  const [type, setType] = useState<AdminPrivacyRequestType | null>(null);
  // Defaults to today and stays editable until the record is created: the
  // reception date is the date the request arrived, not the date it is typed.
  const [receivedDate, setReceivedDate] = useState(() => parisLocalDate());
  const [identification, setIdentification] = useState("");
  const [search, setSearch] = useState<SearchState | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmedEmpty, setConfirmedEmpty] = useState(false);
  const [recorded, setRecorded] = useState<AdminPrivacyRequest | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ message: string; alert: boolean } | null>(null);

  const handleFailure = useCallback(
    async (failure: AdminApiFailure, context: "reference" | "record") => {
      if (failure.kind === "unauthenticated") {
        markExpired();
        return;
      }
      if (failure.kind === "forbidden") await refreshSession();
      setNotice({ message: privacyFailureMessage(failure, context), alert: true });
    },
    [markExpired, refreshSession],
  );

  async function runSearch() {
    const classified = classifyIdentification(identification);
    if (classified.kind === "invalid") {
      setNotice({ message: ADMIN_PRIVACY_MESSAGES.identificationInvalid, alert: true });
      return;
    }
    setPending(true);
    setNotice(null);
    const result = await api.searchPrivacyRequestScope(
      classified.kind === "reference"
        ? { mode: "reference", reference: classified.reference }
        : { mode: "email", email: classified.email },
    );
    setPending(false);
    if (!result.ok) return void handleFailure(result.failure, "reference");
    setSearch({
      identification: classified,
      matches: result.value.matches,
      hasMore: result.value.page.hasMore,
      nextCursor: result.value.page.nextCursor,
    });
    setSelected([]);
    setConfirmedEmpty(false);
    setStep("search");
  }

  /** The next page of an e-mail search, appended: the list is never a clip. */
  async function loadMore() {
    if (!search || search.identification.kind !== "email" || !search.nextCursor) return;
    setPending(true);
    setNotice(null);
    const result = await api.searchPrivacyRequestScope({
      mode: "email",
      email: search.identification.email,
      cursor: search.nextCursor,
    });
    setPending(false);
    if (!result.ok) return void handleFailure(result.failure, "reference");
    setSearch({
      ...search,
      matches: mergeMatches(search.matches, result.value.matches),
      hasMore: result.value.page.hasMore,
      nextCursor: result.value.page.nextCursor,
    });
  }

  async function record() {
    if (!type || !search) return;
    if (!scopeIsRecordable({ selected, confirmedEmpty, hasMore: search.hasMore })) {
      setNotice({ message: ADMIN_PRIVACY_MESSAGES.scopeNothingSelected, alert: true });
      return;
    }
    setPending(true);
    setNotice(null);
    // Only the type, the date and the ticked references travel. The address
    // or reference the administrator typed stays in this form.
    const result = await api.recordPrivacyRequest(
      { type, receivedDate, bookingReferences: selected },
      csrfToken,
    );
    setPending(false);
    if (!result.ok) return void handleFailure(result.failure, "record");
    setRecorded(result.value);
    setStep("recorded");
    setNotice({ message: ADMIN_PRIVACY_MESSAGES.recorded, alert: false });
  }

  return (
    <Modal title="Nouvelle demande RGPD" onClose={onClose}>
      <Steps current={step} />
      {notice ? (
        <div className="mt-4">
          <Notice message={notice.message} alert={notice.alert} />
        </div>
      ) : null}

      {step === "type" ? (
        <form
          className="mt-4 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (type) setStep("identification");
          }}>
          <fieldset>
            <legend className="admin-text text-sm font-medium">Type de demande</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {PRIVACY_REQUEST_TYPES.map((candidate) => (
                <label
                  key={candidate}
                  className="admin-sunken flex cursor-pointer items-center gap-3 rounded-2xl px-4 py-3 text-sm">
                  <input
                    type="radio"
                    name="privacy-request-type"
                    value={candidate}
                    checked={type === candidate}
                    onChange={() => setType(candidate)}
                  />
                  <span className="admin-text">{PRIVACY_REQUEST_TYPE_LABELS[candidate]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block">
            <span className="admin-text text-sm font-medium">Date de réception</span>
            <input
              type="date"
              required
              value={receivedDate}
              max={parisLocalDate()}
              onChange={(event) => setReceivedDate(event.target.value)}
              className="admin-input mt-2 block rounded-full px-4 py-2 text-sm"
            />
            <span className="admin-text-muted mt-1 block text-xs">
              Par défaut aujourd’hui ; le délai de réponse d’un mois est calculé à partir de
              cette date.
            </span>
          </label>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!type || receivedDate === ""}
              className="admin-btn-primary rounded-full px-4 py-2 text-sm font-medium">
              Continuer
            </button>
          </div>
        </form>
      ) : null}

      {step === "identification" ? (
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}>
          <label className="block">
            <span className="admin-text text-sm font-medium">
              Référence de réservation ou adresse e-mail
            </span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={identification}
              onChange={(event) => setIdentification(event.target.value)}
              placeholder="XG73-UVK9, bk_… ou adresse e-mail"
              className="admin-input mt-2 block w-full rounded-full px-4 py-2 text-sm"
            />
            <span className="admin-text-muted mt-1 block text-xs">
              Une référence identifie une réservation ; une adresse e-mail liste toutes les
              réservations actives qui la portent. Cette saisie sert à la recherche et n’est pas
              conservée dans le registre.
            </span>
          </label>
          <div className="flex flex-wrap justify-between gap-3">
            <button
              type="button"
              onClick={() => setStep("type")}
              className="admin-btn-quiet rounded-full px-4 py-2 text-sm">
              Retour
            </button>
            <button
              type="submit"
              disabled={pending}
              className="admin-btn-primary rounded-full px-4 py-2 text-sm font-medium">
              {pending ? "Recherche…" : "Rechercher"}
            </button>
          </div>
        </form>
      ) : null}

      {step === "search" && search ? (
        <div className="mt-4 space-y-4">
          <p className="admin-text-muted text-sm">
            {search.identification.kind === "reference"
              ? "Réservation identifiée par sa référence."
              : describeScopeCompleteness({ hasMore: search.hasMore }, search.matches.length)}
          </p>
          <MatchList matches={search.matches} serviceLabel={serviceLabel} />
          {search.hasMore ? (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={pending}
              className="admin-btn-secondary rounded-full px-4 py-2 text-sm">
              {pending ? "Chargement…" : "Charger la suite"}
            </button>
          ) : null}
          <div className="flex flex-wrap justify-between gap-3">
            <button
              type="button"
              onClick={() => setStep("identification")}
              className="admin-btn-quiet rounded-full px-4 py-2 text-sm">
              Retour
            </button>
            <button
              type="button"
              onClick={() => setStep("scope")}
              disabled={search.hasMore}
              className="admin-btn-primary rounded-full px-4 py-2 text-sm font-medium">
              Vérifier le périmètre
            </button>
          </div>
        </div>
      ) : null}

      {step === "scope" && search && type ? (
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void record();
          }}>
          <p className="admin-text-muted text-sm">
            Cochez les réservations que la demande concerne. Une adresse partagée ne vaut pas
            pour toutes les réservations : seules les références cochées seront enregistrées.
          </p>
          <MatchList
            matches={search.matches}
            serviceLabel={serviceLabel}
            selected={selected}
            onToggle={(reference) => {
              setSelected((current) => toggleReference(current, reference));
              setConfirmedEmpty(false);
            }}
          />
          {selected.length === 0 ? (
            <label className="admin-sunken flex items-center gap-3 rounded-2xl px-4 py-3 text-sm">
              <input
                type="checkbox"
                checked={confirmedEmpty}
                onChange={(event) => setConfirmedEmpty(event.target.checked)}
              />
              <span className="admin-text">
                Je confirme qu’aucune réservation n’est concernée par cette demande.
              </span>
            </label>
          ) : null}
          <dl className="admin-text-muted grid gap-1 text-sm sm:grid-cols-2">
            <div>
              <dt className="admin-text-subtle">Type</dt>
              <dd className="admin-text">{PRIVACY_REQUEST_TYPE_LABELS[type]}</dd>
            </div>
            <div>
              <dt className="admin-text-subtle">Reçue le</dt>
              <dd className="admin-text">{formatParisDate(receivedDate)}</dd>
            </div>
            <div>
              <dt className="admin-text-subtle">Réservations retenues</dt>
              <dd className="admin-text">
                {selected.length === 0 ? "Aucune" : selected.join(", ")}
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap justify-between gap-3">
            <button
              type="button"
              onClick={() => setStep("search")}
              className="admin-btn-quiet rounded-full px-4 py-2 text-sm">
              Retour
            </button>
            <button
              type="submit"
              disabled={
                pending ||
                !scopeIsRecordable({ selected, confirmedEmpty, hasMore: search.hasMore })
              }
              className="admin-btn-strong rounded-full px-4 py-2 text-sm font-medium">
              {pending ? "Enregistrement…" : "Enregistrer la demande"}
            </button>
          </div>
        </form>
      ) : null}

      {step === "recorded" && recorded ? (
        <div className="mt-4 space-y-4">
          <RequestDetail request={recorded} />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="admin-btn-primary rounded-full px-4 py-2 text-sm font-medium">
              Fermer
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

/**
 * The matched bookings. With `onToggle` each row is a checkbox (the scope
 * review); without it the rows are read-only (the search results). What is
 * shown is what the calendar shows — it is never sent back.
 */
function MatchList({
  matches,
  serviceLabel,
  selected,
  onToggle,
}: {
  matches: AdminPrivacyRequestMatch[];
  serviceLabel: (keys: readonly string[]) => string;
  selected?: string[];
  onToggle?: (reference: string) => void;
}) {
  if (matches.length === 0) {
    return <p className="admin-text-muted text-sm">Aucune réservation correspondante.</p>;
  }

  return (
    <ul className="space-y-2">
      {matches.map((match) => {
        const line = (
          <>
            <span className="admin-text font-mono text-sm font-medium">{match.reference}</span>
            <span className="admin-text-muted text-sm">
              {formatParisDate(parisLocalDate(match.startsAtUtc))} à {formatParisTime(match.startsAtUtc)}{" "}
              · {match.customerName} · {serviceLabel(match.serviceKeys)}
              {match.state === "cancelled" ? " · annulée" : ""}
            </span>
          </>
        );
        return (
          <li key={match.reference}>
            {onToggle ? (
              <label className="admin-sunken flex cursor-pointer flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
                <input
                  type="checkbox"
                  checked={selected?.includes(match.reference) ?? false}
                  onChange={() => onToggle(match.reference)}
                />
                {line}
              </label>
            ) : (
              <div className="admin-sunken flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
                {line}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One record, in full: what the register holds, the deadline included. */
function RequestDetail({ request }: { request: AdminPrivacyRequest }) {
  return (
    <dl className="admin-text-muted grid gap-3 text-sm sm:grid-cols-2">
      <div>
        <dt className="admin-text-subtle">Type</dt>
        <dd className="admin-text">{PRIVACY_REQUEST_TYPE_LABELS[request.type]}</dd>
      </div>
      <div>
        <dt className="admin-text-subtle">Statut</dt>
        <dd className="admin-text">{PRIVACY_REQUEST_STATUS_LABELS[request.status]}</dd>
      </div>
      <div>
        <dt className="admin-text-subtle">Reçue le</dt>
        <dd className="admin-text">{formatParisDate(request.receivedDate)}</dd>
      </div>
      <div>
        <dt className="admin-text-subtle">Réponse attendue avant le</dt>
        <dd className="admin-text">{formatParisDate(request.deadlineDate)}</dd>
      </div>
      <div>
        <dt className="admin-text-subtle">Clôturée le</dt>
        <dd className="admin-text">
          {request.closedAtUtc === null
            ? "—"
            : `${formatParisDate(parisLocalDate(request.closedAtUtc))} à ${formatParisTime(request.closedAtUtc)}`}
        </dd>
      </div>
      <div>
        <dt className="admin-text-subtle">Réservations concernées</dt>
        <dd className="admin-text font-mono">
          {request.bookingReferences.length === 0 ? "Aucune" : request.bookingReferences.join(", ")}
        </dd>
      </div>
    </dl>
  );
}

// --- Historique --------------------------------------------------------------

type HistoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      requests: AdminPrivacyRequest[];
      hasMore: boolean;
      nextCursor: { id: number } | null;
    };

function HistoryModal({ onClose }: { onClose: () => void }) {
  const { api, markExpired } = useAdminSession();
  const [state, setState] = useState<HistoryState>({ status: "loading" });
  const [detail, setDetail] = useState<AdminPrivacyRequest | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const handleFailure = useCallback(
    (failure: AdminApiFailure): string | null => {
      if (failure.kind === "unauthenticated") {
        markExpired();
        return null;
      }
      return privacyFailureMessage(failure, "register");
    },
    [markExpired],
  );

  useEffect(() => {
    let active = true;
    void api.listPrivacyRequests({ mode: "history" }).then((result) => {
      if (!active) return;
      if (!result.ok) {
        const message = handleFailure(result.failure);
        if (message !== null) setState({ status: "error", message });
        return;
      }
      setState({
        status: "ready",
        requests: result.value.requests,
        hasMore: result.value.page.hasMore,
        nextCursor: result.value.page.nextCursor,
      });
    });
    return () => {
      active = false;
    };
  }, [api, handleFailure]);

  async function loadMore() {
    if (state.status !== "ready" || !state.nextCursor) return;
    setPending(true);
    const result = await api.listPrivacyRequests({ mode: "history", cursor: state.nextCursor });
    setPending(false);
    if (!result.ok) {
      const message = handleFailure(result.failure);
      if (message !== null) setNotice(message);
      return;
    }
    setState({
      status: "ready",
      requests: [...state.requests, ...result.value.requests],
      hasMore: result.value.page.hasMore,
      nextCursor: result.value.page.nextCursor,
    });
  }

  /** `Voir`: re-read the record so the detail is the register's, not the list's copy. */
  async function view(id: number) {
    setPending(true);
    setNotice(null);
    const result = await api.readPrivacyRequest(id);
    setPending(false);
    if (!result.ok) {
      const message = handleFailure(result.failure);
      if (message !== null) setNotice(message);
      return;
    }
    setDetail(result.value);
  }

  return (
    <Modal title="Historique des demandes RGPD" onClose={onClose}>
      {notice ? (
        <div className="mb-4">
          <Notice message={notice} alert />
        </div>
      ) : null}

      {detail ? (
        <div className="space-y-4">
          <RequestDetail request={detail} />
          <button
            type="button"
            onClick={() => setDetail(null)}
            className="admin-btn-quiet rounded-full px-4 py-2 text-sm">
            Retour à la liste
          </button>
        </div>
      ) : state.status === "loading" ? (
        <p role="status" className="admin-text-muted text-sm">
          Chargement du registre…
        </p>
      ) : state.status === "error" ? (
        <Notice message={state.message} alert />
      ) : state.requests.length === 0 ? (
        <p className="admin-text-muted text-sm">{ADMIN_PRIVACY_MESSAGES.registerEmpty}</p>
      ) : (
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="admin-text-subtle text-xs uppercase tracking-wide">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">Réception</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Type</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Statut</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Clôture</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Références</th>
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody className="admin-text">
                {state.requests.map((request) => (
                  <tr key={request.id} className="admin-border border-t">
                    <td className="py-2 pr-3 whitespace-nowrap">{request.receivedDate}</td>
                    <td className="py-2 pr-3">{PRIVACY_REQUEST_TYPE_LABELS[request.type]}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                          request.status === "closed" ? "admin-note-inert" : "admin-note-ok"
                        }`}>
                        {PRIVACY_REQUEST_STATUS_LABELS[request.status]}
                      </span>
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {request.closedAtUtc === null ? "—" : parisLocalDate(request.closedAtUtc)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">
                      {request.bookingReferences.length === 0
                        ? "Aucune"
                        : request.bookingReferences.join(", ")}
                    </td>
                    <td className="py-2">
                      <button
                        type="button"
                        onClick={() => void view(request.id)}
                        disabled={pending}
                        className="admin-btn-secondary rounded-full px-3 py-1.5 text-xs font-medium">
                        Voir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state.hasMore ? (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={pending}
              className="admin-btn-secondary rounded-full px-4 py-2 text-sm">
              {pending ? "Chargement…" : "Charger la suite"}
            </button>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
