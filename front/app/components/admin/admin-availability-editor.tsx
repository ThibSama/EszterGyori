"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useAdminSession } from "./admin-session-provider";
import type {
  AdminApiFailure,
  AdminAvailabilityException,
  AdminAvailabilityWindow,
  AdminBookingTimeRules,
} from "../../lib/admin-api";
import {
  FOLD_OFFSETS,
  ISO_WEEKDAYS,
  WEEKDAY_LABELS,
  type FoldOffset,
  type RuleIssue,
  type TimeRulesDraft,
  type TimeRulesIssue,
  type WeeklyRuleDraft,
  describeDate,
  emptyDraft,
  exceptionForDate,
  exceptionWindowIssues,
  issuesFor,
  replaceException,
  sortDrafts,
  timeRulesIssues,
  timeRulesToDraft,
  timeRulesToRequest,
  toDrafts,
  toRequest,
  weeklyRuleIssues,
} from "../../lib/admin-availability";
import {
  type AvailabilityRange,
  needsAvailabilityRead,
  planAvailabilityRange,
  rangeCoversDate,
} from "../../lib/admin-availability-range";
import { formatParisDate, parisLocalDate } from "../../lib/admin-booking-calendar";

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

/** Before the first read lands: the contract defaults, which narrow nothing. */
const NO_TIME_RULES: TimeRulesDraft = {
  minimumLeadMinutes: "0",
  preferredFinishLocal: "",
  maxOverrunMinutes: "0",
};

const inputClass =
  "rounded-xl border border-warm-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300";

/**
 * The availability half of the admin, as one shared piece of state (ESZ-159).
 *
 * The editor used to own this state privately, which was fine while it was its
 * own page and impossible once the calendar had to *read* the same rules to
 * shade its week. The two candidate fixes were both wrong: a second fetch in the
 * calendar would let the grid and the editor disagree about the current
 * schedule, and re-deriving windows in the grid would put a business rule in a
 * second place. So the state moved up into a hook, the panels below render from
 * it, and the week grid reads the very same `rules` and `exceptions` the editor
 * is saving. One fetch, one revision, one truth.
 *
 * Nothing about the *writes* moved. Every mutation still goes to the existing
 * server API with its `expectedRevision`, and the server's response is still the
 * only thing adopted afterwards.
 *
 * What the read had to gain is a range that follows the calendar. A fixed
 * `today … today + 180` window answered for dates it had never been asked about
 * — a visible past week, or a week past the horizon — and `dateWindows` cannot
 * tell "no exception" from "no exception *read*". So the window is planned from
 * the visible span (`admin-availability-range`), re-read when navigation leaves
 * it, and published as `coverage` so nothing projects a date the server has not
 * spoken for.
 */
export interface AvailabilityWorkspace {
  readonly loading: boolean;
  readonly rules: WeeklyRuleDraft[];
  readonly savedRules: WeeklyRuleDraft[];
  readonly exceptions: AdminAvailabilityException[];
  readonly saving: boolean;
  readonly message: string | null;
  readonly alert: boolean;
  readonly draft: ExceptionDraft | null;
  readonly confirmation: Confirmation | null;
  readonly previewDate: string;
  /** The civil range the loaded rules and exceptions actually speak for. */
  readonly coverage: AvailabilityRange | null;
  /** Whether the loaded availability covers this date — false means "unknown", never "closed". */
  readonly covers: (localDate: string) => boolean;
  readonly issues: RuleIssue[];
  readonly draftIssues: RuleIssue[];
  /** ESZ-151 — the booking-time rules, edited and saved with the week. */
  readonly timeRules: TimeRulesDraft;
  readonly savedTimeRules: TimeRulesDraft;
  readonly timeRulesIssues: TimeRulesIssue[];
  readonly dirty: boolean;
  readonly noticeRef: RefObject<HTMLDivElement | null>;
  readonly draftHeadingRef: RefObject<HTMLHeadingElement | null>;
  readonly confirmHeadingRef: RefObject<HTMLHeadingElement | null>;
  readonly setRules: Dispatch<SetStateAction<WeeklyRuleDraft[]>>;
  readonly setMessage: Dispatch<SetStateAction<string | null>>;
  readonly setDraft: Dispatch<SetStateAction<ExceptionDraft | null>>;
  readonly setConfirmation: Dispatch<SetStateAction<Confirmation | null>>;
  readonly setPreviewDate: Dispatch<SetStateAction<string>>;
  readonly updateRule: (key: string, patch: Partial<WeeklyRuleDraft>) => void;
  readonly updateTimeRules: (patch: Partial<TimeRulesDraft>) => void;
  readonly submitWeekly: () => void;
  /** Opens the exception editor for one date — the week grid's own entry point. */
  readonly openDraft: (localDate: string) => void;
  readonly submitDraft: () => void;
  readonly confirmed: () => void;
}

