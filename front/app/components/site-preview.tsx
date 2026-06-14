import { HeroInstagramButton } from "./hero-instagram-button";
import { GallerySection } from "./site-gallery-section";
import { Navigation } from "./navigation";
import { Reveal } from "./reveal";
import { createSiteAppearanceVariables } from "../lib/site-appearance";
import type {
  AboutContent,
  ContactContent,
  FooterContent,
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
      className={`glass-card bg-white/40 backdrop-blur-2xl border border-white/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_4px_24px_rgba(0,0,0,0.05)] rounded-2xl ${
        hover
          ? "transition-all duration-500 ease-out hover:-translate-y-1 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_16px_48px_rgba(0,0,0,0.08)] hover:border-white/70"
          : ""
      } ${className}`}>
      {children}
    </div>
  );
}

function HeroSection({ content }: { content: HeroContent }) {
  return (
    <section className="site-section-hero relative z-10 min-h-svh md:min-h-[90vh] flex items-center pt-20 md:pt-24 pb-12 md:pb-16 px-4 md:px-6 overflow-hidden">
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
            <em className="italic">{content.title.emphasized}</em>
            {content.title.suffix}
          </h1>
          <p className="hero-entrance-delayed-2 text-base md:text-lg text-warm-500 leading-relaxed max-w-md">
            {content.description}
          </p>
          <div className="hero-entrance-delayed-3 flex flex-col sm:flex-row flex-wrap gap-3 sm:gap-4 pt-2">
            <a
              href={content.primaryCta.href}
              className="inline-flex items-center justify-center px-7 py-3 sm:py-3.5 bg-warm-800 text-porcelain font-medium rounded-full hover:bg-warm-700 transition-all duration-300 hover:shadow-[0_8px_24px_rgba(44,43,40,0.2)] hover:scale-[1.02] active:scale-[0.98]">
              {content.primaryCta.label}
            </a>
            <a
              href={content.secondaryCta.href}
              className="inline-flex items-center justify-center px-7 py-3 sm:py-3.5 bg-white/50 backdrop-blur-sm border border-white/60 text-warm-600 font-medium rounded-full hover:bg-white/70 hover:border-white/80 transition-all duration-300 hover:shadow-[0_4px_16px_rgba(0,0,0,0.04)]">
              {content.secondaryCta.label}
            </a>
          </div>
        </div>

        <div className="hero-entrance-delayed-2 relative aspect-[3/4] max-w-md mx-auto md:mx-0">
          <div className="absolute -inset-8 bg-gradient-to-br from-sage-300/50 via-mist-200/60 to-warm-300/40 rounded-[3rem] blur-2xl pointer-events-none" />
          <div className="relative h-full rounded-3xl overflow-hidden bg-gradient-to-br from-sage-200 via-mist-100 to-warm-200 border border-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_12px_48px_rgba(0,0,0,0.06)]">
            <div className="absolute inset-0 bg-gradient-to-t from-white/30 via-transparent to-white/10" />
            <div className="absolute inset-0 bg-gradient-to-br from-sage-300/25 via-transparent to-mist-200/20" />
            <div className="relative h-full flex flex-col items-center justify-center p-10">
              <div className="w-32 h-12 mb-5 border-b-[1.5px] border-sage-400/50 rounded-b-[55%]" />
              <div className="flex gap-3 mb-6">
                <div className="w-2 h-2 rounded-full bg-sage-400/45" />
                <div className="w-1.5 h-1.5 rounded-full bg-sage-400/35" />
                <div className="w-1 h-1 rounded-full bg-sage-400/40" />
                <div className="w-1.5 h-1.5 rounded-full bg-sage-400/35" />
                <div className="w-2 h-2 rounded-full bg-sage-400/45" />
              </div>
              <p className="text-sm text-warm-500 text-center leading-relaxed max-w-[200px]">
                {content.visual.alt}
              </p>
            </div>
            <HeroInstagramButton ariaLabel={content.instagramAriaLabel} />
            <div
              className="float-gentle absolute top-5 right-5 bg-white/55 backdrop-blur-md border border-white/45 rounded-xl px-3 py-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.04)]"
              style={{ animationDelay: "-3s" }}>
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
    <section className="site-section-reassurance relative z-10 py-16 md:py-32 px-4 md:px-6">
      <div className="absolute inset-0 bg-gradient-to-b from-warm-50/0 via-sage-100/70 to-warm-50/0 pointer-events-none" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-warm-300/60 to-transparent" />

      <Reveal
        className="relative z-10 max-w-5xl mx-auto"
        disabled={disableRevealAnimations}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-16 gap-y-14">
          {content.items.map((item, index) => (
            <Reveal
              key={item.id}
              className="space-y-4"
              delay={index * 100}
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

function ServiceVisual({ item }: { item: ServiceItemContent }) {
  const visualClassByKind: Record<ServiceVisualKind, string> = {
    brows: "bg-gradient-to-br from-sage-200 via-mist-100 to-warm-200",
    eyeliner: "bg-gradient-to-br from-mist-200 via-sage-100 to-warm-200",
    lips: "bg-gradient-to-br from-warm-300/80 via-mist-100 to-sage-100",
    freckles: "bg-gradient-to-br from-warm-200 via-warm-300/60 to-sage-200",
  };

  return (
    <div
      className={`aspect-[5/3] ${visualClassByKind[item.visualKind]} relative overflow-hidden flex items-center justify-center transition-transform duration-700 group-hover:scale-[1.02]`}>
      <div className="absolute inset-0 bg-gradient-to-t from-white/20 to-transparent" />
      {item.visualKind === "brows" && (
        <div className="w-32 h-12 border-b-[1.5px] border-sage-400/50 rounded-b-[55%] relative z-10" />
      )}
      {item.visualKind === "eyeliner" && (
        <div className="w-28 h-px bg-gradient-to-r from-transparent via-sage-400/50 to-transparent rotate-[-8deg] relative z-10" />
      )}
      {item.visualKind === "lips" && (
        <div className="relative w-14 h-9 z-10">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-9 h-[18px] rounded-t-full border-t-[1.5px] border-x-[1.5px] border-warm-400/45" />
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-11 h-[18px] rounded-b-full border-b-[1.5px] border-x-[1.5px] border-warm-400/45" />
        </div>
      )}
      {item.visualKind === "freckles" && (
        <div className="relative w-20 h-20 z-10">
          <div className="absolute top-2 left-5 w-2 h-2 rounded-full bg-warm-500/40" />
          <div className="absolute top-6 left-1 w-1.5 h-1.5 rounded-full bg-warm-400/35" />
          <div className="absolute top-4 left-10 w-1.5 h-1.5 rounded-full bg-warm-500/38" />
          <div className="absolute top-10 left-4 w-2 h-2 rounded-full bg-warm-400/42" />
          <div className="absolute top-8 left-12 w-1 h-1 rounded-full bg-warm-500/32" />
          <div className="absolute top-14 left-8 w-1.5 h-1.5 rounded-full bg-warm-400/38" />
          <div className="absolute top-12 left-14 w-2 h-2 rounded-full bg-warm-500/40" />
        </div>
      )}
      <div className="absolute bottom-3 left-3 text-[11px] tracking-wide uppercase text-warm-500/80 relative z-10">
        {item.visual.alt}
      </div>
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
            <Reveal key={item.id} delay={index * 100} disabled={disableRevealAnimations}>
              <GlassCard className="overflow-hidden group">
                <ServiceVisual item={item} />
                <div className="p-7 space-y-3">
                  <h3 className="font-display text-2xl font-normal text-warm-800">
                    {item.title}
                  </h3>
                  <p className="text-warm-500 leading-relaxed">
                    {item.description}
                  </p>
                  <a
                    href="#contact"
                    className="inline-block text-sm font-medium text-sage-600 hover:text-sage-500 transition-colors duration-300 group-hover:translate-x-1 transition-transform">
                    {item.ctaLabel}
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
      className="site-section-process relative z-10 py-16 md:py-32 px-4 md:px-6 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-sage-100/60 via-sage-100/80 to-sage-100/50 pointer-events-none" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-warm-300/60 to-transparent" />
      <div
        className="ambient-shape absolute top-[20%] left-[15%] w-[450px] h-[450px] rounded-full bg-sage-300/50 blur-[90px] pointer-events-none"
        style={{ animationDelay: "-5s" }}
      />

      <div className="relative z-10 max-w-6xl mx-auto">
        <Reveal className="mb-16 max-w-xl" disabled={disableRevealAnimations}>
          <div className="w-10 h-px bg-sage-400/60 mb-6" />
          <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-light text-warm-800">
            {content.title}
          </h2>
        </Reveal>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 sm:gap-10 lg:gap-8">
          {content.steps.map((step, index) => (
            <Reveal
              key={step.id}
              className="space-y-5"
              delay={index * 100}
              disabled={disableRevealAnimations}>
              <span className="font-display text-5xl font-light text-sage-300/80">
                {step.number}
              </span>
              <h3 className="text-lg font-medium text-warm-800">
                {step.title}
              </h3>
              <p className="text-sm text-warm-500 leading-relaxed">
                {step.description}
              </p>
            </Reveal>
          ))}
        </div>
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
      className="site-section-about relative z-10 py-16 md:py-32 px-4 md:px-6 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-sage-100/50 via-warm-200/60 to-warm-100/40 pointer-events-none" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-warm-300/60 to-transparent" />
      <div
        className="ambient-drift absolute bottom-[10%] right-[5%] w-[450px] h-[450px] rounded-full bg-sage-300/45 blur-[90px] pointer-events-none"
        style={{ animationDelay: "-7s" }}
      />

      <Reveal
        className="relative z-10 max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-5 gap-12 md:gap-16 items-start"
        disabled={disableRevealAnimations}>
        <div className="md:col-span-2 relative">
          <div className="absolute -inset-6 bg-gradient-to-br from-sage-300/35 to-mist-200/30 rounded-[2rem] blur-xl pointer-events-none" />
          <div className="relative aspect-[3/4] rounded-2xl overflow-hidden bg-gradient-to-br from-sage-200 via-mist-100 to-warm-200 border border-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_12px_40px_rgba(0,0,0,0.06)] flex items-center justify-center p-8 group transition-shadow duration-500 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_16px_48px_rgba(0,0,0,0.08)]">
            <div className="absolute inset-0 bg-gradient-to-t from-white/20 via-transparent to-white/10" />
            <p className="text-sm text-warm-500 text-center leading-relaxed relative z-10">
              {content.portrait.alt}
            </p>
          </div>
        </div>
        <div className="md:col-span-3 space-y-6 md:pt-4">
          <div className="w-10 h-px bg-sage-400/60" />
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
        </div>
      </Reveal>
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
        <GlassCard
          hover={false}
          className="p-6 sm:p-10 md:p-16 text-center space-y-6 sm:space-y-8 rounded-3xl">
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
              className="inline-flex items-center justify-center px-7 py-3.5 bg-warm-800 text-porcelain font-medium rounded-full hover:bg-warm-700 transition-all duration-300 hover:shadow-[0_8px_24px_rgba(44,43,40,0.2)] hover:scale-[1.02] active:scale-[0.98]">
              {content.instagramCta.label}
            </a>
            <a
              href={content.emailCta.href}
              className="inline-flex items-center justify-center px-7 py-3.5 bg-white/50 backdrop-blur-sm border border-white/60 text-warm-600 font-medium rounded-full hover:bg-white/70 hover:border-white/80 transition-all duration-300 hover:shadow-[0_4px_16px_rgba(0,0,0,0.04)]">
              {content.emailCta.label}
            </a>
          </div>
        </GlassCard>
      </Reveal>
    </section>
  );
}

function Footer({ content }: { content: FooterContent }) {
  return (
    <footer className="site-section-footer relative z-10 border-t border-warm-300/50 py-8 md:py-10 px-4 md:px-6 bg-gradient-to-b from-warm-100/60 to-warm-200/40">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
        <p className="text-sm text-warm-400">
          &copy; {new Date().getFullYear()} {content.copyrightName}.{" "}
          {content.copyrightSuffix}
        </p>
        <div className="flex gap-6 text-sm text-warm-400">
          {content.links.map((link) => (
            <a
              key={link.id}
              href={link.href}
              target={link.href.startsWith("http") ? "_blank" : undefined}
              rel={
                link.href.startsWith("http") ? "noopener noreferrer" : undefined
              }
              className="hover:text-warm-600 transition-colors duration-300">
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </footer>
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

export function SitePreview({
  content,
  disableRevealAnimations = false,
}: {
  content: SiteContent;
  disableRevealAnimations?: boolean;
}) {
  return (
    <div
      className="site-preview flex flex-col min-h-screen relative"
      style={createSiteAppearanceVariables(content.appearance)}>
      <AtmosphericLayer />
      <Navigation content={content.navigation} />
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
      <Footer content={content.footer} />
    </div>
  );
}
