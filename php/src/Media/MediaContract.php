<?php

declare(strict_types=1);

namespace Eszter\Media;

use Eszter\Contract\ContractArtifacts;
use Eszter\Contract\ContractArtifactException;

/**
 * The `media` block of `http-contract.json`, read rather than restated.
 *
 * Same rule as {@see \Eszter\Auth\CsrfGuard} and {@see \Eszter\Http\ErrorCatalog}:
 * the allowlist, the byte limit, the dimension bounds and the id pattern are
 * frozen in the generated artifact, and a copy of any of them in PHP would be a
 * place the two can disagree — with the PHP copy winning silently, because it is
 * the one that runs.
 *
 * The allowlist in particular. If someone widened `mediaFormats` in the contract
 * and this class held its own list, the contract test would go green while the
 * server kept refusing the new format; widen it here instead and the server would
 * accept a format nothing had agreed to.
 */
final class MediaContract
{
    /**
     * @param array<string, string> $extensionsByMimeType Verified type → the one
     *        extension a stored file of that type may take.
     */
    private function __construct(
        public readonly string $path,
        public readonly string $cacheControl,
        public readonly string $assetIdPattern,
        public readonly string $publicPathPrefix,
        public readonly string $publicPathPattern,
        public readonly array $extensionsByMimeType,
        public readonly string $uploadFieldName,
        public readonly string $uploadContentType,
        public readonly int $uploadLimitBytes,
        public readonly int $uploadEnvelopeOverheadBytes,
        public readonly int $minDimension,
        public readonly int $maxDimension,
        public readonly int $maxPixels,
        public readonly int $librarySchemaVersion,
    ) {
    }

    public static function fromArtifacts(ContractArtifacts $artifacts): self
    {
        /** @var mixed $media */
        $media = $artifacts->httpContract()['media'] ?? null;

        if (!\is_array($media)) {
            throw new ContractArtifactException('http-contract.json has no `media` block.');
        }

        /** @var mixed $formats */
        $formats = $media['formats'] ?? null;

        if (!\is_array($formats) || $formats === []) {
            throw new ContractArtifactException('http-contract.json declares no media formats.');
        }

        $extensions = [];
        foreach ($formats as $format) {
            if (
                !\is_array($format)
                || !\is_string($format['mimeType'] ?? null)
                || !\is_string($format['extension'] ?? null)
            ) {
                throw new ContractArtifactException('A media format entry is malformed.');
            }

            $extensions[$format['mimeType']] = $format['extension'];
        }

        $upload = self::block($media, 'upload');
        $dimensions = self::block($media, 'dimensions');

        return new self(
            self::string($media, 'path'),
            self::string($media, 'cacheControl'),
            self::string($media, 'assetIdPattern'),
            self::string($media, 'publicPathPrefix'),
            self::string($media, 'publicPathPattern'),
            $extensions,
            self::string($upload, 'fieldName'),
            self::string($upload, 'contentType'),
            self::int($upload, 'limitBytes'),
            self::int($upload, 'envelopeOverheadBytes'),
            self::int($dimensions, 'minDimension'),
            self::int($dimensions, 'maxDimension'),
            self::int($dimensions, 'maxPixels'),
            self::int($media, 'librarySchemaVersion'),
        );
    }

    /** @return list<string> The accepted media types, in contract order. */
    public function mimeTypes(): array
    {
        return array_keys($this->extensionsByMimeType);
    }

    public function accepts(string $mimeType): bool
    {
        return isset($this->extensionsByMimeType[$mimeType]);
    }

    /**
     * The extension a verified type stores under.
     *
     * Only ever called with a type that already passed {@see accepts()}, which is
     * what makes the stored name independent of anything the caller sent.
     */
    public function extensionFor(string $mimeType): string
    {
        if (!isset($this->extensionsByMimeType[$mimeType])) {
            throw new \LogicException("No stored extension for media type {$mimeType}.");
        }

        return $this->extensionsByMimeType[$mimeType];
    }

    /**
     * Whether $id is a well-formed asset id.
     *
     * The pattern is the whole of the validation. It admits no separator, no dot
     * and no byte outside `[0-9a-f]`, so an id that passes cannot express a path
     * fragment — which is why every filesystem operation below takes an id that
     * has already been through here, and why traversal is unrepresentable rather
     * than stripped.
     */
    public function isAssetId(string $id): bool
    {
        return preg_match('#' . $this->assetIdPattern . '#', $id) === 1;
    }

    /** Mints a fresh id: the frozen prefix plus 128 bits from the CSPRNG. */
    public function newAssetId(): string
    {
        return 'med_' . bin2hex(random_bytes(16));
    }

    public function publicPathFor(string $id, string $mimeType): string
    {
        return $this->publicPathPrefix . $id . '.' . $this->extensionFor($mimeType);
    }

    public function fileNameFor(string $id, string $mimeType): string
    {
        return $id . '.' . $this->extensionFor($mimeType);
    }

    /** The largest request this route may accept, framing included. */
    public function requestLimitBytes(): int
    {
        return $this->uploadLimitBytes + $this->uploadEnvelopeOverheadBytes;
    }

    /**
     * @param array<mixed> $source
     * @return array<mixed>
     */
    private static function block(array $source, string $key): array
    {
        /** @var mixed $value */
        $value = $source[$key] ?? null;

        if (!\is_array($value)) {
            throw new ContractArtifactException("http-contract.json has no media.{$key} block.");
        }

        return $value;
    }

    /** @param array<mixed> $source */
    private static function string(array $source, string $key): string
    {
        /** @var mixed $value */
        $value = $source[$key] ?? null;

        if (!\is_string($value) || $value === '') {
            throw new ContractArtifactException("http-contract.json has no media.{$key} string.");
        }

        return $value;
    }

    /** @param array<mixed> $source */
    private static function int(array $source, string $key): int
    {
        /** @var mixed $value */
        $value = $source[$key] ?? null;

        if (!\is_int($value) || $value <= 0) {
            throw new ContractArtifactException("http-contract.json has no positive media.{$key}.");
        }

        return $value;
    }
}
