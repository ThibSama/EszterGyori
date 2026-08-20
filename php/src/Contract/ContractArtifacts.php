<?php

declare(strict_types=1);

namespace Eszter\Contract;

/**
 * The one door onto `contracts/generated/`.
 *
 * ESZ-011: PHP must *consume* the language-neutral artifacts, never re-derive a
 * schema by hand from the TypeScript sources (`docs/contract-freeze.md`, "What a
 * PHP implementation must do"). Everything structural this backend knows about
 * content comes through here.
 *
 * Every artifact is checked against the SHA-256 digest recorded in
 * `manifest.json` on load. A truncated upload or a half-finished deploy is a
 * hard failure, not a validator that silently accepts more than it should.
 */
final class ContractArtifacts
{
    public const MANIFEST = 'manifest.json';

    /** @var array<string, mixed> */
    private array $cache = [];

    /** @var array<string, \stdClass> */
    private array $objectCache = [];

    /** @var array<string, string>|null */
    private ?array $digests = null;

    public function __construct(private readonly string $directory)
    {
    }

    public function directory(): string
    {
        return $this->directory;
    }

    /**
     * Loads and digest-verifies one artifact.
     *
     * @return array<mixed>
     */
    public function load(string $file): array
    {
        if (isset($this->cache[$file])) {
            /** @var array<mixed> */
            return $this->cache[$file];
        }

        $path = $this->directory . \DIRECTORY_SEPARATOR . $file;
        $raw = @file_get_contents($path);

        if ($raw === false) {
            throw new ContractArtifactException("Contract artifact is missing or unreadable: {$path}");
        }

        if ($file !== self::MANIFEST) {
            $this->assertDigest($file, $raw);
        }

        try {
            /** @var mixed $decoded */
            $decoded = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $exception) {
            throw new ContractArtifactException(
                "Contract artifact is not valid JSON: {$file}",
                previous: $exception,
            );
        }

        if (!\is_array($decoded)) {
            throw new ContractArtifactException("Contract artifact is not a JSON object: {$file}");
        }

        $this->cache[$file] = $decoded;

        return $decoded;
    }

    /**
     * Verifies every artifact the manifest declares. Called at bootstrap so a
     * corrupted contract copy fails the process rather than one request.
     *
     * @return list<string> The verified file names, in manifest order.
     */
    public function verifyAll(): array
    {
        $verified = [];

        foreach ($this->digestMap() as $file => $_digest) {
            $this->load($file);
            $verified[] = $file;
        }

        return $verified;
    }

    /** @return array<mixed> */
    public function schema(string $name): array
    {
        return $this->load($name);
    }

