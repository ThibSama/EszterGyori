<?php

declare(strict_types=1);

namespace Eszter\Backup;

/**
 * A minimal POSIX ustar reader and writer, gzip-compressed (ESZ-083).
 *
 * ## Why this is here and not `PharData` or `exec('tar')`
 *
 * A backup is worthless unless it can be *made* on the host that holds the data
 * and *read* on whatever machine is doing the restore, and both ends of that on
 * shared hosting are less certain than they look. `exec()` is frequently disabled
 * and the presence of a `tar` binary is not a guarantee the plan makes. `PharData`
 * needs `ext-phar`, which is compiled in by default but is also one of the first
 * extensions a hardened shared host removes — it is absent from the CLI this was
 * developed against. Depending on either means the backup tool fails on the day
 * someone needs it, which is the only day it matters.
 *
 * `ext-zlib` is the one dependency, and Composer already needs it. Everything else
 * is `pack()` over a 512-byte header. ustar is a thirty-year-old format that fits
 * on one page, so writing it is cheaper than depending on something that might not
 * be installed.
 *
 * ## Deliberately not a general tar implementation
 *
 * Regular files and directories, no symlinks, no hard links, no device nodes, no
 * PAX or GNU extensions. Every one of those is a way for an archive to describe
 * something other than a file, and a restore that followed one would write outside
 * the directory it was given. The reader refuses any type flag it does not
 * recognise rather than skipping it, so an archive this class cannot fully
 * understand is never partially applied.
 *
 * Paths are ASCII, relative, and at most 99 bytes — the ustar name field without
 * the prefix split. The backup set's own paths are `content/draft.json` and
 * `media/med_<32 hex>.jpg`, so the limit is never approached; the writer refuses
 * rather than truncating if it ever is, because a silently shortened path is a
 * file restored to the wrong place.
 */
final class TarArchive
{
    private const BLOCK = 512;
    private const NAME_MAX = 99;

    private const TYPE_FILE = '0';
    private const TYPE_DIRECTORY = '5';

    /**
     * Writes $entries to $path as a gzip-compressed tar.
     *
     * Deterministic: the entries are emitted in the order given, every header
     * field that is not the path or the size is a constant, and the modification
     * time is the one supplied rather than the wall clock. Two backups of
     * identical bytes therefore differ only where the data does, which is what
     * makes "did anything change?" answerable by comparing digests.
     *
     * @param array<string, string> $entries Relative path => file contents.
     */
    public static function write(string $path, array $entries, int $modifiedAt): void
    {
        if (\count($entries) > BackupSet::MAX_ARCHIVE_ENTRIES) {
            throw new BackupException(\sprintf(
                'The backup contains more than the %d entry ceiling.',
                BackupSet::MAX_ARCHIVE_ENTRIES,
            ));
        }

        $totalBytes = 0;
        foreach ($entries as $entryPath => $contents) {
            self::assertWritablePath($entryPath);
            $bytes = \strlen($contents);
            if ($bytes > BackupSet::MAX_ENTRY_BYTES) {
                throw new BackupException(\sprintf(
                    'Backup entry %s is over the %d byte per-entry ceiling.',
                    $entryPath,
                    BackupSet::MAX_ENTRY_BYTES,
                ));
            }
            if ($bytes > BackupSet::MAX_TOTAL_BYTES - $totalBytes) {
                throw new BackupException(\sprintf(
                    'The backup is over the %d byte cumulative ceiling.',
                    BackupSet::MAX_TOTAL_BYTES,
                ));
            }
            $totalBytes += $bytes;
        }

        $handle = @gzopen($path, 'wb9');

        if ($handle === false) {
            throw new BackupException("Could not open the archive for writing: {$path}");
        }

        try {
            foreach ($entries as $entryPath => $contents) {
                self::put($handle, self::header($entryPath, \strlen($contents), self::TYPE_FILE, $modifiedAt));
                self::put($handle, $contents);

                // Every entry is padded to a block boundary. Omitting this is the
                // classic way to produce an archive that the next entry's header
                // is misaligned in, which readers report as corruption several
                // files later than the mistake.
                $remainder = \strlen($contents) % self::BLOCK;

                if ($remainder !== 0) {
                    self::put($handle, str_repeat("\0", self::BLOCK - $remainder));
                }
            }

            // Two zero blocks terminate the archive. GNU tar warns about a missing
            // terminator and other readers simply stop at the first short read, so
            // an archive without them is one that only *usually* reads back.
            self::put($handle, str_repeat("\0", self::BLOCK * 2));
        } finally {
            gzclose($handle);
        }
    }

