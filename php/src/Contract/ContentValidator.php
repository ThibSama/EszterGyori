<?php

declare(strict_types=1);

namespace Eszter\Contract;

/**
 * Contract validation, whole.
 *
 * ```
 * structure (JSON Schema)  →  normalise (transforms + defaults)  →  semantics
 * ```
 *
 * Structural failure short-circuits, mirroring the reference implementation:
 * upstream, a `.superRefine` never runs when the object it hangs off failed to
 * parse, so re-reporting semantic issues over a structurally broken document
 * would invent paths Zod never emits.
 *
 * Normalisation sits in the middle because two declared rules *are*
 * normalisations — `appearance.hexUppercaseNormalization` and
 * `appearance.defaultInjectionForLegacyContent` — and the contrast rules must see
 * the injected defaults, exactly as Zod's `.default()` feeds its `.superRefine()`.
 */
final class ContentValidator
{
    public const TARGET_SITE_CONTENT = 'siteContent';
    public const TARGET_PUBLISHED_ENVELOPE = 'publishedEnvelope';
    public const TARGET_SERVER_DRAFT_ENVELOPE = 'serverDraftEnvelope';
    public const TARGET_SITE_CONTENT_DRAFT = 'siteContentDraft';

    /** target => [schema artifact, envelope timestamp field or null] */
    private const TARGETS = [
        self::TARGET_SITE_CONTENT => ['site-content.input.schema.json', null],
        self::TARGET_PUBLISHED_ENVELOPE => ['published-content-envelope.input.schema.json', 'publishedAt'],
        self::TARGET_SERVER_DRAFT_ENVELOPE => ['server-draft-envelope.input.schema.json', 'updatedAt'],
        self::TARGET_SITE_CONTENT_DRAFT => ['site-content-draft.input.schema.json', 'savedAt'],
    ];

    public function __construct(
        private readonly StructuralValidator $structural,
        private readonly SemanticRuleValidator $semantic,
    ) {
    }

    public static function create(ContractArtifacts $artifacts): self
    {
        $semantic = new SemanticRuleValidator();
        $semantic->assertCoversDeclaredRules($artifacts->semanticRules());

        return new self(new StructuralValidator($artifacts), $semantic);
    }

    /** @return list<string> */
    public static function targets(): array
    {
        return array_keys(self::TARGETS);
    }

    public function validate(mixed $document, string $target): ValidationResult
    {
        if (!isset(self::TARGETS[$target])) {
            throw new \InvalidArgumentException("Unknown validation target: {$target}");
        }

        [$schemaFile, $timestampField] = self::TARGETS[$target];

        $structuralIssues = $this->structural->validate($document, $schemaFile);
        if ($structuralIssues !== []) {
            return ValidationResult::failed($structuralIssues);
        }

        if (!\is_array($document)) {
            // Unreachable while every target schema is `type: object`; kept so a
            // future scalar-rooted schema fails loudly instead of silently.
            throw new \LogicException("Target {$target} validated a non-object document.");
        }

        /** @var array<string, mixed> $document */
        $isEnvelope = $timestampField !== null;
        $contentPrefix = $isEnvelope ? '/content' : '';

        $normalized = $isEnvelope
            ? $this->normalizeEnvelope($document)
            : $this->normalizeContent($document);

        /** @var list<ValidationIssue> $issues */
        $issues = [];

        if ($timestampField !== null) {
            $issues = [...$issues, ...$this->semantic->validateEnvelopeTimestamp($normalized, $timestampField)];
        }

        /** @var mixed $content */
        $content = $isEnvelope ? ($normalized['content'] ?? null) : $normalized;

        if (\is_array($content)) {
            /** @var array<string, mixed> $content */
            $issues = [...$issues, ...$this->semantic->validate($content, $contentPrefix)];
        }

        return $issues === [] ? ValidationResult::ok($normalized) : ValidationResult::failed($issues);
    }

    /**
     * @param array<string, mixed> $envelope
     * @return array<string, mixed>
     */
    private function normalizeEnvelope(array $envelope): array
    {
        /** @var mixed $content */
        $content = $envelope['content'] ?? null;

        if (\is_array($content)) {
            /** @var array<string, mixed> $content */
            $envelope['content'] = $this->normalizeContent($content);
        }

        return $envelope;
    }

    /**
     * `appearance.defaultInjectionForLegacyContent` + `appearance.hexUppercaseNormalization`.
     *
     * @param array<string, mixed> $content
     * @return array<string, mixed>
     */
    private function normalizeContent(array $content): array
    {
        /** @var mixed $appearance */
        $appearance = $content['appearance'] ?? null;

        if (!\is_array($appearance)) {
            $content['appearance'] = Appearance::DEFAULTS;

            return $content;
        }

        foreach (['palette', 'sectionTints'] as $group) {
            /** @var mixed $colors */
            $colors = $appearance[$group] ?? null;
            if (!\is_array($colors)) {
                continue;
            }

            foreach ($colors as $key => $color) {
                if (\is_string($color)) {
                    $colors[$key] = Appearance::normalizeHex($color);
                }
            }

            $appearance[$group] = $colors;
        }

        $content['appearance'] = $appearance;

        return $content;
    }
}
