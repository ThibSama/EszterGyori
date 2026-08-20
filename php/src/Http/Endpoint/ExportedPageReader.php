<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

/**
 * The exported `index.html` the public page injects into.
 *
 * An interface for the same reason {@see \Eszter\Storage\PublishedContentReader}
 * is one: the HTTP conformance suite replays the contract's public-page cases
 * against the real endpoint, and it needs a known export to assert against rather
 * than whatever `front/out/` happens to contain when the suite runs. Production
 * passes the filesystem-backed implementation.
 */
interface ExportedPageReader
{
    /**
     * @return string The exported HTML, verbatim.
     * @throws \Eszter\Storage\StorageException When the export cannot be read.
     */
    public function readExportedPage(): string;
}
