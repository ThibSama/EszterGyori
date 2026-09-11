"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminBookingMutationRequestSchema } from "@eszter/contracts";
import { useAdminSession } from "./admin-session-provider";
import { useServiceLabel } from "./admin-service-catalog-provider";
import {
  asReferenceResult,
  loadBookingsRange,
  type AdminApiFailure,
  type AdminBooking,
  type AdminMoveAvailability,
} from "../../lib/admin-api";
import {
  AdminAvailabilityEditor,
  useAvailabilityWorkspace,
} from "./admin-availability-editor";
import {
  WEEK_DAY_HEADS,
  dayAvailabilityLabel,
  isHourOpen,
  shiftWeek,
  weekDays,
  weekHourSpan,
  weekPlan,
  weekRangeLabel,
  type WeekAppointment,
  type WeekDayPlan,
} from "../../lib/admin-calendar-week";
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

/** The three temporal scales the calendar offers. Week is the one it opens on. */
type View = "week" | "month" | "day";

/** Which side of the unified calendar a route wants open on arrival (ESZ-159). */
export type CalendarPanel = "appointments" | "availability";
type DetailAction = "none" | "move" | "cancel" | "edit";
type ContactField = "customerName" | "customerEmail" | "customerPhone" | "customerNote";
type ContactErrors = Partial<Record<ContactField, string>>;

