<?php

declare(strict_types=1);

namespace Eszter\Tests\Notification;

use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/** ESZ-082: production cron can never degrade silently to the logging transport. */
final class NotificationRunnerCliTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-notification-cli');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    public function testProductionRefusesLoggingBeforeOpeningDatabaseOrNetwork(): void
    {
        $config = TestEnvironment::writeDeployment($this->root, [
            'environment' => 'production',
            'database' => [
                'dsn' => 'mysql:host=127.0.0.1;port=1;dbname=unreachable;charset=utf8mb4',
                'username' => 'operator',
                'password' => 'database-secret-value',
                'connectTimeoutSeconds' => 1,
            ],
            'session' => [
                'cookieSecure' => true,
            ],
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
        ]);
        chmod($config, 0o600);

        [$exit, $stdout, $stderr] = $this->runCommand([
            PHP_BINARY,
            TestEnvironment::repositoryRoot() . '/php/bin/run-notification-jobs.php',
            '--config=' . $config,
            '--transport=logging',
        ]);

        self::assertSame(1, $exit);
        self::assertSame('', $stdout);
        self::assertStringContainsString('logging transport is restricted', $stderr);
        self::assertStringNotContainsString('database-secret-value', $stderr);
        self::assertStringNotContainsString('smtp-secret-value', $stderr);
        self::assertStringNotContainsString('127.0.0.1', $stderr);
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
