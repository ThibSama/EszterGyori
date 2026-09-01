<?php

declare(strict_types=1);

namespace Eszter\Tests\Support;

use Eszter\Support\PasswordPrompt;

/**
 * Recorded double for PasswordPrompt's five seams (ESZ-132).
 *
 * Every terminal command is recorded verbatim — quoting included — so a test
 * can assert the exact restoration command, and every written byte is captured
 * so a test can prove the password reaches neither output nor a shell command.
 */
final class FakeTerminal
{
    /** @var list<string> Every terminal command, in execution order. */
    public array $commands = [];

    public string $stdout = '';
    public string $stderr = '';
    public int $reads = 0;

    /**
     * @param list<string>           $lines               Values for readLine, in order.
     * @param array<string, ?string> $commandResults      Exact-match command overrides.
     * @param string|null            $defaultCommandResult Result for any unlisted command
     *                                                     ('' = success, null = failure).
     * @param \Throwable|null        $readThrow           When set, readLine throws it.
     */
    public function __construct(
        public readonly bool $interactive,
        private array $lines = [],
        private array $commandResults = [],
        private readonly ?string $defaultCommandResult = '',
        private readonly ?\Throwable $readThrow = null,
    ) {
    }

    public function readLine(): string
    {
        if ($this->readThrow !== null) {
            throw $this->readThrow;
        }

        $this->reads++;
        $line = array_shift($this->lines);

        return \is_string($line) ? $line : '';
    }

    public function runCommand(string $command): ?string
    {
        $this->commands[] = $command;

        return array_key_exists($command, $this->commandResults)
            ? $this->commandResults[$command]
            : $this->defaultCommandResult;
    }

    public function writeStdout(string $text): void
    {
        $this->stdout .= $text;
    }

    public function writeStderr(string $text): void
    {
        $this->stderr .= $text;
    }

    public function prompt(): PasswordPrompt
    {
        return new PasswordPrompt(
            fn (): bool => $this->interactive,
            fn (): string => $this->readLine(),
            fn (string $text) => $this->writeStdout($text),
            fn (string $text) => $this->writeStderr($text),
            fn (string $command): ?string => $this->runCommand($command),
        );
    }
}
