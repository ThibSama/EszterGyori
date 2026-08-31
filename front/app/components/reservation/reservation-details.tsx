"use client";

import { useEffect, useRef, type Dispatch, type FormEvent } from "react";
import type {
  CustomerField,
  ReservationFlowAction,
  ReservationFlowState,
} from "../../lib/reservation-flow";
import { validateCustomerDraft } from "../../lib/reservation-flow";

interface ReservationDetailsProps {
  state: ReservationFlowState;
  serviceLabel: string;
  dateLabel: (date: string) => string;
  dispatch: Dispatch<ReservationFlowAction>;
  onSubmit: () => Promise<void>;
}

export function ReservationDetails({
  state,
  serviceLabel,
  dateLabel,
  dispatch,
  onSubmit,
}: ReservationDetailsProps) {
  const detailsHeading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const confirmationHeading = useRef<HTMLHeadingElement>(null);
  const submissionAlert = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const phoneInput = useRef<HTMLInputElement>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const consentInput = useRef<HTMLInputElement>(null);
  const previousPhase = useRef<ReservationFlowState["phase"] | null>(null);

  useEffect(() => {
    if (state.submissionError) {
      submissionAlert.current?.focus();
      return;
    }
    if (previousPhase.current === state.phase) return;
    previousPhase.current = state.phase;
    if (state.phase === "details") detailsHeading.current?.focus();
    if (state.phase === "review") reviewHeading.current?.focus();
    if (state.phase === "confirmed") confirmationHeading.current?.focus();
  }, [state.phase, state.submissionError]);

  if (state.phase === "confirmed" && state.confirmation && state.selectedSlot) {
    return (
      <section className="mt-6 rounded-3xl border border-sage-300 bg-sage-100/80 p-6 shadow-[0_12px_40px_rgba(0,0,0,0.05)] sm:p-10" aria-labelledby="confirmation-heading">
        <p className="text-sm font-medium uppercase tracking-[0.16em] text-sage-600">Rendez-vous confirmé</p>
        <h2 ref={confirmationHeading} tabIndex={-1} id="confirmation-heading" className="mt-3 font-display text-3xl text-warm-800 sm:text-4xl">
          Votre rendez-vous est bien enregistré
        </h2>
        <div className="mt-7 grid gap-4 rounded-2xl bg-white/55 p-5 sm:grid-cols-2">
          <div><span className="block text-sm text-warm-500">Prestation</span><strong className="text-warm-800">{serviceLabel}</strong></div>
          <div><span className="block text-sm text-warm-500">Date et heure</span><strong className="text-warm-800">{dateLabel(state.selectedSlot.localDate)} à {state.selectedSlot.localStart}</strong></div>
        </div>
        <p className="mt-6 text-warm-600">Référence de réservation</p>
        <p className="mt-1 break-all font-mono text-lg font-semibold text-warm-800">{state.confirmation.reference}</p>
        <p className="mt-5 text-sm leading-relaxed text-warm-600">Conservez cette référence. Elle identifie votre rendez-vous sans exposer vos coordonnées.</p>
      </section>
    );
  }

  if (!state.selectedSlot) return null;

  const customer = state.customer;
  const errors = state.customerErrors;

  function update(field: CustomerField, value: string | boolean) {
    dispatch({ type: "update-customer", field, value });
  }

  function showReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateCustomerDraft(customer);
    const first = Object.keys(validation)[0] as keyof typeof customer | undefined;
    if (first) {
      dispatch({ type: "customer-invalid", errors: validation });
      const refs = {
        name: nameInput,
        email: emailInput,
        phone: phoneInput,
        note: noteInput,
        consentAccepted: consentInput,
      };
      queueMicrotask(() => refs[first].current?.focus());
      return;
    }
    dispatch({ type: "show-review" });
  }

  const errorFor = (field: keyof typeof customer) => errors[field];
  const describedBy = (field: keyof typeof customer) => errorFor(field) ? `${field}-error` : undefined;

  return (
    <>
      {state.submissionError && (
        <div ref={submissionAlert} tabIndex={-1} role="alert" className="mt-6 rounded-2xl border border-warm-300 bg-warm-100 p-5 text-warm-700">
          {state.submissionError.message}
        </div>
      )}

      {state.phase === "details" && (
        <section aria-labelledby="details-heading" className="mt-6 glass-card rounded-3xl border border-white/60 bg-white/45 p-5 backdrop-blur-2xl sm:p-8">
          <div className="flex items-start gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warm-800 text-sm text-porcelain">4</span>
            <div>
              <h2 ref={detailsHeading} tabIndex={-1} id="details-heading" className="font-display text-2xl text-warm-800 sm:text-3xl">Vos coordonnées</h2>
              <p className="mt-1 text-sm text-warm-500">Ces informations sont envoyées uniquement lors de votre confirmation.</p>
            </div>
          </div>

          <form onSubmit={showReview} noValidate className="mt-7 space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label htmlFor="customer-name" className="mb-2 block text-sm font-medium text-warm-700">Nom <span aria-hidden="true">*</span></label>
                <input ref={nameInput} id="customer-name" name="name" autoComplete="name" required maxLength={160} value={customer.name} onChange={(event) => update("name", event.target.value)} aria-invalid={Boolean(errorFor("name"))} aria-describedby={describedBy("name")} className="w-full rounded-xl border border-warm-300 bg-white/70 px-4 py-3 text-warm-800" />
                {errorFor("name") && <p id="name-error" className="mt-2 text-sm text-warm-700">{errorFor("name")}</p>}
              </div>
              <div>
                <label htmlFor="customer-email" className="mb-2 block text-sm font-medium text-warm-700">Email <span aria-hidden="true">*</span></label>
                <input ref={emailInput} id="customer-email" name="email" type="email" inputMode="email" autoComplete="email" required maxLength={254} value={customer.email} onChange={(event) => update("email", event.target.value)} aria-invalid={Boolean(errorFor("email"))} aria-describedby={describedBy("email")} className="w-full rounded-xl border border-warm-300 bg-white/70 px-4 py-3 text-warm-800" />
                {errorFor("email") && <p id="email-error" className="mt-2 text-sm text-warm-700">{errorFor("email")}</p>}
              </div>
            </div>
            <div>
              <label htmlFor="customer-phone" className="mb-2 block text-sm font-medium text-warm-700">Téléphone <span className="font-normal text-warm-500">(facultatif)</span></label>
              <input ref={phoneInput} id="customer-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={32} value={customer.phone} onChange={(event) => update("phone", event.target.value)} aria-invalid={Boolean(errorFor("phone"))} aria-describedby={describedBy("phone")} className="w-full rounded-xl border border-warm-300 bg-white/70 px-4 py-3 text-warm-800" />
              {errorFor("phone") && <p id="phone-error" className="mt-2 text-sm text-warm-700">{errorFor("phone")}</p>}
            </div>
            <div>
              <label htmlFor="customer-note" className="mb-2 block text-sm font-medium text-warm-700">Note <span className="font-normal text-warm-500">(facultatif)</span></label>
              <textarea ref={noteInput} id="customer-note" name="note" rows={4} maxLength={2000} value={customer.note} onChange={(event) => update("note", event.target.value)} aria-invalid={Boolean(errorFor("note"))} aria-describedby={describedBy("note")} className="w-full resize-y rounded-xl border border-warm-300 bg-white/70 px-4 py-3 text-warm-800" />
              {errorFor("note") && <p id="note-error" className="mt-2 text-sm text-warm-700">{errorFor("note")}</p>}
            </div>
            <div>
              <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-white/55 p-4" htmlFor="consent-accepted">
                <input ref={consentInput} id="consent-accepted" name="consentAccepted" type="checkbox" checked={customer.consentAccepted} onChange={(event) => update("consentAccepted", event.target.checked)} aria-invalid={Boolean(errorFor("consentAccepted"))} aria-describedby={describedBy("consentAccepted")} className="mt-1 h-5 w-5 shrink-0 accent-sage-600" />
                <span className="text-sm leading-relaxed text-warm-700">J’accepte que mes coordonnées soient utilisées pour traiter cette demande de rendez-vous. <span aria-hidden="true">*</span></span>
              </label>
              {errorFor("consentAccepted") && <p id="consentAccepted-error" className="mt-2 text-sm text-warm-700">{errorFor("consentAccepted")}</p>}
            </div>
            <button type="submit" disabled={state.availabilityStatus !== "ready"} className="w-full rounded-full bg-warm-800 px-6 py-3.5 font-medium text-porcelain transition-colors hover:bg-warm-700 disabled:cursor-wait disabled:opacity-60 sm:w-auto">Vérifier ma demande</button>
            {state.availabilityStatus !== "ready" && <p role="status" className="text-sm text-warm-600">Attendez la vérification des disponibilités avant de continuer.</p>}
          </form>
        </section>
      )}

      {(state.phase === "review" || state.phase === "submitting") && (
        <section aria-labelledby="review-heading" aria-busy={state.phase === "submitting"} className="mt-6 glass-card rounded-3xl border border-white/60 bg-white/45 p-5 backdrop-blur-2xl sm:p-8">
          <div className="flex items-start gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warm-800 text-sm text-porcelain">5</span>
            <div>
              <h2 ref={reviewHeading} tabIndex={-1} id="review-heading" className="font-display text-2xl text-warm-800 sm:text-3xl">Vérifiez votre demande</h2>
              <p className="mt-1 text-sm text-warm-500">Aucun rendez-vous n’est créé avant votre confirmation ci-dessous.</p>
            </div>
          </div>
          <dl className="mt-7 grid gap-4 rounded-2xl bg-white/55 p-5 sm:grid-cols-2">
            <div><dt className="text-sm text-warm-500">Prestation</dt><dd className="font-medium text-warm-800">{serviceLabel}</dd></div>
            <div><dt className="text-sm text-warm-500">Date et heure</dt><dd className="font-medium text-warm-800">{dateLabel(state.selectedSlot.localDate)} à {state.selectedSlot.localStart}</dd></div>
            <div><dt className="text-sm text-warm-500">Nom</dt><dd className="font-medium text-warm-800">{customer.name.trim()}</dd></div>
            <div><dt className="text-sm text-warm-500">Email</dt><dd className="break-all font-medium text-warm-800">{customer.email.trim()}</dd></div>
            {customer.phone.trim() && <div><dt className="text-sm text-warm-500">Téléphone</dt><dd className="font-medium text-warm-800">{customer.phone.trim()}</dd></div>}
            {customer.note.trim() && <div className="sm:col-span-2"><dt className="text-sm text-warm-500">Note</dt><dd className="whitespace-pre-wrap text-warm-800">{customer.note.trim()}</dd></div>}
          </dl>
          <p className="mt-5 text-sm text-warm-600">Consentement confirmé pour le traitement de cette demande.</p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <button type="button" disabled={state.phase === "submitting"} onClick={() => dispatch({ type: "edit-details" })} className="rounded-full border border-warm-300 bg-white/60 px-6 py-3 font-medium text-warm-700 disabled:opacity-50">Modifier mes coordonnées</button>
            <button type="button" disabled={state.phase === "submitting" || state.availabilityStatus !== "ready"} onClick={() => void onSubmit()} className="rounded-full bg-warm-800 px-6 py-3 font-medium text-porcelain transition-colors hover:bg-warm-700 disabled:cursor-wait disabled:opacity-60">
              {state.phase === "submitting" ? "Confirmation en cours…" : "Confirmer le rendez-vous"}
            </button>
          </div>
          {state.phase === "submitting" && <p role="status" aria-live="polite" className="mt-4 text-sm text-warm-600">La demande est en cours d’envoi. Ne fermez pas cette page.</p>}
        </section>
      )}
    </>
  );
}
