<?php

declare(strict_types=1);

namespace Eszter\Support;

/**
 * A terminal-control operation failed in a way that must abort interactive
 * prompting (ESZ-132).
 *
 * Interactive credential reading is fail-closed: a failure to capture the
 * terminal state or to suppress echo means the password is never read, and a
 * failure to restore the captured state is an operational failure on its own.
 */
class TerminalControlException extends \RuntimeException
{
}
