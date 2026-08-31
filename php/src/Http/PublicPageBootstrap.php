<?php

declare(strict_types=1);

namespace Eszter\Http;

use Eszter\Contract\Appearance;
use Eszter\Contract\ContractArtifacts;

/**
 * Rewrites the exported HTML with the published document (ESZ-021).
 *
 * `next build` bakes the canonical defaults into two elements; this class swaps
 * their contents for the published ones, and nothing else about the file changes.
 * That boundary is the whole design (`docs/hetzner-target-architecture.md` §5):
 * PHP never renders the page, it edits two known regions of a file React
 * produced. Templating the page in PHP was the rejected alternative, because it
 * would mean maintaining a second renderer that has to agree with the first.
 *
 * ## Everything it needs is read from the contract
 *
 * The element ids and the list of CSS custom properties come from
 * `http-contract.json`, whose `publicPage.bootstrap` block the frontend generates
 * from the same TypeScript that emits the baked version. There is no second list
 * here to fall out of step, and a rename fails the artifact digest check at boot
 * rather than silently disabling injection in production — which would look like
 * "publishing stopped working" and be very hard to see, since the page would keep
 * serving the last build perfectly happily.
 *
 * ## What it will not do
 *
 * It resolves custom properties by copying values that already passed
 * `hexColorSchema`, plus one contract-defined contrast choice. It does not blend,
 * lighten or otherwise compute colour: the per-section blending lives in
 * `globals.css` as `color-mix()`, precisely so that presentation logic does not
 * have to exist twice. If a future property needs a source this class does not
 * recognise, it is skipped rather than guessed at.
 */
final class PublicPageBootstrap
{
    /**
     * @param string $contentElementId Element carrying the JSON payload.
     * @param string $appearanceElementId Element carrying the `:root` block.
     * @param list<array{name: string, source: string, key: string}> $customProperties
     */
    public function __construct(
        private readonly string $contentElementId,
        private readonly string $appearanceElementId,
        private readonly array $customProperties,
    ) {
    }

    public static function fromArtifacts(ContractArtifacts $artifacts): self
    {
        $contract = $artifacts->httpContract();

        /** @var mixed $publicPage */
        $publicPage = $contract['publicPage'] ?? null;
        if (!\is_array($publicPage)) {
            throw new \RuntimeException('http-contract.json has no publicPage block.');
        }

        /** @var mixed $bootstrap */
        $bootstrap = $publicPage['bootstrap'] ?? null;
        if (!\is_array($bootstrap)) {
            throw new \RuntimeException('http-contract.json has no publicPage.bootstrap block.');
        }

        /** @var mixed $contentElementId */
        $contentElementId = $bootstrap['contentElementId'] ?? null;
        /** @var mixed $appearanceElementId */
        $appearanceElementId = $bootstrap['appearanceElementId'] ?? null;
        /** @var mixed $declared */
        $declared = $bootstrap['appearanceCustomProperties'] ?? null;

        if (!\is_string($contentElementId) || !\is_string($appearanceElementId)) {
            throw new \RuntimeException('publicPage.bootstrap declares no element ids.');
        }

        if (!\is_array($declared) || $declared === []) {
            throw new \RuntimeException('publicPage.bootstrap declares no custom properties.');
        }

        $properties = [];
        foreach ($declared as $property) {
            if (
                !\is_array($property)
                || !\is_string($property['name'] ?? null)
                || !\is_string($property['source'] ?? null)
                || !\is_string($property['key'] ?? null)
            ) {
                throw new \RuntimeException('publicPage.bootstrap has a malformed custom property.');
            }

            $properties[] = [
                'name' => $property['name'],
                'source' => $property['source'],
                'key' => $property['key'],
            ];
        }

        return new self($contentElementId, $appearanceElementId, $properties);
    }

    /**
     * Injects an envelope into the exported HTML.
     *
     * @param string $html The exported file, verbatim.
     * @param array<string, mixed> $envelope A validated published envelope.
     * @return string The rewritten HTML.
     * @throws PublicPageBootstrapException When an element is absent. The caller
     *         serves the file unchanged rather than a half-injected page.
     */
    public function inject(string $html, array $envelope): string
    {
        /** @var mixed $content */
        $content = $envelope['content'] ?? null;
        $appearance = \is_array($content) ? ($content['appearance'] ?? null) : null;

        $html = $this->replaceElement(
            $html,
            'script',
            $this->contentElementId,
            $this->encodePayload($envelope),
        );

        return $this->replaceElement(
            $html,
            'style',
            $this->appearanceElementId,
            $this->renderAppearance(\is_array($appearance) ? $appearance : []),
        );
    }