export function useAvailabilityWorkspace(visible: AvailabilityRange): AvailabilityWorkspace {
  const { api, csrfToken, markExpired, refreshSession } = useAdminSession();
  const today = useMemo(() => parisLocalDate(), []);
  const { fromDate: visibleFrom, untilDate: visibleUntil } = visible;

  const [rules, setRules] = useState<WeeklyRuleDraft[]>([]);
  const [savedRules, setSavedRules] = useState<WeeklyRuleDraft[]>([]);
  const [timeRules, setTimeRules] = useState<TimeRulesDraft>(NO_TIME_RULES);
  const [savedTimeRules, setSavedTimeRules] = useState<TimeRulesDraft>(NO_TIME_RULES);
  const [exceptions, setExceptions] = useState<AdminAvailabilityException[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [alert, setAlert] = useState(false);
  const [draft, setDraft] = useState<ExceptionDraft | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [previewDate, setPreviewDate] = useState(today);
  const [coverage, setCoverage] = useState<AvailabilityRange | null>(null);
  const [fetchedSpan, setFetchedSpan] = useState<AvailabilityRange | null>(null);

  const noticeRef = useRef<HTMLDivElement>(null);
  const draftHeadingRef = useRef<HTMLHeadingElement>(null);
  const confirmHeadingRef = useRef<HTMLHeadingElement>(null);

  /**
   * Busy is *derived*, exactly as it is for the appointments half.
   *
   * A hand-raised flag inside the effect is a cascading render, and one raised
   * by the navigation handlers strands a spinner the moment a handler forgets.
   * Comparing the span on screen with the span that was actually fetched cannot
   * do either: it is true exactly while the two disagree, and it clears on a
   * refused read too — which is why the span is recorded whether or not the read
   * succeeded, while `coverage` is set only when there is data to cover it.
   */
  const loading = needsAvailabilityRead(fetchedSpan, {
    fromDate: visibleFrom,
    untilDate: visibleUntil,
  });

  const issues = useMemo(() => weeklyRuleIssues(rules), [rules]);
  const ruleIssues = useMemo(() => timeRulesIssues(timeRules), [timeRules]);
  const draftIssues = useMemo(
    () => (draft === null || draft.kind === "closed" ? [] : exceptionWindowIssues(draft.windows)),
    [draft],
  );

  // The saved set is the one the server returned. Comparing against it — rather
  // than tracking a dirty flag — means an edit that is undone by hand stops
  // counting as unsaved, and a save that changed nothing is still allowed.
  const dirty = useMemo(
    () =>
      JSON.stringify(toRequest(rules)) !== JSON.stringify(toRequest(savedRules)) ||
      JSON.stringify(timeRules) !== JSON.stringify(savedTimeRules),
    [rules, savedRules, savedTimeRules, timeRules],
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

  // The week and the booking-time rules are adopted together: they come back
  // from the same response, under the same revision.
  const adopt = useCallback((weekly: WeeklyRuleDraft[], stored: AdminBookingTimeRules) => {
    const sorted = sortDrafts(weekly);
    setRules(sorted);
    setSavedRules(sorted);
    const draft = timeRulesToDraft(stored);
    setTimeRules(draft);
    setSavedTimeRules(draft);
  }, []);

  // One read per coverage gap, not one per navigation: paging inside the loaded
  // window asks the server nothing, because nothing it would answer has changed
  // for those dates. Leaving the window is the only thing that must re-read, and
  // until that read lands `coverage` says so rather than the stale set standing
  // in for dates it never included.
  useEffect(() => {
    const span: AvailabilityRange = { fromDate: visibleFrom, untilDate: visibleUntil };
    if (!needsAvailabilityRead(fetchedSpan, span)) return;
    const requested = planAvailabilityRange(span, today);
    let active = true;
    void api.readAvailability(requested).then((result) => {
      if (!active) return;
      // Recorded either way: a span left unrecorded after a refusal re-enters
      // this effect on the next render and retries a refused read forever.
      setFetchedSpan(requested);
      if (!result.ok) return void handleFailure(result.failure);
      adopt(toDrafts(result.value.weeklyRules), result.value.bookingTimeRules);
      setExceptions(result.value.exceptions);
      setRevision(result.value.revision);
      setCoverage(requested);
    });
    return () => {
      active = false;
    };
  }, [adopt, api, fetchedSpan, handleFailure, today, visibleFrom, visibleUntil]);

  const recoverAvailabilityConflict = useCallback(async () => {
    // The same window that is on screen, so recovery restores exactly the dates
    // the operator is looking at rather than a window they navigated away from.
    const range =
      coverage ?? planAvailabilityRange({ fromDate: visibleFrom, untilDate: visibleUntil }, today);
    const fresh = await api.readAvailability(range);
    if (!fresh.ok) return void handleFailure(fresh.failure);

    // Discard every stale editing baseline. The next write is possible only
    // after the operator makes a new explicit edit against this server head.
    adopt(toDrafts(fresh.value.weeklyRules), fresh.value.bookingTimeRules);
    setExceptions(fresh.value.exceptions);
    setRevision(fresh.value.revision);
    setCoverage(range);
    setFetchedSpan(range);
    setDraft(null);
    setConfirmation(null);
    notify(
      "Les disponibilités ont été modifiées ailleurs. Vos changements n’ont pas été enregistrés ; les horaires à jour ont été rechargés.",
      true,
    );
  }, [adopt, api, coverage, handleFailure, notify, today, visibleFrom, visibleUntil]);

  const updateRule = (key: string, patch: Partial<WeeklyRuleDraft>) => {
    setRules((current) =>
      current.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)),
    );
    setMessage(null);
  };

  const updateTimeRules = (patch: Partial<TimeRulesDraft>) => {
    setTimeRules((current) => ({ ...current, ...patch }));
    setMessage(null);
  };

  const saveWeekly = useCallback(async () => {
    if (saving || revision === null || issues.length > 0 || ruleIssues.length > 0) return;
    setSaving(true);
    // One PUT: the week and the booking-time rules, under one revision.
    const result = await api.replaceWeeklyAvailability(
      {
        expectedRevision: revision,
        rules: toRequest(rules),
        bookingTimeRules: timeRulesToRequest(timeRules),
      },
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
    adopt(toDrafts(result.value.weeklyRules), result.value.bookingTimeRules);
    setRevision(result.value.revision);
    notify(
      result.value.weeklyRules.length === 0
        ? "Les horaires hebdomadaires ont été enregistrés : aucun créneau récurrent n’est actif."
        : `Les horaires hebdomadaires ont été enregistrés : ${result.value.weeklyRules.length} créneau${result.value.weeklyRules.length > 1 ? "x" : ""} en place.`,
    );
  }, [
    adopt,
    api,
    csrfToken,
    handleFailure,
    issues.length,
    notify,
    recoverAvailabilityConflict,
    revision,
    ruleIssues.length,
    rules,
    saving,
    timeRules,
  ]);

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

  const covers = useCallback(
    (localDate: string) => rangeCoversDate(coverage, localDate),
    [coverage],
  );

  const openDraft = (localDate: string) => {
    // An uncovered date has no *known* exception, which is not the same as
    // having none: opening a blank "open" draft there and saving it would
    // silently replace a stored closure the tab had never read.
    if (!rangeCoversDate(coverage, localDate)) {
      notify(
        "Les disponibilités de cette date ne sont pas encore chargées. Réessayez dans un instant.",
        true,
      );
      return;
    }
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

  return {
    loading,
    rules,
    savedRules,
    exceptions,
    saving,
    message,
    alert,
    draft,
    confirmation,
    previewDate,
    coverage,
    covers,
    issues,
    draftIssues,
    timeRules,
    savedTimeRules,
    timeRulesIssues: ruleIssues,
    dirty,
    noticeRef,
    draftHeadingRef,
    confirmHeadingRef,
    setRules,
    setMessage,
    setDraft,
    setConfirmation,
    setPreviewDate,
    updateRule,
    updateTimeRules,
    submitWeekly,
    openDraft,
    submitDraft,
    confirmed,
  };
}

export function AdminAvailabilityEditor({
  workspace,
}: Readonly<{ workspace: AvailabilityWorkspace }>) {
  const {
    loading,
    rules,
    savedRules,
    exceptions,
    saving,
    message,
    alert,
    draft,
    confirmation,
    previewDate,
    coverage,
    covers,
    issues,
    draftIssues,
    timeRules,
    savedTimeRules,
    timeRulesIssues: ruleIssues,
    dirty,
    noticeRef,
    draftHeadingRef,
    confirmHeadingRef,
    setRules,
    setMessage,
    setDraft,
    setConfirmation,
    setPreviewDate,
    updateRule,
    updateTimeRules,
    submitWeekly,
    openDraft,
    submitDraft,
    confirmed,
  } = workspace;

  // Only inside the loaded window is this an answer. Outside it, "no exception"
  // is the read's silence rather than the schedule's, and saying "Fermé" there
  // would be the very false constraint the coverage model exists to prevent.
  const previewCovered = covers(previewDate);
  const preview = describeDate(previewDate, rules, exceptions);

  return (
    <section
      className="rounded-3xl border border-warm-200 bg-white/70 p-4 shadow-sm sm:p-6"
      aria-labelledby="availability-heading">
      <div>
        <h2
          id="availability-heading"
          className="font-display text-2xl font-light text-warm-950 sm:text-3xl">
          Horaires et fermetures
        </h2>
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

              <fieldset
                className="mt-6 rounded-2xl border border-warm-200 p-4"
                aria-describedby="time-rules-help">
                <legend className="px-1 text-sm font-medium text-warm-900">
                  Règles de réservation
                </legend>
                <p id="time-rules-help" className="text-sm text-warm-600">
                  Enregistrées avec la semaine. Elles ne font que restreindre les horaires
                  ci-dessus et les ouvertures exceptionnelles : aucun rendez-vous existant n’est
                  déplacé.
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <label className="block text-sm">
                    <span className="text-warm-600">Délai minimum avant un rendez-vous (min)</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={15}
                      value={timeRules.minimumLeadMinutes}
                      onChange={(event) =>
                        updateTimeRules({ minimumLeadMinutes: event.target.value })
                      }
                      aria-invalid={ruleIssues.some((issue) => issue.field === "minimumLeadMinutes")}
                      aria-describedby={ruleIssues.length > 0 ? "time-rules-error" : undefined}
                      className={`mt-1 w-full ${inputClass}`}
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="text-warm-600">Heure de fin habituelle</span>
                    <input
                      type="time"
                      value={timeRules.preferredFinishLocal}
                      onChange={(event) =>
                        updateTimeRules({ preferredFinishLocal: event.target.value })
                      }
                      aria-invalid={ruleIssues.some((issue) => issue.field === "preferredFinishLocal")}
                      aria-describedby={ruleIssues.length > 0 ? "time-rules-error" : undefined}
                      className={`mt-1 w-full ${inputClass}`}
                    />
                    <span className="mt-1 block text-xs text-warm-500">
                      Vide : la fin de chaque plage horaire. Aucun rendez-vous ne commence à cette
                      heure ou après.
                    </span>
                  </label>
                  <label className="block text-sm">
                    <span className="text-warm-600">Dépassement maximal après la fin (min)</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={15}
                      value={timeRules.maxOverrunMinutes}
                      onChange={(event) =>
                        updateTimeRules({ maxOverrunMinutes: event.target.value })
                      }
                      aria-invalid={ruleIssues.some((issue) => issue.field === "maxOverrunMinutes")}
                      aria-describedby={ruleIssues.length > 0 ? "time-rules-error" : undefined}
                      className={`mt-1 w-full ${inputClass}`}
                    />
                    <span className="mt-1 block text-xs text-warm-500">
                      Un rendez-vous peut se terminer au plus tard à l’heure de fin habituelle plus
                      ce délai, sans jamais dépasser la plage horaire.
                    </span>
                  </label>
                </div>
                {ruleIssues.length > 0 && (
                  <p id="time-rules-error" role="alert" className="mt-3 text-sm text-rose-800">
                    {ruleIssues.map((issue) => issue.message).join(" ")}
                  </p>
                )}
              </fieldset>

              <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-warm-200 pt-5">
                <button
                  type="button"
                  disabled={saving || issues.length > 0 || ruleIssues.length > 0}
                  onClick={submitWeekly}
                  className="rounded-full bg-warm-900 px-5 py-2 text-sm text-white disabled:opacity-40">
                  {saving ? "Enregistrement…" : "Enregistrer la semaine"}
                </button>
                <button
                  type="button"
                  disabled={!dirty || saving}
                  onClick={() => {
                    setRules(savedRules);
                    updateTimeRules(savedTimeRules);
                  }}
                  className="rounded-full border border-warm-300 px-4 py-2 text-sm disabled:opacity-40">
                  Annuler les modifications
                </button>
                {issues.length + ruleIssues.length > 0 && (
                  <p role="status" className="text-sm text-rose-800">
                    Corrigez les {issues.length + ruleIssues.length} erreur
                    {issues.length + ruleIssues.length > 1 ? "s" : ""} ci-dessus avant
                    d’enregistrer.
                  </p>
                )}
                {issues.length + ruleIssues.length === 0 && dirty && (
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
                  min={coverage?.fromDate}
                  max={coverage?.untilDate}
                  onChange={(event) => setPreviewDate(event.target.value)}
                  className={`mt-1 w-full ${inputClass}`}
                />
                <p aria-live="polite" className="mt-3 text-sm capitalize text-warm-700">
                  {formatParisDate(previewDate)}
                </p>
                <p className="mt-1 text-sm text-warm-600">
                  {!previewCovered
                    ? "Cette date est hors de la période chargée. Naviguez jusqu’à elle dans le calendrier pour en connaître les horaires."
                    : preview.kind === "closed" && preview.windows.length === 0
                      ? "Fermé."
                      : preview.kind === "exception"
                        ? `Ouverture exceptionnelle : ${preview.windows.join(", ")}.`
                        : `Horaires hebdomadaires : ${preview.windows.join(", ")}.`}
                </p>
                <button
                  type="button"
                  disabled={!previewCovered}
                  onClick={() => openDraft(previewDate)}
                  className="mt-4 rounded-full border border-warm-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300 disabled:cursor-not-allowed disabled:opacity-50">
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
                    Aucune fermeture ni ouverture exceptionnelle sur la période chargée
                    {coverage === null
                      ? "."
                      : ` (${formatParisDate(coverage.fromDate)} – ${formatParisDate(coverage.untilDate)}).`}
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
    </section>
  );
}
