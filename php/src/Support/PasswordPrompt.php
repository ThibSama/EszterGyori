<?php

declare(strict_types=1);

namespace Eszter\Support;

/**
 * Reads an operator password with echo suppressed, fail-closed (ESZ-132).
 *
 * ## Why the seams exist
 *
 * The operations this builds on (`stream_isatty`, `fgets`, `fwrite`, `exec`)
 * are exactly the ones that make failure paths untestable when called
 * directly: the developer's own terminal is the only stdin, and `stty`
 * behaviour cannot be forced. Every interaction is therefore behind an
 * injectable closure, and {@see forStandardStreams()} wires them to the real
 * streams and a checked command runner.
 *
 * ## Fail-closed order
 *
 * An interactive read captures the terminal state first (`stty -g`), then
 * suppresses echo (`stty -echo`), and only after both are *proved* is a line
 * read; the captured state is restored in `finally`, so an exception thrown
 * by the read cannot leave the terminal degraded. A capture or suppression
 * failure aborts before any secret is read. Unavailable or failing shell
 * execution means interactive prompting is unavailable — never that the
 * password may be shown.
 *
 * ## The password never reaches a shell command
 *
 * The only variable interpolated into a command is the captured `stty` state,
 * restored with {@see escapeshellarg()}. The password itself only ever flows
 * through the line-input closure.
 */
final class PasswordPrompt
{
    /**
     * @param \Closure(): bool          $isInteractive True when stdin is a terminal.
     * @param \Closure(): string        $readLine      Reads one line, trailing newline included.
     * @param \Closure(string): void    $writeStdout
     * @param \Closure(string): void    $writeStderr
     * @param \Closure(string): ?string $runCommand    Runs a terminal command and returns
     *                                                 its output, or null when the command
     *                                                 failed or shell execution is
     *                                                 unavailable.
     */
    public function __construct(
        private readonly \Closure $isInteractive,
        private readonly \Closure $readLine,
        private readonly \Closure $writeStdout,
        private readonly \Closure $writeStderr,
        private readonly \Closure $runCommand,
    ) {
    }

    /** The real-stream wiring used by the operator commands. */
    public static function forStandardStreams(): self
    {
        return new self(
            static fn (): bool => stream_isatty(STDIN),
            static fn (): string => (string) fgets(STDIN),
            static function (string $text): void {
                fwrite(STDOUT, $text);
            },
            static function (string $text): void {
                fwrite(STDERR, $text);
            },
            static fn (string $command): ?string => self::runChecked($command),
        );
    }

    /**
     * Reads one password, confirming it when stdin is a terminal.
     *
     * A piped password is read once and never confirmed: there is nobody there
     * to mistype it twice differently, and demanding the value twice on stdin
     * would only make the script awkward to automate. Confirmation and the
     * minimum length are enforced exactly as before ESZ-132; both refusals
     * return null.
     */
    public function readPassword(bool $isNewAccount, int $minimum): ?string
    {
        if (!($this->isInteractive)()) {
            return $this->validated(rtrim(($this->readLine)(), "\r\n"), $minimum);
        }

        ($this->writeStdout)($isNewAccount ? "New account.\n" : "Setting a new password.\n");
        $password = $this->promptHidden('Password: ');
        $confirmation = $this->promptHidden('Confirm password: ');

        if ($password !== $confirmation) {
            ($this->writeStderr)("provision-admin: the two passwords do not match.\n");

            return null;
        }

        return $this->validated($password, $minimum);
    }

    /**
     * capture -> disable echo -> read -> finally restore.
     *
     * @throws TerminalControlException When the state cannot be captured or echo
     *         cannot be suppressed; nothing has been read.
     * @throws TerminalRestoreException When the captured state cannot be restored;
     *         the terminal may be left degraded.
     */
    private function promptHidden(string $label): string
    {
        ($this->writeStdout)($label);
        $state = $this->captureTerminalState();
        $this->suppressEcho($state);

        try {
            $value = rtrim(($this->readLine)(), "\r\n");
        } finally {
            $this->restoreTerminalState($state);
        }

        ($this->writeStdout)("\n");

        return $value;
    }

    /**
     * @throws TerminalControlException When the state could not be captured.
     */
    private function captureTerminalState(): string
    {
        $state = ($this->runCommand)('stty -g');

        if (!\is_string($state) || trim($state) === '') {
            throw new TerminalControlException(
                'the terminal state could not be captured; interactive prompting is unavailable.',
            );
        }

        return trim($state);
    }

    /**
     * @throws TerminalControlException When echo could not be suppressed; the
     *         captured state is restored before throwing.
     */
    private function suppressEcho(string $state): void
    {
        if (($this->runCommand)('stty -echo') === null) {
            $this->restoreTerminalState($state);
            throw new TerminalControlException(
                'echo could not be suppressed; refusing to read the password while it would be visible.',
            );
        }
    }

    /**
     * @throws TerminalRestoreException When the captured state could not be restored.
     */
    private function restoreTerminalState(string $state): void
    {
        if (($this->runCommand)('stty ' . \escapeshellarg($state)) === null) {
            throw new TerminalRestoreException(
                'the terminal state could not be restored; the terminal may be left degraded.',
            );
        }
    }

    private function validated(string $password, int $minimum): ?string
    {
        if (mb_strlen($password, 'UTF-8') < $minimum) {
            ($this->writeStderr)(\sprintf(
                "provision-admin: the password must be at least %d characters.\n",
                $minimum,
            ));

            return null;
        }

        return $password;
    }

    /**
     * The checked command runner behind {@see forStandardStreams()}.
     *
     * `exec` is used rather than `shell_exec` because its exit status is a
     * checked result: `shell_exec` returns null both when a command fails and
     * when it succeeds silently, which is exactly the ambiguity an
     * echo-suppression check must not have. A disabled `exec`, or a command
     * that fails, yields null — the caller treats that as "interactive
     * prompting is unavailable", never as a licence to read visibly.
     */
    private static function runChecked(string $command): ?string
    {
        if (!\function_exists('exec')) {
            return null;
        }

        $output = [];
        $exitCode = 1;
        @exec($command . ' 2>&1', $output, $exitCode);

        return $exitCode === 0 ? implode("\n", $output) : null;
    }
}
