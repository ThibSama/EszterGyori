import type { ReactNode } from "react";

/**
 * The photo-neutral editorial surface shown wherever a real photograph is not
 * published yet (Package 10.4).
 *
 * It fills the exact media surface the future `<img>` will occupy — the caller
 * passes it as the `fallback` of {@link EditorialImage}, whose wrapper is
 * `absolute inset-0` — so a real photo replaces it without any layout change.
 * The material is CSS: layered mocha/taupe/sage gradients, a soft light
 * falloff and a faint grain (`.media-fallback` in `globals.css`), all resolved
 * from the `--site-*` palette. The only markup is a thin abstract contour and
 * the understated label, which is deliberately not an illustration of a
 * treatment or a result.
 */
export type EditorialFallbackMotif =
  | "brows"
  | "eyeliner"
  | "lips"
  | "freckles"
  | "beforeAfterBrows"
  | "healedBrows"
  | "portrait";

const MOTIFS: Record<EditorialFallbackMotif, ReactNode> = {
  brows: (
    <>
      <path d="M38 114 C 64 82, 122 74, 166 104" />
      <path d="M46 124 C 72 102, 122 96, 158 116" opacity="0.4" />
    </>
  ),
  eyeliner: (
    <>
      <path d="M30 122 C 78 100, 130 94, 176 82" />
      <path d="M150 90 C 160 92, 168 90, 176 82" opacity="0.55" />
    </>
  ),
  lips: (
    <>
      <path d="M56 100 C 76 84, 92 86, 100 96 C 108 86, 124 84, 144 100" />
      <path d="M56 100 C 80 128, 120 128, 144 100" />
    </>
  ),
  freckles: (
    <g fill="currentColor" stroke="none">
      <circle cx="74" cy="82" r="2" />
      <circle cx="96" cy="72" r="1.5" />
      <circle cx="118" cy="86" r="1.7" />
      <circle cx="86" cy="104" r="1.4" />
      <circle cx="108" cy="112" r="2" />
      <circle cx="132" cy="106" r="1.3" />
      <circle cx="66" cy="120" r="1.5" />
    </g>
  ),
  beforeAfterBrows: (
    <>
      <path d="M26 112 C 46 88, 76 86, 92 106" />
      <path d="M100 84 V 124" opacity="0.45" />
      <path d="M108 106 C 124 84, 154 84, 174 110" />
    </>
  ),
  healedBrows: (
    <>
      <path d="M40 110 C 68 78, 132 78, 160 106" />
      <path d="M52 118 C 76 100, 124 98, 150 114" opacity="0.35" />
    </>
  ),
  portrait: (
    <>
      <circle cx="112" cy="78" r="44" opacity="0.55" />
      <path d="M28 156 C 70 132, 130 132, 172 158" opacity="0.7" />
    </>
  ),
};

export function EditorialFallback({
  motif,
  label,
  tone = 0,
  className = "",
}: {
  motif: EditorialFallbackMotif;
  label: string;
  /** Rotates the light and gradient composition so neighbouring cards differ. */
  tone?: number;
  className?: string;
}) {
  return (
    <div className={`media-fallback media-fallback-tone-${tone % 4} ${className}`}>
      <svg
        aria-hidden="true"
        viewBox="0 0 200 200"
        preserveAspectRatio="xMidYMid meet"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="media-fallback-motif">
        {MOTIFS[motif]}
      </svg>
      <span className="media-fallback-label">{label}</span>
    </div>
  );
}
