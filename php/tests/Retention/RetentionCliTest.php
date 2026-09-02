<?php

declare(strict_types=1);

namespace Eszter\Tests\Retention;

use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-140 CLI surface without a database: usage errors are exit code 2 with a
 * message, --help is exit 0, and a failure is reported on stderr — never a
 * stack trace with a DSN in it. The real erase/retire behaviour, idempotence
 * and the count-only output are proved against MySQL by the `sql:integration`
 * gate.
 */
final class RetentionCliTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-retention-cli');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    public function testMissingConfigIsAUsageError(): void
    {
        [$exit, $stdout, $stderr] = $this->runCommand([]);

        self::assertSame(2, $exit);
        self::assertSame('', $stdout);
        self::assertStringContainsString('--config=PATH is required', $stderr);
    }

    public function testAnUnknownArgumentIsAUsageError(): void
    {
        $config = TestEnvironment::writeDeployment($this->root);

        [$exit, , $stderr] = $this->runCommand(['--config=' . $config, '--wat']);

        self::assertSame(2, $exit);
        self::assertStringContainsString('Unknown argument', $stderr);
    }

    public function testHelpIsExitZeroAndNamesTheCountOnlyOutput(): void
    {
        [$exit, $stdout] = $this->runCommand(['--help']);

        self::assertSame(0, $exit);
        self::assertStringContainsString('apply-booking-retention.php', $stdout);
        // Wrapped across two usage lines; asserted as one stable fragment.
        self::assertStringContainsString('booking reference or a customer value', $stdout);
    }

    public function testAnOutOfRangeBatchIsAUsageError(): void
    {
        $config = TestEnvironment::writeDeployment($this->root);

        [$exit, , $stderr] = $this->runCommand(['--config=' . $config, '--batch=0']);

        self::assertSame(2, $exit);
        self::assertStringContainsString('--batch must be between 1 and', $stderr);
    }

    /**
     * An operational failure exits 1 with the message and no trace: a PDO
     * stack trace would carry the DSN, and this stream may well be a cron mail.
     */
    public function testOperationalFailureIsExitOneWithAMessageOnly(): void
    {
        $config = TestEnvironment::writeDeployment($this->root, [
            'database' => [
                'dsn' => 'mysql:host=127.0.0.1;port=1;dbname=eszter_retention_cli_test;charset=utf8mb4',
                'username' => 'operator',
                'password' => 'retention-database-secret',
                'connectTimeoutSeconds' => 1,
            ],
        ]);

        [$exit, , $stderr] = $this->runCommand(['--config=' . $config]);

        self::assertSame(1, $exit);
        self::assertStringStartsWith('apply-booking-retention: ', $stderr);
        self::assertStringNotContainsString('retention-database-secret', $stderr);
        self::assertStringNotContainsString('127.0.0.1', $stderr);
        self::assertStringNotContainsString('#0 ', $stderr, 'a stack trace reached stderr');
    }

    /**
     * @param list<string> $arguments
     * @return array{int, string, string}
     */
    private function runCommand(array $arguments): array
    {
        $pipes = [];
        $process = proc_open(
            [PHP_BINARY, TestEnvironment::repositoryRoot() . '/php/bin/apply-booking-retention.php', ...$arguments],
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
