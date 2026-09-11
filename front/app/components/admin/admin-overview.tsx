"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAdminSession } from "./admin-session-provider";
import { AdminOperationsSummary } from "./admin-operations-summary";
import { AdminPrivacyCentre } from "./admin-privacy-centre";
import { adminNavItem, type AdminNavItem } from "../../lib/admin-navigation";
import { describeDate, toDrafts } from "../../lib/admin-availability";
import {
  formatParisDate,
  formatParisTime,
  parisLocalDate,
} from "../../lib/admin-booking-calendar";
import {
  ADMIN_DRAFT_FRESHNESS_LABELS,
  createInitialDraftState,
  describeDraftFreshness,
} from "../../lib/admin-server-draft";
import type { AdminApiFailure } from "../../lib/admin-api";

/**
 * The operational overview at `/admin` (ESZ-155).
 *
 * What this page is allowed to say is bounded by what the application already
 * knows. Every line below traces back to a server response the admin API already
 * serves — the booking summary, the availability configuration, the draft and
 * published content heads — and nothing is computed here that some existing
 * module does not already compute:
 *
 * - the appointments band *is* {@link AdminOperationsSummary}, rendered whole
 *   rather than reimplemented, so there is exactly one place in the product that
 *   decides what "today" and "upcoming" mean for bookings.
 * - today's opening hours come from `describeDate`, the same function the
 *   availability editor previews a date with. No "next free slot" is invented,
 *   no working hour is reinterpreted, and closures and holidays are not
 *   consolidated — that is Package 10.2's product, not this page's.
 * - the site state is `describeDraftFreshness`, the editor's own rule, applied
 *   to the two heads the server reports. Local backups are deliberately not
 *   consulted: `localStorage` is this device's copy, never the site's state.
 *
 * The rule that shapes the three states each panel can be in: a failed request
 * is never rendered as a zero, an empty list or a closed day. "No appointment
 * today" and "the request failed" are different facts about the business, and an
 * overview that blurs them is worse than one that admits it does not know.
 *
 * The `Traitement RGPD` block (ESZ-163) is the one exception to "this page
 * only reports": it opens two modals — a new data-subject request and the
 * register's history — and lives in {@link AdminPrivacyCentre}, its own
 * section beside `Accès rapides`, never a navigation entry. The overview
 * itself still mutates nothing.
 *
 * No price, revenue, accounting or commercial metric appears here, and none can:
 * the admin API serves no such data, so any number of that kind would be
 * invented. There is no decorative copy either — every line answers an
 * operational question or it is not on the page.
 */
export function AdminOverview() {
  const today = parisLocalDate();

  return (
    <main className="admin-canvas min-h-screen">
      <div className="px-4 pt-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1500px]">
          <p className="admin-text-accent text-xs font-semibold uppercase tracking-[0.2em]">
            Administration
          </p>
          <h1 className="admin-text mt-2 font-display text-3xl font-light sm:text-4xl">
            Vue d’ensemble
          </h1>
          <p className="admin-text-muted mt-2 text-sm capitalize">
            {formatParisDate(today)}
          </p>
        </div>
      </div>

      <AdminOperationsSummary />

      <div className="px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto grid max-w-[1500px] gap-5 lg:grid-cols-2">
          <TodayHoursPanel today={today} />
          <SiteStatePanel />
        </div>

        <div className="mx-auto mt-5 max-w-[1500px]">
          <AdminPrivacyCentre />
        </div>

        <div className="mx-auto mt-5 max-w-[1500px]">
          <QuickActions />
        </div>
      </div>
    </main>
  );
}

/** The shared frame, so the three panels keep one shape in every state. */
function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="admin-panel rounded-3xl p-5 sm:p-6">
      <h2 className="admin-text font-display text-2xl">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * A panel's loading line.
 *
 * `role="status"` rather than a bare paragraph so a screen reader is told the
 * panel is still resolving instead of reading a heading with nothing under it.
 */
function PanelLoading({ label }: { label: string }) {
  return (
    <p role="status" className="admin-text-muted text-sm">
      {label}
    </p>
  );
}

/**
 * A panel's failure line.
 *
 * It replaces the panel's data rather than sitting beside a fallback value,
 * which is the whole point: there is no fallback value, because inventing one
 * would report a business fact the server never sent.
 */
