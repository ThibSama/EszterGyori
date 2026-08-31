<?php

declare(strict_types=1);

use Eszter\Security\PdoRateLimiter;
use Eszter\Security\RateLimitPolicy;
use Eszter\Support\SystemClock;
use Eszter\Tests\Sql\TestDatabase;
use Eszter\Tests\TestEnvironment;

require_once __DIR__ . '/../../vendor/autoload.php';

/**
 * One independent limiter process, for the two-process concurrency proof.
 *
 * Its own operating-system process and its own connection, because that is the
 * only arrangement in which MySQL is genuinely arbitrating: two charges issued
 * from one PHP process on one connection are serialised by the connection itself
 * and would prove nothing about two requests arriving at once on a real host —
 * which, on shared hosting where every request *is* a process, is the only way
 * they ever arrive.
 *
 * Prints `ALLOWED` or `REFUSED` so the parent can assert that exactly one of two
 * processes took the last allowance.
 */

/** @var list<string> $argv */
$readyPath = $argv[1] ?? '';
$scope = $argv[2] ?? '';
$subject = $argv[3] ?? '';

if ($readyPath === '' || $scope === '' || $subject === '') {
    fwrite(STDERR, "worker arguments missing\n");
    exit(2);
}

try {
    $clock = new SystemClock();
    $database = TestDatabase::connectSeparately();

    $limiter = new PdoRateLimiter(
        $database,
        RateLimitPolicy::fromArtifacts(TestEnvironment::artifacts()),
        $clock,
        new Eszter\Support\Logger(sys_get_temp_dir() . '/eszter-ratelimit-worker.log', 'error', $clock),
    );

    // Opens the connection before signalling, so the parent's release is not
    // racing a TCP handshake.
    $database->pdo();

    if (!touch($readyPath)) {
        throw new RuntimeException('worker could not signal readiness');
    }

    $decision = $limiter->charge($scope, $subject);

    fwrite(STDOUT, ($decision->allowed ? 'ALLOWED' : 'REFUSED') . "\n");
    exit(0);
} catch (Throwable $exception) {
    fwrite(STDERR, $exception::class . ': ' . $exception->getMessage() . "\n");
    exit(1);
}
