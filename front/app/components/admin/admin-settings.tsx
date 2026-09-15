"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LEGAL_PAGE_LINKS } from "@eszter/contracts";
import { useAdminSession } from "./admin-session-provider";
import { Field, TextArea } from "./editor-fields";
import type { AdminApiFailure, AdminApiResult, AdminLegalInformation } from "../../lib/admin-api";
import {
  ADMIN_LEGAL_MESSAGES,
  canAddRegister,
  draftFromInformation,
  draftWarnings,
  informationFromDraft,
  legalFailureMessage,
  type LegalDraft,
  type LegalDraftErrors,
  type LegalDraftField,
} from "../../lib/admin-legal-information";

/**
 * `/admin/settings` — the `Paramètres` destination (ESZ-165).
 *
 * One section today, `Informations juridiques`: the single legal document
 * both public legal pages publish. The form starts from
 * `GET /api/admin/settings/legal` and every save is
 * `PUT /api/admin/settings/legal` under the revision it read; what the server
 * stores is what the form adopts, never the draft. A 409 reloads the
 * document before Esther tries again.
 *
 * ## What is missing is said here, and only here
 *
 * The warnings panel lists every required fact still unset, live as the
 * draft changes (`draftWarnings`). The public pages never show a warning, a
 * placeholder or an empty label: an unset or non-applicable fact is simply
 * absent there, which is why the panel says so.
 */
