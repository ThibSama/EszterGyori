<?php

declare(strict_types=1);

namespace Eszter\Http;

/**
 * The published-content validator and the `If-None-Match` comparison.
 *
 * Both halves are frozen (`docs/contract-freeze.md`, "ETag, If-None-Match and
 * caching") and both are narrower than RFC 9110 allows. That is deliberate: this
 * service mints exactly one shape of validator, so the parser only has to
 * recognise that shape and say "no" to everything else.
 *
 *  - the tag is `"published-<revision>"`, strong and quoted, derived from the
 *    revision and nothing else — an unchanged revision must always produce a
 *    byte-identical tag, so it can never depend on a timestamp or a hash of the
 *    body;
 *  - `If-None-Match` is split on commas and trimmed, `*` always matches, and a
 *    member equal to the current tag matches. A value that is neither — a bare
 *    unquoted token, a weak `W/"…"` validator, anything malformed — simply does
 *    not match, which yields a normal 200. A malformed conditional header is a
 *    cache-efficiency question, never a reason to fail a request.
 */
final class EntityTag
{
    public function __construct(private readonly string $etagPattern)
    {
    }

    /** @param array<mixed> $httpContract */
    public static function fromContract(array $httpContract): self
    {
        /** @var mixed $caching */
        $caching = $httpContract['caching'] ?? null;

        if (!\is_array($caching) || !\is_string($caching['etagPattern'] ?? null)) {
            throw new \RuntimeException('http-contract.json has no caching.etagPattern.');
        }

        return new self($caching['etagPattern']);
    }

    public function forRevision(int $revision): string
    {
        $etag = \sprintf('"published-%d"', $revision);

        // The contract publishes the tag *pattern* as well as the format, so the
        // two could disagree. Checking here means a future revision type that no
        // longer matches (a negative number, say) fails at the source rather than
        // becoming a validator no cache can use.
        if (preg_match($this->delimited(), $etag) !== 1) {
            throw new \RuntimeException("Computed ETag {$etag} does not match the contract pattern.");
        }

        return $etag;
    }

    /** Whether an inbound `If-None-Match` header selects the given tag. */
    public function ifNoneMatchSelects(?string $header, string $etag): bool
    {
        if ($header === null || trim($header) === '') {
            return false;
        }

        foreach (explode(',', $header) as $candidate) {
            $candidate = trim($candidate);

            if ($candidate === '*' || $candidate === $etag) {
                return true;
            }
        }

        return false;
    }

    private function delimited(): string
    {
        return '#' . str_replace('#', '\\#', $this->etagPattern) . '#';
    }
}
