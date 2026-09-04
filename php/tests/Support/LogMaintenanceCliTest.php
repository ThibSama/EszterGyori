<?php

declare(strict_types=1);

namespace Eszter\Tests\Support;

use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

final class LogMaintenanceCliTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-log-maintenance-cli');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    public function testProductionConfigurationRotatesWithoutOpeningTheDatabase(): void
    {
        $config = TestEnvironment::writeDeployment($this->root, $this->productionOverrides());
        chmod($config, 0o600);
        $active = $this->root . '/var/log/app.log';
        file_put_contents($active, "line\n");
        chmod($active, 0o644);

        [$exit, $stdout, $stderr] = $this->runCommand([
            PHP_BINARY,
            TestEnvironment::repositoryRoot() . '/php/bin/maintain-logs.php',
            '--config=' . $config,
        ]);

        self::assertSame(0, $exit, $stderr);
        self::assertSame('', $stderr);
        self::assertStringContainsString('maintain-logs: PASS (1 rotated, 0 deleted; retention 30 days)', $stdout);
        self::assertStringNotContainsString('database-secret-value', $stdout);
        self::assertStringNotContainsString('log-pseudonymization-secret', $stdout);
        self::assertFileDoesNotExist($active);
        $archives = glob($active . '.[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]');
        self::assertIsArray($archives);
        self::assertCount(1, $archives);
        self::assertSame(0o600, fileperms($archives[0]) & 0o777);

        [$preflightExit, $preflightStdout, $preflightStderr] = $this->runCommand([
            PHP_BINARY,
            TestEnvironment::repositoryRoot() . '/php/bin/preflight-production.php',
            '--config=' . $config,
        ]);
        self::assertSame(0, $preflightExit, $preflightStderr);
        self::assertSame("preflight:production PASS\n", $preflightStdout);
        self::assertSame(0o600, fileperms($active) & 0o777);

        [$secondExit, $secondStdout, $secondStderr] = $this->runCommand([
            PHP_BINARY,
            TestEnvironment::repositoryRoot() . '/php/bin/maintain-logs.php',
            '--config=' . $config,
        ]);
        self::assertSame(0, $secondExit, $secondStderr);
        self::assertStringContainsString('PASS (0 rotated, 0 deleted', $secondStdout);
        self::assertFileExists($active);

        unlink($active);
        symlink($archives[0], $active);
        [$unsafeExit, $unsafeStdout, $unsafeStderr] = $this->runCommand([
            PHP_BINARY,
            TestEnvironment::repositoryRoot() . '/php/bin/maintain-logs.php',
            '--config=' . $config,
        ]);
        self::assertSame(1, $unsafeExit);
        self::assertSame('', $unsafeStdout);
        self::assertSame("maintain-logs: refusing symlink target {$active}\n", $unsafeStderr);
    }

    /** @return array<string, mixed> */
    private function productionOverrides(): array
    {
        return [
            'environment' => 'production',
            'privacy' => ['logPseudonymizationKey' => str_repeat('log-pseudonymization-secret-', 2)],
            'database' => [
                'dsn' => 'mysql:host=127.0.0.1;port=1;dbname=unreachable;charset=utf8mb4',
                'username' => 'operator',
                'password' => 'database-secret-value',
                'connectTimeoutSeconds' => 1,
            ],
            'session' => ['cookieSecure' => true],
            'notifications' => [
                'email' => [
                    'host' => 'smtp.example.test',
                    'port' => 587,
                    'encryption' => 'starttls',
                    'authenticationRequired' => true,
                    'username' => 'mailer',
                    'password' => 'smtp-secret-value',
                    'senderAddress' => 'bonjour@example.test',
                    'senderName' => 'Eszter Gyori',
                    'timeoutSeconds' => 1,
                    'customerContact' => 'Répondez à cet e-mail.',
                    'customerInstructions' => 'Prévenez-nous en cas d’empêchement.',
                ],
            ],
        ];
    }

    /**
     * @param list<string> $command
     * @return array{int, string, string}
     */
    private function runCommand(array $command): array
    {
        $process = proc_open(
            $command,
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
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
