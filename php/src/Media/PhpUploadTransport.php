<?php

declare(strict_types=1);

namespace Eszter\Media;

/**
 * The production transport: PHP's own upload primitives, unwrapped.
 *
 * Nothing here is defensive beyond calling the right two functions, because the
 * guarantee is theirs: `is_uploaded_file()` answers only for paths PHP wrote
 * while parsing *this* request, so it is the check that makes a `$_FILES` entry
 * trustworthy at all.
 */
final class PhpUploadTransport implements UploadTransport
{
    public function isUploadedFile(string $path): bool
    {
        return $path !== '' && is_uploaded_file($path);
    }

    public function moveUploadedFile(string $path, string $destination): bool
    {
        return move_uploaded_file($path, $destination);
    }
}
