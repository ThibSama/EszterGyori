<?php

declare(strict_types=1);

namespace Eszter\Tests\Support;

use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-132: the provision-admin CLI never accepts a password argument.
 *
 * The rejection happens before configuration, database or prompt work, so a
 * broken or absent config is irrelevant: the exit code and the absence of the
 * value from both captured streams are the whole contract.
 */
final class ProvisionAdminCliTest extends TestCase
{
    public function testArgvPasswordIsRejectedWithoutLeakage(): void
    {
        $secret = 'esz132-argv-secret-value';

        [$exit, $stdout, $stderr] = $this->runCommand([
            PHP_BINARY,
            TestEnvironment::repositoryRoot() . '/php/bin/provision-admin.php',
            '--password=' . $secret,
        ]);

        self::assertSame(2, $exit);
        self::assertStringContainsString('--password is not accepted', $stderr);
        self::assertStringNotContainsString($secret, $stdout);
        self::assertStringNotContainsString($secret, $stderr);
    }

    public function testBarePasswordFlagIsAlsoAUsageError(): void
    {
        [$exit, $stdout, $stderr] = $this->runCommand([
            PHP_BINARY,
            TestEnvironment::repositoryRoot() . '/php/bin/provision-admin.php',
            '--password',
        ]);

        self::assertSame(2, $exit);
        self::assertStringContainsString('--password is not accepted', $stderr);
    }

    /**
     * @param list<string> $command
     * @return array{int, string, string}
     */
    private function runCommand(array $command): array
    {
        $pipes = [];
        $process = proc_open(
            $command,
            [
                0 => ['pipe', 'r'],
                1 => ['pipe', 'w'],
                2 => ['pipe', 'w'],
            ],
            $pipes,
            TestEnvironment::repositoryRoot(),
        );
        self::assertIsResource($process);
        fclose($pipes[0]);
        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);

        return [proc_close($process), (string) $stdout, (string) $stderr];
    }
}