    /**
     * Reads every regular file out of $path.
     *
     * Held in memory rather than streamed. The backup set is editorial JSON and
     * image derivatives for a five-page site — tens of megabytes at the very
     * outside — and streaming would trade a real simplification for a saving
     * nobody here would notice. {@see BackupSet} is where the size assumption is
     * stated and bounded.
     *
     * @return array<string, string> Relative path => file contents, in archive order.
     */
    public static function read(
        string $path,
        int $maxEntryBytes = BackupSet::MAX_ENTRY_BYTES,
        int $maxTotalBytes = BackupSet::MAX_TOTAL_BYTES,
        int $maxEntries = BackupSet::MAX_ARCHIVE_ENTRIES,
    ): array {
        if ($maxEntryBytes < 1 || $maxTotalBytes < 1 || $maxEntries < 1) {
            throw new \InvalidArgumentException('Archive read ceilings must be positive.');
        }
        if ($maxEntries > \intdiv(PHP_INT_MAX - $maxTotalBytes - (2 * self::BLOCK), 2 * self::BLOCK)) {
            throw new \InvalidArgumentException('Archive read ceilings overflow the expanded-byte counter.');
        }
        $maximumExpanded = $maxTotalBytes + (((2 * $maxEntries) + 2) * self::BLOCK);
        $handle = @gzopen($path, 'rb');

        if ($handle === false) {
            throw new BackupException("Could not open the archive for reading: {$path}");
        }

        $entries = [];
        $entryCount = 0;
        $totalBytes = 0;
        $expandedBytes = 0;

        try {
            while (true) {
                $header = self::take(
                    $handle,
                    self::BLOCK,
                    $expandedBytes,
                    $maximumExpanded,
                );

                if ($header === null || trim($header, "\0") === '') {
                    // A zero block is the terminator; a short read is the end of a
                    // truncated file, and both mean "no more entries". The
                    // manifest is what distinguishes a complete archive from a
                    // truncated one, and it does so by name and digest rather
                    // than by trusting the terminator.
                    break;
                }

                [$entryPath, $size, $type] = self::parseHeader($header);

                ++$entryCount;
                if ($entryCount > $maxEntries) {
                    throw new BackupException(\sprintf(
                        'The archive contains more than the %d entry ceiling.',
                        $maxEntries,
                    ));
                }

                if ($size > $maxEntryBytes) {
                    throw new BackupException(\sprintf(
                        'Archive entry %s declares %d bytes, over the %d byte per-entry ceiling.',
                        $entryPath,
                        $size,
                        $maxEntryBytes,
                    ));
                }

                if ($size > $maxTotalBytes - $totalBytes) {
                    throw new BackupException(\sprintf(
                        'The archive declares more than the %d byte cumulative ceiling.',
                        $maxTotalBytes,
                    ));
                }
                $totalBytes += $size;

                $contents = $size === 0 ? '' : self::take(
                    $handle,
                    $size,
                    $expandedBytes,
                    $maximumExpanded,
                );

                if ($contents === null) {
                    throw new BackupException("The archive ends inside {$entryPath}; it is truncated.");
                }

                $remainder = $size % self::BLOCK;

                if ($remainder !== 0) {
                    if (
                        self::take(
                            $handle,
                            self::BLOCK - $remainder,
                            $expandedBytes,
                            $maximumExpanded,
                        ) === null
                    ) {
                        throw new BackupException("The archive ends inside {$entryPath}; it is truncated.");
                    }
                }

                if ($type === self::TYPE_FILE) {
                    if (isset($entries[$entryPath])) {
                        throw new BackupException("The archive contains duplicate entry {$entryPath}.");
                    }
                    $entries[$entryPath] = $contents;
                }
            }
        } finally {
            gzclose($handle);
        }

        return $entries;
    }

    /**
     * @return array{0: string, 1: int, 2: string}
     */
    private static function parseHeader(string $header): array
    {
        $checksum = trim(substr($header, 148, 8), "\0 ");

        // The header's own checksum, verified before any field in it is believed.
        // Without this, a corrupted size field is read as a size and the reader
        // walks off into the middle of the next file's data.
        $blanked = substr_replace($header, str_repeat(' ', 8), 148, 8);
        $actual = 0;
        for ($i = 0; $i < self::BLOCK; ++$i) {
            $actual += \ord($blanked[$i]);
        }

        if (preg_match('/^[0-7]{1,6}$/D', $checksum) !== 1 || octdec($checksum) !== $actual) {
            throw new BackupException('The archive contains a header whose checksum does not match.');
        }

        $name = rtrim(substr($header, 0, 100), "\0");
        $sizeField = substr($header, 124, 12);
        $type = substr($header, 156, 1);

        if ($type === "\0") {
            // Historic tar wrote a NUL for a regular file.
            $type = self::TYPE_FILE;
        }

        if ($type !== self::TYPE_FILE && $type !== self::TYPE_DIRECTORY) {
            // Refused, not skipped. A symlink, a hard link or a device node is a
            // way for an archive to describe something other than a file, and a
            // restore that quietly ignored one would be a restore that silently
            // omitted data — or, worse, one that a slightly different reader
            // would have applied.
            throw new BackupException("The archive contains an unsupported entry type `{$type}`.");
        }

        self::assertReadablePath($name);

        return [$name, self::parseSize($sizeField), $type];
    }

