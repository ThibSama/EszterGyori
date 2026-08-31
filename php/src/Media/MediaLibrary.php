<?php

declare(strict_types=1);

namespace Eszter\Media;

use Eszter\Contract\ContractArtifacts;
use Eszter\Contract\StructuralValidator;
use Eszter\Storage\AtomicJsonFile;
use Eszter\Storage\FileLock;
use Eszter\Storage\StorageException;
use Eszter\Support\Clock;

/**
 * The media catalogue and the bytes it describes (ESZ-036 / ESZ-037).
 *
 * Three locations, and the class owns all three so that no caller can put them
 * out of step:
 *
 * ```
 *   data/media-originals/.intake/<random>   the part, while it is inspected
 *   data/media-originals/<id>.<ext>         the verified upload
 *   public_html/media/<id>.<ext>            the derivative — the only reachable one
 *   data/content/media-library.json         the catalogue
 * ```
 *
 * ## Why the catalogue is a file next to draft.json
 *
 * It has the same durability requirement as the draft — one writer, an atomic
 * replacement, a reader that never sees half a document — so it uses the same
 * {@see AtomicJsonFile} and lives on the same filesystem, where `paths.tmp` is
 * already guaranteed to be. Inventing a second mechanism next to one that already
 * satisfies the requirement would only be a second thing to get wrong, and SQL is
 * ruled out by `docs/hetzner-target-architecture.md` §7: bytes stay on disk.
 *
 * It is authoritative for what the library *contains*. A file in `media/` with no
 * catalogue entry is not part of the library — nothing can reference it, because
 * no id for it was ever handed out — and this class never serves, lists or
 * deletes one.
 *
 * ## Its own lock, and why that is safe
 *
 * The library takes `media.lock`, not the content lock. {@see deleteAsset()}
 * reads content *inside* its own lock via the injected predicate, so the
 * acquisition order is always media-then-content and never the reverse: uploading
 * takes only this lock, and every content write takes only the content lock, so
 * there is no cycle to deadlock on.
 *
 * ## Finalisation order
 *
 * Original, then derivative, then catalogue entry, with every placed artefact
 * unwound if a later step fails. The entry is last on purpose: a catalogue that
 * named a file which did not exist would show the editor a broken image and offer
 * no way to tell whether the upload half-worked, whereas a placed file with no
 * entry is invisible bytes that the failure path deletes. Both are prevented; the
 * ordering decides which one a torn power cable could leave behind, and invisible
 * bytes are the better residue.
 */
final class MediaLibrary
{
    public const INDEX_FILE = 'media-library.json';

    /**
     * The catalogue's own size cap, read from
     * `storageLimits.mediaLibraryIndexLimitBytes`.
     *
     * A file that has grown past this is not a catalogue any more, and reading it
     * into memory to find that out is the failure the cap exists to prevent. One
     * entry is about 200 bytes, so this is roughly 5 000 assets — far past what a
     * five-page site will ever hold, and still bounded.
     *
     * ## ESZ-084: it is now enforced on the write as well as on the read
     *
     * Until Package 8.2 the cap was checked only when the catalogue was read.
     * That made it a cap the application could cross and then be unable to
     * uncross: every media operation reads the catalogue first — *including
     * delete*, which has to read it to find the entry — so the moment the file
     * went over, the only action that could have shrunk it stopped working, and
     * the media surface answered 500 with no route back that did not involve
     * editing JSON on the host by hand.
     *
     * It is the one storage cap a caller can actually reach, because uploads
     * append and no request bounds the total. So it is now checked against the
     * bytes about to be written: the upload that would cross the cap is refused
     * with the frozen 413 while the library is still completely readable and
     * every asset still deletable. The read check stays, for the file this
     * application did not write.
     */
    private readonly int $maxIndexBytes;

    public const INDEX_SCHEMA = 'media-library-index.schema.json';
    public const METADATA_ROLE = 'media-library';

    /** The staging prefix inside the document root's media directory. */
    private const STAGING_PREFIX = '.staging-';

    private readonly AtomicJsonFile $writer;
    private readonly FileLock $lock;

    public function __construct(
        private readonly MediaContract $contract,
        private readonly string $contentDirectory,
        private readonly string $originalsDirectory,
        private readonly string $publicMediaDirectory,
        private readonly string $tmpDirectory,
        string $lockDirectory,
        private readonly ContractArtifacts $artifacts,
        private readonly StructuralValidator $structural,
        private readonly Clock $clock,
    ) {
        $this->writer = new AtomicJsonFile($this->tmpDirectory);
        $this->lock = new FileLock($lockDirectory . \DIRECTORY_SEPARATOR . 'media.lock');
        $this->maxIndexBytes = $artifacts->storageLimitBytes('mediaLibraryIndexLimitBytes');
    }

