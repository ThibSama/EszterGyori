"use client";

import { LEGAL_PAGE_LINKS, defaultSiteContent, type LegalInformation, type SiteContent } from "@eszter/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { loadPublishedContent } from "../../lib/booking-api";
import { loadLegalInformation, type LegalInformationResult } from "../../lib/legal-api";
import { createSiteAppearanceVariables } from "../../lib/site-appearance";

/** What a legal page renders from: the document, or the reason it could not be read. */
export type LegalPageState =
  | { status: "loading" }
  | { status: "ready"; information: LegalInformation }
  | { status: "error"; message: string };

/**
 * The chrome shared by the two legal pages (ESZ-165): the site's brand and
 * appearance from the published content, one `<main>` landmark reachable by
 * a skip link, and a footer that links the two legal pages to each other.
 *
 * The frame reads the legal document once and hands it to the page as a
 * {@link LegalPageState}; the page decides what to render from it. Nothing
 * here knows a legal fact.
 */
export function LegalPageFrame({
  mainId,
  eyebrow,
  title,
  children,
}: {
  mainId: string;
  eyebrow: string;
  title: string;
  children: (state: LegalPageState) => React.ReactNode;
}) {
  const [content, setContent] = useState<SiteContent>(defaultSiteContent);
  const [state, setState] = useState<LegalPageState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      loadLegalInformation(fetch, controller.signal),
      loadPublishedContent(defaultSiteContent, fetch, controller.signal),
    ]).then(([legal, published]) => {
      if (controller.signal.aborted) return;
      setContent(published.content);
      setState(stateFrom(legal));
    });
    return () => controller.abort();
  }, []);

  return (
    <div
      className="site-preview min-h-screen relative overflow-hidden"
      style={createSiteAppearanceVariables(content.appearance)}>
      <a href={`#${mainId}`} className="skip-link">Aller au contenu</a>
      <div aria-hidden="true" className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="ambient-shape absolute -top-32 -left-36 h-[520px] w-[520px] rounded-full bg-sage-300/60 blur-[110px]" />
        <div className="ambient-drift absolute bottom-[-12rem] right-[-10rem] h-[560px] w-[560px] rounded-full bg-mist-300/50 blur-[110px]" />
      </div>

      <header className="relative z-10 px-4 py-5 md:px-6">
        <div className="site-navigation-glass glass-card mx-auto flex h-14 max-w-6xl items-center justify-between rounded-2xl px-4 backdrop-blur-2xl md:px-6">
          <Link href="/" className="font-display text-xl tracking-tight text-warm-800" aria-label="Retour à l’accueil">
            {content.navigation.brandLabel}
          </Link>
          <Link href="/" className="text-sm text-warm-600 transition-colors hover:text-warm-800">Retour au site</Link>
        </div>
      </header>

      <main id={mainId} tabIndex={-1} className="relative z-10 px-4 pb-16 pt-8 md:px-6 md:pb-24 md:pt-14">
        <div className="mx-auto max-w-3xl">
          <div className="mb-10 max-w-2xl md:mb-14">
            <div className="mb-5 h-px w-10 bg-sage-400/60" />
            <p className="mb-3 text-sm font-medium uppercase tracking-[0.16em] text-sage-600">{eyebrow}</p>
            <h1 className="font-display text-3xl font-light leading-tight tracking-[-0.02em] text-warm-800 md:text-5xl">
              {title}
            </h1>
          </div>
          {children(state)}
        </div>
      </main>

      <footer className="relative z-10 border-t border-warm-300/50 px-4 py-8 md:px-6">
        <nav aria-label="Pages légales" className="mx-auto flex max-w-3xl flex-wrap gap-6 text-sm text-warm-600">
          {LEGAL_PAGE_LINKS.map((link) => (
            <Link key={link.id} href={link.href} className="hover:text-warm-800 transition-colors duration-300">
              {link.label}
            </Link>
          ))}
        </nav>
      </footer>
    </div>
  );
}

function stateFrom(result: LegalInformationResult): LegalPageState {
  return result.ok
    ? { status: "ready", information: result.value }
    : { status: "error", message: result.failure.message };
}

/** The neutral line a page shows while the document loads or could not be read. */
export function LegalPageStatus({ state }: { state: Exclude<LegalPageState, { status: "ready" }> }) {
  return (
    <p role="status" aria-live="polite" className="text-sm text-warm-600">
      {state.status === "loading" ? "Chargement…" : state.message}
    </p>
  );
}
