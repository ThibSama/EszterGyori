<?php

declare(strict_types=1);

namespace Eszter\Contract;

use Eszter\Support\IsoTimestamp;

/**
 * The half of the contract JSON Schema cannot carry.
 *
 * `semantic-rules.json` names every `.refine`, `.superRefine` and `.transform`
 * the generator had to drop, says why it is unrepresentable, and lists the parity
 * cases that prove it. This class is the executable counterpart: one method per
 * rule id, emitting the same JSON Pointer the reference implementation emits.
 *
 * Two mechanisms keep it from drifting away from the artifacts:
 *
 *  1. {@see assertCoversDeclaredRules()} — every id in `semantic-rules.json` must
 *     be implemented here. Adding a rule upstream without porting it fails
 *     bootstrap, rather than quietly widening what PHP accepts.
 *  2. The parity corpus replay — same accept/reject outcome, same issue paths.
 *
 * Both directions are asserted, so the set of rules here and the set in the
 * artifact are equal rather than merely overlapping: a rule retired upstream
 * fails {@see assertCoversDeclaredRules()} just as an unported one does.
 */
final class SemanticRuleValidator
{
    public const NAVIGATION_LINK_IDS = ['prestations', 'parcours', 'realisations', 'a-propos', 'contact'];

    public const REASSURANCE_ITEM_IDS = [
        'natural-result', 'morphological-analysis', 'hygiene-precision', 'personal-support',
    ];

    public const SERVICE_ITEM_IDS = ['brows', 'eyeliner', 'lips', 'freckles'];

    public const PROCESS_STEP_IDS = [
        'exchange-analysis', 'drawing-validation', 'procedure', 'healing-touch-up',
    ];

    public const PROCESS_STEP_NUMBERS = ['01', '02', '03', '04'];

    public const GALLERY_ITEM_IDS = [
        'natural-brows', 'healed-brows', 'delicate-eyeliner', 'powder-lips', 'freckles',
    ];

    public const SERVICE_MEDIA_IDS_BY_ITEM_ID = [
        'brows' => 'service-brows-placeholder',
        'eyeliner' => 'service-eyeliner-placeholder',
        'lips' => 'service-lips-placeholder',
        'freckles' => 'service-freckles-placeholder',
    ];

    public const GALLERY_MEDIA_IDS_BY_ITEM_ID = [
        'natural-brows' => 'gallery-natural-brows-placeholder',
        'healed-brows' => 'gallery-healed-brows-placeholder',
        'delicate-eyeliner' => 'gallery-delicate-eyeliner-placeholder',
        'powder-lips' => 'gallery-powder-lips-placeholder',
        'freckles' => 'gallery-freckles-placeholder',
    ];

    public const GALLERY_VISUAL_KIND_BY_ITEM_ID = [
        'natural-brows' => 'beforeAfterBrows',
        'healed-brows' => 'healedBrows',
        'delicate-eyeliner' => 'eyeliner',
        'powder-lips' => 'lips',
        'freckles' => 'freckles',
    ];

    /**
     * `publicAssetPathSchema`. Kept here because the media-source *union* is a
     * semantic rule, but asserted equal to the generated schema's `pattern` by
     * MediaSourcePatternTest, so the two cannot drift.
     */
    public const PUBLIC_ASSET_PATH_PATTERN = "#^/(?!/)[A-Za-z0-9._~!$&'()*+,;=:@/-]+$#";

    /** Rule ids implemented here, matching `semantic-rules.json`. */
    public const RULES = [
        'envelope.isoTimestampRoundTrip',
        'appearance.contrastTextOnBackground',
        'appearance.contrastTextOnSurface',
        'appearance.contrastMutedTextOnBackground',
        'appearance.hexUppercaseNormalization',
        'appearance.defaultInjectionForLegacyContent',
        'navigation.linkIdOrder',
        'reassurance.itemIdOrder',
        'services.itemIdOrder',
        'services.visualKindMatchesId',
        'services.visualIdMatchesId',
        'process.stepIdOrder',
        'process.stepNumberOrder',
        'gallery.itemIdOrder',
        'gallery.visualKindMatchesId',
        'gallery.visualIdMatchesId',
        'gallery.featuredOnlyFirstItem',
        'gallery.instagramCtaFixedId',
        'hero.fixedLinkAndMediaIds',
        'about.portraitFixedId',
        'contact.fixedLinkIds',
        'footer.linkIdOrder',
        'links.mailtoHref',
        'links.instagramHttpsHost',
        'media.sourceProtocol',
    ];

