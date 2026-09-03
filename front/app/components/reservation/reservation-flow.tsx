"use client";

import { defaultSiteContent, type SiteContent } from "@eszter/contracts";
import Link from "next/link";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  createBooking,
  loadAvailability,
  loadBookableServices,
  loadPublishedContent,
  type PublicBookableService,
  withSubmissionLock,
} from "../../lib/booking-api";
import {
  RESERVATION_HORIZON_DAYS,
  RESERVATION_RANGE_DAYS,
  activeEditorialServices,
  addCivilDays,
  datesBetween,
  createBookingRequest,
  initialReservationState,
  parisToday,
  rangeFrom,
  reservationFlowReducer,
} from "../../lib/reservation-flow";
import { createSiteAppearanceVariables } from "../../lib/site-appearance";
import {
  isRetryBlocked,
  retryAllowedAtEpochMs,
  retryWaitLabel,
} from "../../lib/retry-after";
import { ReservationDetails } from "./reservation-details";

const DATE_FORMAT = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris",
  weekday: "short",
  day: "numeric",
  month: "short",
});

function dateLabel(date: string): string {
  return DATE_FORMAT.format(new Date(`${date}T12:00:00Z`));
}

function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest}`;
}

export function ReservationFlow() {
  const today = parisToday();
  const [services, setServices] = useState<PublicBookableService[]>([]);
  const [content, setContent] = useState<SiteContent>(defaultSiteContent);
  const [servicesStatus, setServicesStatus] = useState<"loading" | "ready" | "error">("loading");
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [contentFallback, setContentFallback] = useState(false);
  const [bootstrapVersion, setBootstrapVersion] = useState(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const submissionLock = useRef({ current: false });
  const slotHeading = useRef<HTMLHeadingElement>(null);
  const previousNotice = useRef<string | null>(null);
  const [state, dispatch] = useReducer(
    reservationFlowReducer,
    today,
    initialReservationState,
  );
  // The render clock (a state value — never Date.now() during render): while
  // a trusted retry delay runs the interval below advances it each second, so
  // the countdowns update and the retry controls re-enable at their deadline.
  // It only re-renders: nothing in that interval dispatches or fetches.
  const [nowEpochMs, setNowEpochMs] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      loadBookableServices(fetch, controller.signal),
      loadPublishedContent(defaultSiteContent, fetch, controller.signal),
    ]).then(([serviceResult, contentResult]) => {
      if (controller.signal.aborted) return;
      setContent(contentResult.content);
      setContentFallback(contentResult.usedDefault);
      if (!serviceResult.ok) {
        setServicesStatus("error");
        setServicesError(serviceResult.failure.message);
        return;
      }
      setServices(serviceResult.value);
      setServicesStatus("ready");

      const requested = new URLSearchParams(window.location.search).get("service");
      const matching = serviceResult.value.find((service) => service.key === requested);
      if (matching) dispatch({ type: "select-service", serviceKey: matching.key });
    });

    return () => controller.abort();
  }, [bootstrapVersion]);

  useEffect(() => {
    const availabilityGate = state.availabilityRetryAtEpochMs;
    const submissionGate = state.submissionRetryAtEpochMs;
    if (availabilityGate === null && submissionGate === null) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      const stillBlocked = (availabilityGate !== null && now < availabilityGate)
        || (submissionGate !== null && now < submissionGate);
      // Advance the render clock first, then stop once every gate has
      // elapsed: the final tick is what re-enables the controls.
      setNowEpochMs(now);
      if (!stillBlocked) window.clearInterval(interval);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [state.availabilityRetryAtEpochMs, state.submissionRetryAtEpochMs]);

  useEffect(() => {
    if (!state.serviceKey) return;
    // ESZ-136: while a trusted Retry-After delay from a refused availability
    // load is running, no availability request is started — not even from a
    // control that slipped through. The interval above re-renders at the
    // deadline and re-enables the manual control; nothing fires by itself.
    if (isRetryBlocked(state.availabilityRetryAtEpochMs, Date.now())) return;
    const controller = new AbortController();
    dispatch({ type: "request" });
    void loadAvailability(
      state.serviceKey,
      state.fromDate,
      state.untilDate,
      fetch,
      controller.signal,
    ).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        dispatch({ type: "received", availability: result.value });
        return;
      }
      if (result.failure.kind === "rate-limited") {
        setNowEpochMs(Date.now());
        dispatch({
          type: "rate-limited",
          message: result.failure.message,
          retryAtEpochMs: retryAllowedAtEpochMs(
            Date.now(),
            result.failure.retryAfterSeconds,
          ),
        });
        return;
      }
      dispatch({ type: "failed", message: result.failure.message });
    });
    return () => controller.abort();
    // The retry gate is deliberately not a dependency: it only *skips* a
    // request while a trusted delay runs. Re-running this effect when the
    // gate changes would dispatch a duplicate request — the effect itself
    // clears the gate on every request it does start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today, state.serviceKey, state.fromDate, state.untilDate, refreshVersion]);

  const visibleServices = useMemo(
    () => activeEditorialServices(content.services.items, services),
    [content.services.items, services],
  );
  const selectedServiceLabel = visibleServices.find(
    ({ booking }) => booking.key === state.serviceKey,
  )?.editorial.title ?? "Prestation";
  const dates = state.availabilityStatus === "ready"
    ? datesBetween(state.fromDate, state.untilDate)
    : [];
  const selectedDateSlots = state.selectedDate
    ? state.slots.filter((slot) => slot.localDate === state.selectedDate)
    : [];
  const maxRangeStart = addCivilDays(today, RESERVATION_HORIZON_DAYS - RESERVATION_RANGE_DAYS);

  function navigate(days: number) {
    let start = addCivilDays(state.fromDate, days);
    if (start < today) start = today;
    if (start > maxRangeStart) start = maxRangeStart;
    dispatch({ type: "navigate", ...rangeFrom(start) });
  }

  useEffect(() => {
    if (state.notice && state.notice !== previousNotice.current && !state.selectedSlot) {
      slotHeading.current?.focus();
    }
    previousNotice.current = state.notice;
  }, [state.notice, state.selectedSlot]);

  async function submitBooking() {
    if (!state.serviceKey || !state.selectedSlot) return;
    // ESZ-136: a trusted Retry-After delay from a refused creation blocks the
    // confirmation until it elapses; the control is disabled, and this guard
    // closes the same-tick gap for anything that reaches the handler anyway.
    if (isRetryBlocked(state.submissionRetryAtEpochMs, Date.now())) return;
    const request = createBookingRequest(state.serviceKey, state.selectedSlot, state.customer);
    const result = await withSubmissionLock(submissionLock.current, async () => {
      dispatch({ type: "submit-start" });
      return createBooking(request);
    });
    if (result === null) return;
    if (result.ok) {
      dispatch({ type: "submit-success", confirmation: result.value });
      return;
    }
    if (result.failure.kind === "slot-unavailable") {
      dispatch({ type: "booking-slot-unavailable", message: result.failure.message });
      setRefreshVersion((value) => value + 1);
      return;
    }
    if (result.failure.kind === "rate-limited") {
      setNowEpochMs(Date.now());
      dispatch({
        type: "submit-failed",
        failure: result.failure,
        retryAtEpochMs: retryAllowedAtEpochMs(
          Date.now(),
          result.failure.retryAfterSeconds,
        ),
      });
      return;
    }
    dispatch({ type: "submit-failed", failure: result.failure });
  }

  const submissionInFlight = state.phase === "submitting";
  const availabilityRetryBlocked = isRetryBlocked(
    state.availabilityRetryAtEpochMs,
    nowEpochMs,
  );
  const availabilityRetryCopy = retryWaitLabel(
    state.availabilityRetryAtEpochMs,
    nowEpochMs,
  );

  return (
    <div
      className="site-preview min-h-screen relative overflow-hidden"
      style={createSiteAppearanceVariables(content.appearance)}>
      <a href="#reservation-main" className="skip-link">Aller au choix du rendez-vous</a>
      <div aria-hidden="true" className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="ambient-shape absolute -top-32 -left-36 h-[520px] w-[520px] rounded-full bg-sage-300/60 blur-[110px]" />
        <div className="ambient-drift absolute bottom-[-12rem] right-[-10rem] h-[560px] w-[560px] rounded-full bg-mist-300/50 blur-[110px]" />
      </div>

      <header className="relative z-10 px-4 py-5 md:px-6">
        <div className="site-navigation-glass glass-card mx-auto flex h-14 max-w-6xl items-center justify-between rounded-2xl px-4 backdrop-blur-2xl md:px-6">
          <Link href="/" className="font-display text-xl tracking-tight text-warm-800" aria-label="Retour à l’accueil">
            {content.navigation.brandLabel}
          </Link>
          <Link href="/" className="text-sm text-warm-600 transition-colors hover:text-warm-800">Retour au site</Link>
        </div>
      </header>

      <main id="reservation-main" tabIndex={-1} className="relative z-10 px-4 pb-16 pt-8 md:px-6 md:pb-24 md:pt-14">
        <div className="mx-auto max-w-5xl">
          <div className="mb-10 max-w-2xl md:mb-14">
            <div className="mb-5 h-px w-10 bg-sage-400/60" />
            <p className="mb-3 text-sm font-medium uppercase tracking-[0.16em] text-sage-600">Réservation</p>
            <h1 className="font-display text-4xl font-light leading-tight text-warm-800 sm:text-5xl md:text-6xl">
              Choisissez votre prestation et votre créneau
            </h1>
            <p className="mt-5 max-w-xl leading-relaxed text-warm-500">
              Les horaires sont affichés en heure de Paris. Vous ajouterez vos coordonnées et confirmerez votre demande à l’étape suivante.
            </p>
          </div>

          {contentFallback && (
            <p className="mb-6 rounded-2xl border border-warm-300/70 bg-white/45 px-4 py-3 text-sm text-warm-600" role="status">
              Le contenu publié est momentanément indisponible. Les intitulés de réservation restent utilisables.
            </p>
          )}

          {state.phase === "confirmed" ? (
            <ReservationDetails
              state={state}
              serviceLabel={selectedServiceLabel}
              dateLabel={dateLabel}
              dispatch={dispatch}
              nowEpochMs={nowEpochMs}
              onSubmit={submitBooking}
            />
          ) : (
            <>

          <section aria-labelledby="service-heading" className="glass-card rounded-3xl border border-white/60 bg-white/45 p-5 shadow-[0_12px_40px_rgba(0,0,0,0.05)] backdrop-blur-2xl sm:p-8">
            <div className="flex items-start gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warm-800 text-sm text-porcelain">1</span>
              <div className="min-w-0 flex-1">
                <h2 id="service-heading" className="font-display text-2xl text-warm-800 sm:text-3xl">La prestation</h2>
                <p className="mt-1 text-sm text-warm-500">Seules les prestations actuellement réservables sont proposées.</p>
              </div>
            </div>

            {servicesStatus === "loading" && <p role="status" aria-live="polite" className="mt-8 text-warm-500">Chargement des prestations…</p>}
            {servicesStatus === "error" && (
              <div className="mt-8" role="alert">
                <p className="text-warm-700">{servicesError}</p>
                <button type="button" onClick={() => { setServicesStatus("loading"); setServicesError(null); setBootstrapVersion((value) => value + 1); }} className="mt-4 rounded-full bg-warm-800 px-5 py-2.5 text-sm font-medium text-porcelain">Réessayer</button>
              </div>
            )}
            {servicesStatus === "ready" && visibleServices.length === 0 && (
              <p className="mt-8 rounded-2xl bg-warm-100/80 p-4 text-warm-600" role="status">Aucune prestation n’est ouverte à la réservation pour le moment.</p>
            )}
            {visibleServices.length > 0 && (
              <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {visibleServices.map(({ editorial, booking }) => {
                  const selected = state.serviceKey === booking.key;
                  return (
                    <button
                      key={booking.key}
                      type="button"
                      disabled={submissionInFlight}
                      aria-pressed={selected}
                      onClick={() => dispatch({ type: "select-service", serviceKey: booking.key })}
                      className={`rounded-2xl border p-5 text-left transition-all ${selected ? "border-sage-500 bg-sage-100/80 shadow-[0_8px_24px_rgba(44,43,40,0.08)]" : "border-white/70 bg-white/45 hover:border-sage-300 hover:bg-white/70"}`}>
                      <span className="block font-display text-2xl text-warm-800">{editorial.title || booking.label}</span>
                      <span className="mt-1 block text-sm text-sage-600">{durationLabel(booking.durationMinutes)}</span>
                      <span className="mt-3 line-clamp-2 block text-sm leading-relaxed text-warm-500">{editorial.description}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section aria-labelledby="date-heading" className={`mt-6 glass-card rounded-3xl border border-white/60 bg-white/45 p-5 backdrop-blur-2xl sm:p-8 ${!state.serviceKey ? "opacity-60" : ""}`}>
            <div className="flex items-start gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warm-800 text-sm text-porcelain">2</span>
              <div className="min-w-0 flex-1">
                <h2 id="date-heading" className="font-display text-2xl text-warm-800 sm:text-3xl">La date</h2>
                <p className="mt-1 text-sm text-warm-500">Disponibilités sur 90 jours, en heure de Paris.</p>
              </div>
            </div>

            {!state.serviceKey && <p className="mt-7 text-warm-500">Choisissez d’abord une prestation.</p>}
            {state.serviceKey && (
              <>
                <nav aria-label="Navigation des dates" className="mt-7 flex items-center justify-between gap-3">
                  <button type="button" onClick={() => navigate(-RESERVATION_RANGE_DAYS)} disabled={submissionInFlight || state.fromDate <= today} className="rounded-full border border-warm-300 bg-white/50 px-4 py-2 text-sm text-warm-700 disabled:cursor-not-allowed disabled:opacity-40">← Précédent</button>
                  <span className="text-center text-sm font-medium text-warm-700">{dateLabel(state.fromDate)} — {dateLabel(state.untilDate)}</span>
                  <button type="button" onClick={() => navigate(RESERVATION_RANGE_DAYS)} disabled={submissionInFlight || state.fromDate >= maxRangeStart} className="rounded-full border border-warm-300 bg-white/50 px-4 py-2 text-sm text-warm-700 disabled:cursor-not-allowed disabled:opacity-40">Suivant →</button>
                </nav>

                {state.availabilityStatus === "loading" && <p role="status" aria-live="polite" className="mt-7 text-warm-500">Recherche des créneaux disponibles…</p>}
                {state.availabilityStatus === "error" && (
                  <div className="mt-7" role="alert">
                    <p className="text-warm-700">{state.error}</p>
                    <button
                      type="button"
                      disabled={availabilityRetryBlocked}
                      onClick={() => {
                        if (availabilityRetryBlocked) return;
                        setRefreshVersion((value) => value + 1);
                      }}
                      className="mt-4 rounded-full bg-warm-800 px-5 py-2.5 text-sm font-medium text-porcelain disabled:cursor-not-allowed disabled:opacity-50">
                      Réessayer
                    </button>
                    {availabilityRetryCopy && (
                      <p role="status" aria-live="polite" className="mt-3 text-sm text-warm-600">
                        {availabilityRetryCopy}
                      </p>
                    )}
                  </div>
                )}
                {state.notice && <p className="mt-7 rounded-2xl border border-warm-300 bg-warm-100/80 p-4 text-warm-700" role="alert">{state.notice}</p>}
                {state.availabilityStatus === "ready" && (
                  <div className="mt-7 grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-7" role="group" aria-label="Jours disponibles">
                    {dates.map((date) => {
                      const available = state.slots.some((slot) => slot.localDate === date);
                      const selected = state.selectedDate === date;
                      return (
                        <button key={date} type="button" disabled={submissionInFlight || !available} aria-pressed={selected} aria-label={`${dateLabel(date)}${available ? "" : ", indisponible"}`} onClick={() => dispatch({ type: "select-date", date })} className={`min-h-20 rounded-2xl border px-2 py-3 text-center text-sm transition-colors ${selected ? "border-sage-500 bg-sage-100 text-warm-800" : "border-white/70 bg-white/50 text-warm-700"} disabled:cursor-not-allowed disabled:bg-warm-100/60 disabled:text-warm-400 disabled:line-through`}>
                          {dateLabel(date)}
                        </button>
                      );
                    })}
                  </div>
                )}
                {state.availabilityStatus === "ready" && state.slots.length === 0 && <p className="mt-6 rounded-2xl bg-warm-100/80 p-4 text-warm-600" role="status">Aucun créneau disponible sur cette période. Consultez la semaine suivante.</p>}
              </>
            )}
          </section>

          <section aria-labelledby="slot-heading" className={`mt-6 glass-card rounded-3xl border border-white/60 bg-white/45 p-5 backdrop-blur-2xl sm:p-8 ${!state.selectedDate ? "opacity-60" : ""}`}>
            <div className="flex items-start gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warm-800 text-sm text-porcelain">3</span>
              <div>
                <h2 ref={slotHeading} tabIndex={-1} id="slot-heading" className="font-display text-2xl text-warm-800 sm:text-3xl">L’horaire</h2>
                <p className="mt-1 text-sm text-warm-500">Chaque horaire vient directement du planning.</p>
              </div>
            </div>
            {!state.selectedDate && <p className="mt-7 text-warm-500">Choisissez une date disponible.</p>}
            {state.selectedDate && state.availabilityStatus === "ready" && selectedDateSlots.length > 0 && (
              <div className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4" role="group" aria-label={`Créneaux du ${dateLabel(state.selectedDate)}`}>
                {selectedDateSlots.map((slot) => (
                  <button key={slot.startsAtUtc} type="button" disabled={submissionInFlight} aria-pressed={state.selectedSlot?.startsAtUtc === slot.startsAtUtc} onClick={() => dispatch({ type: "select-slot", slot })} className={`rounded-full border px-5 py-3 font-medium transition-colors ${state.selectedSlot?.startsAtUtc === slot.startsAtUtc ? "border-warm-800 bg-warm-800 text-porcelain" : "border-warm-300 bg-white/60 text-warm-700 hover:border-sage-500"}`}>
                    <time dateTime={slot.startsAtUtc}>{slot.localStart}</time>
                  </button>
                ))}
              </div>
            )}
            {state.selectedSlot && (
              <div className="mt-8 rounded-2xl bg-sage-100/80 p-5" role="status" aria-live="polite">
                <p className="font-medium text-warm-800">Créneau sélectionné : {dateLabel(state.selectedSlot.localDate)} à {state.selectedSlot.localStart}</p>
                <p className="mt-1 text-sm text-warm-600">Vos coordonnées et la confirmation seront ajoutées dans la prochaine étape.</p>
                <button type="button" disabled={availabilityRetryBlocked} onClick={() => { if (availabilityRetryBlocked) return; setRefreshVersion((value) => value + 1); }} className="mt-4 text-sm font-medium text-sage-600 underline underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50">Actualiser les disponibilités</button>
                {availabilityRetryCopy && (
                  <p role="status" aria-live="polite" className="mt-3 text-sm text-warm-600">
                    {availabilityRetryCopy}
                  </p>
                )}
              </div>
            )}
          </section>
          <ReservationDetails
            state={state}
            serviceLabel={selectedServiceLabel}
            dateLabel={dateLabel}
            dispatch={dispatch}
            nowEpochMs={nowEpochMs}
            onSubmit={submitBooking}
          />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
