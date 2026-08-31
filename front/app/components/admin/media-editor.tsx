import { useId, useRef, useState } from "react";
import {
  MEDIA_UPLOAD_LIMIT_BYTES,
  mediaMimeTypes,
  type MediaAssetMetadata,
} from "@eszter/contracts";
import type { MediaAsset } from "../../types/site-content";
import {
  MEDIA_LIBRARY_MESSAGES,
  canDelete,
  formatMediaDimensions,
  formatMediaSize,
  isManagedMediaPath,
} from "../../lib/admin-media";
import { Field, ReadOnlyId } from "./editor-fields";
import { useMediaLibrary } from "./media-library-provider";

/**
 * One media field: the source, the alt text, a preview, and the library (ESZ-037).
 *
 * ## Selecting is an ordinary edit
 *
 * Choosing an asset calls `onChange` with `src` set to the asset's public path,
 * exactly as typing a path by hand would. It goes into the working draft through
 * the same `onChange` → editor state → `PUT /api/admin/content/draft` route every
 * other field uses, and nothing is saved until the admin saves. That is what
 * "never create another content authority" means in practice: the library knows
 * which files exist, the draft knows which are used, and the second of those is
 * only ever written by the draft workflow.
 *
 * The manual field stays. It is how an external URL is set, it is the fallback
 * when the library cannot be read, and removing it would make an unreachable
 * `GET /api/admin/media` into an editor that cannot set an image at all.
 *
 * ## Clearing a field deletes nothing
 *
 * Emptying the source, or picking a different asset, leaves the previous file in
 * the library. `media.contentEditsNeverDeleteAssets` — reference-counting on save
 * is how one mistaken edit becomes unrecoverable, and this is a CMS where the
 * same photograph is pointed at and unpointed while a page is arranged.
 */

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

const ACCEPTED_FILE_TYPES = mediaMimeTypes.join(",");

function MediaLibraryPanel({
  idPrefix,
  selected,
  onSelect,
}: {
  idPrefix: string;
  selected: string | null;
  onSelect: (asset: MediaAssetMetadata) => void;
}) {
  const library = useMediaLibrary();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const panelId = useId();

  // Rendered without a library only in a preview or a story: the editor always
  // has the provider above it. Returning null rather than throwing keeps
  // `MediaEditor` usable in isolation.
  if (library === null) return null;

  const { state, ensureLoaded, upload, requestDelete, cancelDelete, confirmDelete, usagesOf } =
    library;

  function toggle() {
    setOpen((wasOpen) => {
      if (!wasOpen) ensureLoaded();
      return !wasOpen;
    });
  }

  async function onFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset immediately so choosing the same file twice fires `change` again —
    // otherwise a failed upload cannot be retried without picking another file.
    event.target.value = "";

    if (file === undefined) return;

    await upload(file);
  }

  return (
    <div className="space-y-3 rounded-lg border border-warm-200 bg-white/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="rounded-lg border border-sage-300 px-3 py-1.5 text-sm font-medium text-sage-800 transition hover:bg-sage-50">
          {open ? "Masquer la médiathèque" : "Choisir dans la médiathèque"}
        </button>
        <p
          role="status"
          aria-live="polite"
          className="text-xs leading-relaxed text-warm-500">
          {state.errorMessage ?? state.statusMessage}
        </p>
      </div>

      {open && (
        <div id={panelId} className="space-y-3">
          <div className="space-y-1.5">
            <label
              htmlFor={`${idPrefix}-upload`}
              className="block text-sm font-medium text-warm-800">
              Envoyer une image
            </label>
            <input
              ref={fileInputRef}
              id={`${idPrefix}-upload`}
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              disabled={state.busy !== null}
              onChange={onFileChosen}
              className="block w-full text-sm text-warm-700 file:mr-3 file:rounded-lg file:border-0 file:bg-sage-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-sage-800"
            />
            <p className="text-xs leading-relaxed text-warm-500">
              JPEG, PNG ou WebP, jusqu’à{" "}
              {formatMediaSize(MEDIA_UPLOAD_LIMIT_BYTES)}. L’image est
              ré-encodée par le serveur : les données EXIF, dont la
              géolocalisation, ne sont pas publiées.
            </p>
          </div>

          {state.assets.length > 0 && (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {state.assets.map((asset) => {
                const isSelected = asset.path === selected;
                const usages = usagesOf(asset.path);
                const pending = state.pendingDeleteId === asset.id;

                return (
                  <li
                    key={asset.id}
                    className={`space-y-1.5 rounded-lg border p-2 ${
                      isSelected
                        ? "border-sage-500 bg-sage-50"
                        : "border-warm-200 bg-white/80"
                    }`}>
                    <button
                      type="button"
                      onClick={() => onSelect(asset)}
                      aria-pressed={isSelected}
                      className="block w-full overflow-hidden rounded border border-warm-200">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={asset.path}
                        alt=""
                        className="h-20 w-full object-cover"
                      />
                    </button>
                    <p className="text-[11px] leading-tight text-warm-500">
                      {formatMediaDimensions(asset)} ·{" "}
                      {formatMediaSize(asset.byteSize)}
                    </p>
                    {usages > 0 && (
                      <p className="text-[11px] leading-tight text-sage-700">
                        Utilisé {usages}×
                      </p>
                    )}
                    {pending ? (
                      <div className="space-y-1">
                        <p className="text-[11px] leading-tight text-warm-700">
                          {MEDIA_LIBRARY_MESSAGES.deleteConfirm}
                        </p>
                        <div className="flex gap-1">
                          <button
                            type="button"
                            disabled={state.busy !== null}
                            onClick={() => void confirmDelete(asset.id)}
                            className="rounded border border-red-300 px-2 py-0.5 text-[11px] text-red-700">
                            Confirmer
                          </button>
                          <button
                            type="button"
                            onClick={cancelDelete}
                            className="rounded border border-warm-300 px-2 py-0.5 text-[11px] text-warm-700">
                            Annuler
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={!canDelete(state)}
                        onClick={() => requestDelete(asset.id)}
                        className="text-[11px] text-warm-500 underline disabled:no-underline disabled:opacity-50">
                        Supprimer
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
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
        placeholder="Ex. /media/med_… ou https://…"
        onChange={(value) => {
          setFailedSource(null);
          onChange({ ...media, src: normalizeOptionalSource(value) });
        }}
        help={
          isManagedMediaPath(media.src)
            ? "Média de la médiathèque. Vider ce champ ne supprime pas le fichier."
            : "Saisir une URL http(s) ou choisir un média ci-dessous."
        }
      />
      <MediaLibraryPanel
        idPrefix={idPrefix}
        selected={media.src}
        onSelect={(asset) => {
          setFailedSource(null);
          // The ordinary field edit. It reaches the server only when the admin
          // saves the draft, exactly like typing the path by hand.
          onChange({ ...media, src: asset.path });
        }}
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