    /**
     * Validates a site-content document.
     *
     * @param array<string, mixed> $content Structurally valid, appearance already
     *                                      normalised by {@see ContentValidator}.
     * @param string $prefix JSON Pointer prefix (`` for a bare document,
     *                       `/content` inside an envelope).
     * @return list<ValidationIssue>
     */
    public function validate(array $content, string $prefix = ''): array
    {
        /** @var list<ValidationIssue> $issues */
        $issues = [];

        $this->checkAppearanceContrast($content, $prefix, $issues);
        $this->checkNavigation($content, $prefix, $issues);
        $this->checkHero($content, $prefix, $issues);
        $this->checkReassurance($content, $prefix, $issues);
        $this->checkServices($content, $prefix, $issues);
        $this->checkProcess($content, $prefix, $issues);
        $this->checkGallery($content, $prefix, $issues);
        $this->checkAbout($content, $prefix, $issues);
        $this->checkContact($content, $prefix, $issues);
        $this->checkFooter($content, $prefix, $issues);

        return $issues;
    }

    /**
     * `envelope.isoTimestampRoundTrip` for the envelope's own timestamp field.
     *
     * @param array<string, mixed> $envelope
     * @return list<ValidationIssue>
     */
    public function validateEnvelopeTimestamp(array $envelope, string $field, string $prefix = ''): array
    {
        if (IsoTimestamp::isCanonical($envelope[$field] ?? null)) {
            return [];
        }

        return [new ValidationIssue(
            $prefix . '/' . $field,
            'Doit etre une date ISO 8601 valide.',
            'envelope.isoTimestampRoundTrip',
        )];
    }

    /**
     * Fails when the declared rule set and the implemented rule set disagree.
     *
     * @param array<string, array<mixed>> $declared Keyed by rule id.
     */
    public function assertCoversDeclaredRules(array $declared): void
    {
        $missing = array_diff(array_keys($declared), self::RULES);

        if ($missing !== []) {
            throw new ContractArtifactException(
                'semantic-rules.json declares rules this backend does not implement: '
                . implode(', ', $missing)
                . '. Implement them in SemanticRuleValidator before serving traffic.',
            );
        }

        $unknown = array_diff(self::RULES, array_keys($declared));

        if ($unknown !== []) {
            throw new ContractArtifactException(
                'SemanticRuleValidator implements rules semantic-rules.json no longer declares: '
                . implode(', ', $unknown)
                . '. Remove them or regenerate the contract artifacts.',
            );
        }
    }

    // ── rules ────────────────────────────────────────────────────────────────

    /**
     * `appearance.contrastTextOnBackground`, `…OnSurface`,
     * `…MutedTextOnBackground` — one `superRefine` upstream, three rule ids.
     *
     * The upstream guard is reproduced: if any colour is not a valid hex, the
     * block returns without emitting contrast issues, because the structural
     * layer already rejected the document and re-reporting adds noise.
     *
     * @param array<string, mixed> $content
     * @param list<ValidationIssue> $issues
     * @param-out list<ValidationIssue> $issues
     */
    private function checkAppearanceContrast(array $content, string $prefix, array &$issues): void
    {
        $appearance = $content['appearance'] ?? null;
        if (!\is_array($appearance)) {
            return;
        }

        $palette = $appearance['palette'] ?? null;
        $tints = $appearance['sectionTints'] ?? null;
        if (!\is_array($palette) || !\is_array($tints)) {
            return;
        }

        foreach ([...array_values($palette), ...array_values($tints)] as $color) {
            if (!Appearance::isHexColor($color)) {
                return;
            }
        }

        /** @var array<string, string> $palette */
        $checks = [
            [
                'appearance.contrastTextOnBackground',
                'text',
                $palette['text'],
                $palette['background'],
                4.5,
                'Le texte principal doit rester lisible sur le fond général.',
            ],
            [
                'appearance.contrastTextOnSurface',
                'text',
                $palette['text'],
                $palette['surface'],
                4.5,
                'Le texte principal doit rester lisible sur les surfaces.',
            ],
            [
                'appearance.contrastMutedTextOnBackground',
                'mutedText',
                $palette['mutedText'],
                $palette['background'],
                3.0,
                'Le texte secondaire doit rester lisible sur le fond général.',
            ],
        ];

        foreach ($checks as [$rule, $key, $foreground, $background, $minimum, $message]) {
            if (Appearance::contrastRatio($foreground, $background) < $minimum) {
                $issues[] = new ValidationIssue("{$prefix}/appearance/palette/{$key}", $message, $rule);
            }
        }
    }

