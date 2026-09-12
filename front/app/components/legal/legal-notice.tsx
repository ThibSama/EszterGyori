"use client";

import { publicLegalFacts, type LegalFactGroup } from "@eszter/contracts";
import { LegalPageFrame, LegalPageStatus } from "./legal-page-frame";

/**
 * `/mentions-legales` (ESZ-165).
 *
 * The page renders exactly `publicLegalFacts(information)`: the facts that
 * are set and applicable, in their groups, and nothing else. A group with
 * no fact is not rendered; a fact with no value does not exist in the
 * projection, so no label, placeholder or warning can appear here — an
 * incomplete document is the administrator's to see, in the admin.
 */
export function LegalNotice() {
  return (
    <LegalPageFrame mainId="legal-notice-main" eyebrow="Informations légales" title="Mentions légales">
      {(state) => {
        if (state.status !== "ready") return <LegalPageStatus state={state} />;
        const groups = publicLegalFacts(state.information);
        if (groups.length === 0) {
          return <p className="text-sm text-warm-600">Les mentions légales seront publiées prochainement.</p>;
        }
        return (
          <div className="space-y-10">
            {groups.map((group) => (
              <LegalFactGroupSection key={group.key} group={group} />
            ))}
          </div>
        );
      }}
    </LegalPageFrame>
  );
}

function LegalFactGroupSection({ group }: { group: LegalFactGroup }) {
  const headingId = `legal-group-${group.key}`;
  return (
    <section aria-labelledby={headingId} className="glass-card rounded-2xl bg-white/40 p-6 backdrop-blur-2xl md:p-8">
      <h2 id={headingId} className="font-display text-2xl font-light text-warm-800">
        {group.title}
      </h2>
      <dl className="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-[minmax(10rem,auto)_1fr]">
        {group.facts.map((fact) => (
          <div key={fact.key} className="contents">
            <dt className="text-sm font-medium text-warm-600">{fact.label}</dt>
            <dd className={`text-warm-800 ${fact.multiline ? "whitespace-pre-line" : ""}`}>
              {fact.href ? (
                <a
                  href={fact.href}
                  className="underline decoration-warm-400 underline-offset-2 hover:text-warm-900"
                  target={fact.href.startsWith("http") ? "_blank" : undefined}
                  rel={fact.href.startsWith("http") ? "noopener noreferrer" : undefined}>
                  {fact.value}
                </a>
              ) : (
                fact.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