export function AdminSettings() {
  const { csrfToken, api, markExpired, refreshSession } = useAdminSession();
  const [stored, setStored] = useState<AdminLegalInformation | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<LegalDraft | null>(null);
  const [errors, setErrors] = useState<LegalDraftErrors>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [alert, setAlert] = useState(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (message) noticeRef.current?.focus();
  }, [message]);

  const notify = useCallback((text: string, isAlert: boolean) => {
    setMessage(text);
    setAlert(isAlert);
  }, []);

  const adopt = useCallback((value: AdminLegalInformation) => {
    setStored(value);
    setDraft(draftFromInformation(value.information));
    setErrors({});
    setStatus("ready");
  }, []);

  const apply = useCallback(
    (result: AdminApiResult<AdminLegalInformation>) => {
      if (!result.ok) {
        if (result.failure.kind === "unauthenticated") return void markExpired();
        setLoadError(result.failure.message);
        setStatus("error");
        return;
      }
      adopt(result.value);
    },
    [markExpired, adopt],
  );

  // The first read: state is set from the response callback, never in the
  // effect body, and a read that resolves after unmount is dropped.
  useEffect(() => {
    let cancelled = false;
    void api.readLegalInformation().then((result) => {
      if (!cancelled) apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, [api, apply]);

  /** A re-read on demand: after a load failure, or after a 409 moved the document. */
  const load = useCallback(async () => {
    setStatus("loading");
    apply(await api.readLegalInformation());
  }, [api, apply]);

  const handleFailure = useCallback(
    async (failure: AdminApiFailure) => {
      if (failure.kind === "unauthenticated") return void markExpired();
      if (failure.kind === "forbidden") await refreshSession();
      notify(legalFailureMessage(failure), true);
      if (failure.kind === "conflict") await load();
    },
    [markExpired, refreshSession, notify, load],
  );

  function update<K extends keyof LegalDraft>(field: K, value: LegalDraft[K]) {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
    setErrors((current) => (field in current ? { ...current, [field]: undefined } : current));
  }

  function updateRegister(index: number, patch: Partial<LegalDraft["registers"][number]>) {
    setDraft((current) => {
      if (!current) return current;
      const registers = current.registers.map((register, at) =>
        at === index ? { ...register, ...patch } : register,
      );
      return { ...current, registers };
    });
    setErrors((current) => ({ ...current, [`registers.${index}`]: undefined }));
  }

  function addRegister() {
    setDraft((current) =>
      current && canAddRegister(current)
        ? { ...current, registers: [...current.registers, { label: "", reference: "" }] }
        : current,
    );
  }

  function removeRegister(index: number) {
    setDraft((current) =>
      current ? { ...current, registers: current.registers.filter((_, at) => at !== index) } : current,
    );
    setErrors({});
  }

  async function save() {
    if (!draft || !stored || saving) return;
    const result = informationFromDraft(draft);
    if (!result.ok) {
      setErrors(result.errors);
      notify(ADMIN_LEGAL_MESSAGES.validation, true);
      return;
    }
    setSaving(true);
    const saved = await api.saveLegalInformation(
      { expectedRevision: stored.revision, information: result.information },
      csrfToken,
    );
    setSaving(false);
    if (!saved.ok) return void handleFailure(saved.failure);
    adopt(saved.value);
    notify(ADMIN_LEGAL_MESSAGES.saved, false);
  }

  const warnings = draft ? draftWarnings(draft) : [];

  return (
    <main className="admin-canvas min-h-screen">
      <div className="px-4 pt-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1100px]">
          <p className="admin-text-accent text-xs font-semibold uppercase tracking-[0.2em]">
            Administration
          </p>
          <h1 className="admin-text mt-2 font-display text-3xl font-light sm:text-4xl">Paramètres</h1>
          <p className="admin-text-muted mt-2 max-w-xl text-sm leading-relaxed">
            Les informations juridiques alimentent les pages{" "}
            {LEGAL_PAGE_LINKS.map((link, index) => (
              <span key={link.id}>
                {index > 0 ? " et " : ""}
                <a href={link.href} target="_blank" rel="noopener noreferrer" className="underline">
                  {link.label}
                </a>
              </span>
            ))}
            . Seules les valeurs renseignées y sont affichées.
          </p>
        </div>
      </div>

      <div className="px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1100px] space-y-5">
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

          {status === "loading" && (
            <p role="status" className="admin-text-muted text-sm">
              {ADMIN_LEGAL_MESSAGES.loading}
            </p>
          )}
          {status === "error" && loadError && (
            <div role="alert">
              <p className="admin-note-danger rounded-2xl px-4 py-3 text-sm">{loadError}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="admin-btn-secondary mt-3 rounded-full px-4 py-2 text-sm">
                Réessayer
              </button>
            </div>
          )}

          {status === "ready" && draft && stored && (
            <section aria-labelledby="legal-information-heading" className="admin-panel rounded-3xl p-5 sm:p-6">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h2 id="legal-information-heading" className="admin-text font-display text-2xl">
                    Informations juridiques
                  </h2>
                  <p className="admin-text-muted mt-1 text-sm">
                    {stored.updatedAt === null
                      ? "Jamais enregistrées."
                      : `Dernier enregistrement : ${new Date(stored.updatedAt).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}.`}
                  </p>
                </div>
              </div>

              <LegalWarningsPanel warnings={warnings} />

              <form
                className="mt-6 space-y-8"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}>
                <Group title="Identité">
                  <DraftField draft={draft} errors={errors} field="legalName" label="Dénomination ou nom de l’exploitant" onChange={update} />
                  <DraftField draft={draft} errors={errors} field="tradeName" label="Nom commercial (facultatif)" onChange={update} />
                  <DraftField draft={draft} errors={errors} field="legalForm" label="Forme juridique" onChange={update} help="Par exemple : Entrepreneur individuel, SASU, EURL." />
                  <DraftField draft={draft} errors={errors} field="activity" label="Activité" onChange={update} />
                </Group>

                <Group title="Immatriculation">
                  <DraftField draft={draft} errors={errors} field="siren" label="SIREN (9 chiffres)" onChange={update} />
                  <DraftField draft={draft} errors={errors} field="siret" label="SIRET (14 chiffres)" onChange={update} />
                  <fieldset className="space-y-3">
                    <legend className="admin-text text-sm font-medium">Registres (facultatif)</legend>
                    {draft.registers.map((register, index) => (
                      <div key={index} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                        <Field
                          id={`legal-register-${index}-label`}
                          label="Registre"
                          value={register.label}
                          onChange={(value) => updateRegister(index, { label: value })}
                          placeholder="Registre national des entreprises"
                        />
                        <Field
                          id={`legal-register-${index}-reference`}
                          label="Référence"
                          value={register.reference}
                          onChange={(value) => updateRegister(index, { reference: value })}
                        />
                        <button
                          type="button"
                          onClick={() => removeRegister(index)}
                          className="admin-btn-secondary rounded-full px-4 py-2 text-sm">
                          Retirer
                        </button>
                        {errors[`registers.${index}`] && (
                          <p role="alert" className="admin-note-danger rounded-xl px-3 py-2 text-sm sm:col-span-3">
                            {errors[`registers.${index}`]}
                          </p>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={addRegister}
                      disabled={!canAddRegister(draft)}
                      className="admin-btn-secondary rounded-full px-4 py-2 text-sm">
                      Ajouter un registre
                    </button>
                  </fieldset>
                  <ApplicabilitySwitch
                    id="legal-vat-applicable"
                    label="La TVA est applicable"
                    help="Décochez en cas de franchise en base de TVA : aucune mention de TVA n’apparaîtra sur la page publique."
                    checked={draft.vatApplicable}
                    onChange={(checked) => update("vatApplicable", checked)}
                  />
                  {draft.vatApplicable && (
                    <DraftField draft={draft} errors={errors} field="vatNumber" label="Numéro de TVA intracommunautaire" onChange={update} placeholder="FR00000000000" />
                  )}
                </Group>

                <Group title="Adresses">
                  <DraftArea draft={draft} errors={errors} field="registeredAddress" label="Adresse légale (siège)" onChange={update} />
                  <ApplicabilitySwitch
                    id="legal-salon-applicable"
                    label="Le salon a une adresse distincte de l’adresse légale"
                    help="Décochez si le salon est à l’adresse légale ou s’il n’y a pas de lieu d’accueil : aucune adresse de salon n’apparaîtra sur la page publique."
                    checked={draft.salonAddressApplicable}
                    onChange={(checked) => update("salonAddressApplicable", checked)}
                  />
                  {draft.salonAddressApplicable && (
                    <DraftArea draft={draft} errors={errors} field="salonAddress" label="Adresse du salon" onChange={update} />
                  )}
                </Group>

                <Group title="Contact">
                  <DraftField draft={draft} errors={errors} field="contactEmail" label="E-mail de contact" type="email" onChange={update} />
                  <DraftField draft={draft} errors={errors} field="contactPhone" label="Téléphone (facultatif)" onChange={update} />
                </Group>

                <Group title="Hébergement">
                  <DraftField draft={draft} errors={errors} field="hostingName" label="Hébergeur" onChange={update} />
                  <DraftArea draft={draft} errors={errors} field="hostingAddress" label="Adresse de l’hébergeur" onChange={update} />
                  <DraftField draft={draft} errors={errors} field="hostingPhone" label="Téléphone de l’hébergeur (facultatif)" onChange={update} />
                  <DraftField draft={draft} errors={errors} field="hostingWebsite" label="Site de l’hébergeur (facultatif)" type="url" onChange={update} placeholder="https://" />
                </Group>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="submit"
                    disabled={saving}
                    className="admin-btn-primary rounded-full px-5 py-2.5 text-sm font-medium">
                    {saving ? "Enregistrement…" : "Enregistrer"}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => adopt(stored)}
                    className="admin-btn-secondary rounded-full px-4 py-2 text-sm">
                    Annuler les modifications
                  </button>
                </div>
              </form>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

function LegalWarningsPanel({ warnings }: { warnings: ReadonlyArray<{ field: string; message: string }> }) {
  if (warnings.length === 0) {
    return (
      <p role="status" className="admin-note-ok mt-4 rounded-2xl px-4 py-3 text-sm">
        {ADMIN_LEGAL_MESSAGES.complete}
      </p>
    );
  }
  return (
    <div data-testid="legal-warnings" className="admin-note-warn mt-4 rounded-2xl px-4 py-3 text-sm">
      <p className="font-medium">
        {warnings.length === 1 ? "1 information requise manque." : `${warnings.length} informations requises manquent.`}
      </p>
      <p className="mt-1">{ADMIN_LEGAL_MESSAGES.incomplete}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {warnings.map((warning) => (
          <li key={warning.field}>{warning.message}</li>
        ))}
      </ul>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-4">
      <legend className="admin-text mb-2 font-display text-lg">{title}</legend>
      {children}
    </fieldset>
  );
}

function DraftField({
  draft,
  errors,
  field,
  label,
  type,
  help,
  placeholder,
  onChange,
}: {
  draft: LegalDraft;
  errors: LegalDraftErrors;
  field: LegalDraftField;
  label: string;
  type?: "text" | "email" | "url";
  help?: string;
  placeholder?: string;
  onChange: (field: LegalDraftField, value: string) => void;
}) {
  const error = errors[field];
  return (
    <div>
      <Field
        id={`legal-${field}`}
        label={label}
        value={draft[field]}
        type={type}
        help={help}
        placeholder={placeholder}
        onChange={(value) => onChange(field, value)}
      />
      {error && (
        <p role="alert" className="admin-note-danger mt-1.5 rounded-xl px-3 py-2 text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

function DraftArea({
  draft,
  errors,
  field,
  label,
  onChange,
}: {
  draft: LegalDraft;
  errors: LegalDraftErrors;
  field: LegalDraftField;
  label: string;
  onChange: (field: LegalDraftField, value: string) => void;
}) {
  const error = errors[field];
  return (
    <div>
      <TextArea id={`legal-${field}`} label={label} value={draft[field]} rows={3} onChange={(value) => onChange(field, value)} />
      {error && (
        <p role="alert" className="admin-note-danger mt-1.5 rounded-xl px-3 py-2 text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

function ApplicabilitySwitch({
  id,
  label,
  help,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="admin-sunken rounded-xl px-3 py-3">
      <label htmlFor={id} className="admin-text flex items-start gap-3 text-sm font-medium">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <span>{label}</span>
      </label>
      <p className="admin-text-muted mt-1.5 pl-7 text-sm leading-relaxed">{help}</p>
    </div>
  );
}