    /**
     * The same artifact decoded to objects rather than associative arrays.
     *
     * JSON Schema needs this distinction and PHP's associative arrays destroy it:
     * `{}` and `[]` both decode to an empty PHP array, so an empty *subschema* —
     * which JSON Schema reads as "anything is valid", and which the generator
     * emits wherever a Zod transform is unrepresentable — arrives at the validator
     * as a JSON array and is rejected as not being a schema at all. Re-encoding an
     * associative array cannot recover it, because the information is already gone
     * by then; the file has to be decoded this way from the start.
     *
     * Digest verification still runs, on the same bytes, in {@see load()}.
     */
    public function schemaDocument(string $name): \stdClass
    {
        if (isset($this->objectCache[$name])) {
            return $this->objectCache[$name];
        }

        // Verifies the digest and caches the array form; the raw bytes are read
        // again here only to decode them differently.
        $this->load($name);

        $raw = @file_get_contents($this->directory . \DIRECTORY_SEPARATOR . $name);

        if ($raw === false) {
            throw new ContractArtifactException("Contract artifact is missing or unreadable: {$name}");
        }

        try {
            /** @var mixed $decoded */
            $decoded = json_decode($raw, false, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $exception) {
            throw new ContractArtifactException(
                "Contract artifact is not valid JSON: {$name}",
                previous: $exception,
            );
        }

        if (!$decoded instanceof \stdClass) {
            throw new ContractArtifactException("Contract artifact is not a JSON object: {$name}");
        }

        return $this->objectCache[$name] = $decoded;
    }

    /** @return array<mixed> */
    public function httpContract(): array
    {
        return $this->load('http-contract.json');
    }

    /**
     * The `auth` block of the HTTP contract (ESZ-025 / ESZ-026).
     *
     * The cookie name and attributes, the CSRF header, the login-failure outcome
     * and the identity normalisation rules all live in the generated artifact, so
     * PHP reads its security posture from the frozen contract rather than
     * restating it. A restatement is a place the two can disagree, and the one
     * that would win is whichever was written last.
     *
     * @return array<mixed>
     */
    public function authContract(): array
    {
        /** @var mixed $auth */
        $auth = $this->httpContract()['auth'] ?? null;

        if (!\is_array($auth)) {
            throw new ContractArtifactException('http-contract.json has no `auth` block.');
        }

        return $auth;
    }

    /** @return array<mixed> */
    public function parityCorpus(): array
    {
        return $this->load('parity-corpus.json');
    }

    /**
     * The declared semantic rules, keyed by id.
     *
     * @return array<string, array<mixed>>
     */
    public function semanticRules(): array
    {
        $document = $this->load('semantic-rules.json');
        /** @var mixed $rules */
        $rules = $document['rules'] ?? null;

        if (!\is_array($rules)) {
            throw new ContractArtifactException('semantic-rules.json has no `rules` array.');
        }

        $byId = [];
        foreach ($rules as $rule) {
            if (!\is_array($rule) || !\is_string($rule['id'] ?? null)) {
                throw new ContractArtifactException('semantic-rules.json contains an unidentified rule.');
            }
            $byId[$rule['id']] = $rule;
        }

        return $byId;
    }

    /**
     * The canonical default content, used to seed empty storage.
     *
     * It is read from `parity-corpus.json` → `bases.siteContent`, which the
     * generator emits directly from `defaultSiteContent` and which
     * `contracts/tests/parity-corpus.test.ts` asserts validates as-is. That makes
     * it the language-neutral publication of the canonical document; copying the
     * same bytes into a second generated file would only create a way for the two
     * to disagree.
     *
     * @return array<string, mixed>
     */
    public function canonicalSiteContent(): array
    {
        /** @var mixed $bases */
        $bases = $this->parityCorpus()['bases'] ?? null;
        /** @var mixed $base */
        $base = \is_array($bases) ? ($bases['siteContent'] ?? null) : null;

        if (!\is_array($base) || $base === []) {
            throw new ContractArtifactException(
                'parity-corpus.json does not carry a `bases.siteContent` document.',
            );
        }

        /** @var array<string, mixed> */
        return $base;
    }

    public function contentSchemaVersion(): int
    {
        $manifest = $this->load(self::MANIFEST);
        /** @var mixed $version */
        $version = $manifest['contentSchemaVersion'] ?? null;

        if (!\is_int($version)) {
            throw new ContractArtifactException('manifest.json has no integer contentSchemaVersion.');
        }

        return $version;
    }

    private function assertDigest(string $file, string $raw): void
    {
        $digests = $this->digestMap();

        if (!isset($digests[$file])) {
            throw new ContractArtifactException("manifest.json does not declare artifact {$file}.");
        }

        $actual = hash('sha256', $raw);

        if (!hash_equals($digests[$file], $actual)) {
            throw new ContractArtifactException(
                "Contract artifact digest mismatch for {$file}: manifest says {$digests[$file]}, file is {$actual}.",
            );
        }
    }

    /** @return array<string, string> */
    private function digestMap(): array
    {
        if ($this->digests !== null) {
            return $this->digests;
        }

        $manifest = $this->load(self::MANIFEST);
        /** @var mixed $artifacts */
        $artifacts = $manifest['artifacts'] ?? null;

        if (!\is_array($artifacts) || $artifacts === []) {
            throw new ContractArtifactException('manifest.json has no `artifacts` list.');
        }

        $digests = [];
        foreach ($artifacts as $artifact) {
            if (
                !\is_array($artifact)
                || !\is_string($artifact['file'] ?? null)
                || !\is_string($artifact['sha256'] ?? null)
            ) {
                throw new ContractArtifactException('manifest.json has a malformed artifact entry.');
            }
            $digests[$artifact['file']] = $artifact['sha256'];
        }

        return $this->digests = $digests;
    }
}
