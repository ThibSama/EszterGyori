<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Database\Database;
use Eszter\Security\PdoRateLimiter;
use Eszter\Security\RateLimitPolicy;
use Eszter\Security\RateLimitRule;
use Eszter\Support\Logger;
use Eszter\Tests\MovableClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-084 — the limiter against real MySQL.
 *
 * ## Why none of this can be proved anywhere else
 *
 * Every guarantee below is a property of the *store*, not of the algorithm. That
 * a bucket survives between requests is a claim about a row; that two callers
 * cannot both take the last allowance is a claim about InnoDB's row lock; that a
 * refused charge writes nothing is a claim about what MySQL's affected-row count
 * means for `INSERT ... ON DUPLICATE KEY UPDATE`. An in-memory double would
 * satisfy all three by construction and prove none of them.
 *
 * ## No enclosing transaction, unlike every other suite here
 *
 * The other SQL suites wrap each test in a transaction and roll it back. This one
 * cannot, and the reason is the design rather than the test: a charge must never
 * be transactional, or a booking that rolled back would roll back the allowance it
 * had just spent and a script could retry forever at zero cost. Isolating these
 * tests in a transaction would hide exactly the property they exist to prove, so
 * they truncate instead.
 */
final class RateLimiterSqlTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';
    private const SUBJECT = '203.0.113.42';
    /** ESZ-130: the subject racing the anonymous-session bootstrap bucket. */
    private const ESZ130_SUBJECT = '203.0.113.130';

    private static bool $migrated = false;

    private Database $database;
    private MovableClock $clock;
    private RateLimitPolicy $policy;
    private PdoRateLimiter $limiter;
    private string $root;

    protected function setUp(): void
    {
        if (!TestDatabase::isConfigured()) {
            self::markTestSkipped(TestDatabase::skipReason());
        }

        $this->database = TestDatabase::connect();

        if (!self::$migrated) {
            TestDatabase::dropEverything($this->database);
            TestDatabase::migrator($this->database)->migrate();
            self::$migrated = true;
        }

        $this->database->executeRaw('TRUNCATE TABLE rate_limit_buckets', 'truncate buckets');

        $this->clock = new MovableClock(self::NOW);
        $this->policy = RateLimitPolicy::fromArtifacts(TestEnvironment::artifacts());
        $this->root = TestEnvironment::makeTempDirectory('eszter-ratelimit-sql');
        $this->limiter = new PdoRateLimiter(
            $this->database,
            $this->policy,
            $this->clock,
            new Logger($this->root . '/limiter.log', 'debug', $this->clock),
        );
    }

    protected function tearDown(): void
    {
        if (isset($this->root)) {
            TestEnvironment::removeDirectory($this->root);
        }
    }

    /**
     * The property the whole design exists for: the count survives the request.
     *
     * On shared hosting each of these charges would be a separate PHP process
     * with no memory of the last one. The row is what remembers.
     */
    public function testAllowanceIsExhaustedAcrossSeparateChargesAndThenRefuses(): void
    {
        $rule = $this->rule();
        $admitted = 0;

        // One more than the burst, at the same instant. GCRA admits exactly
        // `burst` requests arriving together and refuses the next.
        for ($i = 0; $i <= $rule->burst; ++$i) {
            if ($this->limiter->charge($rule->scope, self::SUBJECT)->allowed) {
                ++$admitted;
            }
        }

        self::assertSame($rule->burst, $admitted);
        self::assertFalse($this->limiter->charge($rule->scope, self::SUBJECT)->allowed);
    }

    /**
     * Allowance comes back with time, and at exactly the declared rate.
     *
     * Asserted on both sides of the boundary: one millisecond early is still a
     * refusal and one interval later is an admission. A limiter that only proved
     * "eventually recovers" would pass with any rate at all.
     */
    public function testAllowanceIsRestoredExactlyOneEmissionIntervalLater(): void
    {
        $rule = $this->rule();
        $this->exhaust($rule);

        $this->advanceMs($rule->emissionIntervalMs - 1);
        self::assertFalse($this->limiter->charge($rule->scope, self::SUBJECT)->allowed);

        $this->advanceMs(1);
        self::assertTrue($this->limiter->charge($rule->scope, self::SUBJECT)->allowed);
    }

    /**
     * A refused charge must not push the arrival time further out.
     *
     * Otherwise a caller who kept hammering a full bucket would lengthen their own
     * penalty without bound, and a limiter that punishes retries harder than it
     * punishes the original flood is a limiter that turns impatience into an
     * outage.
     */
    public function testARefusedChargeWritesNothing(): void
    {
        $rule = $this->rule();
        $this->exhaust($rule);

        $before = $this->arrivalTime($rule->scope, self::SUBJECT);

        for ($i = 0; $i < 20; ++$i) {
            self::assertFalse($this->limiter->charge($rule->scope, self::SUBJECT)->allowed);
        }

        self::assertSame($before, $this->arrivalTime($rule->scope, self::SUBJECT));
    }

    /** Two subjects in one scope are two budgets; one caller cannot spend another's. */
    public function testSubjectsDoNotShareABucket(): void
    {
        $rule = $this->rule();
        $this->exhaust($rule);

        self::assertFalse($this->limiter->charge($rule->scope, self::SUBJECT)->allowed);
        self::assertTrue($this->limiter->charge($rule->scope, '198.51.100.7')->allowed);
    }

    /**
     * Two scopes are two budgets even for the same subject.
     *
     * The NUL separator in the key is what guarantees it: concatenated plainly,
     * scope `a` + subject `bc` and scope `ab` + subject `c` would hash to one row
     * and two unrelated rules would silently share an allowance.
     */
    public function testScopesDoNotShareABucket(): void
    {
        $login = $this->policy->rule(RateLimitPolicy::SCOPE_LOGIN_ADDRESS);
        $this->exhaust($login);

        self::assertFalse($this->limiter->charge($login->scope, self::SUBJECT)->allowed);
        self::assertTrue(
            $this->limiter
                ->charge(RateLimitPolicy::SCOPE_BOOKING_CREATE_ADDRESS, self::SUBJECT)
                ->allowed,
        );
    }

    /** The store holds a hash and a scope, and nothing that names anybody. */
    public function testNoSubjectIsStoredInClear(): void
    {
        $this->limiter->charge(RateLimitPolicy::SCOPE_LOGIN_IDENTITY, 'eszter@example.com');
        $this->limiter->charge(RateLimitPolicy::SCOPE_LOGIN_ADDRESS, self::SUBJECT);

        $rows = $this->database->fetchAll('SELECT * FROM rate_limit_buckets');
        self::assertCount(2, $rows);

        $dump = (string) json_encode($rows, JSON_PARTIAL_OUTPUT_ON_ERROR);
        self::assertStringNotContainsString('eszter@example.com', $dump);
        self::assertStringNotContainsString(self::SUBJECT, $dump);

        foreach ($rows as $row) {
            self::assertSame(32, \strlen((string) $row['bucket_key']), 'the key is not a raw sha256');
            self::assertContains($row['scope'], $this->policy->scopes());
        }
    }

    /** A refusal has to say how long, and never zero — a zero invites a busy loop. */
    public function testARefusalReportsAWholeNumberOfSecondsToWait(): void
    {
        $rule = $this->rule();
        $this->exhaust($rule);

        $decision = $this->limiter->charge($rule->scope, self::SUBJECT);

        self::assertFalse($decision->allowed);
        self::assertGreaterThanOrEqual(1, $decision->retryAfterSeconds);
        self::assertLessThanOrEqual(
            (int) ceil($rule->emissionIntervalMs / 1000) + 1,
            $decision->retryAfterSeconds,
            'a full bucket asked the caller to wait longer than one emission interval',
        );
    }

    /**
     * Waiting out the whole period restores the full burst, not one hit.
     *
     * The other direction of the same rule: an idle bucket recovers completely,
     * so a caller who behaved is not permanently penalised for a burst an hour
     * ago.
     */
    public function testAnIdleBucketRecoversItsWholeBurst(): void
    {
        $rule = $this->rule();
        $this->exhaust($rule);

        // A full period, which is the interval the rule is stated in. Recovery is
        // gradual — after `delayTolerance` only `burst - 1` units are back, since
        // the arrival time has to fall all the way to `now` for the bucket to be
        // genuinely idle — so the honest statement of the guarantee is the one the
        // contract makes: `limit` per `periodSeconds`.
        $this->advanceMs($rule->periodSeconds * 1000);

        $admitted = 0;
        for ($i = 0; $i < $rule->burst; ++$i) {
            if ($this->limiter->charge($rule->scope, self::SUBJECT)->allowed) {
                ++$admitted;
            }
        }

        self::assertSame($rule->burst, $admitted);
    }

    /**
     * An idle bucket must not accumulate credit beyond its burst.
     *
     * Without the `GREATEST(tat, now)` in the update, a bucket idle for a year
     * would admit a year's worth of requests at once, which is the failure mode
     * that makes naive leaky-bucket implementations useless in practice.
     */
    public function testIdlenessDoesNotAccumulateUnboundedCredit(): void
    {
        $rule = $this->rule();
        $this->limiter->charge($rule->scope, self::SUBJECT);

        $this->advanceMs($rule->periodSeconds * 1000 * 50);

        $admitted = 0;
        for ($i = 0; $i < $rule->burst * 4; ++$i) {
            if ($this->limiter->charge($rule->scope, self::SUBJECT)->allowed) {
                ++$admitted;
            }
        }

        self::assertSame($rule->burst, $admitted);
    }

    /**
     * The row's retention must outlive its allowance.
     *
     * The `chk_rate_limit_buckets_expiry` CHECK states it, and it is the one way
     * this table could hand out allowance it had already spent: a row swept while
     * still refusing would come back as an empty bucket.
     */
    public function testARowIsNeverSweepableWhileItIsStillRefusing(): void
    {
        $rule = $this->rule();
        $this->exhaust($rule);

        $row = $this->database->fetchOne(
            'SELECT tat_ms, expires_at_ms FROM rate_limit_buckets WHERE scope = :scope',
            ['scope' => $rule->scope],
        );

        self::assertNotNull($row);
        self::assertGreaterThan($row['tat_ms'], $row['expires_at_ms']);
    }

    /**
     * The proof that matters: two operating-system processes, two connections,
     * one remaining allowance.
     *
     * Everything above runs on one connection, where MySQL has no opportunity to
     * interleave anything. Here both workers open their own connection, signal
     * readiness, and race the same conditional UPDATE. Exactly one may win — and
     * on the target host this is not a contrived scenario but the normal one,
     * because every request is its own process.
     */
    public function testTwoIndependentProcessesCannotBothTakeTheLastAllowance(): void
    {
        $rule = $this->rule();

        // Spend everything but one unit, using the real clock the workers will
        // read rather than the movable one.
        $realLimiter = new PdoRateLimiter(
            $this->database,
            $this->policy,
            new \Eszter\Support\SystemClock(),
            new Logger($this->root . '/limiter-real.log', 'error', $this->clock),
        );

        for ($i = 0; $i < $rule->burst - 1; ++$i) {
            self::assertTrue($realLimiter->charge($rule->scope, self::SUBJECT)->allowed);
        }

        // Hold the row from a third connection so both workers block on the same
        // UPDATE rather than being serialised by arriving at different times.
        $holder = TestDatabase::connectSeparately();
        $holder->beginTransaction();
        $holder->fetchOne(
            'SELECT tat_ms FROM rate_limit_buckets WHERE scope = :scope FOR UPDATE',
            ['scope' => $rule->scope],
        );

        $workers = [];
        foreach ([0, 1] as $index) {
            $ready = $this->root . "/limiter-worker-{$index}.ready";
            $pipes = [];
            $process = proc_open(
                [PHP_BINARY, __DIR__ . '/RateLimiterWorker.php', $ready, $rule->scope, self::SUBJECT],
                [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
                $pipes,
            );
            self::assertIsResource($process);
            fclose($pipes[0]);
            $workers[] = ['process' => $process, 'pipes' => $pipes, 'ready' => $ready];
        }

        $deadline = microtime(true) + 10.0;
        do {
            $ready = array_filter($workers, static fn (array $worker): bool => is_file($worker['ready']));
            if (\count($ready) === 2) {
                break;
            }
            usleep(10_000);
        } while (microtime(true) < $deadline);
        self::assertCount(2, $ready, 'both workers did not reach the charge');

        // Time for both to actually block on the UPDATE rather than merely having
        // started. Without it the test could pass by serialising them.
        usleep(300_000);
        $holder->rollBack();

        $outcomes = [];
        foreach ($workers as $worker) {
            $stdout = trim((string) stream_get_contents($worker['pipes'][1]));
            $stderr = trim((string) stream_get_contents($worker['pipes'][2]));
            fclose($worker['pipes'][1]);
            fclose($worker['pipes'][2]);
            self::assertSame(0, proc_close($worker['process']), $stderr);
            $outcomes[] = $stdout;
        }
        sort($outcomes);

        self::assertSame(['ALLOWED', 'REFUSED'], $outcomes);
    }

    // --- ESZ-130: the anonymous-session bootstrap bucket --------------------

    /**
     * The bootstrap bucket is a contract-owned rule like any other: 30 per
     * hour with burst 10 admits exactly ten charges at one instant, refuses
     * the eleventh, and is answered through the same store and the same 429
     * decision path as the POST buckets.
     */
    public function testTheSessionBootstrapBucketHasTheFrozenRateAndBurst(): void
    {
        $rule = $this->policy->rule(RateLimitPolicy::SCOPE_SESSION_BOOTSTRAP_ADDRESS);

        self::assertSame(30, $rule->limit);
        self::assertSame(3600, $rule->periodSeconds);
        self::assertSame(10, $rule->burst);
        self::assertSame(120_000, $rule->emissionIntervalMs);

        $admitted = 0;
        for ($i = 0; $i <= $rule->burst; ++$i) {
            if ($this->limiter->charge($rule->scope, self::ESZ130_SUBJECT)->allowed) {
                ++$admitted;
            }
        }

        self::assertSame($rule->burst, $admitted);
        self::assertFalse($this->limiter->charge($rule->scope, self::ESZ130_SUBJECT)->allowed);

        // Allowance comes back at the declared rate: one emission interval
        // later exactly one charge is admitted again.
        $this->advanceMs($rule->emissionIntervalMs);
        self::assertTrue($this->limiter->charge($rule->scope, self::ESZ130_SUBJECT)->allowed);
        self::assertFalse($this->limiter->charge($rule->scope, self::ESZ130_SUBJECT)->allowed);
    }

    /**
     * ESZ-130, proof 3: the last bootstrap allowance cannot be taken twice.
     *
     * Two independent operating-system processes race the same conditional
     * UPDATE on the `auth.session.bootstrap.address` row — the exact shape two
     * simultaneous no-cookie session reads take on a host where every request
     * is its own process. Exactly one may win.
     */
    public function testTwoIndependentProcessesCannotBothTakeTheLastBootstrapAllowance(): void
    {
        $rule = $this->policy->rule(RateLimitPolicy::SCOPE_SESSION_BOOTSTRAP_ADDRESS);

        // Spend everything but one unit, using the real clock the workers will
        // read rather than the movable one.
        $realLimiter = new PdoRateLimiter(
            $this->database,
            $this->policy,
            new \Eszter\Support\SystemClock(),
            new Logger($this->root . '/limiter-real.log', 'error', $this->clock),
        );

        for ($i = 0; $i < $rule->burst - 1; ++$i) {
            self::assertTrue($realLimiter->charge($rule->scope, self::ESZ130_SUBJECT)->allowed);
        }

        // Hold the row from a third connection so both workers block on the
        // same UPDATE rather than being serialised by arriving at different
        // times.
        $holder = TestDatabase::connectSeparately();
        $holder->beginTransaction();
        $holder->fetchOne(
            'SELECT tat_ms FROM rate_limit_buckets WHERE scope = :scope FOR UPDATE',
            ['scope' => $rule->scope],
        );

        $workers = [];
        foreach ([0, 1] as $index) {
            $ready = $this->root . "/bootstrap-worker-{$index}.ready";
            $pipes = [];
            $process = proc_open(
                [PHP_BINARY, __DIR__ . '/RateLimiterWorker.php', $ready, $rule->scope, self::ESZ130_SUBJECT],
                [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
                $pipes,
            );
            self::assertIsResource($process);
            fclose($pipes[0]);
            $workers[] = ['process' => $process, 'pipes' => $pipes, 'ready' => $ready];
        }

        $deadline = microtime(true) + 10.0;
        do {
            $ready = array_filter($workers, static fn (array $worker): bool => is_file($worker['ready']));
            if (\count($ready) === 2) {
                break;
            }
            usleep(10_000);
        } while (microtime(true) < $deadline);
        self::assertCount(2, $ready, 'both workers did not reach the charge');

        // Time for both to actually block on the UPDATE rather than merely
        // having started. Without it the test could pass by serialising them.
        usleep(300_000);
        $holder->rollBack();

        $outcomes = [];
        foreach ($workers as $worker) {
            $stdout = trim((string) stream_get_contents($worker['pipes'][1]));
            $stderr = trim((string) stream_get_contents($worker['pipes'][2]));
            fclose($worker['pipes'][1]);
            fclose($worker['pipes'][2]);
            self::assertSame(0, proc_close($worker['process']), $stderr);
            $outcomes[] = $stdout;
        }
        sort($outcomes);

        self::assertSame(['ALLOWED', 'REFUSED'], $outcomes);
    }

    // --- helpers ------------------------------------------------------------

    private function rule(): RateLimitRule
    {
        return $this->policy->rule(RateLimitPolicy::SCOPE_BOOKING_CREATE_ADDRESS);
    }

    private function exhaust(RateLimitRule $rule): void
    {
        for ($i = 0; $i < $rule->burst; ++$i) {
            self::assertTrue(
                $this->limiter->charge($rule->scope, self::SUBJECT)->allowed,
                "charge {$i} of the burst was refused",
            );
        }
    }

    private function advanceMs(int $milliseconds): void
    {
        // MovableClock moves in whole seconds, so sub-second steps are applied
        // by rebuilding it. Exactness matters here: the boundary assertions are
        // the difference between proving a rate and proving "eventually".
        $moved = $this->clock->now()->modify(\sprintf('%+d milliseconds', $milliseconds));
        $this->clock = new MovableClock(\Eszter\Support\IsoTimestamp::format($moved));
        $this->limiter = new PdoRateLimiter(
            $this->database,
            $this->policy,
            $this->clock,
            new Logger($this->root . '/limiter.log', 'debug', $this->clock),
        );
    }

    private function arrivalTime(string $scope, string $subject): int
    {
        $row = $this->database->fetchOne(
            'SELECT tat_ms FROM rate_limit_buckets WHERE bucket_key = :key',
            ['key' => hash('sha256', $scope . "\0" . $subject, true)],
        );

        self::assertNotNull($row);

        return (int) $row['tat_ms'];
    }
}
