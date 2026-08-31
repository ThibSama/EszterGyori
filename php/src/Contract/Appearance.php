<?php

declare(strict_types=1);

namespace Eszter\Contract;

/**
 * Port of `contracts/appearance.ts`: hex normalisation and the WCAG relative
 * luminance / contrast maths behind the three `appearance.contrast*` rules.
 *
 * The formulas are reproduced exactly, including the 0.03928 linearisation
 * threshold and the `(lighter + 0.05) / (darker + 0.05)` ratio, because the
 * corpus fixes colours that sit near the 4.5:1 and 3:1 boundaries.
 */
final class Appearance
{
    public const PALETTE_KEYS = [
        'background', 'surface', 'text', 'mutedText', 'primary', 'secondary', 'warmAccent',
    ];

    public const SECTION_TINT_KEYS = [
        'navigation', 'hero', 'reassurance', 'services',
        'process', 'gallery', 'about', 'contact', 'footer',
    ];

    public const HEX_PATTERN = '#^\#[0-9A-Fa-f]{6}$#';

    /** The two candidates {@see readableForeground()} chooses between. */
    public const LIGHT_FOREGROUND = '#FFFFFF';
    public const DARK_FOREGROUND = '#1D1C1A';

    /** Mirrors `defaultSiteAppearance`; injected when content omits `appearance`. */
    public const DEFAULTS = [
        'palette' => [
            'background' => '#F5F4F1',
            'surface' => '#FAFAF8',
            'text' => '#2C2B28',
            'mutedText' => '#6D6B67',
            'primary' => '#63726C',
            'secondary' => '#A8AEB8',
            'warmAccent' => '#D3D1CD',
        ],
        'sectionTints' => [
            'navigation' => '#FAFAF8',
            'hero' => '#DBE0DD',
            'reassurance' => '#DBE0DD',
            'services' => '#E0DEDB',
            'process' => '#DBE0DD',
            'gallery' => '#EDECE8',
            'about' => '#EDECE8',
            'contact' => '#E3E5EA',
            'footer' => '#EDECE8',
        ],
    ];

    public static function isHexColor(mixed $value): bool
    {
        return \is_string($value) && preg_match(self::HEX_PATTERN, $value) === 1;
    }

    /** `hexColorSchema.transform` — accepted lowercase, emitted uppercase. */
    public static function normalizeHex(string $value): string
    {
        return strtoupper($value);
    }

    private static function linearize(int $channel): float
    {
        $value = $channel / 255;

        return $value <= 0.03928
            ? $value / 12.92
            : (($value + 0.055) / 1.055) ** 2.4;
    }

    public static function relativeLuminance(string $hex): float
    {
        $r = (int) hexdec(substr($hex, 1, 2));
        $g = (int) hexdec(substr($hex, 3, 2));
        $b = (int) hexdec(substr($hex, 5, 2));

        return 0.2126 * self::linearize($r)
            + 0.7152 * self::linearize($g)
            + 0.0722 * self::linearize($b);
    }

    public static function contrastRatio(string $first, string $second): float
    {
        $a = self::relativeLuminance($first);
        $b = self::relativeLuminance($second);

        return (max($a, $b) + 0.05) / (min($a, $b) + 0.05);
    }

    /**
     * `getReadableForeground` — the legible ink for a given background.
     *
     * The contract's own rule, ported rather than invented: the two candidates and
     * the tie-break are exactly what `contracts/appearance.ts` uses, and it is the
     * same contrast function `siteAppearanceSchema` polices legibility with. It is
     * here because `--site-primary-contrast` is the one injected custom property
     * that is derived rather than copied
     * (`publicPage.bootstrap.appearanceCustomProperties`, source
     * `readableForeground`).
     *
     * A tie goes to white, matching the TypeScript `>=`. Ties are reachable — a
     * mid-grey primary sits close to the midpoint — so which side wins has to be
     * fixed by both implementations rather than left to a rounding difference.
     */
    public static function readableForeground(string $background): string
    {
        return self::contrastRatio($background, self::LIGHT_FOREGROUND)
            >= self::contrastRatio($background, self::DARK_FOREGROUND)
            ? self::LIGHT_FOREGROUND
            : self::DARK_FOREGROUND;
    }
}
