<?php

declare(strict_types=1);

namespace Eszter\Media;

/**
 * The seam between the ingest and PHP's upload machinery.
 *
 * `is_uploaded_file()` and `move_uploaded_file()` are the two functions that make
 * an upload path safe, and both consult a list PHP builds while parsing the
 * request. That list cannot be populated from a test, so a pipeline calling them
 * directly would be a pipeline no test could drive — and the parts of it worth
 * testing are precisely the ones after the move.
 *
 * So they sit behind this interface. Production uses {@see PhpUploadTransport},
 * which calls the real functions and therefore keeps the real guarantee: a path
 * that PHP did not itself write cannot be moved, so an attacker who found a way
 * to influence `$_FILES` still cannot make the ingest ingest `/etc/passwd`.
 */
interface UploadTransport
{
    /** Whether $path really is a part of the current request. */
    public function isUploadedFile(string $path): bool;

    /** Moves an uploaded part to $destination. May cross filesystems. */
    public function moveUploadedFile(string $path, string $destination): bool;
}
