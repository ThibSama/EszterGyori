"use client";

import {
  bookingPrivacyCurrentNotice,
  legalControllerName,
  type LegalInformation,
} from "@eszter/contracts";
import { LegalPageFrame, LegalPageStatus } from "./legal-page-frame";

/**
 * `/confidentialite` (ESZ-165) — the destination the ESZ-161 booking notice
 * froze.
 *
 * The policy facts are the repository's frozen ones: the purpose and the
 * contractual / pre-contractual basis of a booking, the 90-day retention,
 * the technical recipient categories and the rights, read from the current
 * privacy notice (`bookingPrivacyCurrentNotice`) rather than restated here
 * — the notice itself is never edited to share this page. The controller's
 * identity and the contact address come from the stored legal document, and
 * a fact the document does not carry is simply not rendered.
 */
export function PrivacyPolicy() {
  return (
    <LegalPageFrame mainId="privacy-policy-main" eyebrow="Données personnelles" title="Politique de confidentialité">
      {(state) => {
        if (state.status !== "ready") return <LegalPageStatus state={state} />;
        return <PrivacySections information={state.information} />;
      }}
    </LegalPageFrame>
  );
}

function PrivacySections({ information }: { information: LegalInformation }) {
  const notice = bookingPrivacyCurrentNotice.content;
  const controller = legalControllerName(information);
  const email = information.contact.email;

  return (
    <div className="space-y-10">
      <Section id="controller" title="Responsable du traitement">
        {controller !== null && <p>{controller}</p>}
        {information.registeredAddress !== null && (
          <p className="whitespace-pre-line">{information.registeredAddress}</p>
        )}
        {email !== null && (
          <p>
            <a href={`mailto:${email}`} className="underline decoration-warm-400 underline-offset-2 hover:text-warm-900">
              {email}
            </a>
          </p>
        )}
        {controller === null && information.registeredAddress === null && email === null && (
          <p>{notice.controller}</p>
        )}
      </Section>

      <Section id="purpose" title="Finalité et base légale">
        <p>{notice.legalBasis}</p>
      </Section>

      <Section id="retention" title="Durée de conservation">
        <p>{notice.retention}</p>
      </Section>

      <Section id="recipients" title="Destinataires">
        <p>{notice.recipients}</p>
        {information.hosting.name !== null && <p>Hébergement du site : {information.hosting.name}.</p>}
      </Section>

      <Section id="rights" title="Vos droits">
        <p>{notice.rights}</p>
        <p>{email !== null ? `Pour les exercer : ${email}.` : notice.contact}</p>
      </Section>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  const headingId = `privacy-${id}`;
  return (
    <section aria-labelledby={headingId} className="glass-card rounded-2xl bg-white/40 p-6 backdrop-blur-2xl md:p-8">
      <h2 id={headingId} className="font-display text-2xl font-light text-warm-800">
        {title}
      </h2>
      <div className="mt-4 space-y-3 leading-relaxed text-warm-800">{children}</div>
    </section>
  );
}
