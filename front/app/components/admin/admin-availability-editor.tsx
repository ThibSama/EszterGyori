"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAdminSession } from "./admin-session-provider";
import type {
  AdminApiFailure,
  AdminAvailabilityException,
  AdminAvailabilityWindow,
} from "../../lib/admin-api";
import {
  FOLD_OFFSETS,
  ISO_WEEKDAYS,
  WEEKDAY_LABELS,
  type FoldOffset,
  type WeeklyRuleDraft,
  describeDate,
  emptyDraft,
  exceptionForDate,
  exceptionWindowIssues,
  issuesFor,
  replaceException,
  sortDrafts,
  toDrafts,
  toRequest,
  weeklyRuleIssues,
} from "../../lib/admin-availability";
import { addCivilDays, formatParisDate, parisLocalDate } from "../../lib/admin-booking-calendar";

/** How far ahead the editor reads exceptions. Well inside the contract's 400-day cap. */
const HORIZON_DAYS = 180;

type ExceptionDraft = {
  localDate: string;
  kind: "closed" | "open";
  windows: AdminAvailabilityWindow[];
  note: string;
  existing: boolean;
};

type Confirmation =
  | { kind: "close"; localDate: string }
  | { kind: "remove"; localDate: string }
  | { kind: "clear-weekly" };

function failureMessage(failure: AdminApiFailure): string {
  if (failure.kind === "forbidden") {
    return "Le jeton de sécurité a expiré. Il a été actualisé ; confirmez de nouveau l’enregistrement.";
  }
  if (failure.kind === "validation") {
    return "Le serveur a refusé ces horaires. Rien n’a été enregistré : l’horaire précédent est toujours en place.";
  }
  return failure.message;
}

const inputClass =
  "rounded-xl border border-warm-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300";