    /** The catalogue cap in force, from the frozen contract. */
    public function maxIndexBytes(): int
    {
        return $this->maxIndexBytes;
    }

    public function indexPath(): string
    {
        return $this->contentDirectory . \DIRECTORY_SEPARATOR . self::INDEX_FILE;
    }

    public function intakeDirectory(): string
    {
        return $this->originalsDirectory . \DIRECTORY_SEPARATOR . '.intake';
    }

    /**
     * Every catalogued asset, newest first.
     *
     * The order is `uploadedAt` descending with the id as the tie-break, which
     * makes it total: two uploads inside the same millisecond would otherwise
     * order differently on each read, and a list that reshuffles under an editor
     * looks like the library changed when nothing did.
     *
     * @return list<array<string, mixed>>
     */
    public function assets(): array
    {
        /** @var list<array<string, mixed>> $assets */
        $assets = $this->lock->withLock(false, fn (): array => $this->readIndex()['assets']);

        // Compared as strings read defensively rather than cast: the schema
        // pins both fields, and an entry that somehow lacked one would sort
        // deterministically last instead of tripping over a cast.
        $field = static function (array $asset, string $key): string {
            /** @var mixed $value */
            $value = $asset[$key] ?? null;

            return \is_string($value) ? $value : '';
        };

        usort($assets, static function (array $left, array $right) use ($field): int {
            // ISO-8601 UTC timestamps sort lexicographically, which is the
            // property `IsoTimestamp` exists to guarantee.
            $byTime = strcmp($field($right, 'uploadedAt'), $field($left, 'uploadedAt'));

            return $byTime !== 0 ? $byTime : strcmp($field($right, 'id'), $field($left, 'id'));
        });

        return $assets;
    }

    /**
     * One asset's metadata, or null when the catalogue does not carry it.
     *
     * A malformed id returns null rather than raising for internal callers. The
     * HTTP delete endpoint validates its request first, so a malformed id is 400
     * `VALIDATION_FAILED`; only a well-formed id absent from the catalogue is 404.
     *
     * @return array<string, mixed>|null
     */
    public function find(string $id): ?array
    {
        if (!$this->contract->isAssetId($id)) {
            return null;
        }

        /** @var array<string, mixed>|null */
        return $this->lock->withLock(false, function () use ($id): ?array {
            foreach ($this->readIndex()['assets'] as $asset) {
                if (($asset['id'] ?? null) === $id) {
                    return $asset;
                }
            }

            return null;
        });
    }

    /** A fresh intake path: inside the originals tree, random, no extension. */
    public function newIntakePath(): string
    {
        $this->ensureDirectory($this->intakeDirectory());

        return $this->intakeDirectory() . \DIRECTORY_SEPARATOR . bin2hex(random_bytes(16));
    }

    /**
     * A staging path *inside* the served media directory.
     *
     * Deliberately not in `paths.tmp`. The derivative is published by renaming
     * it, and `rename()` is only atomic within one filesystem; staging it in the
     * directory it will be renamed inside makes that true no matter how the host
     * is laid out, which is the same reason intake lives inside the originals
     * directory.
     *
     * Being briefly present under the document root costs nothing, because the
     * generated `media/.htaccess` denies every name that is not a well-formed
     * `<id>.<ext>` — a staging file is not addressable even while it exists.
     */
    public function newStagingPath(): string
    {
        $this->ensureDirectory($this->publicMediaDirectory);

        return $this->publicMediaDirectory . \DIRECTORY_SEPARATOR
            . self::STAGING_PREFIX . bin2hex(random_bytes(16));
    }

    public function ensureDirectories(): void
    {
        $this->ensureDirectory($this->contentDirectory);
        $this->ensureDirectory($this->tmpDirectory);
        $this->ensureDirectory($this->originalsDirectory);
        $this->ensureDirectory($this->intakeDirectory());
        $this->ensureDirectory($this->publicMediaDirectory);
    }