    /**
     * Encodes the envelope for the script element.
     *
     * `JSON_HEX_*` is applied by the encoder itself, so the escaping lands inside
     * string values and never on JSON's own delimiters — the result is both
     * unbreakable-out-of and still parseable, which a substitution over finished
     * JSON could not achieve. `JSON_UNESCAPED_UNICODE` keeps the French copy as
     * UTF-8, matching what `GET /api/content` sends and what the export baked in.
     *
     * @param array<string, mixed> $envelope
     */
    private function encodePayload(array $envelope): string
    {
        $json = json_encode(
            $envelope,
            JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
                | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE,
        );

        if ($json === false) {
            throw new PublicPageBootstrapException(
                'The published envelope could not be encoded for injection: ' . json_last_error_msg(),
            );
        }

        return $json;
    }

    /**
     * Builds the `:root` block from a validated appearance document.
     *
     * Every value is re-checked against the hex pattern on the way out, even
     * though the envelope was validated before it got here. This is the last point
     * before an editorial value becomes CSS text, and the invariant
     * `page.appearanceIsColoursOnly` is only actually true if something enforces
     * it here. A value that fails is dropped, never emitted: the property then
     * falls back to whatever the stylesheet declares, which is a slightly wrong
     * colour rather than a broken rule or an injection point.
     *
     * The parameter is `array<mixed>` rather than `array<string, mixed>` because
     * that is what it honestly is: a sub-document of decoded JSON, whose keys are
     * whatever was on disk. Both lookups below are guarded, so an array with
     * numeric keys or no keys at all yields an empty block rather than a type
     * error — which is the behaviour a document this method is not allowed to
     * trust should have.
     *
     * @param array<mixed> $appearance
     */
    public function renderAppearance(array $appearance): string
    {
        /** @var mixed $palette */
        $palette = $appearance['palette'] ?? null;
        /** @var mixed $tints */
        $tints = $appearance['sectionTints'] ?? null;

        $palette = \is_array($palette) ? $palette : [];
        $tints = \is_array($tints) ? $tints : [];

        $declarations = [];

        foreach ($this->customProperties as $property) {
            /** @var mixed $raw */
            $raw = $property['source'] === 'sectionTint'
                ? ($tints[$property['key']] ?? null)
                : ($palette[$property['key']] ?? null);

            if (!Appearance::isHexColor($raw)) {
                continue;
            }

            /** @var string $raw */
            $value = Appearance::normalizeHex($raw);

            if ($property['source'] === 'readableForeground') {
                $value = Appearance::readableForeground($value);
            }

            $declarations[] = $property['name'] . ':' . $value;
        }

        return ':root{' . implode(';', $declarations) . '}';
    }

    /**
     * Replaces one element's contents, located by id.
     *
     * Matching on `id` rather than on the exact opening tag is deliberate: the
     * bundler is free to reorder or add attributes between builds, and an
     * injection that silently stops matching is the worst available failure — the
     * site keeps serving, just never updating again.
     *
     * @throws PublicPageBootstrapException When the element is not in the file.
     */
    private function replaceElement(
        string $html,
        string $tag,
        string $id,
        string $contents,
    ): string {
        $pattern = \sprintf(
            '#(<%1$s\b[^>]*\bid="%2$s"[^>]*>)(.*?)(</%1$s>)#s',
            preg_quote($tag, '#'),
            preg_quote($id, '#'),
        );

        $replaced = preg_replace_callback(
            $pattern,
            static fn (array $matches): string => $matches[1] . $contents . $matches[3],
            $html,
            1,
            $count,
        );

        if ($replaced === null || $count !== 1) {
            throw new PublicPageBootstrapException(
                \sprintf('The exported page has no <%s id="%s"> element to inject into.', $tag, $id),
            );
        }

        return $replaced;
    }
}
