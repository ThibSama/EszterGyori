<?php

declare(strict_types=1);

namespace Eszter\Tests\Support;

use Eszter\Support\TerminalControlException;
use Eszter\Support\TerminalRestoreException;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-132: interactive password prompting is fail-closed.
 *
 * Every scenario is driven through {@see FakeTerminal}; the developer's real
 * TTY is never involved, and no scenario provisions anything.
 */
final class PasswordPromptTest extends TestCase
{
    private const SECRET = 'esz132-hunter2-secret';
    private const STATE = '38400:5:bf:ce:85:7f:1f:3f:0:0:0:0:0:0:0:0:0:0:0:0';

    public function testNonTtySuccessInvokesZeroTerminalCommands(): void
    {
        $terminal = new FakeTerminal(interactive: false, lines: [self::SECRET . "\n"]);
        $prompt = $terminal->prompt();

        self::assertSame(self::SECRET, $prompt->readPassword(true, 8));
        self::assertSame([], $terminal->commands);
        self::assertSame('', $terminal->stdout);
        self::assertSame(1, $terminal->reads);
    }

    public function testNonTtyTooShortPasswordKeepsItsRefusal(): void
    {
        $terminal = new FakeTerminal(interactive: false, lines: ["abc\n"]);
        $prompt = $terminal->prompt();

        self::assertNull($prompt->readPassword(true, 8));
        self::assertSame([], $terminal->commands);
        self::assertStringContainsString('must be at least 8 characters', $terminal->stderr);
    }

    public function testCaptureFailureAbortsBeforeAnySecretRead(): void
    {
        $terminal = new FakeTerminal(
            interactive: true,
            lines: [self::SECRET . "\n"],
            commandResults: ['stty -g' => null],
        );
        $prompt = $terminal->prompt();

        try {
            $prompt->readPassword(true, 8);
            self::fail('a capture failure must abort interactive prompting');
        } catch (TerminalControlException $exception) {
            self::assertStringContainsString('could not be captured', $exception->getMessage());
        }

        self::assertSame(0, $terminal->reads);
        self::assertSame(['stty -g'], $terminal->commands);
        self::assertStringNotContainsString(self::SECRET, $terminal->stdout . $terminal->stderr);
    }

    public function testEchoDisableFailurePerformsNoReadAndAttemptsRestore(): void
    {
        $terminal = new FakeTerminal(
            interactive: true,
            lines: [self::SECRET . "\n"],
            commandResults: [
                'stty -g' => self::STATE,
                'stty -echo' => null,
            ],
        );
        $prompt = $terminal->prompt();

        try {
            $prompt->readPassword(true, 8);
            self::fail('an echo-suppression failure must abort interactive prompting');
        } catch (TerminalControlException $exception) {
            self::assertStringContainsString('could not be suppressed', $exception->getMessage());
        }

        self::assertSame(0, $terminal->reads);
        self::assertSame(
            ['stty -g', 'stty -echo', "stty '" . self::STATE . "'"],
            $terminal->commands,
        );
        self::assertStringNotContainsString(self::SECRET, $terminal->stdout . $terminal->stderr);
    }

    public function testInputExceptionAfterDisableStillRestores(): void
    {
        $terminal = new FakeTerminal(
            interactive: true,
            lines: [],
            commandResults: ['stty -g' => self::STATE],
            readThrow: new \RuntimeException('stdin exploded'),
        );
        $prompt = $terminal->prompt();

        try {
            $prompt->readPassword(true, 8);
            self::fail('the input exception must propagate');
        } catch (\RuntimeException $exception) {
            self::assertSame('stdin exploded', $exception->getMessage());
        }

        self::assertSame(
            ['stty -g', 'stty -echo', "stty '" . self::STATE . "'"],
            $terminal->commands,
        );
    }

    public function testRestoreFailureIsAnOperationalFailureNotSuccess(): void
    {
        $terminal = new FakeTerminal(
            interactive: true,
            lines: [self::SECRET . "\n"],
            commandResults: [
                'stty -g' => self::STATE,
                "stty '" . self::STATE . "'" => null,
            ],
        );
        $prompt = $terminal->prompt();

        try {
            $prompt->readPassword(true, 8);
            self::fail('a restoration failure must abort provisioning');
        } catch (TerminalRestoreException $exception) {
            self::assertStringContainsString('could not be restored', $exception->getMessage());
        }

        self::assertStringNotContainsString(self::SECRET, $terminal->stdout . $terminal->stderr);
    }

    public function testSuccessfulConfirmationRestoresExactStateAndNeverEchoesSecret(): void
    {
        $terminal = new FakeTerminal(
            interactive: true,
            lines: [self::SECRET . "\n", self::SECRET . "\n"],
            commandResults: ['stty -g' => self::STATE],
        );
        $prompt = $terminal->prompt();

        $password = $prompt->readPassword(true, 8);

        self::assertSame(self::SECRET, $password);
        self::assertSame(
            [
                'stty -g',
                'stty -echo',
                "stty '" . self::STATE . "'",
                'stty -g',
                'stty -echo',
                "stty '" . self::STATE . "'",
            ],
            $terminal->commands,
        );
        self::assertSame("New account.\nPassword: \nConfirm password: \n", $terminal->stdout);
        self::assertStringNotContainsString(self::SECRET, $terminal->stdout . $terminal->stderr);
        self::assertStringNotContainsString(self::SECRET, implode("\n", $terminal->commands));
    }

    public function testConfirmationMismatchKeepsItsRefusal(): void
    {
        $terminal = new FakeTerminal(
            interactive: true,
            lines: [self::SECRET . "\n", "esz132-other-secret\n"],
            commandResults: ['stty -g' => self::STATE],
        );
        $prompt = $terminal->prompt();

        self::assertNull($prompt->readPassword(false, 8));
        self::assertStringContainsString('the two passwords do not match', $terminal->stderr);
        self::assertStringContainsString("Setting a new password.\n", $terminal->stdout);
    }

    public function testMinimumLengthStaysEnforcedInteractively(): void
    {
        $terminal = new FakeTerminal(
            interactive: true,
            lines: ["short\n", "short\n"],
            commandResults: ['stty -g' => self::STATE],
        );
        $prompt = $terminal->prompt();

        self::assertNull($prompt->readPassword(true, 8));
        self::assertStringContainsString('must be at least 8 characters', $terminal->stderr);
    }
}
