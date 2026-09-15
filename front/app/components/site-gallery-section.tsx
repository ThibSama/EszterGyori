import { Reveal } from "./reveal";
import { EditorialImage } from "./editorial-image";
import { EditorialFallback } from "./editorial-fallback";
import type { GalleryContent, GalleryItemContent } from "../types/site-content";

function GalleryCard({ item, index }: { item: GalleryItemContent; index: number }) {
  const baseByKind: Record<GalleryItemContent["visualKind"], string> = {
    beforeAfterBrows: "bg-gradient-to-br from-sage-200 via-mist-100 to-warm-200",
    healedBrows: "bg-gradient-to-br from-warm-200 via-sage-100 to-mist-100",
    eyeliner: "bg-gradient-to-br from-mist-200 via-sage-100 to-warm-100",
    lips: "bg-gradient-to-br from-warm-300/70 via-mist-100 to-sage-100",
    freckles: "bg-gradient-to-br from-sage-200/80 via-warm-200 to-mist-100",
  };

  return (
    <div
      className={`polish-surface polish-card group rounded-2xl overflow-hidden border border-white/40 ${baseByKind[item.visualKind]}`}>
      <div
        className={`${item.featured ? "aspect-[16/9]" : "aspect-square"} relative overflow-hidden`}>
        <EditorialImage
          src={item.visual.src}
          alt={item.visual.alt}
          surface={`gallery-${item.id}`}
          className="polish-media absolute inset-0 h-full w-full object-cover"
          fallback={
            <EditorialFallback
              motif={item.visualKind}
              label={item.label}
              tone={index}
            />
          }
        />
        <div className="polish-media-veil" aria-hidden="true" />
      </div>
      <div className="px-5 py-4">
        <p className="polish-caption text-sm font-medium text-warm-600">{item.caption}</p>
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
  return (
    <section
      id="realisations"
      data-preview-section="site-section-gallery"
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
              delay={index * 70}
              disabled={disableRevealAnimations}>
              <GalleryCard item={item} index={index} />
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
            className="polish-btn-secondary inline-flex items-center justify-center gap-2 px-7 py-3.5 bg-white/50 backdrop-blur-sm border border-white/60 text-warm-600 font-medium rounded-full">
            {content.instagramCta.label}
          </a>
        </Reveal>
      </div>
    </section>
  );
}