    /**
     * @param array<string, mixed> $content
     * @param list<ValidationIssue> $issues
     * @param-out list<ValidationIssue> $issues
     */
    private function checkNavigation(array $content, string $prefix, array &$issues): void
    {
        $links = $this->listAt($content, ['navigation', 'links']);
        if ($links === null) {
            return;
        }

        foreach (self::NAVIGATION_LINK_IDS as $index => $id) {
            if ($this->fieldOf($links, $index, 'id') !== $id) {
                $issues[] = $this->fixedValue(
                    "{$prefix}/navigation/links/{$index}/id",
                    'id',
                    'navigation.linkIdOrder',
                );
            }
        }
    }

    /**
     * @param array<string, mixed> $content
     * @param list<ValidationIssue> $issues
     * @param-out list<ValidationIssue> $issues
     */
    private function checkHero(array $content, string $prefix, array &$issues): void
    {
        $hero = $content['hero'] ?? null;
        if (!\is_array($hero)) {
            return;
        }

        $fixed = [
            ['primaryCta', 'discover-services'],
            ['secondaryCta', 'contact'],
            ['visual', 'hero-placeholder'],
        ];

        foreach ($fixed as [$key, $expected]) {
            $node = $hero[$key] ?? null;
            if (\is_array($node) && ($node['id'] ?? null) !== $expected) {
                $issues[] = $this->fixedValue(
                    "{$prefix}/hero/{$key}/id",
                    'id',
                    'hero.fixedLinkAndMediaIds',
                );
            }
        }

        $this->checkMediaSource($hero['visual'] ?? null, "{$prefix}/hero/visual", $issues);
    }

    /**
     * @param array<string, mixed> $content
     * @param list<ValidationIssue> $issues
     * @param-out list<ValidationIssue> $issues
     */
    private function checkReassurance(array $content, string $prefix, array &$issues): void
    {
        $items = $this->listAt($content, ['reassurance', 'items']);
        if ($items === null) {
            return;
        }

        foreach (self::REASSURANCE_ITEM_IDS as $index => $id) {
            if ($this->fieldOf($items, $index, 'id') !== $id) {
                $issues[] = $this->fixedValue(
                    "{$prefix}/reassurance/items/{$index}/id",
                    'id',
                    'reassurance.itemIdOrder',
                );
            }
        }
    }

    /**
     * Upstream keys every check on the *expected* id for the position, never on
     * the submitted one — otherwise a renamed item would also silently move which
     * media id and visual kind are considered correct.
     *
     * @param array<string, mixed> $content
     * @param list<ValidationIssue> $issues
     * @param-out list<ValidationIssue> $issues
     */
    private function checkServices(array $content, string $prefix, array &$issues): void
    {
        $items = $this->listAt($content, ['services', 'items']);
        if ($items === null) {
            return;
        }

        foreach (self::SERVICE_ITEM_IDS as $index => $id) {
            $item = $items[$index] ?? null;
            if (!\is_array($item)) {
                continue;
            }

            $base = "{$prefix}/services/items/{$index}";

            if (($item['id'] ?? null) !== $id) {
                $issues[] = $this->fixedValue("{$base}/id", 'id', 'services.itemIdOrder');
            }
            if (($item['visualKind'] ?? null) !== $id) {
                $issues[] = $this->fixedValue("{$base}/visualKind", 'visualKind', 'services.visualKindMatchesId');
            }

            $visual = $item['visual'] ?? null;
            if (\is_array($visual) && ($visual['id'] ?? null) !== self::SERVICE_MEDIA_IDS_BY_ITEM_ID[$id]) {
                $issues[] = $this->fixedValue("{$base}/visual/id", 'visual.id', 'services.visualIdMatchesId');
            }

            $this->checkMediaSource($visual, "{$base}/visual", $issues);
        }
    }