function PanelError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="admin-note-danger rounded-2xl px-4 py-3 text-sm">
      {message}
    </p>
  );
}

/** The three states any one panel can be in. `null` data is never a value. */
type PanelState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

/**
 * Runs one admin read and keeps it in a {@link PanelState}.
 *
 * An expired session is escalated to the session provider rather than shown as a
 * panel error: the whole shell has to react to that, not one card.
 */
function usePanelData<T>(read: () => Promise<
  { ok: true; value: T } | { ok: false; failure: AdminApiFailure }
>) {
  const { markExpired } = useAdminSession();
  const [state, setState] = useState<PanelState<T>>({ status: "loading" });

  const handleFailure = useCallback(
    (failure: AdminApiFailure) => {
      if (failure.kind === "unauthenticated") {
        markExpired();
        return;
      }
      setState({ status: "error", message: failure.message });
    },
    [markExpired],
  );

  useEffect(() => {
    let active = true;
    void read().then((result) => {
      if (!active) return;
      if (!result.ok) return void handleFailure(result.failure);
      setState({ status: "ready", data: result.value });
    });
    return () => {
      active = false;
    };
  }, [read, handleFailure]);

  return state;
}

/**
 * Today's opening hours, read from the availability configuration.
 *
 * The window requested is exactly today, and the answer is `describeDate`'s:
 * an exception replaces the day's weekly hours, and a day with no active rule is
 * closed. That is the availability product as it exists — this panel reports it
 * and adds nothing to it.
 */
function TodayHoursPanel({ today }: { today: string }) {
  const { api } = useAdminSession();
  const state = usePanelData(
    useCallback(
      () => api.readAvailability({ fromDate: today, untilDate: today }),
      [api, today],
    ),
  );

  return (
    <Panel title="Horaires du jour">
      {state.status === "loading" ? (
        <PanelLoading label="Chargement des horaires…" />
      ) : state.status === "error" ? (
        <PanelError message={state.message} />
      ) : (
        <TodayHours today={today} availability={state.data} />
      )}
    </Panel>
  );
}

function TodayHours({
  today,
  availability,
}: {
  today: string;
  availability: {
    weeklyRules: Parameters<typeof toDrafts>[0];
    exceptions: Parameters<typeof describeDate>[2];
  };
}) {
  const described = describeDate(
    today,
    toDrafts(availability.weeklyRules),
    availability.exceptions,
  );

  if (described.kind === "closed") {
    return (
      <>
        <p className="admin-text text-lg font-medium">Fermé aujourd’hui</p>
        <p className="admin-text-muted mt-1 text-sm">
          Aucun créneau n’est ouvert à la réservation pour cette date.
        </p>
      </>
    );
  }

  return (
    <>
      <ul className="space-y-1">
        {described.windows.map((window) => (
          <li key={window} className="admin-text text-lg font-medium">
            {window}
          </li>
        ))}
      </ul>
      <p className="admin-text-muted mt-2 text-sm">
        {described.kind === "exception"
          ? "Horaires exceptionnels : cette date remplace les horaires hebdomadaires."
          : "Horaires hebdomadaires habituels."}
      </p>
    </>
  );
}

/**
 * What visitors are being served, and whether anything is waiting to be
 * published.
 *
 * Both heads are required. If either read fails the panel says so, because the
 * comparison is the entire fact: knowing the draft head without the published
 * head cannot distinguish "everything is published" from "a change is waiting".
 */
function SiteStatePanel() {
  const { api } = useAdminSession();
  const state = usePanelData(
    useCallback(async () => {
      const [draft, published] = await Promise.all([
        api.readDraft(),
        api.readPublished(),
      ]);
      if (!draft.ok) return draft;
      if (!published.ok) return published;
      return { ok: true as const, value: { draft: draft.value, published: published.value } };
    }, [api]),
  );

  return (
    <Panel title="État du site">
      {state.status === "loading" ? (
        <PanelLoading label="Chargement de l’état du site…" />
      ) : state.status === "error" ? (
        <PanelError message={state.message} />
      ) : (
        <SiteState
          draftRevision={state.data.draft.revision}
          draftUpdatedAt={state.data.draft.updatedAt}
          publishedRevision={state.data.published.revision}
          publishedAt={state.data.published.publishedAt}
        />
      )}
    </Panel>
  );
}

