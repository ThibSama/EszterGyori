import { useState } from "react";
import type { MediaAsset } from "../../types/site-content";
import { Field, ReadOnlyId } from "./editor-fields";

function normalizeOptionalSource(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPreviewableImageSource(source: string): boolean {
  const trimmed = source.trim();

  if (trimmed.startsWith("/")) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function MediaEditor({
  idPrefix,
  media,
  onChange,
}: {
  idPrefix: string;
  media: MediaAsset;
  onChange: (media: MediaAsset) => void;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = media.src ?? "";
  const hasSource = source.trim().length > 0;
  const canPreview =
    hasSource && isPreviewableImageSource(source) && failedSource !== source;

  return (
    <div className="space-y-3 rounded-xl border border-sage-200/80 bg-sage-50/70 p-4">
      <ReadOnlyId label="ID média" value={media.id} />
      <Field
        id={`${idPrefix}-src`}
        label="Source de l'image"
        value={source}
        placeholder="Ex. /images/portrait.jpg"
        onChange={(value) => {
          setFailedSource(null);
          onChange({ ...media, src: normalizeOptionalSource(value) });
        }}
        help="Saisir une URL ou un chemin public. Les vrais uploads seront ajoutés plus tard avec le backend."
      />
      <Field
        id={`${idPrefix}-alt`}
        label="Texte alternatif"
        value={media.alt}
        placeholder="Ex. Portrait professionnel"
        onChange={(value) => onChange({ ...media, alt: value })}
      />
      <div className="overflow-hidden rounded-lg border border-warm-200 bg-white/70">
        {canPreview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={source}
            alt={media.alt}
            onError={() => setFailedSource(source)}
            className="h-36 w-full object-cover"
          />
        ) : (
          <div className="flex h-28 items-center justify-center px-4 text-center text-sm text-warm-500">
            {hasSource
              ? "Aperçu indisponible : saisir une URL http(s) valide ou un chemin public commençant par /."
              : "Aucune source renseignée. Le site public conserve son placeholder actuel."}
          </div>
        )}
      </div>
    </div>
  );
}
