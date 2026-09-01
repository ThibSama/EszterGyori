"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminBookingMutationRequestSchema } from "@eszter/contracts";
import { useAdminSession } from "./admin-session-provider";
import type { AdminApiFailure, AdminBooking, AdminMoveAvailability } from "../../lib/admin-api";
import {
  addCivilDays,
  bookingsForDate,
  formatParisDate,
  formatParisTime,
  monthGrid,
  monthKey,
  parisLocalDate,
  replaceBooking,
  shiftMonth,
} from "../../lib/admin-booking-calendar";

type View = "month" | "day";
type DetailAction = "none" | "move" | "cancel" | "edit";
type ContactField = "customerName" | "customerEmail" | "customerPhone" | "customerNote";
type ContactErrors = Partial<Record<ContactField, string>>;

const CONTACT_ERROR_MESSAGES: Record<ContactField, string> = {
  customerName: "Saisissez un nom valide.",
  customerEmail: "Saisissez une adresse email valide.",
  customerPhone: "Saisissez un numéro de téléphone valide.",
  customerNote: "Saisissez une note valide.",
};

const SERVICE_LABELS: Record<string, string> = {
  brows: "Sourcils",
  lashes: "Cils",
  makeup: "Maquillage",
  nails: "Ongles",
};

function failureMessage(failure: AdminApiFailure): string {
  if (failure.kind === "conflict") return "Les données ont changé sur le serveur. Elles ont été actualisées.";
  if (failure.kind === "forbidden") return "Le jeton de sécurité a expiré. Il a été actualisé ; confirmez de nouveau l’action.";
  if (failure.kind === "not-found") return "Ce rendez-vous n’existe plus.";
  return failure.message;
}

/**
 * The accessible name of one day cell (ESZ-085).
 *
 * Without it a screen reader reads the button's visible text: a bare day number
 * followed by up to three truncated customer names, which is neither a date nor a
 * summary. The count matters as much as the date — "how busy is the 24th?" is the
 * question the month view exists to answer, and it is the one thing the visual
 * layout conveys instantly and the text conveyed not at all.
 */
function dayCellLabel(date: string, bookingCount: number): string {
  const appointments =
    bookingCount === 0
      ? "aucun rendez-vous"
      : `${bookingCount} rendez-vous`;

  return `${formatParisDate(date)}, ${appointments}`;
}

