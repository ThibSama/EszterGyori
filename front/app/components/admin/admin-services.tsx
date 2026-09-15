"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAdminSession } from "./admin-session-provider";
import { useAdminServiceCatalog } from "./admin-service-catalog-provider";
import { MediaLibraryPanel } from "./media-editor";
import { MediaLibraryProvider } from "./media-library-provider";
import { Field, TextArea } from "./editor-fields";
import type {
  AdminApiFailure,
  AdminBookableService,
  AdminServiceCombination,
} from "../../lib/admin-api";
import {
  ADMIN_SERVICES_MESSAGES,
  COMBINATION_STATUS_LABELS,
  MAX_SERVICES_OPTIONS,
  SERVICE_DRAFT_ERRORS,
  SERVICE_STATUS_LABELS,
  clearCombinationDurationMutation,
  combinationDurationDraft,
  combinationUnavailableReason,
  disableCombinationMutation,
  draftFromService,
  emptyServiceDraft,
  formatServiceDuration,
  isCatalogStale,
  mutationFromDraft,
  serviceFailureMessage,
  serviceImageUsages,
  validateCombinationMutation,
  validateServiceDraft,
  type ServiceDraft,
  type ServiceDraftErrors,
} from "../../lib/admin-services";

/**
 * `/admin/services` — the `Prestations` destination (ESZ-149).
 *
 * One list and one form. The list is exactly four columns — Prestation,
 * Durée, Statut, Actions — because that is what Esther needs to find a
 * service and act on it; there is no price, category, revenue or statistic
 * here and the admin API serves none. The form edits the four facts the
 * catalog owns: name, description, duration and image.
 *
 * ## Where the truth is
 *
 * The catalog read and every row shown come from
 * {@link useAdminServiceCatalog}; every save goes to `PATCH /api/admin/services`
 * with the row's own `updatedAt` as its token, and what the server stores is
 * what the list adopts — never the draft. A 409 or a 404 means the catalog
 * moved under this page, so the list is re-read before Esther tries again.
 *
 * ## The image is the media library's
 *
 * There is no path field. A service image is chosen from the same library the
 * CMS uses, through the same panel, and the library counts the catalog's
 * references so its delete control is honest; the server refuses the delete
 * regardless. Clearing the image deletes nothing.
 *
 * ## Archiving is not deleting
 *
 * The only destructive-looking action is "Archiver", it asks for confirmation
 * in place, and what it does is stated in the confirmation: the service leaves
 * the reservation page, its bookings stay. "Restaurer" is the way back.
 *
 * ## Combinations (ESZ-150, corrected in domain version 15)
 *
 * The same page owns the maximum number of services per appointment and the
 * combinations. The maximum is the whole rule: at 2, every pair of active
 * prestations is bookable, for the sum of its durations, with nothing stored
 * and nothing to click. The list exists to *override* that — to take one
 * combination off the menu, or to pin a duration that is not the sum — so a
 * row with no stored override reads `Active par défaut` and still offers
 * `Désactiver`. Saving a duration pins it for that combination only and a
 * later component edit never rewrites it; `Durée automatique` gives it back.
 * Every combination mutation re-reads the catalog, because the list is
 * derived from what is stored.
 */
