<?php

declare(strict_types=1);

namespace Eszter\Backup;

/**
 * A backup or restore that refused to continue (ESZ-083).
 *
 * Every raise from this package is a refusal to produce or apply something
 * incomplete. There is deliberately no partial-success path: a backup missing a
 * file, or a restore that applied half a set, is worse than neither, because it
 * looks like the thing that would have worked.
 */
final class BackupException extends \RuntimeException
{
}