const CONTACT_ERROR_MESSAGES: Record<ContactField, string> = {
  customerName: "Saisissez un nom valide.",
  customerEmail: "Saisissez une adresse email valide.",
  customerPhone: "Saisissez un numéro de téléphone valide.",
  customerNote: "Saisissez une note valide.",
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

/**
 * The accessible name of one week-view day head.
 *
 * The week grid's whole point is that appointments and planning constraints are
 * legible together, and a head that read only "lundi 1 juin" would keep the
 * constraint half sighted-only: the shading says "closed" and the text said
 * nothing. So the day's availability is part of its name, in the same words the
 * visible line uses.
 */
function weekDayHeadLabel(plan: WeekDayPlan, ready: boolean): string {
  const appointments =
    plan.appointments.length === 0
      ? "aucun rendez-vous"
      : `${plan.appointments.length} rendez-vous`;

  return `${formatParisDate(plan.date)}, ${appointments}, ${availabilityPhrase(plan, ready)}`;
}

/**
 * The day's availability in words — or the honest absence of it.
 *
 * `ready` is false while the loaded availability does not cover this date, and
 * the sentence has to say so rather than read out the weekly fallback: a screen
 * reader hearing "Fermé" for a date whose stored closure was never read is told
 * the same falsehood the shading would tell (ESZ-159).
 */
function availabilityPhrase(plan: WeekDayPlan, ready: boolean): string {
  return ready ? dayAvailabilityLabel(plan) : "disponibilité non chargée pour cette date";
}

/** The accessible name of the button that edits one date's exception. */
function availabilityButtonLabel(plan: WeekDayPlan, ready: boolean): string {
  const action = ready
    ? "Modifier l’exception de cette date."
    : "Disponible une fois les disponibilités chargées.";
  return `Disponibilité du ${formatParisDate(plan.date)} : ${availabilityPhrase(plan, ready)}. ${action}`;
}

/** The accessible name of one appointment chip on the week grid. */
function weekAppointmentLabel(item: WeekAppointment, serviceLabel: (key: string | readonly string[]) => string): string {
  const state = item.booking.state === "cancelled" ? "annulé" : "confirmé";
  return `${item.startLocal} – ${item.endLocal}, ${item.booking.customerName}, ${serviceLabel(item.booking.serviceKeys)}, ${state}`;
}

export function AdminBookingCalendar({
  initialPanel = "appointments",
}: Readonly<{ initialPanel?: CalendarPanel }> = {}) {
  const { api, csrfToken, markExpired, refreshSession } = useAdminSession();
  // ESZ-149: service names come from the catalog, archived rows included, so
  // a historical booking on an archived service still reads as that service.
  const serviceLabel = useServiceLabel();
  const [showAvailability, setShowAvailability] = useState(initialPanel === "availability");
  const today = useMemo(() => parisLocalDate(), []);
  const [month, setMonth] = useState(monthKey(today));
  const [selectedDate, setSelectedDate] = useState(today);
  const [view, setView] = useState<View>("week");
  const [bookings, setBookings] = useState<AdminBooking[]>([]);
  const [selectedReference, setSelectedReference] = useState<string | null>(null);
  const [loadedRange, setLoadedRange] = useState<string | null>(null);
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
  // The visible span *is* the fetch range, whichever scale is on screen. One
  // memo answers both questions, so the walk below can never load a range the
  // grid is not showing.
  const dates = useMemo(() => {
    if (view === "week") return weekDays(selectedDate);
    if (view === "day") return [selectedDate];
    return monthGrid(month);
  }, [month, selectedDate, view]);
  const rangeKey = `${dates[0]}..${dates[dates.length - 1]}`;
  const visibleSpan = useMemo(
    () => ({ fromDate: dates[0], untilDate: dates[dates.length - 1] }),
    [dates],
  );
  // ESZ-159: one availability state for the whole destination. The grid shades
  // itself from these rules and the editor below saves them; there is no second
  // fetch and no second opinion about what a date is open for. The span on
  // screen is what it reads for, so navigating out of the loaded window re-reads
  // instead of projecting dates the last read never covered.
  const availability = useAvailabilityWorkspace(visibleSpan);
  /**
   * Busy is *derived*, not announced.
   *
   * Every navigation changes the visible span, and the two obvious spellings of
   * this both have a failure mode: raising a flag inside the effect is a
   * cascading render, and asking each navigation handler to raise it means the
   * one handler that forgets shows stale rows as if they were loaded, while one
   * that raises it for a span that turns out identical hangs on a spinner that
   * nothing will ever clear. Comparing the span on screen with the span that was
   * actually fetched cannot do either: it is true exactly when the two disagree.
   */
  const loading = loadedRange !== rangeKey;
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
    // ESZ-144: one month is one *walk*. The server pages a range on a fixed
    // page size with typed cursors; this consumes every page before the month
    // is shown, so a month with more rows than the old cap never renders as a
    // silently clipped subset. loadBookingsRange guards the walk — cursor
    // progress, malformed pages, and the declared page budget.
    void loadBookingsRange(api, dates[0], dates[dates.length - 1]).then((result) => {
      if (!active) return;
      // The span is recorded as fetched either way: a failure that left it
      // unrecorded would re-enter this effect on the next render, retrying a
      // refused read forever behind a spinner.
      setLoadedRange(rangeKey);
      if (!result.ok) return void handleFailure(result.failure);
      setBookings(result.value);
    });
    return () => { active = false; };
  }, [api, dates, handleFailure, rangeKey]);

  const chooseBooking = (booking: AdminBooking) => {
    setSelectedReference(booking.reference);
    setAction("none");
    setMessage(null);
    requestAnimationFrame(() => detailHeadingRef.current?.focus());
  };

  const refreshOne = useCallback(async (reference: string): Promise<AdminBooking | null> => {
    const result = await api.queryBookings({ mode: "reference", reference });
    if (!result.ok) {
      void handleFailure(result.failure);
      return null;
    }
    // ESZ-139: the calendar adopts the authoritative reloaded row — the whole
    // UI keeps working from it, never from the copy the tab held before.
    // ESZ-145: the reference envelope is the booking beside its history page;
    // the calendar adopts the current-state booking and ignores the trail.
    const fresh = asReferenceResult(result.value)?.booking ?? null;
    if (fresh) setBookings((current) => replaceBooking(current, fresh));
    return fresh;
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

  /**
   * Move the calendar to a date, keeping the month in step.
   *
   * Week and day navigation both change the anchor, and the month view reads
   * `month` rather than the anchor — so without this the operator could page
   * three weeks forward, switch to Mois, and land back where they started.
   */
  const goToDate = (date: string) => {
    setSelectedDate(date);
    setMonth(monthKey(date));
    setMessage(null);
  };

  /** Opens the availability editor on one date, revealing it if it was folded away. */
  const editAvailability = (date: string) => {
    setShowAvailability(true);
    availability.openDraft(date);
  };

  const navigateDay = (date: string) => {
    goToDate(date);
  };

  const submitMove = async () => {
    if (!selected || !selectedSlot || mutating) return;
    setMutating(true);
    const result = await api.mutateBooking(
      {
        action: "move",
        reference: selected.reference,
        expectedUpdatedAt: selected.updatedAt,
        startsAtUtc: selectedSlot,
      },
      csrfToken,
    );
    setMutating(false);
    if (!result.ok) {
      if (result.failure.kind !== "conflict") return void handleFailure(result.failure);
      // ESZ-139 — both move conflicts reload the booking by reference first:
      // the calendar then keeps working from the authoritative row, and slots
      // are refreshed only when the reloaded booking is still confirmed. The
      // two frozen codes are told apart: a REVISION_CONFLICT means the tab was
      // stale (never auto-retried, explicit stale-data copy, no success
      // claim), while SLOT_UNAVAILABLE means another appointment took the
      // instant and the operator should pick another slot.
      setSelectedSlot(null);
      const fresh = await refreshOne(selected.reference);
      if (fresh?.state === "confirmed") {
        await loadMoveSlots(fresh, moveDate);
      } else {
        setAction("none");
      }
      if (result.failure.errorCode === "REVISION_CONFLICT") {
        setMessage("Ce rendez-vous avait déjà changé. Il n’a pas été déplacé : les données affichées ont été actualisées.");
      } else {
        setMessage("Ce créneau n’est plus disponible. Le rendez-vous n’a pas été déplacé ; choisissez un autre horaire.");
      }
      requestAnimationFrame(() => noticeRef.current?.focus());
      return;
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
      {
        action: "cancel",
        reference: selected.reference,
        expectedUpdatedAt: selected.updatedAt,
        reason: cancelReason.trim() || null,
      },
      csrfToken,
    );
    setMutating(false);
    if (!result.ok) {
      if (result.failure.kind === "conflict") {
        // ESZ-139: stale cancellation — never auto-retried, never claimed as
        // cancelled. The booking is reloaded by reference and the panel closes
        // on the authoritative row with explicit stale-data copy.
        setCancelReason("");
        await refreshOne(selected.reference);
        setAction("none");
        setMessage("Ce rendez-vous avait déjà changé. Il n’a pas été annulé : les données affichées ont été actualisées.");
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
      expectedUpdatedAt: selected.updatedAt,
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

  /** One step at the scale currently on screen. */
  const stepView = (delta: number) => {
    setSelectedReference(null);
    setMessage(null);
    if (view === "month") {
      setMonth(shiftMonth(month, delta));
      return;
    }
    goToDate(view === "week" ? shiftWeek(selectedDate, delta) : addCivilDays(selectedDate, delta));
  };

  // Ready means *covered*, not merely "not loading". A week the last read did
  // not include has no exceptions in hand, and `dateWindows` would answer for it
  // from the weekly rules alone — a stored closure would render as ordinary
  // opening hours, which is a false planning constraint rather than a slow one.
  // So the grid waits, exactly as it already waits for its appointments.

  // The week the grid draws, and the hours tall enough to hold it. Both are
  // projections of state the server already returned — `weekPlan` asks
  // `dateWindows` what each day is open for and lays the answer beside the
  // appointments, which is the whole of the "readable together" requirement and
  // none of a slot rule.
  const weekDates = useMemo(() => weekDays(selectedDate), [selectedDate]);
  const availabilityReady =
    !availability.loading &&
    availability.covers(weekDates[0]) &&
    availability.covers(weekDates[weekDates.length - 1]);
  const week = useMemo(
    () => weekPlan(weekDates, availability.rules, availability.exceptions, bookings, today),
    [availability.exceptions, availability.rules, bookings, today, weekDates],
  );
  const hourSpan = useMemo(
    () => weekHourSpan(weekDates, availability.rules, availability.exceptions, bookings),
    [availability.exceptions, availability.rules, bookings, weekDates],
  );
  const hours = useMemo(
    () =>
      Array.from(
        { length: hourSpan.lastHour - hourSpan.firstHour },
        (_, index) => hourSpan.firstHour + index,
      ),
    [hourSpan],
  );

  const scaleLabel = { week: "Semaine", month: "Mois", day: "Jour" } as const;
  const stepLabels = {
    week: ["Semaine précédente", "Semaine suivante"],
    month: ["Mois précédent", "Mois suivant"],
    day: ["Jour précédent", "Jour suivant"],
  } as const;
  const periodHeading =
    view === "week"
      ? weekRangeLabel(weekDates)
      : view === "day"
        ? formatParisDate(selectedDate)
        : new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-15T12:00:00Z`));

  const dayBookings = bookingsForDate(bookings, selectedDate);
  const lastMoveDate = addCivilDays(today, 89);

  return (
    <main className="min-h-screen bg-warm-50 px-4 py-8 text-warm-800 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sage-700">Rendez-vous et disponibilités</p>
            <h1 className="mt-2 font-display text-3xl font-light text-warm-950 sm:text-4xl">Calendrier</h1>
            <p className="mt-2 text-sm text-warm-600">Toutes les heures sont affichées en Europe/Paris.</p>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Navigation du calendrier">
            <button type="button" onClick={() => stepView(-1)} className="rounded-full border border-warm-300 bg-white px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300">{stepLabels[view][0]}</button>
            <button type="button" onClick={() => { setSelectedReference(null); setMessage(null); goToDate(today); }} className="rounded-full border border-warm-300 bg-white px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300">Aujourd’hui</button>
            <button type="button" onClick={() => stepView(1)} className="rounded-full border border-warm-300 bg-white px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300">{stepLabels[view][1]}</button>
            <button type="button" aria-expanded={showAvailability} aria-controls="calendar-availability" onClick={() => setShowAvailability((current) => !current)} className="rounded-full bg-warm-900 px-4 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sage-300">{showAvailability ? "Masquer les disponibilités" : "Gérer les disponibilités"}</button>
          </div>
        </div>

        <div ref={noticeRef} tabIndex={-1} role={message?.includes("n’est plus") ? "alert" : "status"} aria-live="polite" className={message ? "mt-5 rounded-2xl border border-sage-200 bg-sage-50 px-4 py-3 text-sm focus:outline-none" : "sr-only"}>{message}</div>

        {/*
          The side column is right for a list and wrong for a week.
          Month and Jour render a narrow column of appointments, so a 420 px
          detail panel beside them costs nothing. The week grid is 860 px at its
          narrowest, and on a 1280 px laptop behind a 256 px sidebar the side
          column leaves it about 500 px — so the week would arrive on desktop
          already scrolled, showing three days of seven. The grid takes the full
          width at that scale instead and the detail panel sits below it, which
          is where selecting an appointment already moves focus.
        */}
        <div className={`mt-6 grid gap-6 ${view === "week" ? "" : "xl:grid-cols-[minmax(0,1fr)_420px]"}`}>
          {/*
            `min-w-0` is load-bearing, not tidying. Below `xl` this two-column
            grid collapses to one implicit column whose width is `auto`, so a
            grid item is free to be as wide as its widest content — and the week
            grid declares an 860 px minimum. Without it the section pushes the
            *document* sideways at tablet widths instead of letting the week
            scroll inside its own container, which is exactly the "crushed grid"
            failure the responsive requirement forbids.
          */}
          <section className="min-w-0 rounded-3xl border border-warm-200 bg-white p-4 shadow-sm sm:p-6" aria-busy={loading}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-2xl capitalize text-warm-900">{periodHeading}</h2>
              <div className="flex rounded-full border border-warm-300 p-1" aria-label="Vue du calendrier">
                {(["week", "month", "day"] as const).map((candidate) => <button key={candidate} type="button" aria-pressed={view === candidate} onClick={() => setView(candidate)} className={`rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300 ${view === candidate ? "bg-warm-900 text-white" : "text-warm-700"}`}>{scaleLabel[candidate]}</button>)}
              </div>
            </div>
            {loading ? <p role="status" className="py-16 text-center text-warm-600">Chargement des rendez-vous…</p> : view === "week" ? (
              <div className="mt-5">
                <p className="text-xs text-warm-500 lg:hidden">
                  Faites défiler la grille horizontalement pour parcourir toute la semaine.
                </p>
                <div className="mt-2 overflow-x-auto">
                  <div className="grid min-w-[860px] grid-cols-[4.5rem_repeat(7,minmax(0,1fr))] gap-1">
                    <div aria-hidden="true" />
                    {week.map((plan, index) => (
                      <div key={plan.date} className="space-y-1">
                        <button
                          type="button"
                          aria-label={weekDayHeadLabel(plan, availabilityReady)}
                          aria-current={selectedDate === plan.date ? "date" : undefined}
                          onClick={() => { setView("day"); goToDate(plan.date); }}
                          className={`w-full rounded-xl border px-2 py-2 text-center focus:outline-none focus:ring-2 focus:ring-sage-300 ${plan.isToday ? "border-sage-500 bg-sage-50" : "border-warm-200 bg-white"}`}>
                          <span aria-hidden="true" className="block text-xs font-semibold uppercase tracking-wide text-warm-500">{WEEK_DAY_HEADS[index]}</span>
                          <span aria-hidden="true" className="block text-lg font-medium text-warm-900">{Number(plan.date.slice(-2))}</span>
                        </button>
                        <button
                          type="button"
                          aria-label={availabilityButtonLabel(plan, availabilityReady)}
                          disabled={!availabilityReady}
                          onClick={() => editAvailability(plan.date)}
                          className={`w-full rounded-lg border px-2 py-1 text-[11px] leading-tight focus:outline-none focus:ring-2 focus:ring-sage-300 disabled:cursor-progress ${!availabilityReady ? "border-warm-200 bg-warm-50 text-warm-500" : plan.windows.length === 0 ? "border-warm-200 bg-warm-100 text-warm-600" : plan.kind === "exception" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-sage-200 bg-sage-50 text-sage-900"}`}>
                          <span aria-hidden="true">{availabilityReady ? dayAvailabilityLabel(plan) : availability.loading ? "Chargement…" : "Indisponible"}</span>
                        </button>
                      </div>
                    ))}
                    {hours.map((hour) => (
                      <div key={hour} className="contents">
                        <div aria-hidden="true" className="pr-2 pt-1 text-right text-xs text-warm-500">{`${String(hour).padStart(2, "0")}:00`}</div>
                        {week.map((plan) => {
                          const openHour = availabilityReady && isHourOpen(hour, plan.windows);
                          const items = plan.appointments.filter((item) => item.hour === hour);
                          return (
                            <div
                              key={`${plan.date}-${hour}`}
                              className={`min-h-12 rounded-lg border p-1 ${openHour ? "border-sage-100 bg-white" : "border-warm-100 bg-warm-50"} ${plan.isToday ? "ring-1 ring-sage-200" : ""}`}>
                              {items.map((item) => (
                                <button
                                  key={item.booking.reference}
                                  type="button"
                                  aria-label={weekAppointmentLabel(item, serviceLabel)}
                                  aria-current={selectedReference === item.booking.reference ? "true" : undefined}
                                  onClick={() => chooseBooking(item.booking)}
                                  className={`mb-1 block w-full rounded-md px-2 py-1 text-left text-xs focus:outline-none focus:ring-2 focus:ring-sage-300 ${item.booking.state === "cancelled" ? "bg-warm-100 text-warm-500 line-through" : "bg-sage-100 text-sage-900"} ${selectedReference === item.booking.reference ? "ring-2 ring-sage-400" : ""}`}>
                                  <span aria-hidden="true" className="block font-medium">{item.startLocal}</span>
                                  <span aria-hidden="true" className="block truncate">{item.booking.customerName}</span>
                                  {item.span > 1 && (
                                    <span aria-hidden="true" className="block text-[10px] text-warm-600">→ {item.endLocal}</span>
                                  )}
                                </button>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : view === "month" ? (
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
                {dayBookings.length === 0 ? <p className="py-16 text-center text-warm-600">Aucun rendez-vous ce jour.</p> : <ul className="mt-5 space-y-3">{dayBookings.map((booking) => <li key={booking.reference}><button type="button" onClick={() => chooseBooking(booking)} className={`flex w-full items-center justify-between gap-4 rounded-2xl border p-4 text-left focus:outline-none focus:ring-2 focus:ring-sage-300 ${booking.state === "cancelled" ? "border-warm-200 bg-warm-50 text-warm-500" : "border-sage-200 bg-sage-50/50"}`}><span><span className="block text-lg font-medium">{formatParisTime(booking.startsAtUtc)} · {booking.customerName}</span><span className="mt-1 block text-sm">{serviceLabel(booking.serviceKeys)}</span></span><span className={`rounded-full px-3 py-1 text-xs font-semibold uppercase ${booking.state === "cancelled" ? "bg-warm-200" : "bg-sage-200 text-sage-900"}`}>{booking.state === "cancelled" ? "Annulé" : "Confirmé"}</span></button></li>)}</ul>}
              </div>
            )}
          </section>

          <aside className="rounded-3xl border border-warm-200 bg-white p-5 shadow-sm sm:p-6" aria-label="Détail du rendez-vous">
            {!selected ? <div className="flex min-h-64 items-center justify-center text-center text-sm text-warm-600">Sélectionnez un rendez-vous dans la vue Jour pour afficher ses détails.</div> : <div>
              <h2 ref={detailHeadingRef} tabIndex={-1} className="font-display text-2xl text-warm-900 focus:outline-none">{selected.customerName}</h2>
              <p className="mt-1 text-sm text-warm-600">{serviceLabel(selected.serviceKeys)}</p>
              <dl className="mt-5 grid gap-4 text-sm"><div><dt className="text-warm-500">Date et heure (Paris)</dt><dd className="mt-1 font-medium capitalize">{formatParisDate(parisLocalDate(selected.startsAtUtc))}, {formatParisTime(selected.startsAtUtc)}</dd></div><div><dt className="text-warm-500">État</dt><dd className="mt-1 font-medium">{selected.state === "cancelled" ? "Annulé" : "Confirmé"}</dd></div><div><dt className="text-warm-500">Email</dt><dd className="mt-1 break-all"><a className="underline" href={`mailto:${selected.customerEmail}`}>{selected.customerEmail}</a></dd></div>{selected.customerPhone && <div><dt className="text-warm-500">Téléphone</dt><dd className="mt-1"><a className="underline" href={`tel:${selected.customerPhone}`}>{selected.customerPhone}</a></dd></div>}{selected.customerNote && <div><dt className="text-warm-500">Note</dt><dd className="mt-1 whitespace-pre-wrap">{selected.customerNote}</dd></div>}</dl>
              {action === "none" && <div className="mt-6 flex flex-wrap gap-2"><button type="button" onClick={beginContactEdit} className="rounded-full border border-warm-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300">Modifier les coordonnées</button>{selected.state === "confirmed" && <><button type="button" onClick={beginMove} className="rounded-full bg-warm-900 px-4 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sage-300">Déplacer</button><button type="button" onClick={() => { setAction("cancel"); setCancelReason(""); requestAnimationFrame(() => actionHeadingRef.current?.focus()); }} className="rounded-full border border-rose-300 px-4 py-2 text-sm text-rose-800 focus:outline-none focus:ring-2 focus:ring-rose-300">Annuler</button></>}</div>}
              {action === "edit" && <div className="mt-6 border-t border-warm-200 pt-5"><h3 ref={actionHeadingRef} tabIndex={-1} className="font-medium focus:outline-none">Modifier les coordonnées</h3><label className="mt-4 block text-sm" htmlFor="contact-name">Nom</label><input id="contact-name" value={contactName} onChange={(event) => setContactName(event.target.value)} aria-invalid={Boolean(contactErrors.customerName)} aria-describedby={contactErrors.customerName ? "contact-name-error" : undefined} className="mt-1 w-full rounded-xl border border-warm-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-300" />{contactErrors.customerName && <p id="contact-name-error" tabIndex={-1} className="mt-1 text-sm text-rose-800">{contactErrors.customerName}</p>}<label className="mt-4 block text-sm" htmlFor="contact-email">Email</label><input id="contact-email" type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} aria-invalid={Boolean(contactErrors.customerEmail)} aria-describedby={contactErrors.customerEmail ? "contact-email-error" : undefined} className="mt-1 w-full rounded-xl border border-warm-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-300" />{contactErrors.customerEmail && <p id="contact-email-error" tabIndex={-1} className="mt-1 text-sm text-rose-800">{contactErrors.customerEmail}</p>}<label className="mt-4 block text-sm" htmlFor="contact-phone">Téléphone</label><input id="contact-phone" type="tel" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} aria-invalid={Boolean(contactErrors.customerPhone)} aria-describedby={contactErrors.customerPhone ? "contact-phone-error" : undefined} className="mt-1 w-full rounded-xl border border-warm-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-300" />{contactErrors.customerPhone && <p id="contact-phone-error" tabIndex={-1} className="mt-1 text-sm text-rose-800">{contactErrors.customerPhone}</p>}<label className="mt-4 block text-sm" htmlFor="contact-note">Note</label><textarea id="contact-note" value={contactNote} onChange={(event) => setContactNote(event.target.value)} aria-invalid={Boolean(contactErrors.customerNote)} aria-describedby={contactErrors.customerNote ? "contact-note-error" : undefined} className="mt-1 min-h-24 w-full rounded-xl border border-warm-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-300" />{contactErrors.customerNote && <p id="contact-note-error" tabIndex={-1} className="mt-1 text-sm text-rose-800">{contactErrors.customerNote}</p>}<div className="mt-5 flex flex-wrap gap-2"><button type="button" disabled={mutating} onClick={() => void submitContactEdit()} className="rounded-full bg-warm-900 px-4 py-2 text-sm text-white disabled:opacity-40">{mutating ? "Enregistrement…" : "Enregistrer les coordonnées"}</button><button type="button" onClick={() => { setAction("none"); setContactErrors({}); }} className="rounded-full border border-warm-300 px-4 py-2 text-sm">Annuler la modification</button></div></div>}
              {action === "move" && <div className="mt-6 border-t border-warm-200 pt-5"><h3 ref={actionHeadingRef} tabIndex={-1} className="font-medium focus:outline-none">Choisir un nouvel horaire</h3><label className="mt-4 block text-sm" htmlFor="move-date">Date</label><input id="move-date" type="date" min={today} max={lastMoveDate} value={moveDate} onChange={(event) => { const date = event.target.value; setMoveDate(date); if (date) void loadMoveSlots(selected, date); }} className="mt-1 w-full rounded-xl border border-warm-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-300" />{moveLoading ? <p role="status" className="mt-4 text-sm">Chargement des horaires…</p> : moveAvailability?.slots.length ? <fieldset className="mt-4"><legend className="text-sm text-warm-600">Horaires disponibles</legend><div className="mt-2 grid grid-cols-3 gap-2">{moveAvailability.slots.map((slot) => <button key={slot.startsAtUtc} type="button" aria-pressed={selectedSlot === slot.startsAtUtc} onClick={() => setSelectedSlot(slot.startsAtUtc)} className={`rounded-xl border px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300 ${selectedSlot === slot.startsAtUtc ? "border-warm-900 bg-warm-900 text-white" : "border-warm-300"}`}>{slot.localStart}</button>)}</div></fieldset> : <p className="mt-4 text-sm text-warm-600">Aucun horaire disponible à cette date.</p>}<div className="mt-5 flex gap-2"><button type="button" disabled={!selectedSlot || mutating} onClick={() => void submitMove()} className="rounded-full bg-warm-900 px-4 py-2 text-sm text-white disabled:opacity-40">{mutating ? "Confirmation…" : "Confirmer le déplacement"}</button><button type="button" onClick={() => setAction("none")} className="rounded-full border border-warm-300 px-4 py-2 text-sm">Conserver</button></div></div>}
              {action === "cancel" && <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4"><h3 ref={actionHeadingRef} tabIndex={-1} className="font-medium text-rose-950 focus:outline-none">Confirmer l’annulation</h3><p className="mt-2 text-sm text-rose-800">Le rendez-vous restera dans le calendrier avec l’état annulé.</p><label htmlFor="cancel-reason" className="mt-4 block text-sm">Motif facultatif</label><textarea id="cancel-reason" maxLength={500} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} className="mt-1 min-h-20 w-full rounded-xl border border-rose-200 bg-white px-3 py-2" /><div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={mutating} onClick={() => void submitCancellation()} className="rounded-full bg-rose-800 px-4 py-2 text-sm text-white disabled:opacity-40">{mutating ? "Annulation…" : "Confirmer l’annulation"}</button><button type="button" onClick={() => setAction("none")} className="rounded-full border border-warm-300 bg-white px-4 py-2 text-sm">Conserver le rendez-vous</button></div></div>}
              {selected.state === "cancelled" && <p className="mt-6 rounded-2xl bg-warm-100 p-4 text-sm text-warm-600">Ce rendez-vous est annulé et ne peut plus être déplacé ni annulé de nouveau.{selected.cancellationReason ? ` Motif : ${selected.cancellationReason}` : ""}</p>}
            </div>}
          </aside>
        </div>

        {/*
          ESZ-159: availability is part of this destination, not a page next to
          it. It sits below the grid at full width rather than inside the 420 px
          detail column, because the weekly-hours rows are a four-field form per
          row: squeezed into the side column they would be unusable at exactly
          the widths (tablet, split screens) where the operator is most likely to
          be standing. Folded away by default, it keeps the appointment view the
          thing the page opens on, and a day's availability button above opens it
          straight onto that date.
        */}
        <div id="calendar-availability" className="mt-6">
          {showAvailability && <AdminAvailabilityEditor workspace={availability} />}
        </div>
      </div>
    </main>
  );
}
