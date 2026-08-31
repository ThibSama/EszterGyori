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
 * it leaves every cache serving the old document indefinitely.
 *
 * Since ESZ-031 the sequence is **shared** by both files and moved only by the
 * three operations below: `draft.revision` is the head, `published.revision` is
 * the draft head that was published, and `published.revision <= draft.revision`
 * holds at all times. The rationale is frozen in the HTTP contract as
 * `contentRevisionSemantics`; the short version is that two independent counters
 * cannot answer "is this draft published?", and one shared sequence can.
 *
 * {@see writeDraft()} and {@see writePublished()} still write whatever envelope
 * they are given, revision included. They are not the contracted path and no
 * route reaches them.
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
    /**
     * The read guard on `draft.json` and `published.json`, from
     * `storageLimits.contentFileLimitBytes`.
     *
     * ESZ-084 moved this number into the contract and stated what it is for,
     * because standing next to a 64 kB request limit it read as a contradiction.
     * It is not one: every byte of content reaches disk through a request the
     * smaller limit already bounds, so the largest file this application can
     * write is around 65 kB and this cap is never the binding constraint. It
     * exists for the file the application did *not* write — restored, hand-edited
     * or truncated — where reading an unbounded file into memory to discover it is
     * unusable is the failure worth preventing.
     *
     * The inequality is what makes the pair safe, and it only works in this
     * direction. A storage cap *below* the request limit would accept a save,
     * write it, and refuse it on the next read — content destroyed by the rule
     * meant to protect it. `storageLimitReconciliation.invariant` states that, and
     * the contract suite asserts it.
     */
    private readonly int $maxFileBytes;

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
        $this->maxFileBytes = $artifacts->storageLimitBytes('contentFileLimitBytes');
    }

    /** The content read guard in force, from the frozen contract. */
    public function maxFileBytes(): int
    {
        return $this->maxFileBytes;
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
     * Validates then atomically replaces the draft envelope, unconditionally.
     *
     * No HTTP route reaches this. The contracted write path is
     * {@see saveDraft()}, which additionally enforces the optimistic-concurrency
     * precondition; this one exists so the storage layer is complete and
     * testable, and so a fixture can put storage into a known state without
     * having to satisfy a precondition first.
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

    // ── The contracted content operations (ESZ-031/032/033) ─────────────────
    //
    // All three live here rather than in their endpoints for one reason:
    // {@see FileLock} is not reentrant, so a read-modify-write cannot be
    // assembled from the public read and write methods above without releasing
    // the lock in the middle. The lock is this class's, and so is every
    // operation that has to hold it across more than one step.
    //
    // Each one follows the same shape — acquire exclusive, read the
    // authoritative draft, check the precondition, write, re-read — and every
    // step is inside the same acquisition. `contentRevisionSemantics` in the
    // HTTP contract is the specification these implement.

    /**
     * Replaces the draft with $content, provided the head is still $expectedRevision.
     *
     * $content must already have passed contract validation: this is the storage
     * layer, and a document that fails validation *here* is a fault, reported as
     * one. The endpoint validates what the caller sent so that a bad document is
     * the caller's 400 rather than this method's 500.
     *
     * @param array<string, mixed> $content A complete, contract-valid SiteContent.
     * @return array<string, mixed> The stored draft envelope at its new revision.
     * @throws RevisionConflictException Before anything is written.
     */
    public function saveDraft(int $expectedRevision, array $content): array
    {
        $this->prepareDirectories();

        /** @var array<string, mixed> */
        return $this->lock->withLock(true, function () use ($expectedRevision, $content): array {
            $head = $this->revisionOf($this->readOrSeedLocked(self::ROLE_DRAFT), self::ROLE_DRAFT);
            $this->assertRevisionMatches($expectedRevision, $head);

            $this->writeEnvelope(self::ROLE_DRAFT, [
                'schemaVersion' => $this->artifacts->contentSchemaVersion(),
                'revision' => $head + 1,
                'updatedAt' => $this->clock->nowIso(),
                'content' => $content,
            ]);

            // Re-read rather than returning what was just built: the caller gets
            // the document as a subsequent reader would see it, normalisation
            // included, so the response cannot describe a file that is not there.
            return $this->readEnvelope(self::ROLE_DRAFT);
        });
    }

    /**
     * Publishes the stored draft.
     *
     * The draft is re-read and re-validated inside this lock acquisition, and the
     * document that comes back is the one that gets published. Nothing the caller
     * sent participates: publish takes what is stored.
     *
     * `published.revision` becomes the draft head that was published — it is not
     * incremented — so republishing an unchanged draft is idempotent and a
     * publish that advances the site always retires the previous ETag. See
     * `contentRevisionSemantics` for why that is the frozen choice.
     *
     * The only mutation is a single `rename()` at the end of
     * {@see AtomicJsonFile::write()}, which is what makes the operation
     * all-or-nothing: a failure anywhere before it leaves the previous published
     * envelope readable and byte-identical.
     *
     * @return array<string, mixed> The stored published envelope.
     * @throws RevisionConflictException Before anything is written.
     */
    public function publishDraft(int $expectedRevision): array
    {
        $this->prepareDirectories();

        /** @var array<string, mixed> */
        return $this->lock->withLock(true, function () use ($expectedRevision): array {
            // Reading is validating: readEnvelope() raises a StorageException on a
            // draft that no longer satisfies the contract, so an unpublishable
            // document stops the publish instead of becoming published.
            $draft = $this->readOrSeedLocked(self::ROLE_DRAFT);
            $head = $this->revisionOf($draft, self::ROLE_DRAFT);
            $this->assertRevisionMatches($expectedRevision, $head);

            /** @var mixed $content */
            $content = $draft['content'] ?? null;

            if (!\is_array($content)) {
                // Unreachable through readEnvelope(), which validated the draft
                // against a schema requiring `content`. Stated so the published
                // document can never be built from something that is not one.
                throw new StorageException(
                    StorageException::VALIDATION_FAILED,
                    'The stored draft carries no content object to publish.',
                    self::ROLE_DRAFT,
                );
            }

            $this->writeEnvelope(self::ROLE_PUBLISHED, [
                'schemaVersion' => $this->artifacts->contentSchemaVersion(),
                'revision' => $head,
                'publishedAt' => $this->clock->nowIso(),
                'content' => $content,
            ]);

            return $this->readEnvelope(self::ROLE_PUBLISHED);
        });
    }

    /**
     * Rebuilds the draft from the current published content.
     *
     * Published content is **read** here and never written: this method touches
     * `draft.json` alone, so resetting an editor's work can never change what the
     * public site serves or move the published revision.
     *
     * The rebuilt draft takes the next revision like any other draft write. A
     * reset that left the head where it was would be the one draft mutation
     * invisible to the concurrency check, and a concurrent editor's next save
     * would silently undo it.
     *
     * @return array<string, mixed> The stored draft envelope at its new revision.
     * @throws RevisionConflictException Before anything is written.
     */
    public function resetDraftToPublished(int $expectedRevision): array
    {
        $this->prepareDirectories();

        /** @var array<string, mixed> */
        return $this->lock->withLock(true, function () use ($expectedRevision): array {
            $head = $this->revisionOf($this->readOrSeedLocked(self::ROLE_DRAFT), self::ROLE_DRAFT);
            $this->assertRevisionMatches($expectedRevision, $head);

            $published = $this->readOrSeedLocked(self::ROLE_PUBLISHED);
            /** @var mixed $content */
            $content = $published['content'] ?? null;

            if (!\is_array($content)) {
                throw new StorageException(
                    StorageException::VALIDATION_FAILED,
                    'The stored published envelope carries no content object to reset to.',
                    self::ROLE_PUBLISHED,
                );
            }

            $this->writeEnvelope(self::ROLE_DRAFT, [
                'schemaVersion' => $this->artifacts->contentSchemaVersion(),
                'revision' => $head + 1,
                'updatedAt' => $this->clock->nowIso(),
                'content' => $content,
            ]);

            return $this->readEnvelope(self::ROLE_DRAFT);
        });
    }

    /**
     * The draft head, for a caller that needs it without changing anything.
     *
     * Taken under the shared lock, so it never observes a half-written draft. It
     * is a snapshot the instant it is returned and must never be used as the
     * input to a write — the write paths above re-read the head under their own
     * exclusive lock precisely so that no decision depends on a value read
     * outside the lock that acts on it.
     */
    public function draftRevision(): int
    {
        return $this->revisionOf($this->read(self::ROLE_DRAFT), self::ROLE_DRAFT);
    }

    /**
     * @throws RevisionConflictException
     */
    private function assertRevisionMatches(int $expected, int $head): void
    {
        if ($expected !== $head) {
            throw new RevisionConflictException($expected, $head);
        }
    }

    /**
     * Reads one role, seeding it if absent, **assuming the lock is already held**.
     *
     * The public {@see read()} cannot be reused inside a locked closure: it takes
     * the lock itself, and {@see FileLock} refuses to nest rather than silently
     * releasing the outer one.
     *
     * @return array<string, mixed>
     */
    private function readOrSeedLocked(string $role): array
    {
        if (!is_file($this->descriptor($role)['path'])) {
            $this->writeEnvelope($role, $this->seedEnvelope($role));
        }

        return $this->readEnvelope($role);
    }

    /**
     * @param array<string, mixed> $envelope
     */
    private function revisionOf(array $envelope, string $role): int
    {
        /** @var mixed $revision */
        $revision = $envelope['revision'] ?? null;

        if (!\is_int($revision) || $revision < 0) {
            // Unreachable through readEnvelope(), whose schema pins revision to a
            // non-negative integer. Stated anyway: every revision decision below
            // is arithmetic, and arithmetic on a non-integer is how a sequence
            // silently stops being one.
            throw new StorageException(
                StorageException::VALIDATION_FAILED,
                "The stored {$role} envelope carries no usable revision.",
                $role,
            );
        }

        return $revision;
    }

    /** The directory and filesystem checks every write path needs before locking. */
    private function prepareDirectories(): void
    {
        $this->ensureDirectory($this->contentDirectory);
        $this->ensureDirectory($this->tmpDirectory);
        $this->assertSameFilesystem();
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
        if ($size > $this->maxFileBytes) {
            throw new StorageException(
                StorageException::FILE_TOO_LARGE,
                "{$role} content file is {$size} bytes, over the {$this->maxFileBytes} byte cap.",
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