    /**
     * @param array<string, mixed> $content
     * @param list<ValidationIssue> $issues
     * @param-out list<ValidationIssue> $issues
     */
    private function checkProcess(array $content, string $prefix, array &$issues): void
    {
        $steps = $this->listAt($content, ['process', 'steps']);
        if ($steps === null) {
            return;
        }

        foreach (self::PROCESS_STEP_IDS as $index => $id) {
            $step = $steps[$index] ?? null;
            if (!\is_array($step)) {
                continue;
            }

            $base = "{$prefix}/process/steps/{$index}";

            if (($step['id'] ?? null) !== $id) {
                $issues[] = $this->fixedValue("{$base}/id", 'id', 'process.stepIdOrder');
            }
            if (($step['number'] ?? null) !== self::PROCESS_STEP_NUMBERS[$index]) {
                $issues[] = $this->fixedValue("{$base}/number", 'number', 'process.stepNumberOrder');
            }
        }
    }

    /**
     * @param array<string, mixed> $content
     * @param list<ValidationIssue> $issues
     * @param-out list<ValidationIssue> $issues
     */
    private function checkGallery(array $content, string $prefix, array &$issues): void
    {
        $gallery = $content['gallery'] ?? null;
        if (!\is_array($gallery)) {
            return;
        }

        $items = \is_array($gallery['items'] ?? null) ? $gallery['items'] : null;

        if ($items !== null) {
            foreach (self::GALLERY_ITEM_IDS as $index => $id) {
                $item = $items[$index] ?? null;
                if (!\is_array($item)) {
                    continue;
                }

                $base = "{$prefix}/gallery/items/{$index}";

                if (($item['id'] ?? null) !== $id) {
                    $issues[] = $this->fixedValue("{$base}/id", 'id', 'gallery.itemIdOrder');
                }
                if (($item['visualKind'] ?? null) !== self::GALLERY_VISUAL_KIND_BY_ITEM_ID[$id]) {
                    $issues[] = $this->fixedValue("{$base}/visualKind", 'visualKind', 'gallery.visualKindMatchesId');
                }

                $visual = $item['visual'] ?? null;
                if (\is_array($visual) && ($visual['id'] ?? null) !== self::GALLERY_MEDIA_IDS_BY_ITEM_ID[$id]) {
                    $issues[] = $this->fixedValue("{$base}/visual/id", 'visual.id', 'gallery.visualIdMatchesId');
                }

                // Only the first item carries `featured: true`; the rest must omit
                // the key entirely — `featured: false` is a rejection, not a synonym.
                $featured = \array_key_exists('featured', $item) ? $item['featured'] : null;
                $hasFeatured = \array_key_exists('featured', $item);

                if ($index === 0 && $featured !== true) {
                    $issues[] = $this->fixedValue("{$base}/featured", 'featured', 'gallery.featuredOnlyFirstItem');
                }
                if ($index !== 0 && $hasFeatured) {
                    $issues[] = $this->fixedValue("{$base}/featured", 'featured', 'gallery.featuredOnlyFirstItem');
                }

                $this->checkMediaSource($visual, "{$base}/visual", $issues);
            }
        }

        $cta = $gallery['instagramCta'] ?? null;
        if (\is_array($cta)) {
            if (($cta['id'] ?? null) !== 'instagram-more') {
                $issues[] = $this->fixedValue(
                    "{$prefix}/gallery/instagramCta/id",
                    'id',
                    'gallery.instagramCtaFixedId',
                );
            }
            $this->checkInstagramHref($cta['href'] ?? null, "{$prefix}/gallery/instagramCta/href", $issues);
        }
    }

    /**
     * @param array<string, mixed> $content
     * @param list<ValidationIssue> $issues
     * @param-out list<ValidationIssue> $issues
     */
    private function checkAbout(array $content, string $prefix, array &$issues): void
    {
        $about = $content['about'] ?? null;
        $portrait = \is_array($about) ? ($about['portrait'] ?? null) : null;
        if (!\is_array($portrait)) {
            return;
        }

        if (($portrait['id'] ?? null) !== 'eszter-portrait-placeholder') {
            $issues[] = $this->fixedValue("{$prefix}/about/portrait/id", 'id', 'about.portraitFixedId');
        }

        $this->checkMediaSource($portrait, "{$prefix}/about/portrait", $issues);
    }

