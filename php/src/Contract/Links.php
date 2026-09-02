<?php

declare(strict_types=1);

namespace Eszter\Contract;

/**
 * Link and media-source predicates behind `links.mailtoHref`,
 * `links.instagramHttpsHost` and `media.sourceProtocol`.
 *
 * The reference implementation reaches these through `new URL(...)`, whose
 * defining property is that it *throws* on anything that is not an absolute URL.
 * `parse_url()` does not throw — it happily returns a host for `//evil.example/x`
 * and a path for `contact@example.com`. {@see absoluteUrl()} restores the
 * stricter behaviour by requiring a scheme, which is what makes the
 * protocol-relative and bare-address corpus cases reject here too.
 */
final class Links
{
    public static function looksLikeMailto(mixed $value): bool
    {
        return \is_string($value) && str_starts_with($value, 'mailto:');
    }

    /** `mailtoHrefSchema`: the `mailto:` scheme plus a parseable address. */
    public static function isMailtoHref(mixed $value): bool
    {
        if (!self::looksLikeMailto($value)) {
            return false;
        }

        /** @var string $value */
        $address = substr($value, \strlen('mailto:'));

        return $address !== '' && filter_var($address, FILTER_VALIDATE_EMAIL) !== false;
    }

    /** `instagramUrlSchema`: HTTPS on instagram.com or one of its subdomains. */
    public static function isInstagramHttpsUrl(mixed $value): bool
    {
        $parts = self::absoluteUrl($value);

        if ($parts === null || $parts['scheme'] !== 'https') {
            return false;
        }

        $host = $parts['host'];

        return $host === 'instagram.com' || str_ends_with($host, '.instagram.com');
    }

    /**
     * `mediaSourceSchema`: a rooted public path, an HTTPS URL, or null.
     *
     * HTTP is deliberately absent (ESZ-104): the reference accepts only the
     * shared `httpsUrlSchema` for the external-URL branch, mirroring the
     * production `img-src 'self' data: https:` policy under which an `http:`
     * media source could never render.
     */
    public static function isMediaSource(mixed $value): bool
    {
        if ($value === null) {
            return true;
        }

        if (!\is_string($value)) {
            return false;
        }

        if (preg_match(SemanticRuleValidator::PUBLIC_ASSET_PATH_PATTERN, $value) === 1) {
            return true;
        }

        $parts = self::absoluteUrl($value);

        return $parts !== null && $parts['scheme'] === 'https';
    }

    /**
     * @return array{scheme: string, host: string}|null
     */
    private static function absoluteUrl(mixed $value): ?array
    {
        if (!\is_string($value) || $value === '') {
            return null;
        }

        $parts = parse_url($value);

        if ($parts === false || !isset($parts['scheme'])) {
            return null;
        }

        $scheme = strtolower($parts['scheme']);
        $host = strtolower($parts['host'] ?? '');

        // Hierarchical schemes without an authority (`https:/foo`) are not URLs
        // `new URL` would accept as same-shaped; treat them as unparseable.
        if (\in_array($scheme, ['http', 'https'], true) && $host === '') {
            return null;
        }

        return ['scheme' => $scheme, 'host' => $host];
    }
}
