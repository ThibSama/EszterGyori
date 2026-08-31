"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminSession } from "./admin-session-provider";
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

const SERVICE_LABELS: Record<string, string> = {
  brows: "Sourcils",
  lashes: "Cils",
  makeup: "Maquillage",
  nails: "Ongles",
};

const UPCOMING_DAYS = 7;

export function AdminOperationsSummary() {
  const { api, markExpired } = useAdminSession();
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
      <section className="bg-warm-50 px-4 pt-8 sm:px-6 lg:px-8" aria-label="Résumé opérationnel">
        <div className="mx-auto max-w-[1500px]">
          <p role="status" className="rounded-3xl border border-warm-200 bg-white p-5 text-sm text-warm-600">
            Chargement du résumé…
          </p>
        </div>
      </section>
    );
  }

  if (summary === null) {
    return (
      <section className="bg-warm-50 px-4 pt-8 sm:px-6 lg:px-8" aria-label="Résumé opérationnel">
        <div className="mx-auto max-w-[1500px]">
          <p
            ref={noticeRef}
            tabIndex={-1}
            role="alert"
            className="rounded-3xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-900 focus:outline-none focus:ring-2 focus:ring-rose-400">
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
    <section className="bg-warm-50 px-4 pt-8 sm:px-6 lg:px-8" aria-labelledby="summary-heading">
      <div className="mx-auto max-w-[1500px] rounded-3xl border border-warm-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="summary-heading" className="font-display text-2xl text-warm-900">
            Résumé
          </h2>
          <p className="text-sm capitalize text-warm-600">{formatParisDate(summary.todayDate)}</p>
        </div>

        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          {tiles.map((tile) => (
            <div key={tile.label} className="rounded-2xl border border-warm-200 bg-warm-50/60 p-4">
              <dt className="text-xs font-semibold uppercase tracking-wide text-warm-500">
                {tile.label}
              </dt>
              <dd className="mt-1 text-2xl font-medium text-warm-950">{tile.value}</dd>
              <p className="mt-1 text-xs text-warm-500">{tile.hint}</p>
            </div>
          ))}
        </dl>

        <p className="mt-4 text-sm text-warm-700">
          {summary.nextConfirmedStartsAtUtc === null
            ? "Aucun rendez-vous à venir sur la période."
            : `Prochain rendez-vous à ${formatParisTime(summary.nextConfirmedStartsAtUtc)}.`}
        </p>

        <div className="mt-4 grid gap-5 lg:grid-cols-2">
          <div>
            <h3 className="text-sm font-medium text-warm-900">Aujourd’hui</h3>
            {summary.today.length === 0 ? (
              <p className="mt-2 text-sm text-warm-600">Aucun rendez-vous aujourd’hui.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {summary.today.map((entry) => (
                  <li key={entry.reference} className="text-sm text-warm-700">
                    <span className="font-medium">{entry.localStart}</span> · {entry.customerName} ·{" "}
                    {SERVICE_LABELS[entry.serviceKey] ?? entry.serviceKey}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="text-sm font-medium text-warm-900">À venir</h3>
            {summary.upcoming.length === 0 ? (
              <p className="mt-2 text-sm text-warm-600">
                Aucun rendez-vous sur les {UPCOMING_DAYS} prochains jours.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {summary.upcoming.slice(0, 6).map((entry) => (
                  <li key={entry.reference} className="text-sm text-warm-700">
                    <span className="font-medium">
                      {entry.localDate.slice(8)}/{entry.localDate.slice(5, 7)} {entry.localStart}
                    </span>{" "}
                    · {entry.customerName} · {SERVICE_LABELS[entry.serviceKey] ?? entry.serviceKey}
                  </li>
                ))}
                {summary.upcoming.length > 6 && (
                  <li className="text-sm text-warm-500">
                    + {summary.upcoming.length - 6} autre
                    {summary.upcoming.length - 6 > 1 ? "s" : ""}
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
