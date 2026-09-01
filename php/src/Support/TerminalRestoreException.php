<?php

declare(strict_types=1);

namespace Eszter\Support;

/**
 * The captured terminal state could not be restored after echo suppression
 * (ESZ-132).
 *
 * Distinct from {@see TerminalControlException} so a caller can tell "could
 * not start suppressing" from "the terminal may be left degraded". A failed
 * restoration is itself an operational failure: provisioning must never be
 * reported successful on top of it.
 */
final class TerminalRestoreException extends TerminalControlException
{
}
