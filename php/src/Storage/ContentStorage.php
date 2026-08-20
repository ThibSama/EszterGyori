<?php

declare(strict_types=1);

namespace Eszter\Storage;

use Eszter\Contract\ContentValidator;
use Eszter\Contract\ContractArtifacts;
use Eszter\Contract\ValidationResult;
use Eszter\Support\Clock;

/**
 * `draft.json` and `published.json`, ported from the reference implementation.
 *
 * The envelope semantics are unchanged and binding
 * (`docs/hetzner-target-architecture.md` §4):
 *
 *   canonical defaults ─seed─▶ draft ─explicit publish─▶ published
 *
 * `revision` is a non-negative integer and the **only** input to the
 * `"published-<revision>"` ETag, so a write that changes content without bumping
 * it leaves every cache serving the old document indefinitely. Nothing here bumps
 * it implicitly; callers own that, and the publish path that will do so is ESZ-013+.
 *
 * ## Strict fail-fast
 *
 * {@see initialize()} seeds a *missing* file from the canonical defaults and
 * **validates** an existing one. A file that exists but is malformed, oversized,
 * schema-incompatible or semantically invalid raises — it is never repaired,
 * replaced or bypassed, because the alternative is overwriting an editor's work
 * with defaults and calling it recovery.
 *
 * ## Locking
 *
 * Reads take a shared lock; only seeding and writing take the exclusive one, and
 * each write path re-checks its precondition under that lock. Two readers
 * therefore never block each other, while a reader still never observes a
 * half-written file, since every writer holds the exclusive lock across the whole
 * temp-write/fsync/rename sequence.
 */
final class ContentStorage implements PublishedContentReader
{
    /** Ported from `MAX_CONTENT_FILE_BYTES`. */
    public const MAX_FILE_BYTES = 1024 * 1024;

    public const ROLE_DRAFT = 'draft';
    public const ROLE_PUBLISHED = 'published';

    public const STATUS_CREATED = 'created';
    public const STATUS_VALIDATED = 'validated';

    private readonly AtomicJsonFile $writer;
    private readonly FileLock $lock;

    public function __construct(
        private readonly string $contentDirectory,
        private readonly string $tmpDirectory,
        string $lockDirectory,
        private readonly ContractArtifacts $artifacts,
        private readonly ContentValidator $validator,
        private readonly Clock $clock,
    ) {
        $this->writer = new AtomicJsonFile($this->tmpDirectory);
        $this->lock = new FileLock($lockDirectory . \DIRECTORY_SEPARATOR . 'content.lock');
    }

    public function draftPath(): string
    {
        return $this->contentDirectory . \DIRECTORY_SEPARATOR . 'draft.json';
    }

    public function publishedPath(): string
    {
        return $this->contentDirectory . \DIRECTORY_SEPARATOR . 'published.json';
    }

    /**
     * Seeds what is missing, validates what is present, and refuses anything else.
     *
     * Takes the **shared** lock whenever both files already exist, which is every
     * request after the first. Package 1.1 took the exclusive lock unconditionally
     * because this method may seed, which meant concurrent reads queued behind one
     * another for a write that almost never happens. The exclusive lock is now
     * taken only on the branch that actually writes, and that branch re-checks
     * under the lock, because another process may have seeded in the gap between
     * the two acquisitions.
     *
     * @return array{draft: string, published: string} Per-role status.
     */
    public function initialize(): array
    {
        $this->ensureDirectory($this->contentDirectory);
        $this->ensureDirectory($this->tmpDirectory);
        $this->assertSameFilesystem();

        /** @var array{draft: string, published: string}|null $status */
        $status = $this->lock->withLock(false, function (): ?array {
            if (!is_file($this->draftPath()) || !is_file($this->publishedPath())) {
                return null;
            }

            $this->readEnvelope(self::ROLE_DRAFT);
            $this->readEnvelope(self::ROLE_PUBLISHED);

            return [
                self::ROLE_DRAFT => self::STATUS_VALIDATED,
                self::ROLE_PUBLISHED => self::STATUS_VALIDATED,
            ];
        });

        if ($status !== null) {
            return $status;
        }

        return $this->lock->withLock(true, function (): array {
            return [
                self::ROLE_DRAFT => $this->ensureFile(self::ROLE_DRAFT),
                self::ROLE_PUBLISHED => $this->ensureFile(self::ROLE_PUBLISHED),
            ];
        });
    }

    /** @return array<string, mixed> The validated, normalised published envelope. */
    public function readPublished(): array
    {
        return $this->read(self::ROLE_PUBLISHED);
    }

    /** @return array<string, mixed> The validated, normalised draft envelope. */
    public function readDraft(): array
    {
        return $this->read(self::ROLE_DRAFT);
    }

    /**
     * Reads one role under the shared lock, seeding it only if it is absent.
     *
     * The absent case is a first deployment, not a repair: a file that exists but
     * does not validate raises out of {@see readEnvelope()} and is never replaced.
     *
     * @return array<string, mixed>
     */
    private function read(string $role): array
    {
        $this->ensureDirectory($this->contentDirectory);

        /** @var array<string, mixed>|null $envelope */
        $envelope = $this->lock->withLock(
            false,
            fn (): ?array => is_file($this->descriptor($role)['path'])
                ? $this->readEnvelope($role)
                : null,
        );

        if ($envelope !== null) {
            return $envelope;
        }

        $this->ensureDirectory($this->tmpDirectory);
        $this->assertSameFilesystem();

        return $this->lock->withLock(true, function () use ($role): array {
            // Re-checked under the exclusive lock: between releasing the shared
            // lock and taking this one, another process may already have seeded.
            if (!is_file($this->descriptor($role)['path'])) {
                $this->writeEnvelope($role, $this->seedEnvelope($role));
            }

            return $this->readEnvelope($role);
        });
    }

