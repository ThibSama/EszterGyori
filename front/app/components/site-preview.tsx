import { HeroInstagramButton } from "./hero-instagram-button";
import { EditorialImage } from "./editorial-image";
import { EditorialFallback } from "./editorial-fallback";
import { GallerySection } from "./site-gallery-section";
import { Navigation } from "./navigation";
import { Reveal } from "./reveal";
import { SiteFooter } from "./site-footer";
import { createSiteAppearanceVariables } from "../lib/site-appearance";
import type { CSSProperties } from "react";
import type {
  AboutContent,
  ContactContent,
  HeroContent,
  ProcessContent,
  ReassuranceContent,
  ServiceItemContent,
  ServicesContent,
  ServiceVisualKind,
  SiteContent,
} from "../types/site-content";

function GlassCard({
  children,
  className = "",
  hover = true,
}: {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div
      className={`glass-card polish-surface bg-white/40 backdrop-blur-2xl border border-white/60 rounded-2xl ${
        hover ? "polish-card" : ""
      } ${className}`}>
      {children}
    </div>
  );
}

function HeroSection({ content }: { content: HeroContent }) {
  return (
    <section
      data-preview-section="site-section-hero"
      className="site-section-hero relative z-10 min-h-svh md:min-h-[90vh] flex items-center pt-20 md:pt-24 pb-12 md:pb-16 px-4 md:px-6 overflow-hidden">
      <div className="ambient-shape absolute top-[8%] left-[2%] w-[550px] h-[550px] rounded-full bg-sage-300/65 blur-[100px] pointer-events-none" />
      <div
        className="ambient-drift absolute bottom-[0%] right-[5%] w-[500px] h-[500px] rounded-full bg-mist-300/50 blur-[90px] pointer-events-none"
        style={{ animationDelay: "-8s" }}
      />
      <div
        className="ambient-shape absolute top-[35%] right-[25%] w-[350px] h-[350px] rounded-full bg-warm-300/55 blur-[80px] pointer-events-none"
        style={{ animationDelay: "-16s" }}
      />

      <div className="relative z-10 max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-12 md:gap-20 items-center">
        <div className="space-y-8">
          <div className="hero-entrance w-10 h-px bg-sage-400/60" />
          <h1 className="hero-entrance-delayed font-display text-[2.25rem] sm:text-[2.75rem] md:text-[4.25rem] font-light leading-[1.08] tracking-[-0.02em] text-warm-800">
            {content.title.prefix}{" "}
            <em className="hero-entrance-em italic">{content.title.emphasized}</em>
            {content.title.suffix}
          </h1>
          <p className="hero-entrance-delayed-2 text-base md:text-lg text-warm-500 leading-relaxed max-w-md">
            {content.description}
          </p>
          <div className="hero-entrance-delayed-3 flex flex-col sm:flex-row flex-wrap gap-3 sm:gap-4 pt-2">
            <a
              href={content.primaryCta.href}
              className="polish-btn-primary inline-flex items-center justify-center px-7 py-3 sm:py-3.5 bg-warm-800 text-porcelain font-medium rounded-full">
              {content.primaryCta.label}
            </a>
            <a
              href={content.secondaryCta.href}
              className="polish-btn-secondary inline-flex items-center justify-center px-7 py-3 sm:py-3.5 bg-white/50 backdrop-blur-sm border border-white/60 text-warm-600 font-medium rounded-full">
              {content.secondaryCta.label}
            </a>
          </div>
        </div>

        <div className="hero-visual relative aspect-[3/4] max-w-md mx-auto md:mx-0">
          <div className="hero-visual-light absolute -inset-16 pointer-events-none" aria-hidden="true" />
          <div className="absolute -inset-8 bg-gradient-to-br from-sage-300/50 via-mist-200/60 to-warm-300/40 rounded-[3rem] blur-2xl pointer-events-none" />
          <div className="polish-surface relative h-full rounded-3xl overflow-hidden bg-gradient-to-br from-sage-200 via-mist-100 to-warm-200 border border-white/40">
            <EditorialImage
              src={content.visual.src}
              alt={content.visual.alt}
              surface="hero"
              loading="eager"
              fetchPriority="high"
              className="absolute inset-0 h-full w-full object-cover"
              fallback={
                <EditorialFallback
                  motif="portrait"
                  label={content.visual.alt}
                  tone={0}
                  className="media-fallback-hero"
                />
              }
            />
            <HeroInstagramButton ariaLabel={content.instagramAriaLabel} />
            <div className="hero-badge absolute top-5 right-5 bg-white/55 backdrop-blur-md border border-white/45 rounded-xl px-3 py-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.04)]">
              <p className="text-[10px] uppercase tracking-wider text-sage-500">
                {content.badgeLabel}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ReassuranceSection({
  content,
  disableRevealAnimations = false,
}: {
  content: ReassuranceContent;
  disableRevealAnimations?: boolean;
}) {
  return (
    <section
      data-preview-section="site-section-reassurance"
      className="site-section-reassurance relative z-10 py-16 md:py-32 px-4 md:px-6">
      <div className="absolute inset-0 bg-gradient-to-b from-warm-50/0 via-sage-100/70 to-warm-50/0 pointer-events-none" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-warm-300/60 to-transparent" />
      <h2 className="sr-only">Pourquoi choisir Eszter Gyori</h2>

      <Reveal
        className="relative z-10 max-w-5xl mx-auto"
        disabled={disableRevealAnimations}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-16 gap-y-14">
          {content.items.map((item, index) => (
            <Reveal
              key={item.id}
              className="space-y-4"
              delay={index * 70}
              disabled={disableRevealAnimations}>
              <div className="w-8 h-px bg-sage-400/50" />
              <h3 className="font-display text-2xl font-normal text-warm-800">
                {item.title}
              </h3>
              <p className="text-warm-500 leading-relaxed">
                {item.description}
              </p>
            </Reveal>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

function ServiceVisual({ item, index }: { item: ServiceItemContent; index: number }) {
  const visualClassByKind: Record<ServiceVisualKind, string> = {
    brows: "bg-gradient-to-br from-sage-200 via-mist-100 to-warm-200",
    eyeliner: "bg-gradient-to-br from-mist-200 via-sage-100 to-warm-200",
    lips: "bg-gradient-to-br from-warm-300/80 via-mist-100 to-sage-100",
    freckles: "bg-gradient-to-br from-warm-200 via-warm-300/60 to-sage-200",
  };

  return (
    <div
      className={`aspect-[5/3] ${visualClassByKind[item.visualKind]} relative overflow-hidden`}>
      <EditorialImage
        src={item.visual.src}
        alt={item.visual.alt}
        surface={`service-${item.id}`}
        className="polish-media absolute inset-0 h-full w-full object-cover"
        fallback={
          <EditorialFallback
            motif={item.visualKind}
            label={item.visual.alt}
            tone={index}
          />
        }
      />
      <div className="polish-media-veil" aria-hidden="true" />
    </div>
  );
}

function ServicesSection({
  content,
  disableRevealAnimations = false,
}: {
  content: ServicesContent;
  disableRevealAnimations?: boolean;
}) {
  return (
    <section
      id="prestations"
      data-preview-section="site-section-services"
      className="site-section-services relative z-10 py-16 md:py-32 px-4 md:px-6 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-warm-200/50 via-transparent to-sage-100/40 pointer-events-none" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sage-300/50 to-transparent" />
      <div className="ambient-shape absolute bottom-[5%] left-[0%] w-[550px] h-[550px] rounded-full bg-sage-300/60 blur-[100px] pointer-events-none" />
      <div
        className="ambient-drift absolute top-[10%] right-[3%] w-[450px] h-[450px] rounded-full bg-mist-200/50 blur-[90px] pointer-events-none"
        style={{ animationDelay: "-12s" }}
      />

      <div className="relative z-10 max-w-6xl mx-auto">
        <Reveal className="mb-16 max-w-xl" disabled={disableRevealAnimations}>
          <div className="w-10 h-px bg-sage-400/60 mb-6" />
          <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-light text-warm-800">
            {content.title}
          </h2>
        </Reveal>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {content.items.map((item, index) => (
            <Reveal key={item.id} delay={index * 70} disabled={disableRevealAnimations}>
              <GlassCard className="overflow-hidden group">
                <ServiceVisual item={item} index={index} />
                <div className="p-7 space-y-3">
                  <h3 className="font-display text-2xl font-normal text-warm-800">
                    {item.title}
                  </h3>
                  <p className="text-warm-500 leading-relaxed">
                    {item.description}
                  </p>
                  <a
                    href="#contact"
                    className="polish-link inline-block text-sm font-medium text-sage-600 hover:text-sage-500">
                    {item.ctaLabel}
                  </a>
                  <a
                    href={`/reservation?service=${item.id}`}
                    className="ml-5 inline-block text-sm font-medium text-warm-800 underline decoration-sage-300 underline-offset-4 transition-colors hover:text-sage-600">
                    Réserver →
                  </a>
                </div>
              </GlassCard>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProcessSection({
  content,
  disableRevealAnimations = false,
}: {
  content: ProcessContent;
  disableRevealAnimations?: boolean;
}) {
  return (
    <section
      id="parcours"
      data-preview-section="site-section-process"
      className="site-section-process relative z-10 py-16 md:py-32 px-4 md:px-6 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-sage-100/60 via-sage-100/80 to-sage-100/50 pointer-events-none" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-warm-300/60 to-transparent" />
      <div
        className="ambient-shape absolute top-[20%] left-[15%] w-[450px] h-[450px] rounded-full bg-sage-300/50 blur-[90px] pointer-events-none"
        style={{ animationDelay: "-5s" }}
      />
      <div className="process-light absolute inset-0 pointer-events-none" aria-hidden="true" />

      <div className="relative z-10 max-w-6xl mx-auto">
        <Reveal className="mb-16 max-w-xl" disabled={disableRevealAnimations}>
          <div className="w-10 h-px bg-sage-400/60 mb-6" />
          <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-light text-warm-800">
            {content.title}
          </h2>
        </Reveal>
        <Reveal
          className="process-track relative grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 sm:gap-10 lg:gap-8"
          disabled={disableRevealAnimations}>
          <div className="process-line" aria-hidden="true" />
          {content.steps.map((step, index) => (
            <div
              key={step.id}
              className="process-step space-y-5"
              style={{ "--step-index": index } as CSSProperties}>
              <span className="process-number font-display text-5xl font-light">
                {step.number}
              </span>
              <h3 className="text-lg font-medium text-warm-800">
                {step.title}
              </h3>
              <p className="text-sm text-warm-500 leading-relaxed">
                {step.description}
              </p>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

function AboutSection({
  content,
  disableRevealAnimations = false,
}: {
  content: AboutContent;
  disableRevealAnimations?: boolean;
}) {
  return (
    <section
      id="a-propos"
      data-preview-section="site-section-about"
      className="site-section-about relative z-10 py-16 md:py-32 px-4 md:px-6 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-sage-100/50 via-warm-200/60 to-warm-100/40 pointer-events-none" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-warm-300/60 to-transparent" />
      <div
        className="ambient-drift absolute bottom-[10%] right-[5%] w-[450px] h-[450px] rounded-full bg-sage-300/45 blur-[90px] pointer-events-none"
        style={{ animationDelay: "-7s" }}
      />

      <div className="relative z-10 max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-5 gap-12 md:gap-16 items-start">
        <Reveal className="about-media md:col-span-2 relative" disabled={disableRevealAnimations}>
          <div className="about-media-light absolute -inset-20 pointer-events-none" aria-hidden="true" />
          <div className="absolute -inset-6 bg-gradient-to-br from-sage-300/35 to-mist-200/30 rounded-[2rem] blur-xl pointer-events-none" />
          <div className="about-media-frame absolute -inset-3 rounded-[1.4rem] pointer-events-none" aria-hidden="true" />
          <div className="about-media-surface polish-surface polish-card group relative aspect-[3/4] rounded-2xl overflow-hidden bg-gradient-to-br from-sage-200 via-mist-100 to-warm-200 border border-white/40">
            <EditorialImage
              src={content.portrait.src}
              alt={content.portrait.alt}
              surface="about"
              className="polish-media absolute inset-0 h-full w-full object-cover"
              fallback={
                <EditorialFallback
                  motif="portrait"
                  label={content.portrait.alt}
                  tone={2}
                />
              }
            />
            <div className="polish-media-veil" aria-hidden="true" />
          </div>
        </Reveal>
        <Reveal
          className="about-copy md:col-span-3 space-y-6 md:pt-4"
          delay={120}
          disabled={disableRevealAnimations}>
          <div className="about-rule w-10 h-px" />
          <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-light text-warm-800">
            {content.title}
          </h2>
          <div className="space-y-5 pt-2">
            {content.paragraphs.map((paragraph) => (
              <p key={paragraph} className="text-warm-500 leading-[1.8]">
                {paragraph}
              </p>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function ContactSection({
  content,
  disableRevealAnimations = false,
}: {
  content: ContactContent;
  disableRevealAnimations?: boolean;
}) {
  return (
    <section
      id="contact"
      data-preview-section="site-section-contact"
      className="site-section-contact relative z-10 py-16 md:py-32 px-4 md:px-6 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-sage-100/60 via-mist-100/50 to-warm-200/50 pointer-events-none" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sage-300/50 to-transparent" />
      <div className="ambient-shape absolute top-[5%] left-[10%] w-[500px] h-[500px] rounded-full bg-sage-300/55 blur-[100px] pointer-events-none" />
      <div
        className="ambient-drift absolute bottom-[5%] right-[5%] w-[450px] h-[450px] rounded-full bg-mist-300/45 blur-[90px] pointer-events-none"
        style={{ animationDelay: "-14s" }}
      />

      <Reveal
        className="relative z-10 max-w-2xl mx-auto"
        disabled={disableRevealAnimations}>
        <div className="polish-cta-halo absolute -inset-x-16 -inset-y-12 sm:-inset-x-24 sm:-inset-y-16 pointer-events-none" aria-hidden="true" />
        <GlassCard
          hover={false}
          className="polish-cta p-6 sm:p-10 md:p-16 text-center space-y-6 sm:space-y-8 rounded-3xl">
          <div className="w-10 h-px bg-sage-400/60 mx-auto" />
          <h2 className="font-display text-2xl sm:text-3xl md:text-[2.75rem] font-light leading-tight text-warm-800">
            {content.title}
          </h2>
          <p className="text-warm-500 leading-relaxed max-w-md mx-auto">
            {content.description}
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center pt-2">
            <a
              href={content.instagramCta.href}
              target="_blank"
              rel="noopener noreferrer"
              className="polish-btn-primary inline-flex items-center justify-center px-7 py-3.5 bg-warm-800 text-porcelain font-medium rounded-full">
              {content.instagramCta.label}
            </a>
            <a
              href={content.emailCta.href}
              className="polish-btn-secondary inline-flex items-center justify-center px-7 py-3.5 bg-white/50 backdrop-blur-sm border border-white/60 text-warm-600 font-medium rounded-full">
              {content.emailCta.label}
            </a>
          </div>
        </GlassCard>
      </Reveal>
    </section>
  );
}

function AtmosphericLayer() {
  return (
    <div
      className="fixed inset-0 z-0 pointer-events-none overflow-hidden"
      aria-hidden="true">
      <div className="ambient-shape absolute top-[5%] left-[-5%] w-[700px] h-[700px] rounded-full bg-sage-300/60 blur-[120px]" />
      <div
        className="ambient-drift absolute top-[50%] right-[-8%] w-[600px] h-[600px] rounded-full bg-mist-300/50 blur-[110px]"
        style={{ animationDelay: "-10s" }}
      />
      <div
        className="ambient-shape absolute bottom-[10%] left-[20%] w-[500px] h-[500px] rounded-full bg-warm-300/55 blur-[100px]"
        style={{ animationDelay: "-18s" }}
      />
      <div
        className="ambient-drift absolute top-[25%] left-[50%] w-[400px] h-[400px] rounded-full bg-sage-200/50 blur-[100px]"
        style={{ animationDelay: "-6s" }}
      />
    </div>
  );
}

/**
 * Where the `--site-*` custom properties come from.
 *
 * `element` writes them as an inline style on this wrapper. That is what the
 * admin preview needs: it re-renders on every keystroke, and the palette has to
 * follow the editor's state immediately.
 *
 * `document` writes nothing, leaving the properties to the
 * `<style id="__ESZTER_APPEARANCE__">` block in `<head>`. That is what the public
 * page needs, and the difference is not cosmetic. PHP injects that block, so the
 * published palette is already correct when the first pixel is painted — before
 * React has run at all. An inline style here would override it with whatever the
 * hydration pass believes the appearance to be, which is the *default* palette,
 * producing exactly the flash of wrong colour the injection exists to avoid.
 */
export type AppearanceSource = "element" | "document";

export function SitePreview({
  content,
  disableRevealAnimations = false,
  appearanceSource = "element",
}: {
  content: SiteContent;
  disableRevealAnimations?: boolean;
  appearanceSource?: AppearanceSource;
}) {
  return (
    <div
      className="site-preview flex flex-col min-h-screen relative"
      style={
        appearanceSource === "element"
          ? createSiteAppearanceVariables(content.appearance)
          : undefined
      }>
      <a href="#main-content" className="skip-link">
        Aller au contenu principal
      </a>
      <AtmosphericLayer />
      <Navigation content={content.navigation} />
      <main id="main-content" tabIndex={-1}>
        <HeroSection content={content.hero} />
        <ReassuranceSection
          content={content.reassurance}
          disableRevealAnimations={disableRevealAnimations}
        />
        <ServicesSection
          content={content.services}
          disableRevealAnimations={disableRevealAnimations}
        />
        <ProcessSection
          content={content.process}
          disableRevealAnimations={disableRevealAnimations}
        />
        <GallerySection
          content={content.gallery}
          disableRevealAnimations={disableRevealAnimations}
        />
        <AboutSection
          content={content.about}
          disableRevealAnimations={disableRevealAnimations}
        />
        <ContactSection
          content={content.contact}
          disableRevealAnimations={disableRevealAnimations}
        />
      </main>
      <SiteFooter content={content.footer} />
    </div>
  );
}