export function AdminServices() {
  const { csrfToken, api, markExpired, refreshSession } = useAdminSession();
  const catalog = useAdminServiceCatalog();
  const [draft, setDraft] = useState<ServiceDraft | null>(null);
  const [errors, setErrors] = useState<ServiceDraftErrors>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [alert, setAlert] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const formHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (message) noticeRef.current?.focus();
  }, [message]);

  useEffect(() => {
    if (draft) formHeadingRef.current?.focus();
  }, [draft?.key, draft !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const usagesOf = useCallback(
    (path: string) => serviceImageUsages(catalog.services, path),
    [catalog.services],
  );

  const notify = useCallback((text: string, isAlert: boolean) => {
    setMessage(text);
    setAlert(isAlert);
  }, []);

  const handleFailure = useCallback(
    async (failure: AdminApiFailure) => {
      if (failure.kind === "unauthenticated") {
        markExpired();
        return;
      }
      if (failure.kind === "forbidden") await refreshSession();
      if (isCatalogStale(failure)) {
        setDraft(null);
        setConfirming(null);
        await catalog.reload();
      }
      notify(serviceFailureMessage(failure), true);
    },
    [markExpired, refreshSession, catalog, notify],
  );

  function startAdd() {
    setErrors({});
    setConfirming(null);
    setDraft(emptyServiceDraft());
  }

  function startEdit(service: AdminBookableService) {
    setErrors({});
    setConfirming(null);
    setDraft(draftFromService(service));
  }

  function cancelEdit() {
    setDraft(null);
    setErrors({});
  }

  function updateDraft<K extends keyof ServiceDraft>(field: K, value: ServiceDraft[K]) {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
    if (field === "label" || field === "description" || field === "durationMinutes") {
      setErrors((current) => ({ ...current, [field]: undefined }));
    }
  }

  async function save() {
    if (!draft || saving) return;
    const found = validateServiceDraft(draft);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    const mutation = mutationFromDraft(draft);
    if (mutation === null) return;
    setSaving(true);
    const result = await api.mutateService(mutation, csrfToken);
    setSaving(false);
    if (!result.ok) return void handleFailure(result.failure);
    if (!("service" in result.value)) return void catalog.reload();
    catalog.adopt(result.value.service);
    setDraft(null);
    notify(
      mutation.action === "create" ? ADMIN_SERVICES_MESSAGES.created : ADMIN_SERVICES_MESSAGES.updated,
      false,
    );
  }

  async function setArchived(service: AdminBookableService, archived: boolean) {
    if (saving) return;
    setSaving(true);
    const result = await api.mutateService(
      {
        action: archived ? "archive" : "restore",
        key: service.key,
        expectedUpdatedAt: service.updatedAt,
      },
      csrfToken,
    );
    setSaving(false);
    setConfirming(null);
    if (!result.ok) return void handleFailure(result.failure);
    if (!("service" in result.value)) return void catalog.reload();
    catalog.adopt(result.value.service);
    if (draft?.key === service.key) setDraft(draftFromService(result.value.service));
    notify(archived ? ADMIN_SERVICES_MESSAGES.archived : ADMIN_SERVICES_MESSAGES.restored, false);
    // ESZ-150: a member's activity decides which combinations are bookable
    // and which candidates exist, so the combination list is re-read.
    await catalog.reload();
  }

  /** ESZ-150 — every combination mutation re-reads the catalog it derives from. */
  async function mutateCombinations(
    mutation: Parameters<typeof api.mutateService>[0],
    success: string,
  ): Promise<boolean> {
    if (saving) return false;
    setSaving(true);
    const result = await api.mutateService(mutation, csrfToken);
    setSaving(false);
    if (!result.ok) {
      if (result.failure.kind === "conflict") {
        await catalog.reload();
        notify(ADMIN_SERVICES_MESSAGES.combinationConflict, true);
        return false;
      }
      await handleFailure(result.failure);
      return false;
    }
    await catalog.reload();
    notify(success, false);
    return true;
  }

  return (
    <MediaLibraryProvider additionalUsagesOf={usagesOf}>
      <main className="admin-canvas min-h-screen">
        <div className="px-4 pt-8 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-[1500px] flex-wrap items-end justify-between gap-4">
            <div>
              <p className="admin-text-accent text-xs font-semibold uppercase tracking-[0.2em]">
                Administration
              </p>
              <h1 className="admin-text mt-2 font-display text-3xl font-light sm:text-4xl">
                Prestations
              </h1>
              <p className="admin-text-muted mt-2 max-w-xl text-sm leading-relaxed">
                Les prestations actives sont proposées sur la page de réservation. Une prestation
                archivée n’est plus proposée ; ses rendez-vous restent dans le calendrier.
              </p>
            </div>
            <button
              type="button"
              onClick={startAdd}
              disabled={saving}
              className="admin-btn-primary rounded-full px-5 py-2.5 text-sm font-medium">
              Ajouter une prestation
            </button>
          </div>
        </div>

        <div className="px-4 py-8 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-[1500px] space-y-5">
            {message && (
              <p
                ref={noticeRef}
                tabIndex={-1}
                role={alert ? "alert" : "status"}
                aria-live="polite"
                className={`rounded-2xl px-4 py-3 text-sm ${alert ? "admin-note-danger" : "admin-note-ok"}`}>
                {message}
              </p>
            )}

            {draft && (
              <ServiceForm
                draft={draft}
                errors={errors}
                saving={saving}
                headingRef={formHeadingRef}
                onChange={updateDraft}
                onSave={() => void save()}
                onCancel={cancelEdit}
              />
            )}

            <section aria-labelledby="services-list-heading" className="admin-panel rounded-3xl p-5 sm:p-6">
              <h2 id="services-list-heading" className="admin-text font-display text-2xl">
                Catalogue
              </h2>
              {catalog.status === "loading" && (
                <p role="status" className="admin-text-muted mt-4 text-sm">
                  {ADMIN_SERVICES_MESSAGES.loading}
                </p>
              )}
              {catalog.status === "error" && catalog.failure && (
                <div className="mt-4" role="alert">
                  <p className="admin-note-danger rounded-2xl px-4 py-3 text-sm">
                    {catalog.failure.message}
                  </p>
                  <button
                    type="button"
                    onClick={() => void catalog.reload()}
                    className="admin-btn-secondary mt-3 rounded-full px-4 py-2 text-sm">
                    Réessayer
                  </button>
                </div>
              )}
              {catalog.status === "ready" && catalog.services.length === 0 && (
                <p className="admin-text-muted mt-4 text-sm">{ADMIN_SERVICES_MESSAGES.empty}</p>
              )}
              {catalog.status === "ready" && catalog.services.length > 0 && (
                <ServiceList
                  services={catalog.services}
                  busy={saving}
                  editingKey={draft?.key ?? null}
                  confirmingKey={confirming}
                  onEdit={startEdit}
                  onArchiveRequest={(service) => setConfirming(service.key)}
                  onArchiveCancel={() => setConfirming(null)}
                  onArchiveConfirm={(service) => void setArchived(service, true)}
                  onRestore={(service) => void setArchived(service, false)}
                />
              )}
            </section>

            {catalog.status === "ready" && (
              <CombinationsPanel
                services={catalog.services}
                combinations={catalog.combinations}
                complete={catalog.combinationsComplete}
                maxServices={catalog.maxServicesPerAppointment}
                busy={saving}
                labelOf={catalog.labelOf}
                onSetMax={(max) => void mutateCombinations(
                  { action: "setMaxServices", maxServicesPerAppointment: max },
                  ADMIN_SERVICES_MESSAGES.maxSaved,
                )}
                onValidate={(mutation) => mutateCombinations(
                  mutation,
                  ADMIN_SERVICES_MESSAGES.combinationValidated,
                )}
                onClearDuration={(combination) => void mutateCombinations(
                  clearCombinationDurationMutation(combination),
                  ADMIN_SERVICES_MESSAGES.combinationCleared,
                )}
                onSetActive={(combination, active) => void mutateCombinations(
                  active
                    ? {
                        action: "enableCombination",
                        key: combination.key,
                        expectedUpdatedAt: combination.updatedAt ?? "",
                      }
                    : disableCombinationMutation(combination),
                  active
                    ? ADMIN_SERVICES_MESSAGES.combinationEnabled
                    : ADMIN_SERVICES_MESSAGES.combinationDisabled,
                )}
              />
            )}
          </div>
        </div>
      </main>
    </MediaLibraryProvider>
  );
}

/**
 * The four columns, as one grid that stacks under `sm`. Each cell carries its
 * column name on small screens, so a phone reads "Durée 1 h 30" rather than a
 * bare value, and the header row is hidden there because the cells say it.
 */
function ServiceList({
  services,
  busy,
  editingKey,
  confirmingKey,
  onEdit,
  onArchiveRequest,
  onArchiveCancel,
  onArchiveConfirm,
  onRestore,
}: {
  services: AdminBookableService[];
  busy: boolean;
  editingKey: string | null;
  confirmingKey: string | null;
  onEdit: (service: AdminBookableService) => void;
  onArchiveRequest: (service: AdminBookableService) => void;
  onArchiveCancel: () => void;
  onArchiveConfirm: (service: AdminBookableService) => void;
  onRestore: (service: AdminBookableService) => void;
}) {
  const columns = "sm:grid-cols-[minmax(0,1fr)_7rem_7rem_minmax(11rem,auto)]";
  return (
    <div role="table" aria-label="Prestations" className="mt-4">
      <div
        role="row"
        className={`admin-text-subtle hidden gap-4 px-3 pb-2 text-xs font-semibold uppercase tracking-wide sm:grid ${columns}`}>
        <span role="columnheader">Prestation</span>
        <span role="columnheader">Durée</span>
        <span role="columnheader">Statut</span>
        <span role="columnheader">Actions</span>
      </div>
      <ul className="admin-border divide-y divide-[color:var(--admin-border)] border-t">
        {services.map((service) => {
          const archived = service.status === "archived";
          const confirming = confirmingKey === service.key;
          return (
            <li
              key={service.key}
              role="row"
              data-service-key={service.key}
              data-service-status={service.status}
              aria-current={editingKey === service.key ? "true" : undefined}
              className={`grid gap-3 px-3 py-4 sm:items-center sm:gap-4 ${columns} ${archived ? "opacity-75" : ""}`}>
              <div role="cell" className="flex min-w-0 items-center gap-3">
                <span className="admin-sunken relative block h-12 w-16 shrink-0 overflow-hidden rounded-lg">
                  {service.imageSrc !== null ? (
                    // Managed media are runtime URLs owned by the library, not build-time assets.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={service.imageSrc} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="admin-text-subtle flex h-full w-full items-center justify-center text-[10px] uppercase tracking-wide">
                      Sans image
                    </span>
                  )}
                </span>
                <span className="min-w-0">
                  <span className="admin-text block truncate font-medium">{service.label}</span>
                  {service.description.length > 0 && (
                    <span className="admin-text-muted block truncate text-xs">{service.description}</span>
                  )}
                </span>
              </div>
              <p role="cell" className="admin-text text-sm">
                <span className="admin-text-subtle mr-2 text-xs uppercase tracking-wide sm:hidden">Durée</span>
                {formatServiceDuration(service.durationMinutes)}
              </p>
              <p role="cell" className="text-sm">
                <span className="admin-text-subtle mr-2 text-xs uppercase tracking-wide sm:hidden">Statut</span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${archived ? "admin-note-inert" : "admin-note-ok"}`}>
                  {SERVICE_STATUS_LABELS[service.status]}
                </span>
              </p>
              <div role="cell" className="flex flex-wrap items-center gap-2">
                {confirming ? (
                  <div className="admin-note-warn w-full rounded-2xl px-3 py-2 text-sm" role="group" aria-label={`Archiver ${service.label}`}>
                    <p>
                      Archiver « {service.label} » ? {ADMIN_SERVICES_MESSAGES.archiveConfirm}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onArchiveConfirm(service)}
                        className="admin-btn-danger rounded-full px-3 py-1.5 text-xs font-medium">
                        Confirmer l’archivage
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={onArchiveCancel}
                        className="admin-btn-quiet rounded-full px-3 py-1.5 text-xs">
                        Annuler
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onEdit(service)}
                      className="admin-btn-secondary rounded-full px-3 py-1.5 text-xs font-medium">
                      Modifier
                    </button>
                    {archived ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onRestore(service)}
                        className="admin-btn-quiet rounded-full px-3 py-1.5 text-xs">
                        Restaurer
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onArchiveRequest(service)}
                        className="admin-btn-quiet rounded-full px-3 py-1.5 text-xs">
                        Archiver
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ServiceForm({
  draft,
  errors,
  saving,
  headingRef,
  onChange,
  onSave,
  onCancel,
}: {
  draft: ServiceDraft;
  errors: ServiceDraftErrors;
  saving: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onChange: <K extends keyof ServiceDraft>(field: K, value: ServiceDraft[K]) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const idPrefix = useId();
  const adding = draft.key === null;

  return (
    <form
      aria-labelledby={`${idPrefix}-heading`}
      className="admin-panel rounded-3xl p-5 sm:p-6"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}>
      <h2 id={`${idPrefix}-heading`} ref={headingRef} tabIndex={-1} className="admin-text font-display text-2xl">
        {adding ? "Nouvelle prestation" : `Modifier « ${draft.label || "…"} »`}
      </h2>
      {!adding && (
        <p className="admin-text-subtle mt-1 text-xs">
          Identifiant de réservation : <code>{draft.key}</code>
        </p>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div>
            <Field
              id={`${idPrefix}-label`}
              label="Nom"
              value={draft.label}
              placeholder="Ex. Microblading sourcils"
              onChange={(value) => onChange("label", value)}
            />
            {errors.label && (
              <p role="alert" className="admin-note-danger mt-1.5 rounded-lg px-3 py-1.5 text-sm">
                {errors.label}
              </p>
            )}
          </div>
          <div>
            <TextArea
              id={`${idPrefix}-description`}
              label="Description"
              value={draft.description}
              placeholder="Ce que la cliente lira sur la page de réservation."
              onChange={(value) => onChange("description", value)}
            />
            {errors.description && (
              <p role="alert" className="admin-note-danger mt-1.5 rounded-lg px-3 py-1.5 text-sm">
                {errors.description}
              </p>
            )}
          </div>
          <div>
            <Field
              id={`${idPrefix}-duration`}
              label="Durée (minutes)"
              type="number"
              value={draft.durationMinutes}
              placeholder="Ex. 90"
              help="Entre 5 et 480 minutes. Les rendez-vous déjà pris gardent leur durée."
              onChange={(value) => onChange("durationMinutes", value)}
            />
            {errors.durationMinutes && (
              <p role="alert" className="admin-note-danger mt-1.5 rounded-lg px-3 py-1.5 text-sm">
                {errors.durationMinutes}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <p className="admin-text block text-sm font-medium">Image</p>
          <div className="admin-sunken relative overflow-hidden rounded-2xl">
            {draft.imageSrc !== null ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={draft.imageSrc} alt="" className="h-44 w-full object-cover" />
            ) : (
              <div className="admin-text-subtle flex h-32 items-center justify-center text-sm">
                Aucune image. Choisissez-en une dans la médiathèque.
              </div>
            )}
          </div>
          {draft.imageSrc !== null && (
            <button
              type="button"
              onClick={() => onChange("imageSrc", null)}
              className="admin-btn-quiet rounded-full px-3 py-1.5 text-xs">
              Retirer l’image
            </button>
          )}
          <MediaLibraryPanel
            idPrefix={`${idPrefix}-media`}
            selected={draft.imageSrc}
            onSelect={(asset) => onChange("imageSrc", asset.path)}
          />
          <p className="admin-text-muted text-sm leading-relaxed">
            La même image sert la liste, ce formulaire et la page de réservation. Retirer une
            image ne la supprime pas de la médiathèque.
          </p>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={saving}
          className="admin-btn-primary rounded-full px-5 py-2.5 text-sm font-medium">
          {saving ? "Enregistrement…" : adding ? "Ajouter la prestation" : "Enregistrer"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          className="admin-btn-quiet rounded-full px-5 py-2.5 text-sm">
          Annuler
        </button>
      </div>
    </form>
  );
}

/**
 * ESZ-150, corrected in domain version 15 — the maximum and the
 * combinations, inside `Prestations`.
 *
 * The maximum means exactly what it says: at 2, every pair of prestations
 * actives est réservable, sans aucune action de la part d’Esther. Every
 * combination the server listed is shown whether or not it has a row, and
 * the five columns say which rule applies to it: Prestations, Durée
 * automatique (the sum of its prestations, recomputed whenever a prestation
 * moves), Durée du rendez-vous (an input — saving it pins a custom duration
 * for this combination only), Statut (`Active par défaut`, `Durée
 * personnalisée`, `Désactivée`) and Actions (`Désactiver` / `Réactiver`, and
 * `Durée automatique` to drop a custom duration again). A truncated
 * enumeration says so.
 */
function CombinationsPanel({
  services,
  combinations,
  complete,
  maxServices,
  busy,
  labelOf,
  onSetMax,
  onValidate,
  onClearDuration,
  onSetActive,
}: {
  services: AdminBookableService[];
  combinations: AdminServiceCombination[];
  complete: boolean;
  maxServices: number;
  busy: boolean;
  labelOf: (key: string | readonly string[]) => string;
  onSetMax: (max: number) => void;
  onValidate: (mutation: NonNullable<ReturnType<typeof validateCombinationMutation>>) => Promise<boolean>;
  onClearDuration: (combination: AdminServiceCombination) => void;
  onSetActive: (combination: AdminServiceCombination, active: boolean) => void;
}) {
  const idPrefix = useId();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  function draftOf(combination: AdminServiceCombination): string {
    return drafts[combination.key] ?? combinationDurationDraft(combination);
  }

  async function validate(combination: AdminServiceCombination) {
    const mutation = validateCombinationMutation(combination, draftOf(combination));
    if (mutation === null) {
      setErrors((current) => ({ ...current, [combination.key]: SERVICE_DRAFT_ERRORS.durationMinutes }));
      return;
    }
    setErrors((current) => ({ ...current, [combination.key]: "" }));
    if (await onValidate(mutation)) {
      setDrafts((current) => {
        const next = { ...current };
        delete next[combination.key];
        return next;
      });
    }
  }

  const columns = "sm:grid-cols-[minmax(0,1fr)_8rem_11rem_8rem_minmax(11rem,auto)]";
  return (
    <section aria-labelledby={`${idPrefix}-heading`} className="admin-panel rounded-3xl p-5 sm:p-6" data-combinations-panel>
      <h2 id={`${idPrefix}-heading`} className="admin-text font-display text-2xl">
        Combinaisons
      </h2>
      <p className="admin-text-muted mt-2 max-w-2xl text-sm leading-relaxed">
        Une cliente peut réserver plusieurs prestations dans un même rendez-vous. Toutes les
        combinaisons sont proposées automatiquement, dans la limite du maximum ci-dessous, et durent
        la somme des prestations choisies. Vous n’avez donc rien à valider : servez-vous de cette
        liste seulement pour désactiver une combinaison ou lui fixer une durée particulière.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <label htmlFor={`${idPrefix}-max`} className="admin-text text-sm font-medium">
          Prestations maximum par rendez-vous
        </label>
        <select
          id={`${idPrefix}-max`}
          value={maxServices}
          disabled={busy}
          onChange={(event) => onSetMax(Number(event.target.value))}
          className="admin-input rounded-full px-4 py-2 text-sm">
          {MAX_SERVICES_OPTIONS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </div>

      {combinations.length === 0 && (
        <p className="admin-text-muted mt-4 text-sm">{ADMIN_SERVICES_MESSAGES.combinationsNone}</p>
      )}
      {!complete && (
        <p role="status" className="admin-note-warn mt-4 rounded-2xl px-4 py-3 text-sm">
          {ADMIN_SERVICES_MESSAGES.combinationsIncomplete}
        </p>
      )}
      {combinations.length > 0 && (
        <div role="table" aria-label="Combinaisons" className="mt-4">
          <div
            role="row"
            className={`admin-text-subtle hidden gap-4 px-3 pb-2 text-xs font-semibold uppercase tracking-wide sm:grid ${columns}`}>
            <span role="columnheader">Prestations</span>
            <span role="columnheader">Durée automatique</span>
            <span role="columnheader">Durée du rendez-vous</span>
            <span role="columnheader">Statut</span>
            <span role="columnheader">Actions</span>
          </div>
          <ul className="admin-border divide-y divide-[color:var(--admin-border)] border-t">
            {combinations.map((combination) => {
              const reason = combinationUnavailableReason(combination, services, maxServices);
              const disabled = combination.status === "disabled";
              const customised = combination.durationMinutes !== null;
              const inputId = `${idPrefix}-${combination.key}`;
              return (
                <li
                  key={combination.key}
                  role="row"
                  data-combination-key={combination.key}
                  data-combination-status={combination.status}
                  data-combination-bookable={combination.bookable ? "true" : "false"}
                  className={`grid gap-3 px-3 py-4 sm:items-center sm:gap-4 ${columns} ${disabled ? "opacity-75" : ""}`}>
                  <div role="cell" className="min-w-0">
                    <span className="admin-text block font-medium">{labelOf(combination.serviceKeys)}</span>
                    {reason && <span className="admin-text-muted block text-xs">{reason}</span>}
                  </div>
                  <p role="cell" className="admin-text text-sm">
                    <span className="admin-text-subtle mr-2 text-xs uppercase tracking-wide sm:hidden">Automatique</span>
                    {formatServiceDuration(combination.proposedDurationMinutes)}
                  </p>
                  <div role="cell">
                    <label htmlFor={inputId} className="admin-text-subtle mr-2 text-xs uppercase tracking-wide sm:sr-only">
                      Durée du rendez-vous (minutes)
                    </label>
                    <input
                      id={inputId}
                      type="number"
                      inputMode="numeric"
                      value={draftOf(combination)}
                      disabled={busy}
                      aria-invalid={errors[combination.key] ? true : undefined}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDrafts((current) => ({ ...current, [combination.key]: value }));
                        setErrors((current) => ({ ...current, [combination.key]: "" }));
                      }}
                      className="admin-input w-28 rounded-full px-3 py-1.5 text-sm"
                    />
                    {errors[combination.key] && (
                      <p role="alert" className="admin-note-danger mt-1.5 rounded-lg px-3 py-1.5 text-sm">
                        {errors[combination.key]}
                      </p>
                    )}
                    <span className="admin-text-subtle mt-1 block text-xs">
                      {customised ? "Durée personnalisée" : "Somme automatique"}
                    </span>
                  </div>
                  <p role="cell" className="text-sm">
                    <span className="admin-text-subtle mr-2 text-xs uppercase tracking-wide sm:hidden">Statut</span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${combination.bookable ? "admin-note-ok" : "admin-note-inert"}`}>
                      {COMBINATION_STATUS_LABELS[combination.status]}
                    </span>
                  </p>
                  <div role="cell" className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void validate(combination)}
                      className="admin-btn-secondary rounded-full px-3 py-1.5 text-xs font-medium">
                      Enregistrer la durée
                    </button>
                    {customised && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onClearDuration(combination)}
                        className="admin-btn-quiet rounded-full px-3 py-1.5 text-xs">
                        Durée automatique
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      data-combination-action={disabled ? "enable" : "disable"}
                      onClick={() => onSetActive(combination, disabled)}
                      className="admin-btn-quiet rounded-full px-3 py-1.5 text-xs">
                      {disabled ? "Réactiver" : "Désactiver"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