    /**
     * Moves a verified original and its derivative into place and catalogues them.
     *
     * Everything it places, it unwinds on failure — including the original, which
     * would otherwise survive as an untracked file that nothing can ever reach or
     * remove. The catalogue write is last and is a single atomic rename, so the
     * operation has one instant at which it becomes true.
     *
     * @param array{
     *     id: string,
     *     path: string,
     *     mimeType: string,
     *     byteSize: int,
     *     width: int,
     *     height: int,
     *     uploadedAt: string,
     * } $metadata Already contract-shaped, minus nothing.
     * @return array<string, mixed> The catalogued metadata, read back from disk.
     */
    public function publishAsset(
        string $id,
        string $verifiedOriginalPath,
        string $verifiedDerivativePath,
        array $metadata,
    ): array {
        $this->ensureDirectories();

        $fileName = $this->contract->fileNameFor($id, $metadata['mimeType']);
        $originalTarget = $this->originalsDirectory . \DIRECTORY_SEPARATOR . $fileName;
        $publicTarget = $this->publicMediaDirectory . \DIRECTORY_SEPARATOR . $fileName;

        /** @var array<string, mixed> */
        return $this->lock->withLock(true, function () use (
            $id,
            $metadata,
            $verifiedOriginalPath,
            $verifiedDerivativePath,
            $originalTarget,
            $publicTarget,
        ): array {
            $index = $this->readIndex();

            foreach ($index['assets'] as $asset) {
                if (($asset['id'] ?? null) === $id) {
                    // Unreachable with 128 bits of CSPRNG output. Stated because
                    // the alternative to raising is overwriting an asset that
                    // published content may already point at.
                    throw new StorageException(
                        StorageException::WRITE_FAILED,
                        "A media asset already exists under the generated id {$id}.",
                        self::METADATA_ROLE,
                    );
                }
            }

            $placed = [];

            try {
                if (!@rename($verifiedOriginalPath, $originalTarget)) {
                    throw new StorageException(
                        StorageException::RENAME_FAILED,
                        "Could not move the verified original onto {$originalTarget}.",
                        self::METADATA_ROLE,
                    );
                }
                $placed[] = $originalTarget;
                @chmod($originalTarget, AtomicJsonFile::FILE_MODE);

                if (!@rename($verifiedDerivativePath, $publicTarget)) {
                    throw new StorageException(
                        StorageException::RENAME_FAILED,
                        "Could not move the derivative onto {$publicTarget}.",
                        self::METADATA_ROLE,
                    );
                }
                $placed[] = $publicTarget;
                // 0644, not the 0640 the catalogue uses: this one is served by
                // Apache, which usually runs as a different user.
                @chmod($publicTarget, 0o644);

                $index['assets'][] = $metadata;
                $this->writeIndex($index);
            } catch (\Throwable $failure) {
                foreach ($placed as $path) {
                    @unlink($path);
                }

                throw $failure;
            }

            $stored = $this->findIn($this->readIndex(), $id);

            if ($stored === null) {
                throw new StorageException(
                    StorageException::VALIDATION_FAILED,
                    "The catalogue does not carry {$id} after writing it.",
                    self::METADATA_ROLE,
                );
            }

            return $stored;
        });
    }

    /**
     * Removes one asset, its original and its catalogue entry.
     *
     * $isReferenced is consulted **inside** the lock and decides nothing else: it
     * is given the asset's public path and answers whether any content document
     * still points at it. Injecting it keeps this class free of any dependency on
     * content storage, and — more usefully — makes the refusal testable without
     * a content directory.
     *
     * A catalogue entry whose file is already gone still deletes cleanly. The goal
     * state is "this asset is not in the library", and refusing to reach it
     * because a file is missing would make a disagreement between disk and
     * catalogue permanent.
     *
     * @param callable(string): bool $isReferenced
     * @throws MediaMissingException When the catalogue has no such asset.
     * @throws MediaReferencedException When a document still points at the asset.
     * @return array<string, mixed> The metadata of what was removed.
     */
    public function deleteAsset(string $id, callable $isReferenced): array
    {
        /** @var array<string, mixed> */
        return $this->lock->withLock(true, function () use ($id, $isReferenced): array {
            $index = $this->readIndex();
            $asset = $this->findIn($index, $id);

            if ($asset === null) {
                throw new MediaMissingException($id);
            }

            /** @var mixed $publicPath */
            $publicPath = $asset['path'] ?? null;

            if (!\is_string($publicPath) || $publicPath === '') {
                // Unreachable: the catalogue was validated against a schema that
                // requires `path` to match the frozen public-path pattern. The
                // alternative to raising is deriving a filesystem path from
                // something that is not one.
                throw new StorageException(
                    StorageException::VALIDATION_FAILED,
                    "The catalogue entry for {$id} carries no usable public path.",
                    self::METADATA_ROLE,
                );
            }

            if ($isReferenced($publicPath)) {
                throw new MediaReferencedException($id);
            }

            $index['assets'] = array_values(array_filter(
                $index['assets'],
                static fn (array $candidate): bool => ($candidate['id'] ?? null) !== $id,
            ));

            // The catalogue first, then the bytes. If the process dies between
            // them the asset is already out of the library and the files are
            // unreachable orphans; the reverse order would leave the catalogue
            // advertising an asset whose file had gone.
            $this->writeIndex($index);

            $fileName = basename($publicPath);
            @unlink($this->publicMediaDirectory . \DIRECTORY_SEPARATOR . $fileName);
            @unlink($this->originalsDirectory . \DIRECTORY_SEPARATOR . $fileName);

            return $asset;
        });
    }