    /**
     * Parses the POSIX octal size without `octdec()`, whose float fallback and
     * permissive prefix parsing can turn a malformed or overflowing field into a
     * believable allocation size.
     */
    private static function parseSize(string $field): int
    {
        if (preg_match('/^[0-7]{1,11}(?:\0| )*$/D', $field) !== 1) {
            throw new BackupException('The archive contains a malformed or overflowing size header.');
        }

        $digits = rtrim($field, "\0 ");
        $size = 0;

        foreach (str_split($digits) as $digit) {
            $value = \ord($digit) - \ord('0');
            if ($size > \intdiv(PHP_INT_MAX - $value, 8)) {
                throw new BackupException('The archive contains a malformed or overflowing size header.');
            }
            $size = ($size * 8) + $value;
        }

        return $size;
    }

    private static function header(string $path, int $size, string $type, int $modifiedAt): string
    {
        $header = pack('a100', $path)
            . pack('a8', '0000644' . "\0")
            . pack('a8', '0000000' . "\0")
            . pack('a8', '0000000' . "\0")
            . pack('a12', \sprintf('%011o', $size) . "\0")
            . pack('a12', \sprintf('%011o', $modifiedAt) . "\0")
            . str_repeat(' ', 8)
            . $type
            . pack('a100', '')
            . pack('a6', 'ustar')
            . pack('a2', '00')
            . pack('a32', 'eszter')
            . pack('a32', 'eszter')
            . pack('a8', '')
            . pack('a8', '')
            . pack('a155', '');

        $header = str_pad($header, self::BLOCK, "\0");

        $checksum = 0;
        for ($i = 0; $i < self::BLOCK; ++$i) {
            $checksum += \ord($header[$i]);
        }

        return substr_replace(
            $header,
            \sprintf('%06o', $checksum) . "\0 ",
            148,
            8,
        );
    }

    private static function assertWritablePath(string $path): void
    {
        if (\strlen($path) > self::NAME_MAX) {
            throw new BackupException(
                "Backup entry path is longer than ustar allows without a prefix: {$path}",
            );
        }

        self::assertReadablePath($path);
    }

    /**
     * The one rule that decides whether an archive can escape its destination.
     *
     * A restore joins these names onto a directory, so `../` or a leading slash in
     * one of them is a write outside the tree the operator named. Enforced on both
     * the write and the read side: an archive this application produced is safe by
     * construction, and one it merely *received* is not.
     */
    private static function assertReadablePath(string $path): void
    {
        if ($path === '' || preg_match('#^[A-Za-z0-9][A-Za-z0-9._/-]*$#', $path) !== 1) {
            throw new BackupException("Backup entry path is not an accepted relative path: {$path}");
        }

        foreach (explode('/', $path) as $segment) {
            if ($segment === '' || $segment === '.' || $segment === '..') {
                throw new BackupException("Backup entry path traverses directories: {$path}");
            }
        }
    }

    /** @param resource $handle */
    private static function put(mixed $handle, string $bytes): void
    {
        if (gzwrite($handle, $bytes) !== \strlen($bytes)) {
            throw new BackupException('Short write while producing the archive.');
        }
    }

    /**
     * @param resource $handle
     * @return string|null Null when the stream ended before $length bytes.
     */
    private static function take(
        mixed $handle,
        int $length,
        ?int &$expandedBytes = null,
        ?int $maximumExpanded = null,
    ): ?string {
        $buffer = '';

        while (\strlen($buffer) < $length) {
            $chunk = gzread($handle, min(64 * 1024, $length - \strlen($buffer)));

            if ($chunk === false || $chunk === '') {
                return null;
            }

            if ($expandedBytes !== null) {
                $expandedBytes += \strlen($chunk);
                if ($maximumExpanded !== null && $expandedBytes > $maximumExpanded) {
                    throw new BackupException('The archive exceeds the cumulative uncompressed ceiling.');
                }
            }

            $buffer .= $chunk;
        }

        return $buffer;
    }
}
