<?php

declare(strict_types=1);

namespace Eszter\Media;

/**
 * The runtime half of ESZ-147: no content write persists a managed media path
 * the catalogue does not name.
 *
 * `MediaAsset.src` accepts any contract-valid public path plus absolute
 * HTTP(S) URLs, and the *managed* namespace — paths matching the frozen
 * `media.publicPathPattern` — is the one the server itself controls. A
 * document that names a managed path with no catalogue entry would render a
 * broken image that no editor can tell apart from a working one, so both
 * content writes that can make such a reference durable — draft save and
 * publish — run this guard on the exact document they are about to commit.
 *
 * Everything here is reused rather than restated:
 *
 *  - {@see MediaReferences} finds the `src` values, by the same structural
 *    walk the delete reference check uses;
 *  - {@see MediaContract} decides which of them are managed, from the frozen
 *    `publicPathPattern` — the pattern lives in the generated artifact and is
 *    never duplicated here or anywhere else;
 *  - {@see MediaLibrary} answers catalogue membership, by exact public path
 *    and from the catalogue alone. The filesystem is never probed: bytes and
 *    catalogue entries can disagree, and the catalogue is the record of what
 *    may be referenced.
 *
 * The guard holds no lock of its own. It is invoked by the storage layer
 * inside the exclusive content-lock acquisition of the operation being
 * committed, while the {@see \Eszter\Storage\MediaContentLock} boundary is
 * held shared across the whole check-to-commit critical section — so a media
 * delete, which needs that boundary exclusively, can never land between this
 * check and the write. Its catalogue read takes `media.lock` shared inside
 * `content.lock`; that inverted domain order is deadlock-free precisely
 * because the delete — the only exclusive `media.lock` holder that also waits
 * on `content.lock` — cannot be inside its critical section at the same time
 * as any content writer (see {@see \Eszter\Storage\MediaContentLock}).
 */
final class ManagedMediaReferenceGuard
{
    public function __construct(
        private readonly MediaContract $contract,
        private readonly MediaLibrary $library,
    ) {
    }

    /**
     * Refuses $content when a managed src names no catalogued public path.
     *
     * @param array<string, mixed> $content A complete, contract-valid
     *        SiteContent about to become durable.
     * @throws DanglingMediaReferenceException Naming every managed path that
     *         matched no catalogue entry.
     */
    public function assertResolvable(array $content): void
    {
        $managed = [];

        foreach (MediaReferences::sourcesIn($content) as $source) {
            if ($this->contract->isManagedPublicPath($source)) {
                $managed[] = $source;
            }
        }

        if ($managed === []) {
            // No managed reference: nothing for the catalogue to decide, and
            // no catalogue read and no extra lock on the common path.
            return;
        }

        $missing = $this->library->missingCataloguedPaths(\array_values(\array_unique($managed)));

        if ($missing !== []) {
            throw new DanglingMediaReferenceException($missing);
        }
    }
}