export function AdminAvailabilityEditor() {
  const { api, csrfToken, markExpired, refreshSession } = useAdminSession();
  const today = useMemo(() => parisLocalDate(), []);
  const untilDate = useMemo(() => addCivilDays(today, HORIZON_DAYS), [today]);

  const [loading, setLoading] = useState(true);
  const [rules, setRules] = useState<WeeklyRuleDraft[]>([]);
  const [savedRules, setSavedRules] = useState<WeeklyRuleDraft[]>([]);
  const [exceptions, setExceptions] = useState<AdminAvailabilityException[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [alert, setAlert] = useState(false);
  const [draft, setDraft] = useState<ExceptionDraft | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [previewDate, setPreviewDate] = useState(today);

  const noticeRef = useRef<HTMLDivElement>(null);
  const draftHeadingRef = useRef<HTMLHeadingElement>(null);
  const confirmHeadingRef = useRef<HTMLHeadingElement>(null);

  const issues = useMemo(() => weeklyRuleIssues(rules), [rules]);
  const draftIssues = useMemo(
    () => (draft === null || draft.kind === "closed" ? [] : exceptionWindowIssues(draft.windows)),
    [draft],
  );

  // The saved set is the one the server returned. Comparing against it — rather
  // than tracking a dirty flag — means an edit that is undone by hand stops
  // counting as unsaved, and a save that changed nothing is still allowed.
  const dirty = useMemo(
    () => JSON.stringify(toRequest(rules)) !== JSON.stringify(toRequest(savedRules)),
    [rules, savedRules],
  );

  const notify = useCallback((text: string, isAlert = false) => {
    setMessage(text);
    setAlert(isAlert);
    requestAnimationFrame(() => noticeRef.current?.focus());
  }, []);

  const handleFailure = useCallback(
    async (failure: AdminApiFailure) => {
      if (failure.kind === "unauthenticated") {
        markExpired();
        return;
      }
      if (failure.kind === "forbidden") await refreshSession();
      notify(failureMessage(failure), true);
    },
    [markExpired, notify, refreshSession],
  );

  const adopt = useCallback((weekly: WeeklyRuleDraft[]) => {
    const sorted = sortDrafts(weekly);
    setRules(sorted);
    setSavedRules(sorted);
  }, []);

  useEffect(() => {
    let active = true;
    void api.readAvailability({ fromDate: today, untilDate }).then((result) => {
      if (!active) return;
      setLoading(false);
      if (!result.ok) return void handleFailure(result.failure);
      adopt(toDrafts(result.value.weeklyRules));
      setExceptions(result.value.exceptions);
      setRevision(result.value.revision);
    });
    return () => {
      active = false;
    };
  }, [adopt, api, handleFailure, today, untilDate]);

  const recoverAvailabilityConflict = useCallback(async () => {
    const fresh = await api.readAvailability({ fromDate: today, untilDate });
    if (!fresh.ok) return void handleFailure(fresh.failure);

    // Discard every stale editing baseline. The next write is possible only
    // after the operator makes a new explicit edit against this server head.
    adopt(toDrafts(fresh.value.weeklyRules));
    setExceptions(fresh.value.exceptions);
    setRevision(fresh.value.revision);
    setDraft(null);
    setConfirmation(null);
    notify(
      "Les disponibilités ont été modifiées ailleurs. Vos changements n’ont pas été enregistrés ; les horaires à jour ont été rechargés.",
      true,
    );
  }, [adopt, api, handleFailure, notify, today, untilDate]);

  const updateRule = (key: string, patch: Partial<WeeklyRuleDraft>) => {
    setRules((current) =>
      current.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)),
    );
    setMessage(null);
  };

  const saveWeekly = useCallback(async () => {
    if (saving || revision === null || issues.length > 0) return;
    setSaving(true);
    const result = await api.replaceWeeklyAvailability(
      { expectedRevision: revision, rules: toRequest(rules) },
      csrfToken,
    );
    if (!result.ok) {
      if (result.failure.kind === "conflict") {
        await recoverAvailabilityConflict();
        setSaving(false);
        return;
      }
      setSaving(false);
      return void handleFailure(result.failure);
    }
    setSaving(false);

    // The response, never the request. Ids, ordering and any normalisation are
    // the server's, and this is the only state the editor renders from here on.
    adopt(toDrafts(result.value.weeklyRules));
    setRevision(result.value.revision);
    notify(
      result.value.weeklyRules.length === 0
        ? "Les horaires hebdomadaires ont été enregistrés : aucun créneau récurrent n’est actif."
        : `Les horaires hebdomadaires ont été enregistrés : ${result.value.weeklyRules.length} créneau${result.value.weeklyRules.length > 1 ? "x" : ""} en place.`,
    );
  }, [adopt, api, csrfToken, handleFailure, issues.length, notify, recoverAvailabilityConflict, revision, rules, saving]);

  const submitWeekly = () => {
    // Emptying the schedule closes the salon to every new booking, so it is
    // confirmed rather than being one click away from a stray delete.
    if (rules.length === 0 && savedRules.length > 0) {
      setConfirmation({ kind: "clear-weekly" });
      requestAnimationFrame(() => confirmHeadingRef.current?.focus());
      return;
    }
    void saveWeekly();
  };

  const openDraft = (localDate: string) => {
    const existing = exceptionForDate(exceptions, localDate);
    setDraft({
      localDate,
      kind: existing?.kind ?? "open",
      windows:
        existing !== null && existing.windows.length > 0
          ? existing.windows.map((window) => ({ ...window }))
          : [{ startLocal: "09:00", endLocal: "12:00", foldUtcOffset: null }],
      note: existing?.note ?? "",
      existing: existing !== null,
    });
    setConfirmation(null);
    setMessage(null);
    requestAnimationFrame(() => draftHeadingRef.current?.focus());
  };

  const applyException = useCallback(
    async (
      localDate: string,
      body:
        | { action: "close"; localDate: string; note: string | null }
        | { action: "open"; localDate: string; windows: AdminAvailabilityWindow[]; note: string | null }
        | { action: "remove"; localDate: string },
      success: string,
    ) => {
      if (saving || revision === null) return;
      setSaving(true);
      const result = await api.mutateAvailabilityException(
        { ...body, expectedRevision: revision },
        csrfToken,
      );
      if (!result.ok) {
        if (result.failure.kind === "conflict") {
          await recoverAvailabilityConflict();
          setSaving(false);
          return;
        }
        setSaving(false);
        return void handleFailure(result.failure);
      }
      setSaving(false);

      setExceptions((current) => replaceException(current, localDate, result.value.exception));
      setRevision(result.value.revision);
      setDraft(null);
      setConfirmation(null);
      notify(success);
    },
    [api, csrfToken, handleFailure, notify, recoverAvailabilityConflict, revision, saving],
  );

  const submitDraft = () => {
    if (draft === null) return;
    if (draft.kind === "closed") {
      setConfirmation({ kind: "close", localDate: draft.localDate });
      requestAnimationFrame(() => confirmHeadingRef.current?.focus());
      return;
    }
    if (draftIssues.length > 0 || draft.windows.length === 0) return;
    void applyException(
      draft.localDate,
      {
        action: "open",
        localDate: draft.localDate,
        windows: draft.windows,
        note: draft.note.trim() === "" ? null : draft.note.trim(),
      },
      "L’ouverture exceptionnelle est enregistrée. Elle remplace les horaires hebdomadaires de cette date.",
    );
  };

  const confirmed = () => {
    if (confirmation === null) return;
    if (confirmation.kind === "clear-weekly") {
      setConfirmation(null);
      void saveWeekly();
      return;
    }
    if (confirmation.kind === "close") {
      void applyException(
        confirmation.localDate,
        {
          action: "close",
          localDate: confirmation.localDate,
          note: draft !== null && draft.note.trim() !== "" ? draft.note.trim() : null,
        },
        "La date est fermée. Aucun rendez-vous ne peut plus y être pris.",
      );
      return;
    }
    void applyException(
      confirmation.localDate,
      { action: "remove", localDate: confirmation.localDate },
      "L’exception est supprimée. Cette date suit de nouveau les horaires hebdomadaires.",
    );
  };

  const preview = describeDate(previewDate, rules, exceptions);

  return (
    <main className="min-h-screen bg-warm-50 px-4 py-8 text-warm-800 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1200px]">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sage-700">Disponibilités</p>
        <h1 className="mt-2 font-display text-3xl font-light text-warm-950 sm:text-4xl">
          Horaires et fermetures
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-warm-600">
          Les horaires hebdomadaires définissent les créneaux récurrents. Une exception remplace
          entièrement les horaires d’une date : elle ne s’y ajoute pas. Toutes les heures sont en
          Europe/Paris.
        </p>

        <div
          ref={noticeRef}
          tabIndex={-1}
          role={alert ? "alert" : "status"}
          aria-live="polite"
          className={
            message
              ? `mt-5 rounded-2xl border px-4 py-3 text-sm focus:outline-none ${alert ? "border-rose-200 bg-rose-50 text-rose-900" : "border-sage-200 bg-sage-50"}`
              : "sr-only"
          }>
          {message}
        </div>

        {loading ? (
          <p role="status" className="py-20 text-center text-warm-600">
            Chargement des disponibilités…
          </p>
        ) : (
          <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
            <section
              className="rounded-3xl border border-warm-200 bg-white p-4 shadow-sm sm:p-6"
              aria-labelledby="weekly-heading">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="weekly-heading" className="font-display text-2xl text-warm-900">
                  Horaires hebdomadaires
                </h2>
                <button
                  type="button"
                  onClick={() => {
                    setRules((current) => sortDrafts([...current, emptyDraft(1)]));
                    setMessage(null);
                  }}
                  className="rounded-full border border-warm-300 bg-white px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300">
                  Ajouter un créneau
                </button>
              </div>

              {rules.length === 0 ? (
                <p className="mt-6 rounded-2xl bg-warm-100 p-4 text-sm text-warm-600">
                  Aucun créneau récurrent. Tant que cette liste est vide, seules les ouvertures
                  exceptionnelles permettent de prendre rendez-vous.
                </p>
              ) : (
                <ul className="mt-5 space-y-3">
                  {rules.map((rule, index) => {
                    const rowIssues = issuesFor(issues, index);
                    const errorId = `rule-error-${rule.key}`;
                    return (
                      <li
                        key={rule.key}
                        className={`rounded-2xl border p-4 ${rowIssues.length > 0 ? "border-rose-300 bg-rose-50/60" : "border-warm-200"}`}>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          <label className="block text-sm">
                            <span className="text-warm-600">Jour</span>
                            <select
                              value={rule.weekdayIso}
                              onChange={(event) =>
                                updateRule(rule.key, { weekdayIso: Number(event.target.value) })
                              }
                              aria-invalid={rowIssues.some((issue) => issue.field === "weekday")}
                              aria-describedby={rowIssues.length > 0 ? errorId : undefined}
                              className={`mt-1 w-full ${inputClass}`}>
                              {ISO_WEEKDAYS.map((weekday) => (
                                <option key={weekday} value={weekday}>
                                  {WEEKDAY_LABELS[weekday]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="block text-sm">
                            <span className="text-warm-600">Début</span>
                            <input
                              type="time"
                              value={rule.startLocal}
                              onChange={(event) =>
                                updateRule(rule.key, { startLocal: event.target.value })
                              }
                              aria-invalid={rowIssues.some((issue) => issue.field !== "validity")}
                              aria-describedby={rowIssues.length > 0 ? errorId : undefined}
                              className={`mt-1 w-full ${inputClass}`}
                            />
                          </label>
                          <label className="block text-sm">
                            <span className="text-warm-600">Fin</span>
                            <input
                              type="time"
                              value={rule.endLocal}
                              onChange={(event) =>
                                updateRule(rule.key, { endLocal: event.target.value })
                              }
                              aria-invalid={rowIssues.some((issue) => issue.field !== "validity")}
                              aria-describedby={rowIssues.length > 0 ? errorId : undefined}
                              className={`mt-1 w-full ${inputClass}`}
                            />
                          </label>
                          <div className="flex items-end gap-3">
                            <label className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={rule.isActive}
                                onChange={(event) =>
                                  updateRule(rule.key, { isActive: event.target.checked })
                                }
                                className="h-4 w-4 rounded border-warm-300 focus:ring-2 focus:ring-sage-300"
                              />
                              Actif
                            </label>
                            <button
                              type="button"
                              onClick={() => {
                                setRules((current) =>
                                  current.filter((candidate) => candidate.key !== rule.key),
                                );
                                setMessage(null);
                              }}
                              className="rounded-full border border-rose-300 px-3 py-2 text-sm text-rose-800 focus:outline-none focus:ring-2 focus:ring-rose-300">
                              Retirer
                            </button>
                          </div>
                        </div>

                        <details className="mt-3">
                          <summary className="cursor-pointer text-sm text-warm-600">
                            Période de validité et heure d’été
                          </summary>
                          <div className="mt-3 grid gap-3 sm:grid-cols-3">
                            <label className="block text-sm">
                              <span className="text-warm-600">À partir du</span>
                              <input
                                type="date"
                                value={rule.validFrom ?? ""}
                                onChange={(event) =>
                                  updateRule(rule.key, { validFrom: event.target.value || null })
                                }
                                className={`mt-1 w-full ${inputClass}`}
                              />
                            </label>
                            <label className="block text-sm">
                              <span className="text-warm-600">Jusqu’au</span>
                              <input
                                type="date"
                                value={rule.validUntil ?? ""}
                                onChange={(event) =>
                                  updateRule(rule.key, { validUntil: event.target.value || null })
                                }
                                className={`mt-1 w-full ${inputClass}`}
                              />
                            </label>
                            <label className="block text-sm">
                              <span className="text-warm-600">Décalage (nuit d’automne)</span>
                              <select
                                value={rule.foldUtcOffset ?? ""}
                                onChange={(event) =>
                                  updateRule(rule.key, {
                                    foldUtcOffset: (event.target.value || null) as FoldOffset | null,
                                  })
                                }
                                className={`mt-1 w-full ${inputClass}`}>
                                <option value="">Automatique</option>
                                {FOLD_OFFSETS.map((offset) => (
                                  <option key={offset} value={offset}>
                                    {offset}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                        </details>

                        {rowIssues.length > 0 && (
                          <p id={errorId} role="alert" className="mt-3 text-sm text-rose-800">
                            {rowIssues.map((issue) => issue.message).join(" ")}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-warm-200 pt-5">
                <button
                  type="button"
                  disabled={saving || issues.length > 0}
                  onClick={submitWeekly}
                  className="rounded-full bg-warm-900 px-5 py-2 text-sm text-white disabled:opacity-40">
                  {saving ? "Enregistrement…" : "Enregistrer la semaine"}
                </button>
                <button
                  type="button"
                  disabled={!dirty || saving}
                  onClick={() => {
                    setRules(savedRules);
                    setMessage(null);
                  }}
                  className="rounded-full border border-warm-300 px-4 py-2 text-sm disabled:opacity-40">
                  Annuler les modifications
                </button>
                {issues.length > 0 && (
                  <p role="status" className="text-sm text-rose-800">
                    Corrigez les {issues.length} erreur{issues.length > 1 ? "s" : ""} ci-dessus avant
                    d’enregistrer.
                  </p>
                )}
                {issues.length === 0 && dirty && (
                  <p role="status" className="text-sm text-warm-600">
                    Modifications non enregistrées.
                  </p>
                )}
              </div>
              <p className="mt-4 text-xs text-warm-500">
                L’enregistrement remplace la totalité des horaires hebdomadaires en une seule
                opération : en cas de refus, l’horaire précédent reste en place.
              </p>
            </section>

            <aside className="space-y-6">
              <section
                className="rounded-3xl border border-warm-200 bg-white p-5 shadow-sm"
                aria-labelledby="preview-heading">
                <h2 id="preview-heading" className="font-display text-xl text-warm-900">
                  Vérifier une date
                </h2>
                <label className="mt-3 block text-sm" htmlFor="preview-date">
                  Date
                </label>
                <input
                  id="preview-date"
                  type="date"
                  value={previewDate}
                  onChange={(event) => setPreviewDate(event.target.value)}
                  className={`mt-1 w-full ${inputClass}`}
                />
                <p aria-live="polite" className="mt-3 text-sm capitalize text-warm-700">
                  {formatParisDate(previewDate)}
                </p>
                <p className="mt-1 text-sm text-warm-600">
                  {preview.kind === "closed" && preview.windows.length === 0
                    ? "Fermé."
                    : preview.kind === "exception"
                      ? `Ouverture exceptionnelle : ${preview.windows.join(", ")}.`
                      : `Horaires hebdomadaires : ${preview.windows.join(", ")}.`}
                </p>
                <button
                  type="button"
                  onClick={() => openDraft(previewDate)}
                  className="mt-4 rounded-full border border-warm-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300">
                  Gérer l’exception de cette date
                </button>
              </section>

              <section
                className="rounded-3xl border border-warm-200 bg-white p-5 shadow-sm"
                aria-labelledby="exceptions-heading">
                <h2 id="exceptions-heading" className="font-display text-xl text-warm-900">
                  Exceptions à venir
                </h2>
                {exceptions.length === 0 ? (
                  <p className="mt-3 text-sm text-warm-600">
                    Aucune fermeture ni ouverture exceptionnelle sur les {HORIZON_DAYS} prochains
                    jours.
                  </p>
                ) : (
                  <ul className="mt-4 space-y-2">
                    {exceptions.map((exception) => (
                      <li
                        key={exception.localDate}
                        className="rounded-2xl border border-warm-200 p-3 text-sm">
                        <p className="font-medium capitalize">{formatParisDate(exception.localDate)}</p>
                        <p className="mt-1 text-warm-600">
                          {exception.kind === "closed"
                            ? "Fermé toute la journée."
                            : exception.windows
                                .map((window) => `${window.startLocal} – ${window.endLocal}`)
                                .join(", ")}
                        </p>
                        {exception.note && (
                          <p className="mt-1 text-warm-500">{exception.note}</p>
                        )}
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => openDraft(exception.localDate)}
                            className="rounded-full border border-warm-300 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-sage-300">
                            Modifier
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmation({ kind: "remove", localDate: exception.localDate });
                              requestAnimationFrame(() => confirmHeadingRef.current?.focus());
                            }}
                            className="rounded-full border border-rose-300 px-3 py-1.5 text-xs text-rose-800 focus:outline-none focus:ring-2 focus:ring-rose-300">
                            Supprimer
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </aside>
          </div>
        )}

        {draft !== null && (
          <section
            className="mt-6 rounded-3xl border border-sage-200 bg-white p-5 shadow-sm sm:p-6"
            aria-labelledby="draft-heading">
            <h2
              id="draft-heading"
              ref={draftHeadingRef}
              tabIndex={-1}
              className="font-display text-2xl text-warm-900 focus:outline-none">
              Exception du <span className="capitalize">{formatParisDate(draft.localDate)}</span>
            </h2>
            <p className="mt-2 text-sm text-warm-600">
              Une exception remplace intégralement les horaires hebdomadaires de cette date.
            </p>

            <fieldset className="mt-5">
              <legend className="text-sm text-warm-600">Type d’exception</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {(["closed", "open"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={draft.kind === kind}
                    onClick={() => setDraft({ ...draft, kind })}
                    className={`rounded-full px-4 py-2 text-sm ${draft.kind === kind ? "bg-warm-900 text-white" : "border border-warm-300"}`}>
                    {kind === "closed" ? "Fermeture" : "Ouverture exceptionnelle"}
                  </button>
                ))}
              </div>
            </fieldset>

            {draft.kind === "open" && (
              <div className="mt-5">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium">Plages d’ouverture</h3>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        windows: [
                          ...draft.windows,
                          { startLocal: "14:00", endLocal: "17:00", foldUtcOffset: null },
                        ],
                      })
                    }
                    className="rounded-full border border-warm-300 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-sage-300">
                    Ajouter une plage
                  </button>
                </div>
                <ul className="mt-3 space-y-3">
                  {draft.windows.map((window, index) => {
                    const rowIssues = issuesFor(draftIssues, index);
                    const errorId = `window-error-${index}`;
                    const patch = (next: Partial<AdminAvailabilityWindow>) =>
                      setDraft({
                        ...draft,
                        windows: draft.windows.map((candidate, position) =>
                          position === index ? { ...candidate, ...next } : candidate,
                        ),
                      });
                    return (
                      <li
                        key={`window-${index}`}
                        className={`grid gap-3 rounded-2xl border p-3 sm:grid-cols-4 ${rowIssues.length > 0 ? "border-rose-300 bg-rose-50/60" : "border-warm-200"}`}>
                        <label className="block text-sm">
                          <span className="text-warm-600">Début</span>
                          <input
                            type="time"
                            value={window.startLocal}
                            onChange={(event) => patch({ startLocal: event.target.value })}
                            aria-invalid={rowIssues.length > 0}
                            aria-describedby={rowIssues.length > 0 ? errorId : undefined}
                            className={`mt-1 w-full ${inputClass}`}
                          />
                        </label>
                        <label className="block text-sm">
                          <span className="text-warm-600">Fin</span>
                          <input
                            type="time"
                            value={window.endLocal}
                            onChange={(event) => patch({ endLocal: event.target.value })}
                            aria-invalid={rowIssues.length > 0}
                            aria-describedby={rowIssues.length > 0 ? errorId : undefined}
                            className={`mt-1 w-full ${inputClass}`}
                          />
                        </label>
                        <label className="block text-sm">
                          <span className="text-warm-600">Décalage</span>
                          <select
                            value={window.foldUtcOffset ?? ""}
                            onChange={(event) =>
                              patch({
                                foldUtcOffset: (event.target.value || null) as FoldOffset | null,
                              })
                            }
                            className={`mt-1 w-full ${inputClass}`}>
                            <option value="">Automatique</option>
                            {FOLD_OFFSETS.map((offset) => (
                              <option key={offset} value={offset}>
                                {offset}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="flex items-end">
                          <button
                            type="button"
                            disabled={draft.windows.length === 1}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                windows: draft.windows.filter((_, position) => position !== index),
                              })
                            }
                            className="rounded-full border border-rose-300 px-3 py-2 text-sm text-rose-800 disabled:opacity-40">
                            Retirer
                          </button>
                        </div>
                        {rowIssues.length > 0 && (
                          <p id={errorId} role="alert" className="text-sm text-rose-800 sm:col-span-4">
                            {rowIssues.map((issue) => issue.message).join(" ")}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-3 text-xs text-warm-500">
                  Le décalage n’est utile que la nuit du changement d’heure d’automne, où la même
                  heure existe deux fois. Le reste de l’année, laissez « Automatique ».
                </p>
              </div>
            )}

            <label className="mt-5 block text-sm" htmlFor="exception-note">
              Motif (facultatif)
            </label>
            <input
              id="exception-note"
              type="text"
              maxLength={255}
              value={draft.note}
              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
              className={`mt-1 w-full ${inputClass}`}
            />

            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={saving || (draft.kind === "open" && draftIssues.length > 0)}
                onClick={submitDraft}
                className="rounded-full bg-warm-900 px-4 py-2 text-sm text-white disabled:opacity-40">
                {draft.kind === "closed" ? "Fermer cette date" : "Enregistrer l’ouverture"}
              </button>
              {draft.existing && (
                <button
                  type="button"
                  onClick={() => {
                    setConfirmation({ kind: "remove", localDate: draft.localDate });
                    requestAnimationFrame(() => confirmHeadingRef.current?.focus());
                  }}
                  className="rounded-full border border-rose-300 px-4 py-2 text-sm text-rose-800">
                  Supprimer l’exception
                </button>
              )}
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="rounded-full border border-warm-300 px-4 py-2 text-sm">
                Fermer sans enregistrer
              </button>
            </div>
          </section>
        )}

        {confirmation !== null && (
          <section
            className="mt-6 rounded-3xl border border-rose-200 bg-rose-50 p-5"
            aria-labelledby="confirm-heading">
            <h2
              id="confirm-heading"
              ref={confirmHeadingRef}
              tabIndex={-1}
              className="font-display text-xl text-rose-950 focus:outline-none">
              {confirmation.kind === "clear-weekly"
                ? "Supprimer tous les horaires hebdomadaires ?"
                : confirmation.kind === "close"
                  ? "Confirmer la fermeture ?"
                  : "Supprimer cette exception ?"}
            </h2>
            <p className="mt-2 text-sm text-rose-900">
              {confirmation.kind === "clear-weekly"
                ? "Plus aucun créneau récurrent ne sera proposé. Les rendez-vous déjà pris ne sont pas annulés."
                : confirmation.kind === "close"
                  ? "Aucun nouveau rendez-vous ne pourra être pris ce jour-là. Les rendez-vous déjà pris ne sont pas annulés."
                  : "Cette date suivra de nouveau les horaires hebdomadaires. Aucun rendez-vous n’est supprimé."}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={confirmed}
                className="rounded-full bg-rose-800 px-4 py-2 text-sm text-white disabled:opacity-40">
                {saving ? "Enregistrement…" : "Confirmer"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmation(null)}
                className="rounded-full border border-warm-300 bg-white px-4 py-2 text-sm">
                Conserver
              </button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
