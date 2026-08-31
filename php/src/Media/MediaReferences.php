<?php

declare(strict_types=1);

namespace Eszter\Media;

/**
 * Which media paths a content document points at (ESZ-037).
 *
 * This is the whole of "is the asset still in use", and it is deliberately a
 * *structural* walk rather than a substring search of the encoded document. A
 * substring search would refuse to delete an asset whose id happened to appear
 * in editorial copy, and — worse for reasoning about it — it would keep working
 * for the wrong reason if the schema ever moved media somewhere else.
 *
 * The walk collects every string value stored under a key named `src`, at any
 * depth. In `SiteContent` that key belongs to `mediaAsset` and to nothing else
 * (`contracts/site-content.ts`), so the rule is exact today; and it is the
 * conservative direction tomorrow, because a future field named `src` would be
 * treated as a reference and protect the asset rather than expose it.
 *
 * Matching by *path* rather than by id is the other half. `MediaAsset.src` holds
 * a public path — that is what the schema accepts and what the page renders — so
 * the path is the thing a document can actually be said to reference. Comparing
 * ids would mean parsing an id back out of every `src`, and a `src` that pointed
 * at an asset by a spelling the parser did not recognise would read as "not
 * referenced", which is the one wrong answer that loses data.
 */
final class MediaReferences
{
    /**
     * Every media source string in $document, deduplicated.
     *
     * @param array<mixed> $document Any part of a content document.
     * @return list<string>
     */
    public static function sourcesIn(array $document): array
    {
        $found = [];
        self::walk($document, $found);

        return array_values(array_unique($found));
    }

    /**
     * Whether $document points at $publicPath.
     *
     * @param array<mixed> $document
     */
    public static function isReferenced(array $document, string $publicPath): bool
    {
        return \in_array($publicPath, self::sourcesIn($document), true);
    }

    /**
     * @param array<mixed> $node
     * @param list<string> $found
     * @param-out list<string> $found
     */
    private static function walk(array $node, array &$found): void
    {
        foreach ($node as $key => $value) {
            if ($key === 'src' && \is_string($value)) {
                $found[] = $value;

                continue;
            }

            if (\is_array($value)) {
                self::walk($value, $found);
            }
        }
    }
}