export function AdminBookingCalendar() {
  const { api, csrfToken, markExpired, refreshSession } = useAdminSession();
  const today = useMemo(() => parisLocalDate(), []);
  const [month, setMonth] = useState(monthKey(today));
  const [selectedDate, setSelectedDate] = useState(today);
  const [view, setView] = useState<View>("month");
  const [bookings, setBookings] = useState<AdminBooking[]>([]);
  const [selectedReference, setSelectedReference] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [action, setAction] = useState<DetailAction>("none");
  const [moveDate, setMoveDate] = useState(today);
  const [moveAvailability, setMoveAvailability] = useState<AdminMoveAvailability | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [moveLoading, setMoveLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactNote, setContactNote] = useState("");
  const [contactErrors, setContactErrors] = useState<ContactErrors>({});
  const noticeRef = useRef<HTMLDivElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const actionHeadingRef = useRef<HTMLHeadingElement>(null);
  const dates = useMemo(() => monthGrid(month), [month]);
  const selected = bookings.find((booking) => booking.reference === selectedReference) ?? null;

  const handleFailure = useCallback(async (failure: AdminApiFailure) => {
    if (failure.kind === "unauthenticated") {
      markExpired();
      return;
    }
    if (failure.kind === "forbidden") await refreshSession();
    setMessage(failureMessage(failure));
    requestAnimationFrame(() => noticeRef.current?.focus());
  }, [markExpired, refreshSession]);

  useEffect(() => {
    let active = true;
    void api.queryBookings({
      mode: "range",
      fromDate: dates[0],
      untilDate: dates[dates.length - 1],
    }).then((result) => {
      if (!active) return;
      setLoading(false);
      if (!result.ok) return void handleFailure(result.failure);
      setBookings(result.value);
    });
    return () => { active = false; };
  }, [api, dates, handleFailure]);

  const chooseBooking = (booking: AdminBooking) => {
    setSelectedReference(booking.reference);
    setAction("none");
    setMessage(null);
    requestAnimationFrame(() => detailHeadingRef.current?.focus());
  };

  const refreshOne = useCallback(async (reference: string) => {
    const result = await api.queryBookings({ mode: "reference", reference });
    if (!result.ok) return void handleFailure(result.failure);
    if (result.value[0]) setBookings((current) => replaceBooking(current, result.value[0]));
  }, [api, handleFailure]);

  const loadMoveSlots = useCallback(async (booking: AdminBooking, date: string) => {
    setMoveLoading(true);
    setMoveAvailability(null);
    setSelectedSlot(null);
    const result = await api.moveAvailability({ reference: booking.reference, fromDate: date, untilDate: date });
    setMoveLoading(false);
    if (!result.ok) return void handleFailure(result.failure);
    setMoveAvailability(result.value);
  }, [api, handleFailure]);

  const beginMove = () => {
    if (!selected || selected.state !== "confirmed") return;
    const currentDate = parisLocalDate(selected.startsAtUtc);
    const date = currentDate < today ? today : currentDate;
    setMoveDate(date);
    setAction("move");
    setMessage(null);
    void loadMoveSlots(selected, date);
    requestAnimationFrame(() => actionHeadingRef.current?.focus());
  };

  const beginContactEdit = () => {
    if (!selected) return;
    setContactName(selected.customerName);
    setContactEmail(selected.customerEmail);
    setContactPhone(selected.customerPhone ?? "");
    setContactNote(selected.customerNote ?? "");
    setContactErrors({});
    setAction("edit");
    setMessage(null);
    requestAnimationFrame(() => actionHeadingRef.current?.focus());
  };

  const navigateDay = (date: string) => {
    setSelectedDate(date);
    if (monthKey(date) !== month) {
      setLoading(true);
      setMessage(null);
      setMonth(monthKey(date));
    }
  };

  const submitMove = async () => {
    if (!selected || !selectedSlot || mutating) return;
    setMutating(true);
    const result = await api.mutateBooking(
      { action: "move", reference: selected.reference, startsAtUtc: selectedSlot },
      csrfToken,
    );
    setMutating(false);
    if (!result.ok) {
      if (result.failure.kind === "conflict") {
        setSelectedSlot(null);
        await refreshOne(selected.reference);
        await loadMoveSlots(selected, moveDate);
        setMessage("Ce créneau n’est plus disponible. Le rendez-vous n’a pas été déplacé ; choisissez un autre horaire.");
        requestAnimationFrame(() => noticeRef.current?.focus());
        return;
      }
      return void handleFailure(result.failure);
    }
    setBookings((current) => replaceBooking(current, result.value));
    setSelectedReference(result.value.reference);
    setSelectedDate(parisLocalDate(result.value.startsAtUtc));
    setMonth(monthKey(parisLocalDate(result.value.startsAtUtc)));
    setAction("none");
    setMessage("Le rendez-vous a été déplacé et confirmé par le serveur.");
    requestAnimationFrame(() => noticeRef.current?.focus());
  };

  const submitCancellation = async () => {
    if (!selected || selected.state !== "confirmed" || mutating) return;
    setMutating(true);
    const result = await api.mutateBooking(
      { action: "cancel", reference: selected.reference, reason: cancelReason.trim() || null },
      csrfToken,
    );
    setMutating(false);
    if (!result.ok) {
      if (result.failure.kind === "conflict") {
        await refreshOne(selected.reference);
        setAction("none");
        setMessage("Le rendez-vous avait déjà changé. Son état serveur a été actualisé sans nouvelle annulation.");
        requestAnimationFrame(() => noticeRef.current?.focus());
        return;
      }
      return void handleFailure(result.failure);
    }
    setBookings((current) => replaceBooking(current, result.value));
    setAction("none");
    setCancelReason("");
    setMessage("Le rendez-vous est annulé. Il reste visible dans le calendrier.");
    requestAnimationFrame(() => noticeRef.current?.focus());
  };

  const submitContactEdit = async () => {
    if (!selected || mutating) return;
    const parsed = adminBookingMutationRequestSchema.safeParse({
      action: "update",
      reference: selected.reference,
      customerName: contactName,
      customerEmail: contactEmail,
      customerPhone: contactPhone.trim() || null,
      customerNote: contactNote.trim() || null,
    });
    if (!parsed.success) {
      const errors: ContactErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (
          (field === "customerName" || field === "customerEmail" || field === "customerPhone" || field === "customerNote")
          && !errors[field]
        ) errors[field] = CONTACT_ERROR_MESSAGES[field];
      }
      setContactErrors(errors);
      setMessage("Certaines coordonnées sont invalides. Corrigez les champs indiqués.");
      const firstInvalid = (["customerName", "customerEmail", "customerPhone", "customerNote"] as const).find((field) => errors[field]);
      const fieldIds: Record<ContactField, string> = {
        customerName: "contact-name",
        customerEmail: "contact-email",
        customerPhone: "contact-phone",
        customerNote: "contact-note",
      };
      requestAnimationFrame(() => firstInvalid ? document.getElementById(fieldIds[firstInvalid])?.focus() : noticeRef.current?.focus());
      return;
    }
    setContactErrors({});
    setMutating(true);
    const result = await api.mutateBooking(parsed.data, csrfToken);
    setMutating(false);
    if (!result.ok) {
      if (result.failure.kind === "conflict") {
        await refreshOne(selected.reference);
        setAction("none");
        setMessage("Le rendez-vous avait changé. Ses coordonnées serveur ont été actualisées sans enregistrer la modification.");
        requestAnimationFrame(() => noticeRef.current?.focus());
        return;
      }
      return void handleFailure(result.failure);
    }
    setBookings((current) => replaceBooking(current, result.value));
    setSelectedReference(result.value.reference);
    setAction("none");
    setMessage("Les coordonnées du rendez-vous ont été enregistrées.");
    requestAnimationFrame(() => noticeRef.current?.focus());
  };

  const dayBookings = bookingsForDate(bookings, selectedDate);
  const lastMoveDate = addCivilDays(today, 89);

  return (
    <main className="min-h-screen bg-warm-50 px-4 py-8 text-warm-800 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sage-700">Rendez-vous</p>
            <h1 className="mt-2 font-display text-3xl font-light text-warm-950 sm:text-4xl">Calendrier</h1>
            <p className="mt-2 text-sm text-warm-600">Toutes les heures sont affichées en Europe/Paris.</p>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Navigation du calendrier">
            <button type="button" onClick={() => { setLoading(true); setMessage(null); setMonth(shiftMonth(month, -1)); setSelectedReference(null); }} className="rounded-full border border-warm-300 bg-white px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300">Mois précédent</button>
            <button type="button" onClick={() => { setLoading(true); setMessage(null); setMonth(monthKey(today)); setSelectedDate(today); }} className="rounded-full border border-warm-300 bg-white px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300">Aujourd’hui</button>
            <button type="button" onClick={() => { setLoading(true); setMessage(null); setMonth(shiftMonth(month, 1)); setSelectedReference(null); }} className="rounded-full border border-warm-300 bg-white px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300">Mois suivant</button>
          </div>
        </div>

        <div ref={noticeRef} tabIndex={-1} role={message?.includes("n’est plus") ? "alert" : "status"} aria-live="polite" className={message ? "mt-5 rounded-2xl border border-sage-200 bg-sage-50 px-4 py-3 text-sm focus:outline-none" : "sr-only"}>{message}</div>

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
          <section className="rounded-3xl border border-warm-200 bg-white p-4 shadow-sm sm:p-6" aria-busy={loading}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-2xl capitalize text-warm-900">{new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-15T12:00:00Z`))}</h2>
              <div className="flex rounded-full border border-warm-300 p-1" aria-label="Vue du calendrier">
                {(["month", "day"] as const).map((candidate) => <button key={candidate} type="button" aria-pressed={view === candidate} onClick={() => setView(candidate)} className={`rounded-full px-4 py-2 text-sm ${view === candidate ? "bg-warm-900 text-white" : "text-warm-700"}`}>{candidate === "month" ? "Mois" : "Jour"}</button>)}
              </div>
            </div>
            {loading ? <p role="status" className="py-16 text-center text-warm-600">Chargement des rendez-vous…</p> : view === "month" ? (
              <div className="mt-5 overflow-x-auto">
                {/*
                  ESZ-085: a list of day buttons, not an ARIA grid.

                  This used to carry the grid, columnheader and gridcell roles
                  with no row role between them, which is not a grid — those roles
                  require rows, and without them a screen reader is told about a
                  structure that is not there. The grid role also promises
                  arrow-key navigation between cells, which this component does
                  not implement. Claiming a pattern and then not honouring it is
                  worse for someone relying on it than claiming nothing, because
                  they navigate as if the promise held.

                  So the roles are gone and the layout is unchanged: the CSS grid
                  still lays out seven columns, each day is still a button, and Tab
                  still reaches every one of them in reading order. What is added is
                  the part that was actually missing — each button now says what day
                  it is and how many appointments it holds, instead of announcing a
                  bare number followed by truncated customer names.
                */}
                <div className="grid min-w-[680px] grid-cols-7 gap-1" role="list" aria-label="Calendrier mensuel">
                  {["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"].map((day) => <div key={day} aria-hidden="true" className="px-2 py-2 text-center text-xs font-semibold uppercase text-warm-500">{day}</div>)}
                  {dates.map((date) => {
                    const items = bookingsForDate(bookings, date);
                    return <div key={date} role="listitem" className="contents"><button type="button" aria-label={dayCellLabel(date, items.length)} aria-current={selectedDate === date ? "date" : undefined} onClick={() => { setSelectedDate(date); setView("day"); }} className={`min-h-28 rounded-xl border p-2 text-left align-top focus:outline-none focus:ring-2 focus:ring-sage-300 ${date.startsWith(month) ? "bg-white" : "bg-warm-50 text-warm-400"} ${selectedDate === date ? "border-sage-500" : "border-warm-200"}`}><span aria-hidden="true" className="text-sm font-medium">{Number(date.slice(-2))}</span><span aria-hidden="true" className="mt-2 block space-y-1">{items.slice(0, 3).map((booking) => <span key={booking.reference} className={`block truncate rounded-md px-2 py-1 text-xs ${booking.state === "cancelled" ? "bg-warm-100 text-warm-500 line-through" : "bg-sage-100 text-sage-900"}`}>{formatParisTime(booking.startsAtUtc)} · {booking.customerName}</span>)}{items.length > 3 && <span className="block text-xs text-warm-500">+ {items.length - 3}</span>}</span></button></div>;
                  })}
                </div>
              </div>
            ) : (
              <div className="mt-6">
                <div className="flex items-center justify-between gap-3"><button type="button" onClick={() => navigateDay(addCivilDays(selectedDate, -1))} className="rounded-full border border-warm-300 px-3 py-2" aria-label="Jour précédent">←</button><h3 className="font-medium capitalize">{formatParisDate(selectedDate)}</h3><button type="button" onClick={() => navigateDay(addCivilDays(selectedDate, 1))} className="rounded-full border border-warm-300 px-3 py-2" aria-label="Jour suivant">→</button></div>
                {dayBookings.length === 0 ? <p className="py-16 text-center text-warm-600">Aucun rendez-vous ce jour.</p> : <ul className="mt-5 space-y-3">{dayBookings.map((booking) => <li key={booking.reference}><button type="button" onClick={() => chooseBooking(booking)} className={`flex w-full items-center justify-between gap-4 rounded-2xl border p-4 text-left focus:outline-none focus:ring-2 focus:ring-sage-300 ${booking.state === "cancelled" ? "border-warm-200 bg-warm-50 text-warm-500" : "border-sage-200 bg-sage-50/50"}`}><span><span className="block text-lg font-medium">{formatParisTime(booking.startsAtUtc)} · {booking.customerName}</span><span className="mt-1 block text-sm">{SERVICE_LABELS[booking.serviceKey] ?? booking.serviceKey}</span></span><span className={`rounded-full px-3 py-1 text-xs font-semibold uppercase ${booking.state === "cancelled" ? "bg-warm-200" : "bg-sage-200 text-sage-900"}`}>{booking.state === "cancelled" ? "Annulé" : "Confirmé"}</span></button></li>)}</ul>}
              </div>
            )}
          </section>

          <aside className="rounded-3xl border border-warm-200 bg-white p-5 shadow-sm sm:p-6" aria-label="Détail du rendez-vous">
            {!selected ? <div className="flex min-h-64 items-center justify-center text-center text-sm text-warm-600">Sélectionnez un rendez-vous dans la vue Jour pour afficher ses détails.</div> : <div>
              <h2 ref={detailHeadingRef} tabIndex={-1} className="font-display text-2xl text-warm-900 focus:outline-none">{selected.customerName}</h2>
              <p className="mt-1 text-sm text-warm-600">{SERVICE_LABELS[selected.serviceKey] ?? selected.serviceKey}</p>
              <dl className="mt-5 grid gap-4 text-sm"><div><dt className="text-warm-500">Date et heure (Paris)</dt><dd className="mt-1 font-medium capitalize">{formatParisDate(parisLocalDate(selected.startsAtUtc))}, {formatParisTime(selected.startsAtUtc)}</dd></div><div><dt className="text-warm-500">État</dt><dd className="mt-1 font-medium">{selected.state === "cancelled" ? "Annulé" : "Confirmé"}</dd></div><div><dt className="text-warm-500">Email</dt><dd className="mt-1 break-all"><a className="underline" href={`mailto:${selected.customerEmail}`}>{selected.customerEmail}</a></dd></div>{selected.customerPhone && <div><dt className="text-warm-500">Téléphone</dt><dd className="mt-1"><a className="underline" href={`tel:${selected.customerPhone}`}>{selected.customerPhone}</a></dd></div>}{selected.customerNote && <div><dt className="text-warm-500">Note</dt><dd className="mt-1 whitespace-pre-wrap">{selected.customerNote}</dd></div>}</dl>
              {action === "none" && <div className="mt-6 flex flex-wrap gap-2"><button type="button" onClick={beginContactEdit} className="rounded-full border border-warm-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300">Modifier les coordonnées</button>{selected.state === "confirmed" && <><button type="button" onClick={beginMove} className="rounded-full bg-warm-900 px-4 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sage-300">Déplacer</button><button type="button" onClick={() => { setAction("cancel"); setCancelReason(""); requestAnimationFrame(() => actionHeadingRef.current?.focus()); }} className="rounded-full border border-rose-300 px-4 py-2 text-sm text-rose-800 focus:outline-none focus:ring-2 focus:ring-rose-300">Annuler</button></>}</div>}
              {action === "edit" && <div className="mt-6 border-t border-warm-200 pt-5"><h3 ref={actionHeadingRef} tabIndex={-1} className="font-medium focus:outline-none">Modifier les coordonnées</h3><label className="mt-4 block text-sm" htmlFor="contact-name">Nom</label><input id="contact-name" value={contactName} onChange={(event) => setContactName(event.target.value)} aria-invalid={Boolean(contactErrors.customerName)} aria-describedby={contactErrors.customerName ? "contact-name-error" : undefined} className="mt-1 w-full rounded-xl border border-warm-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-300" />{contactErrors.customerName && <p id="contact-name-error" tabIndex={-1} className="mt-1 text-sm text-rose-800">{contactErrors.customerName}</p>}<label className="mt-4 block text-sm" htmlFor="contact-email">Email</label><input id="contact-email" type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} aria-invalid={Boolean(contactErrors.customerEmail)} aria-describedby={contactErrors.customerEmail ? "contact-email-error" : undefined} className="mt-1 w-full rounded-xl border border-warm-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-300" />{contactErrors.customerEmail && <p id="contact-email-error" tabIndex={-1} className="mt-1 text-sm text-rose-800">{contactErrors.customerEmail}</p>}<label className="mt-4 block text-sm" htmlFor="contact-phone">Téléphone</label><input id="contact-phone" type="tel" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} aria-invalid={Boolean(contactErrors.customerPhone)} aria-describedby={contactErrors.customerPhone ? "contact-phone-error" : undefined} className="mt-1 w-full rounded-xl border border-warm-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-300" />{contactErrors.customerPhone && <p id="contact-phone-error" tabIndex={-1} className="mt-1 text-sm text-rose-800">{contactErrors.customerPhone}</p>}<label className="mt-4 block text-sm" htmlFor="contact-note">Note</label><textarea id="contact-note" value={contactNote} onChange={(event) => setContactNote(event.target.value)} aria-invalid={Boolean(contactErrors.customerNote)} aria-describedby={contactErrors.customerNote ? "contact-note-error" : undefined} className="mt-1 min-h-24 w-full rounded-xl border border-warm-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-300" />{contactErrors.customerNote && <p id="contact-note-error" tabIndex={-1} className="mt-1 text-sm text-rose-800">{contactErrors.customerNote}</p>}<div className="mt-5 flex flex-wrap gap-2"><button type="button" disabled={mutating} onClick={() => void submitContactEdit()} className="rounded-full bg-warm-900 px-4 py-2 text-sm text-white disabled:opacity-40">{mutating ? "Enregistrement…" : "Enregistrer les coordonnées"}</button><button type="button" onClick={() => { setAction("none"); setContactErrors({}); }} className="rounded-full border border-warm-300 px-4 py-2 text-sm">Annuler la modification</button></div></div>}
              {action === "move" && <div className="mt-6 border-t border-warm-200 pt-5"><h3 ref={actionHeadingRef} tabIndex={-1} className="font-medium focus:outline-none">Choisir un nouvel horaire</h3><label className="mt-4 block text-sm" htmlFor="move-date">Date</label><input id="move-date" type="date" min={today} max={lastMoveDate} value={moveDate} onChange={(event) => { const date = event.target.value; setMoveDate(date); if (date) void loadMoveSlots(selected, date); }} className="mt-1 w-full rounded-xl border border-warm-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-300" />{moveLoading ? <p role="status" className="mt-4 text-sm">Chargement des horaires…</p> : moveAvailability?.slots.length ? <fieldset className="mt-4"><legend className="text-sm text-warm-600">Horaires disponibles</legend><div className="mt-2 grid grid-cols-3 gap-2">{moveAvailability.slots.map((slot) => <button key={slot.startsAtUtc} type="button" aria-pressed={selectedSlot === slot.startsAtUtc} onClick={() => setSelectedSlot(slot.startsAtUtc)} className={`rounded-xl border px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300 ${selectedSlot === slot.startsAtUtc ? "border-warm-900 bg-warm-900 text-white" : "border-warm-300"}`}>{slot.localStart}</button>)}</div></fieldset> : <p className="mt-4 text-sm text-warm-600">Aucun horaire disponible à cette date.</p>}<div className="mt-5 flex gap-2"><button type="button" disabled={!selectedSlot || mutating} onClick={() => void submitMove()} className="rounded-full bg-warm-900 px-4 py-2 text-sm text-white disabled:opacity-40">{mutating ? "Confirmation…" : "Confirmer le déplacement"}</button><button type="button" onClick={() => setAction("none")} className="rounded-full border border-warm-300 px-4 py-2 text-sm">Conserver</button></div></div>}
              {action === "cancel" && <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4"><h3 ref={actionHeadingRef} tabIndex={-1} className="font-medium text-rose-950 focus:outline-none">Confirmer l’annulation</h3><p className="mt-2 text-sm text-rose-800">Le rendez-vous restera dans le calendrier avec l’état annulé.</p><label htmlFor="cancel-reason" className="mt-4 block text-sm">Motif facultatif</label><textarea id="cancel-reason" maxLength={500} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} className="mt-1 min-h-20 w-full rounded-xl border border-rose-200 bg-white px-3 py-2" /><div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={mutating} onClick={() => void submitCancellation()} className="rounded-full bg-rose-800 px-4 py-2 text-sm text-white disabled:opacity-40">{mutating ? "Annulation…" : "Confirmer l’annulation"}</button><button type="button" onClick={() => setAction("none")} className="rounded-full border border-warm-300 bg-white px-4 py-2 text-sm">Conserver le rendez-vous</button></div></div>}
              {selected.state === "cancelled" && <p className="mt-6 rounded-2xl bg-warm-100 p-4 text-sm text-warm-600">Ce rendez-vous est annulé et ne peut plus être déplacé ni annulé de nouveau.{selected.cancellationReason ? ` Motif : ${selected.cancellationReason}` : ""}</p>}
            </div>}
          </aside>
        </div>
      </div>
    </main>
  );
}
