<?php

declare(strict_types=1);

namespace Eszter\Backup;

/**
 * The index and integrity record of one backup (ESZ-083).
 *
 * ## What it is for
 *
 * A backup nobody can verify is a backup nobody should trust. The manifest names
 * every entry with its byte count and sha256, so a restore can answer three
 * questions before it writes anything: is every file the backup claims to have
 * actually here, is each one the bytes it was when it was written, and is there
 * anything here the backup does not claim — which would mean the archive was
 * assembled by something other than this tool.
 *
 * The check runs *before* the restore, not during it. A restore that discovered
 * corruption on the last file would already have overwritten the database with
 * the first.
 *
 * ## What it records beyond digests
 *
 * The applied migration versions, so a restore can refuse a set from a schema the
 * target has never reached; the content schema and HTTP contract versions, so a
 * mismatch is visible rather than mysterious; and per-table row counts, which are
 * what makes "did it all come back?" answerable by an operator reading a terminal
 * rather than by writing a query.
 *
 * The manifest is itself the one entry with no digest of its own — nothing could
 * hold it — so it carries a digest over the *rest* of the entries instead:
 * changing any file's recorded digest changes `entriesDigest`, and changing that
 * is a change to the file whose whole purpose is to be compared.
 */
final class BackupManifest
{
    /**
     * @param array<string, array{bytes: int, sha256: string}> $entries
     * @param list<string> $appliedMigrations
     * @param array<string, int> $rowCounts
     */
    private function __construct(
        public readonly int $formatVersion,
        public readonly string $createdAt,
        public readonly array $entries,
        public readonly string $entriesDigest,
        public readonly array $appliedMigrations,
        public readonly array $rowCounts,
        public readonly int $contentSchemaVersion,
        public readonly int $httpContractVersion,
        /**
         * Named so an operator reading the manifest sees the omissions too.
         *
         * @var array<string, string> Table name => why it is not in the backup.
         */
        public readonly array $excludedTables,
    ) {
    }

    /**
     * @param array<string, string> $entries Relative path => contents.
     * @param list<string> $appliedMigrations
     * @param array<string, int> $rowCounts
     * @param array<string, string> $excludedTables
     */
    public static function describe(
        array $entries,
        string $createdAt,
        array $appliedMigrations,
        array $rowCounts,
        int $contentSchemaVersion,
        int $httpContractVersion,
        array $excludedTables,
    ): self {
        $described = [];

        // Sorted by path, so the manifest reads the same however the set was
        // assembled and two manifests can be diffed line by line.
        ksort($entries);

        foreach ($entries as $path => $contents) {
            $described[$path] = ['bytes' => \strlen($contents), 'sha256' => hash('sha256', $contents)];
        }

        return new self(
            BackupSet::FORMAT_VERSION,
            $createdAt,
            $described,
            self::digestOf($described),
            $appliedMigrations,
            $rowCounts,
            $contentSchemaVersion,
            $httpContractVersion,
            $excludedTables,
        );
    }

