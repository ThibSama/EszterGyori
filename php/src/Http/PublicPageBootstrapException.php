<?php

declare(strict_types=1);

namespace Eszter\Http;

/**
 * The exported page could not be rewritten.
 *
 * Always a deployment fault, never a caller's: the file on disk is not the one
 * the build produced, or is not a Next export at all. It is separate from
 * {@see \Eszter\Storage\StorageException} because the remedy is different —
 * storage failures mean the content is bad, this means the *frontend artifact*
 * is — and because it must not be mistaken for the opaque 500 the API answers.
 *
 * The public page catches it and serves the file unchanged, so visitors see the
 * baked-in defaults instead of an error (`publicPageFallbackOutcome`).
 */
final class PublicPageBootstrapException extends \RuntimeException
{
}
