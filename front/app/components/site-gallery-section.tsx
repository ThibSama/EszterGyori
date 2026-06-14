import { Reveal } from "./reveal";
import type { GalleryContent, GalleryItemContent } from "../types/site-content";

function GalleryVisual({ item }: { item: GalleryItemContent }) {
  if (item.visualKind === "beforeAfterBrows") {
    return (
      <>
        <div className="flex gap-8 items-center relative z-10 transition-transform duration-700 group-hover:scale-[1.03]">
          <div className="w-16 h-10 border-b-[1.5px] border-sage-400/45 rounded-b-[50%]" />
          <div className="w-px h-6 bg-warm-400/50" />
          <div className="w-16 h-10 border-b-[1.5px] border-sage-400/50 rounded-b-[50%]" />
        </div>
        <div className="absolute bottom-4 left-4 text-[11px] tracking-wide uppercase text-warm-500/80">
          {item.label}
        </div>
      </>
    );
  }

  if (item.visualKind === "healedBrows") {
    return (
      <>
        <div className="w-20 h-8 border-b-[1.5px] border-sage-400/45 rounded-b-[48%] relative z-10 transition-transform duration-700 group-hover:scale-[1.03]" />
        <div className="absolute bottom-4 left-4 text-[11px] tracking-wide uppercase text-warm-500/80">
          {item.label}
        </div>
      </>
    );
  }

  if (item.visualKind === "eyeliner") {
    return (
      <>
        <div className="w-24 h-px bg-gradient-to-r from-transparent via-sage-400/50 to-transparent rotate-[-6deg] relative z-10 transition-transform duration-700 group-hover:scale-[1.03]" />
        <div className="absolute bottom-4 left-4 text-[11px] tracking-wide uppercase text-warm-500/80">
          {item.label}
        </div>
      </>
    );
  }

  if (item.visualKind === "lips") {
    return (
      <>
        <div className="relative w-12 h-8 z-10 transition-transform duration-700 group-hover:scale-[1.03]">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-4 rounded-t-full border-t-[1.5px] border-x-[1.5px] border-warm-400/40" />
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-10 h-4 rounded-b-full border-b-[1.5px] border-x-[1.5px] border-warm-400/40" />
        </div>
        <div className="absolute bottom-4 left-4 text-[11px] tracking-wide uppercase text-warm-500/80">
          {item.label}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="relative w-16 h-16 z-10 transition-transform duration-700 group-hover:scale-[1.03]">
        <div className="absolute top-1 left-3 w-2 h-2 rounded-full bg-warm-500/38" />
        <div className="absolute top-4 left-8 w-1.5 h-1.5 rounded-full bg-warm-400/32" />
        <div className="absolute top-7 left-1 w-1.5 h-1.5 rounded-full bg-warm-500/38" />
        <div className="absolute top-10 left-6 w-2 h-2 rounded-full bg-warm-400/35" />
        <div className="absolute top-6 left-12 w-1 h-1 rounded-full bg-warm-500/30" />
      </div>
      <div className="absolute bottom-4 left-4 text-[11px] tracking-wide uppercase text-warm-500/80">
        {item.label}
      </div>
    </>
  );
}

function GalleryCard({ item }: { item: GalleryItemContent }) {
  const containerClass = item.featured
    ? "rounded-2xl overflow-hidden bg-gradient-to-br from-sage-200 via-mist-100 to-warm-200 border border-white/40 shadow-[0_4px_24px_rgba(0,0,0,0.05)] group transition-shadow duration-500 hover:shadow-[0_8px_32px_rgba(0,0,0,0.08)]"
    : item.visualKind === "healedBrows"
      ? "rounded-2xl overflow-hidden bg-gradient-to-br from-warm-200 via-sage-100 to-mist-100 border border-white/40 shadow-[0_4px_24px_rgba(0,0,0,0.05)] group transition-shadow duration-500 hover:shadow-[0_8px_32px_rgba(0,0,0,0.08)]"
      : item.visualKind === "eyeliner"
        ? "rounded-2xl overflow-hidden bg-gradient-to-br from-mist-200 via-sage-100 to-warm-100 border border-white/40 shadow-[0_4px_24px_rgba(0,0,0,0.05)] group transition-shadow duration-500 hover:shadow-[0_8px_32px_rgba(0,0,0,0.08)]"
        : item.visualKind === "lips"
          ? "rounded-2xl overflow-hidden bg-gradient-to-br from-warm-300/70 via-mist-100 to-sage-100 border border-white/40 shadow-[0_4px_24px_rgba(0,0,0,0.05)] group transition-shadow duration-500 hover:shadow-[0_8px_32px_rgba(0,0,0,0.08)]"
          : "rounded-2xl overflow-hidden bg-gradient-to-br from-sage-200/80 via-warm-200 to-mist-100 border border-white/40 shadow-[0_4px_24px_rgba(0,0,0,0.05)] group transition-shadow duration-500 hover:shadow-[0_8px_32px_rgba(0,0,0,0.08)]";

  return (
    <div className={containerClass}>
      <div
        className={`${item.featured ? "aspect-[16/9]" : "aspect-square"} flex items-center justify-center relative overflow-hidden`}>
        <div className="absolute inset-0 bg-gradient-to-t from-white/15 to-transparent" />
        <GalleryVisual item={item} />
      </div>
      <div className="px-5 py-4">
        <p className="text-sm font-medium text-warm-600">{item.caption}</p>
      </div>
    </div>
  );
}

export function GallerySection({
  content,
  disableRevealAnimations = false,
}: {
  content: GalleryContent;
  disableRevealAnimations?: boolean;
}) {
  const delays = [0, 100, 200, 250, 300];

  return (
    <section
      id="realisations"
      className="site-section-gallery relative z-10 py-16 md:py-32 px-4 md:px-6 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-warm-50/0 via-warm-200/60 to-warm-50/0 pointer-events-none" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sage-300/50 to-transparent" />
      <div className="ambient-drift absolute top-[5%] right-[5%] w-[500px] h-[500px] rounded-full bg-mist-300/50 blur-[100px] pointer-events-none" />
      <div
        className="ambient-shape absolute bottom-[5%] left-[8%] w-[400px] h-[400px] rounded-full bg-sage-200/55 blur-[90px] pointer-events-none"
        style={{ animationDelay: "-10s" }}
      />

      <div className="relative z-10 max-w-6xl mx-auto">
        <Reveal className="mb-16 max-w-xl" disabled={disableRevealAnimations}>
          <div className="w-10 h-px bg-sage-400/60 mb-6" />
          <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-light text-warm-800">
            {content.title}
          </h2>
        </Reveal>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4 md:gap-6">
          {content.items.map((item, index) => (
            <Reveal
              key={item.id}
              className={item.featured ? "col-span-2" : undefined}
              delay={delays[index] ?? 0}
              disabled={disableRevealAnimations}>
              <GalleryCard item={item} />
            </Reveal>
          ))}
        </div>

        <Reveal
          className="mt-14 flex justify-center"
          disabled={disableRevealAnimations}>
          <a
            href={content.instagramCta.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 px-7 py-3.5 bg-white/50 backdrop-blur-sm border border-white/60 text-warm-600 font-medium rounded-full hover:bg-white/70 hover:border-white/80 transition-all duration-300 hover:shadow-[0_4px_16px_rgba(0,0,0,0.04)]">
            {content.instagramCta.label}
          </a>
        </Reveal>
      </div>
    </section>
  );
}