    public static function fromJson(string $json): self
    {
        try {
            /** @var mixed $decoded */
            $decoded = json_decode($json, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException $exception) {
            throw new BackupException('The backup manifest is not valid JSON.', previous: $exception);
        }

        if (!\is_array($decoded)) {
            throw new BackupException('The backup manifest is not a JSON object.');
        }

        /** @var array<string, mixed> $decoded */
        $formatVersion = self::integer($decoded, 'formatVersion');

        if ($formatVersion !== BackupSet::FORMAT_VERSION) {
            // Refused rather than best-effort. A format this code does not know is
            // one whose entries may mean something else, and guessing about a
            // backup is the one place guessing is never worth it.
            throw new BackupException(\sprintf(
                'The backup is format version %d; this application restores version %d.',
                $formatVersion,
                BackupSet::FORMAT_VERSION,
            ));
        }

        /** @var mixed $entries */
        $entries = $decoded['entries'] ?? null;

        if (!\is_array($entries)) {
            throw new BackupException('The backup manifest declares no entries.');
        }

        $described = [];

        /** @var mixed $entry */
        foreach ($entries as $path => $entry) {
            if (!\is_string($path) || !\is_array($entry)) {
                throw new BackupException('The backup manifest has a malformed entry.');
            }

            /** @var array<string, mixed> $entry */
            $described[$path] = [
                'bytes' => self::integer($entry, 'bytes'),
                'sha256' => self::text($entry, 'sha256'),
            ];
        }

        $manifest = new self(
            $formatVersion,
            self::text($decoded, 'createdAt'),
            $described,
            self::text($decoded, 'entriesDigest'),
            self::stringList($decoded, 'appliedMigrations'),
            self::intMap($decoded, 'rowCounts'),
            self::integer($decoded, 'contentSchemaVersion'),
            self::integer($decoded, 'httpContractVersion'),
            self::stringMap($decoded, 'excludedTables'),
        );

        if (!hash_equals($manifest->entriesDigest, self::digestOf($described))) {
            throw new BackupException(
                'The backup manifest\'s entry digest does not match the entries it lists; '
                . 'the manifest has been altered.',
            );
        }

        return $manifest;
    }

    public function toJson(): string
    {
        $encoded = json_encode([
            '$comment' => 'Eszter backup manifest. Verify before restoring; see docs/backup-and-restore.md.',
            'formatVersion' => $this->formatVersion,
            'createdAt' => $this->createdAt,
            'contentSchemaVersion' => $this->contentSchemaVersion,
            'httpContractVersion' => $this->httpContractVersion,
            'appliedMigrations' => $this->appliedMigrations,
            'rowCounts' => $this->rowCounts,
            'excludedTables' => $this->excludedTables,
            'entriesDigest' => $this->entriesDigest,
            'entries' => $this->entries,
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        if ($encoded === false) {
            throw new BackupException('The backup manifest could not be encoded.');
        }

        return $encoded . "\n";
    }

    /**
     * Compares the archive against what the manifest claims, in both directions.
     *
     * Both directions matter and for different reasons. A missing or altered entry
     * is a corrupt backup. An *extra* entry is a backup this tool did not produce,
     * and a restore that wrote it would be writing a file nobody declared — which
     * is how an archive becomes a delivery mechanism rather than a backup.
     *
     * @param array<string, string> $archive Relative path => contents.
     */
    public function assertMatches(array $archive): void
    {
        foreach ($this->entries as $path => $expected) {
            if (!isset($archive[$path])) {
                throw new BackupException("The backup is missing a file it declares: {$path}");
            }

            $actual = $archive[$path];

            if (\strlen($actual) !== $expected['bytes']) {
                throw new BackupException(\sprintf(
                    'The backup entry %s is %d bytes; the manifest declares %d.',
                    $path,
                    \strlen($actual),
                    $expected['bytes'],
                ));
            }

            if (!hash_equals($expected['sha256'], hash('sha256', $actual))) {
                throw new BackupException("The backup entry {$path} does not match its recorded digest.");
            }
        }

        foreach (array_keys($archive) as $path) {
            if ($path === BackupSet::MANIFEST_FILE || isset($this->entries[$path])) {
                continue;
            }

            throw new BackupException("The backup carries a file the manifest does not declare: {$path}");
        }
    }

    /** @param array<string, array{bytes: int, sha256: string}> $entries */
    private static function digestOf(array $entries): string
    {
        ksort($entries);

        $material = '';

        foreach ($entries as $path => $entry) {
            $material .= $path . "\0" . $entry['bytes'] . "\0" . $entry['sha256'] . "\n";
        }

        return hash('sha256', $material);
    }

    /** @param array<string, mixed> $block */
    private static function integer(array $block, string $key): int
    {
        /** @var mixed $value */
        $value = $block[$key] ?? null;

        if (!\is_int($value)) {
            throw new BackupException("The backup manifest has no integer `{$key}`.");
        }

        return $value;
    }

    /** @param array<string, mixed> $block */
    private static function text(array $block, string $key): string
    {
        /** @var mixed $value */
        $value = $block[$key] ?? null;

        if (!\is_string($value) || $value === '') {
            throw new BackupException("The backup manifest has no `{$key}`.");
        }

        return $value;
    }

    /**
     * @param array<string, mixed> $block
     * @return list<string>
     */
    private static function stringList(array $block, string $key): array
    {
        /** @var mixed $value */
        $value = $block[$key] ?? null;

        if (!\is_array($value)) {
            throw new BackupException("The backup manifest has no `{$key}` list.");
        }

        $list = [];

        /** @var mixed $item */
        foreach ($value as $item) {
            if (!\is_string($item)) {
                throw new BackupException("The backup manifest's `{$key}` holds a non-string.");
            }

            $list[] = $item;
        }

        return $list;
    }

    /**
     * @param array<string, mixed> $block
     * @return array<string, int>
     */
    private static function intMap(array $block, string $key): array
    {
        /** @var mixed $value */
        $value = $block[$key] ?? null;

        if (!\is_array($value)) {
            throw new BackupException("The backup manifest has no `{$key}` map.");
        }

        $map = [];

        /** @var mixed $item */
        foreach ($value as $name => $item) {
            if (!\is_string($name) || !\is_int($item)) {
                throw new BackupException("The backup manifest's `{$key}` is malformed.");
            }

            $map[$name] = $item;
        }

        return $map;
    }

    /**
     * @param array<string, mixed> $block
     * @return array<string, string>
     */
    private static function stringMap(array $block, string $key): array
    {
        /** @var mixed $value */
        $value = $block[$key] ?? null;

        if (!\is_array($value)) {
            throw new BackupException("The backup manifest has no `{$key}` map.");
        }

        $map = [];

        /** @var mixed $item */
        foreach ($value as $name => $item) {
            if (!\is_string($name) || !\is_string($item)) {
                throw new BackupException("The backup manifest's `{$key}` is malformed.");
            }

            $map[$name] = $item;
        }

        return $map;
    }
}
