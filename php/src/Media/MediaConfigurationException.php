<?php

declare(strict_types=1);

namespace Eszter\Media;

/**
 * The host cannot verify an image, so this deployment will not accept one.
 *
 * Raised when `fileinfo` or `gd` is missing, or when `gd` is present without
 * support for a format the frozen allowlist declares. It is deliberately fatal
 * for the upload rather than something the pipeline degrades around: every check
 * in `mediaIngest.pipeline` exists because the ones before it are insufficient,
 * and an ingest that skipped the decode because no decoder was installed would be
 * accepting whatever the caller sent on the strength of its magic bytes alone.
 *
 * `docs/hetzner-target-architecture.md` §7 requires content inspection. A host
 * that cannot do it fails the request with 500 INVALID_CONFIGURATION, which is
 * both honest and actionable: the fix is a hosting setting, not a code change.
 */
final class MediaConfigurationException extends \RuntimeException
{
}
