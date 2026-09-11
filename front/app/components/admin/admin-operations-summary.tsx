"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminSession } from "./admin-session-provider";
import { useServiceLabel } from "./admin-service-catalog-provider";
import type { AdminApiFailure, AdminBookingsSummary } from "../../lib/admin-api";
import { formatParisDate, formatParisTime } from "../../lib/admin-booking-calendar";

/**
 * The operational summary (ESZ-065).
 *
 * Deliberately small. It answers "what is happening today, and what is next",
 * and it does so from the server's own partition of the booking rows rather than
 * by counting an array the calendar happens to be holding — which is the reason
 * a cancellation can never be counted as an appointment here: the two never meet
 * in this component at all.
 *
 * It stores nothing and it is not a second booking view. Selecting anything is
 * the calendar's job; this band is read-only on purpose.
 */


const UPCOMING_DAYS = 7;

export function AdminOperationsSummary() {
  const { api, markExpired } = useAdminSession();
  // ESZ-149: names from the catalog, never from a hard-coded map.
  const serviceLabel = useServiceLabel();
  const [summary, setSummary] = useState<AdminBookingsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);

  const handleFailure = useCallback(
    (failure: AdminApiFailure) => {
      if (failure.kind === "unauthenticated") {
        markExpired();
        return;
      }
      setMessage(failure.message);
    },
    [markExpired],
  );

  useEffect(() => {
    let active = true;
    void api.bookingsSummary({ upcomingDays: UPCOMING_DAYS }).then((result) => {
      if (!active) return;
      setLoading(false);
      if (!result.ok) return void handleFailure(result.failure);
      setSummary(result.value);
    });
    return () => {
      active = false;
    };
  }, [api, handleFailure]);

  if (loading) {
    return (
      <section className="admin-canvas px-4 pt-8 sm:px-6 lg:px-8" aria-label="Résumé opérationnel">
        <div className="mx-auto max-w-[1500px]">
          <p role="status" className="admin-panel admin-text-muted rounded-3xl p-5 text-sm">
            Chargement du résumé…
          </p>
        </div>
      </section>
    );
  }

  if (summary === null) {
    return (
      <section className="admin-canvas px-4 pt-8 sm:px-6 lg:px-8" aria-label="Résumé opérationnel">
        <div className="mx-auto max-w-[1500px]">
          <p
            ref={noticeRef}
            tabIndex={-1}
            role="alert"
            className="admin-note-danger rounded-3xl p-5 text-sm focus:outline-none focus:ring-2 focus:ring-rose-400">
            {message ?? "Le résumé n’a pas pu être chargé."}
          </p>
        </div>
      </section>
    );
  }

  const tiles = [
    { label: "Aujourd’hui", value: summary.counts.todayConfirmed, hint: "rendez-vous confirmés" },
    {
      label: `${UPCOMING_DAYS} prochains jours`,
      value: summary.counts.upcomingConfirmed,
      hint: "rendez-vous confirmés",
    },
    {
      label: "Annulations",
      value: summary.counts.todayCancelled + summary.counts.upcomingCancelled,
      hint: "sur la période, hors compte actif",
    },
  ];

  return (
    <section className="admin-canvas px-4 pt-8 sm:px-6 lg:px-8" aria-labelledby="summary-heading">
      <div className="admin-panel mx-auto max-w-[1500px] rounded-3xl p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="summary-heading" className="admin-text font-display text-2xl">
            Résumé
          </h2>
          <p className="admin-text-muted text-sm capitalize">{formatParisDate(summary.todayDate)}</p>
        </div>

        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          {tiles.map((tile) => (
            <div key={tile.label} className="admin-sunken rounded-2xl p-4">
              <dt className="admin-text-subtle text-xs font-semibold uppercase tracking-wide">
                {tile.label}
              </dt>
              <dd className="admin-text mt-1 text-2xl font-medium">{tile.value}</dd>
              <p className="admin-text-subtle mt-1 text-xs">{tile.hint}</p>
            </div>
          ))}
        </dl>

        <p className="admin-text-muted mt-4 text-sm">
          {summary.nextConfirmedStartsAtUtc === null
            ? "Aucun rendez-vous à venir sur la période."
            : `Prochain rendez-vous à ${formatParisTime(summary.nextConfirmedStartsAtUtc)}.`}
        </p>

        <div className="mt-4 grid gap-5 lg:grid-cols-2">
          <div>
            <h3 className="admin-text text-sm font-medium">Aujourd’hui</h3>
            {summary.today.length === 0 ? (
              <p className="admin-text-muted mt-2 text-sm">Aucun rendez-vous aujourd’hui.</p>
            ) : (
              <>
                <ul className="mt-2 space-y-1">
                  {summary.today.map((entry) => (
                    <li key={entry.reference} className="admin-text-muted text-sm">
                      <span className="font-medium">{entry.localStart}</span> · {entry.customerName} ·{" "}
                      {serviceLabel(entry.serviceKey)}
                    </li>
                  ))}
                </ul>
                {!summary.listings.todayComplete && (
                  <p role="note" className="admin-text-subtle mt-2 text-xs">
                    Liste partielle : {summary.counts.todayConfirmed} rendez-vous confirmés
                    aujourd’hui ; les {summary.today.length} premiers sont affichés.
                  </p>
                )}
              </>
            )}
          </div>
          <div>
            <h3 className="admin-text text-sm font-medium">À venir</h3>
            {summary.upcoming.length === 0 ? (
              <p className="admin-text-muted mt-2 text-sm">
                Aucun rendez-vous sur les {UPCOMING_DAYS} prochains jours.
              </p>
            ) : (
              <>
                <ul className="mt-2 space-y-1">
                  {summary.upcoming.slice(0, 6).map((entry) => (
                    <li key={entry.reference} className="admin-text-muted text-sm">
                      <span className="font-medium">
                        {entry.localDate.slice(8)}/{entry.localDate.slice(5, 7)} {entry.localStart}
                      </span>{" "}
                      · {entry.customerName} · {serviceLabel(entry.serviceKey)}
                    </li>
                  ))}
                  {summary.counts.upcomingConfirmed > 6 && (
                    <li className="admin-text-subtle text-sm">
                      + {summary.counts.upcomingConfirmed - 6} autre
                      {summary.counts.upcomingConfirmed - 6 > 1 ? "s" : ""}
                    </li>
                  )}
                </ul>
                {!summary.listings.upcomingComplete && (
                  <p role="note" className="admin-text-subtle mt-2 text-xs">
                    Liste partielle : {summary.counts.upcomingConfirmed} rendez-vous confirmés à
                    venir ; les {summary.upcoming.length} plus proches sont affichés.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