function SiteState({
  draftRevision,
  draftUpdatedAt,
  publishedRevision,
  publishedAt,
}: {
  draftRevision: number;
  draftUpdatedAt: string;
  publishedRevision: number;
  publishedAt: string;
}) {
  // The editor's own rule, applied to the server's own heads. `isDirty` is false
  // because this page holds no unsaved edit — it is not an editor.
  const freshness = describeDraftFreshness(
    {
      ...createInitialDraftState(),
      revision: draftRevision,
      updatedAt: draftUpdatedAt,
      publishedRevision,
      publishedAt,
    },
    false,
  );

  return (
    <>
      <p className="admin-text flex items-center gap-2 text-lg font-medium">
        {/* The cue is the word, not the dot: the dot is decoration that repeats
            a state the sentence already carries in full. */}
        <span
          aria-hidden="true"
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            freshness === "published" ? "admin-dot-live" : "admin-dot-idle"
          }`}
        />
        {ADMIN_DRAFT_FRESHNESS_LABELS[freshness]}
      </p>
      <p className="admin-text-muted mt-2 text-sm">
        {freshness === "published"
          ? "Le site public affiche la dernière version enregistrée."
          : "Des modifications sont enregistrées sur le serveur mais ne sont pas encore visibles sur le site public."}
      </p>
      <dl className="admin-text-muted mt-4 space-y-1 text-sm">
        <div className="flex flex-wrap gap-x-2">
          <dt className="admin-text-subtle">Dernière publication :</dt>
          <dd>
            {formatParisDate(parisLocalDate(publishedAt))} à{" "}
            {formatParisTime(publishedAt)}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="admin-text-subtle">Dernier enregistrement :</dt>
          <dd>
            {formatParisDate(parisLocalDate(draftUpdatedAt))} à{" "}
            {formatParisTime(draftUpdatedAt)}
          </dd>
        </div>
      </dl>
    </>
  );
}

/**
 * The way on to the business destinations.
 *
 * The entries are read from the navigation model rather than written out here,
 * so the overview cannot offer a destination the shell calls pending — or point
 * either of them at a route that does not exist.
 */
function QuickActions() {
  const actions: ReadonlyArray<{ item: AdminNavItem; hint: string }> = [
    {
      item: adminNavItem("calendar"),
      hint: "Consulter et gérer les rendez-vous.",
    },
    {
      item: adminNavItem("content"),
      hint: "Modifier et publier le contenu du site.",
    },
    {
      item: adminNavItem("services"),
      hint: "Gérer les prestations proposées.",
    },
  ];

  return (
    <section aria-label="Accès rapides">
      <h2 className="admin-text font-display text-2xl">Accès rapides</h2>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {actions.map(({ item, hint }) => (
          <li key={item.key}>
            <QuickAction item={item} hint={hint} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const ACTION_BASE =
  "flex h-full flex-col rounded-3xl border p-5 text-left transition";

function QuickAction({ item, hint }: { item: AdminNavItem; hint: string }) {
  if (item.status === "pending") {
    // Inert for the same reason the shell's entry is: there is no route. A card
    // that looked clickable and went nowhere would be the dead link the
    // architecture forbids, so it takes no tab stop and offers no click.
    return (
      <span
        aria-disabled="true"
        data-action-key={item.key}
        data-action-status="pending"
        className={`${ACTION_BASE} admin-note-inert cursor-default`}>
        <span className="flex items-center gap-2">
          <span className="text-base font-medium">{item.label}</span>
          <span className="admin-chip rounded-full px-1.5 py-px text-[10px] font-medium uppercase tracking-wide">
            {item.pendingLabel}
          </span>
        </span>
        <span className="mt-1 text-sm">{hint}</span>
      </span>
    );
  }

  return (
    <Link
      href={item.href}
      data-action-key={item.key}
      data-action-status="available"
      className={`${ACTION_BASE} admin-panel admin-quick-action focus:outline-none focus:ring-2 focus:ring-sage-300`}>
      <span className="admin-text text-base font-medium">{item.label}</span>
      <span className="admin-text-muted mt-1 text-sm">{hint}</span>
    </Link>
  );
}