    /**
     * @param array<string, mixed> $content
     * @param list<ValidationIssue> $issues
     * @param-out list<ValidationIssue> $issues
     */
    private function checkContact(array $content, string $prefix, array &$issues): void
    {
        $contact = $content['contact'] ?? null;
        if (!\is_array($contact)) {
            return;
        }

        $instagram = $contact['instagramCta'] ?? null;
        if (\is_array($instagram)) {
            if (($instagram['id'] ?? null) !== 'write-instagram') {
                $issues[] = $this->fixedValue(
                    "{$prefix}/contact/instagramCta/id",
                    'id',
                    'contact.fixedLinkIds',
                );
            }
            $this->checkInstagramHref($instagram['href'] ?? null, "{$prefix}/contact/instagramCta/href", $issues);
        }

        $email = $contact['emailCta'] ?? null;
        if (\is_array($email)) {
            if (($email['id'] ?? null) !== 'email') {
                $issues[] = $this->fixedValue("{$prefix}/contact/emailCta/id", 'id', 'contact.fixedLinkIds');
            }
            if (!Links::isMailtoHref($email['href'] ?? null)) {
                $issues[] = new ValidationIssue(
                    "{$prefix}/contact/emailCta/href",
                    'Doit etre un lien mailto valide.',
                    'links.mailtoHref',
                );
            }
        }
    }

    /**
     * `footer.links` is a union of the Instagram and mailto link shapes, so a
     * member's href only has to satisfy *one* of them. The issue is therefore
     * raised on the element, matching where the reference reports a union failure,
     * not on the `href` leaf.
     *
     * @param array<string, mixed> $content
     * @param list<ValidationIssue> $issues
     * @param-out list<ValidationIssue> $issues
     */
    private function checkFooter(array $content, string $prefix, array &$issues): void
    {
        $links = $this->listAt($content, ['footer', 'links']);
        if ($links === null) {
            return;
        }

        foreach (['instagram', 'contact'] as $index => $id) {
            if ($this->fieldOf($links, $index, 'id') !== $id) {
                $issues[] = $this->fixedValue(
                    "{$prefix}/footer/links/{$index}/id",
                    'id',
                    'footer.linkIdOrder',
                );
            }
        }

        foreach ($links as $index => $link) {
            if (!\is_array($link)) {
                continue;
            }

            $href = $link['href'] ?? null;
            if (Links::isInstagramHttpsUrl($href) || Links::isMailtoHref($href)) {
                continue;
            }

            $issues[] = new ValidationIssue(
                "{$prefix}/footer/links/{$index}",
                'Doit etre un lien Instagram HTTPS ou un lien mailto valide.',
                Links::looksLikeMailto($href) ? 'links.mailtoHref' : 'links.instagramHttpsHost',
            );
        }
    }

    // ── shared leaf checks ───────────────────────────────────────────────────

    /**
     * @param list<ValidationIssue> $issues
     * @param-out list<ValidationIssue> $issues
     */
    private function checkInstagramHref(mixed $href, string $path, array &$issues): void
    {
        if (Links::isInstagramHttpsUrl($href)) {
            return;
        }

        $issues[] = new ValidationIssue(
            $path,
            'Doit etre une URL Instagram HTTPS valide.',
            'links.instagramHttpsHost',
        );
    }

    /**
     * @param list<ValidationIssue> $issues
     * @param-out list<ValidationIssue> $issues
     */
    private function checkMediaSource(mixed $media, string $mediaPath, array &$issues): void
    {
        if (!\is_array($media) || !\array_key_exists('src', $media)) {
            return;
        }

        if (Links::isMediaSource($media['src'])) {
            return;
        }

        $issues[] = new ValidationIssue(
            "{$mediaPath}/src",
            'Doit etre un chemin public, une URL HTTPS ou null.',
            'media.sourceProtocol',
        );
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /**
     * @param array<string, mixed> $content
     * @param list<string> $path
     * @return array<int, mixed>|null
     */
    private function listAt(array $content, array $path): ?array
    {
        $node = $content;

        foreach ($path as $segment) {
            if (!\array_key_exists($segment, $node)) {
                return null;
            }

            /** @var mixed $next */
            $next = $node[$segment];

            if (!\is_array($next)) {
                return null;
            }

            $node = $next;
        }

        /** @var array<int, mixed> */
        return $node;
    }

    /** @param array<int, mixed> $items */
    private function fieldOf(array $items, int $index, string $field): mixed
    {
        $item = $items[$index] ?? null;

        return \is_array($item) ? ($item[$field] ?? null) : null;
    }

    private function fixedValue(string $path, string $label, string $rule): ValidationIssue
    {
        return new ValidationIssue(
            $path,
            "{$label} doit conserver la valeur technique actuelle.",
            $rule,
        );
    }
}