    /**
     * Validates then atomically replaces the draft envelope.
     *
     * No HTTP route reaches this yet — `/api/admin/content/draft` is frozen at 404
     * until it is added to the contract first (`docs/contract-freeze.md`). The
     * method exists so the storage layer is complete and testable, not so it can
     * be called from a request.
     */
    public function writeDraft(mixed $envelope): void
    {
        $this->lock->withLock(true, function () use ($envelope): void {
            $this->writeEnvelope(self::ROLE_DRAFT, $envelope);
        });
    }

    /** Validates then atomically replaces the published envelope. See {@see writeDraft()}. */
    public function writePublished(mixed $envelope): void
    {
        $this->lock->withLock(true, function () use ($envelope): void {
            $this->writeEnvelope(self::ROLE_PUBLISHED, $envelope);
        });
    }

    /** @return array{role: string, path: string, target: string, timestampField: string} */
    private function descriptor(string $role): array
    {
        return $role === self::ROLE_DRAFT
            ? [
                'role' => self::ROLE_DRAFT,
                'path' => $this->draftPath(),
                'target' => ContentValidator::TARGET_SERVER_DRAFT_ENVELOPE,
                'timestampField' => 'updatedAt',
            ]
            : [
                'role' => self::ROLE_PUBLISHED,
                'path' => $this->publishedPath(),
                'target' => ContentValidator::TARGET_PUBLISHED_ENVELOPE,
                'timestampField' => 'publishedAt',
            ];
    }

    private function ensureFile(string $role): string
    {
        $descriptor = $this->descriptor($role);

        if (is_file($descriptor['path'])) {
            $this->readEnvelope($role);

            return self::STATUS_VALIDATED;
        }

        $this->writeEnvelope($role, $this->seedEnvelope($role));

        return self::STATUS_CREATED;
    }

    /** @return array<string, mixed> */
    private function seedEnvelope(string $role): array
    {
        $descriptor = $this->descriptor($role);

        return [
            'schemaVersion' => $this->artifacts->contentSchemaVersion(),
            'revision' => 0,
            $descriptor['timestampField'] => $this->clock->nowIso(),
            'content' => $this->artifacts->canonicalSiteContent(),
        ];
    }

    /** @return array<string, mixed> */
    private function readEnvelope(string $role): array
    {
        $descriptor = $this->descriptor($role);
        $path = $descriptor['path'];

        $size = @filesize($path);

        if ($size === false || !is_file($path)) {
            throw new StorageException(
                StorageException::FILE_NOT_FOUND,
                "Missing {$role} content file at {$path}.",
                $role,
            );
        }

        // Checked before reading, not after: the cap exists so a runaway file
        // cannot be pulled into memory in the first place.
        if ($size > self::MAX_FILE_BYTES) {
            throw new StorageException(
                StorageException::FILE_TOO_LARGE,
                "{$role} content file is {$size} bytes, over the "
                    . self::MAX_FILE_BYTES . " byte cap.",
                $role,
            );
        }

        $raw = @file_get_contents($path);

        if ($raw === false) {
            throw new StorageException(
                StorageException::READ_FAILED,
                "Could not read {$role} content file at {$path}.",
                $role,
            );
        }

        try {
            /** @var mixed $decoded */
            $decoded = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $exception) {
            throw new StorageException(
                StorageException::INVALID_JSON,
                "{$role} content file contains invalid JSON.",
                $role,
                $exception,
            );
        }

        return $this->validated($role, $decoded, $descriptor['target']);
    }

    private function writeEnvelope(string $role, mixed $envelope): void
    {
        $descriptor = $this->descriptor($role);
        $validated = $this->validated($role, $envelope, $descriptor['target']);

        $this->writer->write($descriptor['path'], $validated, $role);
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(string $role, mixed $candidate, string $target): array
    {
        $result = $this->validator->validate($candidate, $target);

        if (!$result->valid) {
            throw new StorageException(
                StorageException::VALIDATION_FAILED,
                "{$role} content envelope failed contract validation: " . $result->summary(),
                $role,
            );
        }

        /** @var array<string, mixed> */
        return $this->assertArray($result);
    }

    /** @return array<string, mixed> */
    private function assertArray(ValidationResult $result): array
    {
        if (!\is_array($result->value)) {
            throw new \LogicException('A validated envelope must be an object.');
        }

        /** @var array<string, mixed> */
        return $result->value;
    }

    private function ensureDirectory(string $directory): void
    {
        if (is_dir($directory)) {
            return;
        }

        if (!@mkdir($directory, 0o770, true) && !is_dir($directory)) {
            throw new StorageException(
                StorageException::DIRECTORY_FAILED,
                "Could not create content storage directory {$directory}.",
            );
        }
    }

    /**
     * `rename()` is only atomic within one filesystem. Detecting a split at
     * bootstrap turns a silent durability hole into a configuration error.
     */
    private function assertSameFilesystem(): void
    {
        $content = @stat($this->contentDirectory);
        $tmp = @stat($this->tmpDirectory);

        if ($content === false || $tmp === false) {
            throw new StorageException(
                StorageException::DIRECTORY_FAILED,
                'Could not stat the content or temp directory.',
            );
        }

        if ($content['dev'] !== $tmp['dev']) {
            throw new StorageException(
                StorageException::CROSS_DEVICE_TMP,
                "paths.tmp ({$this->tmpDirectory}) and paths.content ({$this->contentDirectory}) "
                    . 'are on different filesystems, so rename() would not be atomic.',
            );
        }
    }
}
