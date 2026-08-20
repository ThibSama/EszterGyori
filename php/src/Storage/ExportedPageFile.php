<?php

declare(strict_types=1);

namespace Eszter\Storage;

use Eszter\Http\Endpoint\ExportedPageReader;

/**
 * Reads the exported `index.html` from the document root.
 *
 * Deliberately thin and deliberately *not* part of {@see ContentStorage}. That
 * class owns editorial JSON: it locks, seeds, validates and writes atomically,
 * because two processes can race to change a document. This file is a read-only
 * build artifact replaced only by a deploy, so it needs none of that, and putting
 * it there would suggest it did.
 *
 * The size cap is the same idea as `ContentStorage`'s, for a different reason: not
 * to bound a document that should be small, but to refuse to buffer an arbitrarily
 * large file into memory on shared hosting because something under the document
 * root was mistaken for the page.
 */
final class ExportedPageFile implements ExportedPageReader
{
    /** A Next export of this site is ~70 kB; 4 MB is a wide margin, not a target. */
    public const MAX_PAGE_BYTES = 4 * 1024 * 1024;

    public function __construct(
        private readonly string $publicDir,
        private readonly string $fileName = 'index.html',
    ) {
    }

    public function path(): string
    {
        return $this->publicDir . \DIRECTORY_SEPARATOR . $this->fileName;
    }

    public function readExportedPage(): string
    {
        $path = $this->path();

        if (!is_file($path)) {
            throw new StorageException(
                StorageException::FILE_NOT_FOUND,
                "The exported public page is missing: {$path}",
                'public-page',
            );
        }

        $size = filesize($path);

        if ($size === false) {
            throw new StorageException(
                StorageException::READ_FAILED,
                "The exported public page could not be sized: {$path}",
                'public-page',
            );
        }

        if ($size > self::MAX_PAGE_BYTES) {
            throw new StorageException(
                StorageException::FILE_TOO_LARGE,
                \sprintf(
                    'The exported public page is %d bytes, over the %d byte limit: %s',
                    $size,
                    self::MAX_PAGE_BYTES,
                    $path,
                ),
                'public-page',
            );
        }

        $html = file_get_contents($path);

        if ($html === false) {
            throw new StorageException(
                StorageException::READ_FAILED,
                "The exported public page could not be read: {$path}",
                'public-page',
            );
        }

        return $html;
    }
}