    /**
     * @param array{schemaVersion: int, assets: list<array<string, mixed>>} $index
     * @return array<string, mixed>|null
     */
    private function findIn(array $index, string $id): ?array
    {
        foreach ($index['assets'] as $asset) {
            if (($asset['id'] ?? null) === $id) {
                return $asset;
            }
        }

        return null;
    }

    /**
     * Reads and validates the catalogue, treating an absent file as empty.
     *
     * Absent is a first upload, not a fault, so it seeds in memory rather than on
     * disk — a read that wrote would mean listing an empty library left a file
     * behind. A file that *exists* and does not validate raises, and is never
     * repaired or replaced: the same fail-fast rule {@see \Eszter\Storage\ContentStorage}
     * follows, for the same reason. Silently rewriting a catalogue the service
     * cannot parse is how the record of which files are in use gets destroyed.
     *
     * @return array{schemaVersion: int, assets: list<array<string, mixed>>}
     */
    private function readIndex(): array
    {
        $path = $this->indexPath();

        if (!is_file($path)) {
            return ['schemaVersion' => $this->contract->librarySchemaVersion, 'assets' => []];
        }

        $size = @filesize($path);

        if ($size === false) {
            throw new StorageException(
                StorageException::READ_FAILED,
                "Could not stat the media catalogue at {$path}.",
                self::METADATA_ROLE,
            );
        }

        if ($size > $this->maxIndexBytes) {
            throw new StorageException(
                StorageException::FILE_TOO_LARGE,
                "The media catalogue is {$size} bytes, over the {$this->maxIndexBytes} byte cap.",
                self::METADATA_ROLE,
            );
        }

        $raw = @file_get_contents($path);

        if ($raw === false) {
            throw new StorageException(
                StorageException::READ_FAILED,
                "Could not read the media catalogue at {$path}.",
                self::METADATA_ROLE,
            );
        }

        try {
            /** @var mixed $decoded */
            $decoded = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $exception) {
            throw new StorageException(
                StorageException::INVALID_JSON,
                'The media catalogue contains invalid JSON.',
                self::METADATA_ROLE,
                $exception,
            );
        }

        return $this->validatedIndex($decoded);
    }

    /**
     * @param array{schemaVersion: int, assets: list<array<string, mixed>>} $index
     */
    private function writeIndex(array $index): void
    {
        $this->writer->write(
            $this->indexPath(),
            $this->validatedIndex($index),
            self::METADATA_ROLE,
            // ESZ-084. The cap is applied here rather than only on the next read,
            // so a catalogue that would cross it is never written and every asset
            // it already holds stays deletable. See the note on $maxIndexBytes.
            $this->maxIndexBytes,
        );
    }

    /**
     * @return array{schemaVersion: int, assets: list<array<string, mixed>>}
     */
    private function validatedIndex(mixed $candidate): array
    {
        $issues = $this->structural->validate($candidate, self::INDEX_SCHEMA);

        if ($issues !== [] || !\is_array($candidate)) {
            throw new StorageException(
                StorageException::VALIDATION_FAILED,
                'The media catalogue failed contract validation: ' . \count($issues) . ' issue(s).',
                self::METADATA_ROLE,
            );
        }

        /** @var array{schemaVersion: int, assets: list<array<string, mixed>>} $candidate */
        return $candidate;
    }

    /** The catalogue's declared schema version, for a freshly seeded library. */
    public function schemaVersion(): int
    {
        return $this->contract->librarySchemaVersion;
    }

    public function nowIso(): string
    {
        return $this->clock->nowIso();
    }

    public function artifacts(): ContractArtifacts
    {
        return $this->artifacts;
    }

    private function ensureDirectory(string $directory): void
    {
        if (is_dir($directory)) {
            return;
        }

        if (!@mkdir($directory, 0o770, true) && !is_dir($directory)) {
            throw new StorageException(
                StorageException::DIRECTORY_FAILED,
                "Could not create media directory {$directory}.",
                self::METADATA_ROLE,
            );
        }
    }
}
