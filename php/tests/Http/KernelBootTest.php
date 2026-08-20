<?php

declare(strict_types=1);

namespace Eszter\Tests\Http;

use Eszter\Config\ConfigurationException;
use Eszter\Contract\ContractArtifactException;
use Eszter\Http\Request;
use Eszter\Kernel;
use Eszter\Storage\StorageException;
use Eszter\Support\FrozenClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * Bootstrap is fail-fast by decision, so what it refuses is the specification.
 */
final class KernelBootTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-boot');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    private function boot(): Kernel
    {
        return Kernel::boot(
            TestEnvironment::writeDeployment($this->root),
            new FrozenClock('2026-06-13T12:00:00.000Z'),
        );
    }

    public function testBootTouchesNoContentStorage(): void
    {
        // ESZ-013: boot verifies the contract and wires routes; it does not read,
        // lock or seed content. Health must be answerable on a host whose content
        // is unreadable, and a 500 must not be reachable on /api/health, whose
        // frozen statuses are 200, 400 and 405.
        $kernel = $this->boot();

        self::assertFileDoesNotExist($this->root . '/data/content/published.json');
        self::assertFileDoesNotExist($this->root . '/data/content/draft.json');
        self::assertSame(404, $kernel->handle(new Request('GET', '/api/unknown'))->status);
        self::assertSame(200, $kernel->handle(new Request('GET', '/api/health'))->status);
    }

    public function testSeedingIsIdempotentAcrossBoots(): void
    {
        $this->boot()->handle(new Request('GET', '/api/content'));
        $first = (string) file_get_contents($this->root . '/data/content/published.json');

        $this->boot()->handle(new Request('GET', '/api/content'));

        self::assertSame($first, file_get_contents($this->root . '/data/content/published.json'));
    }

    public function testAMalformedStoredEnvelopeFailsTheContentRequestRatherThanDegrading(): void
    {
        // Package 1.1 aborted the boot here. ESZ-013 moved the failure onto the
        // request that actually needs the content, which is the outcome
        // `http-contract.json` already freezes for this case
        // (`content.get.malformedStoredEnvelope`: an opaque 500 STORAGE_FAILURE).
        // Nothing is weakened — the invalid file is still never repaired,
        // replaced or served — and health stays up while it is investigated.
        $kernel = $this->boot();
        $kernel->handle(new Request('GET', '/api/content'));
        file_put_contents($this->root . '/data/content/published.json', '{ nope');

        $response = $this->boot()->handle(new Request('GET', '/api/content'));
        $body = $response->decodedBody();

        self::assertSame(500, $response->status);
        self::assertIsArray($body);
        self::assertSame('STORAGE_FAILURE', $body['error']['code']);
        self::assertSame(
            '{ nope',
            file_get_contents($this->root . '/data/content/published.json'),
            'the invalid file was rewritten',
        );

        self::assertSame(200, $this->boot()->handle(new Request('GET', '/api/health'))->status);
    }

    public function testAStorageFailureRaisesOutOfTheStorageLayerItself(): void
    {
        // The opaque 500 above must come from a real refusal, not from the route
        // happening to return nothing. Asserted directly against storage so the
        // exception type and role survive independently of the HTTP mapping.
        $kernel = $this->boot();
        $kernel->handle(new Request('GET', '/api/content'));
        file_put_contents($this->root . '/data/content/published.json', '{ nope');

        $this->expectException(StorageException::class);

        $kernel->storage->readPublished();
    }

    public function testMissingConfigurationAbortsBoot(): void
    {
        $this->expectException(ConfigurationException::class);

        Kernel::boot($this->root . '/absent.php');
    }

    public function testMissingContractArtifactsAbortBoot(): void
    {
        $path = TestEnvironment::writeDeployment(
            $this->root,
            ['paths' => ['contracts' => $this->root . '/no-contracts']],
        );

        $this->expectException(ContractArtifactException::class);

        Kernel::boot($path, new FrozenClock('2026-06-13T12:00:00.000Z'));
    }

    public function testTheLogHonoursItsLevelThreshold(): void
    {
        $this->boot();

        // Level is `error` in the test deployment, so the `info` boot line must
        // not be written at all: the logger honours its threshold rather than
        // writing everything and filtering later.
        self::assertFileDoesNotExist($this->root . '/var/log/app.log');
    }

    public function testTheLoggerWritesStructuredLinesWhenTheLevelAllowsIt(): void
    {
        Kernel::boot(
            TestEnvironment::writeDeployment($this->root, ['logLevel' => 'info']),
            new FrozenClock('2026-06-13T12:00:00.000Z'),
        );

        $log = (string) file_get_contents($this->root . '/var/log/app.log');
        $line = json_decode(trim(explode("\n", trim($log))[0]), true);

        self::assertIsArray($line);
        self::assertSame('info', $line['level']);
        self::assertSame('Kernel booted.', $line['message']);
        // `/` joined the routed surface in ESZ-021. The boot line reports what
        // this request can actually serve, so it is the first place a deployment
        // that lost the public page would show it.
        self::assertSame('/, /api/content, /api/health', $line['routes']);
        self::assertSame('2026-06-13T12:00:00.000Z', $line['ts']);
    }

    public function testStorageFailuresDuringARequestAreOpaque(): void
    {
        $kernel = $this->boot();

        $kernel->router->register('GET', '/api/probe', static function (): never {
            throw new StorageException(
                StorageException::READ_FAILED,
                'Could not read /home/user/data/content/published.json',
                'published',
            );
        });

        $response = $kernel->handle(new Request('GET', '/api/probe'));
        $body = $response->decodedBody();

        self::assertSame(500, $response->status);
        self::assertIsArray($body);
        self::assertSame('STORAGE_FAILURE', $body['error']['code']);

        // `errors.leakNothing`: no path, no file name, no storage code in the body.
        self::assertStringNotContainsString('/home/user', $response->body);
        self::assertStringNotContainsString('published.json', $response->body);
        self::assertStringNotContainsString('READ_FAILED', $response->body);
    }

    public function testAnUnexpectedFailureBecomesAnInternalError(): void
    {
        $kernel = $this->boot();

        $kernel->router->register('GET', '/api/probe', static function (): never {
            throw new \RuntimeException('secret detail at /var/private');
        });

        $response = $kernel->handle(new Request('GET', '/api/probe'));
        $body = $response->decodedBody();

        self::assertSame(500, $response->status);
        self::assertIsArray($body);
        self::assertSame('INTERNAL_ERROR', $body['error']['code']);
        self::assertStringNotContainsString('/var/private', $response->body);
    }

    public function testErrorResponsesNeverCarryAPublishedEtag(): void
    {
        $response = $this->boot()->handle(new Request('GET', '/api/unknown'));

        self::assertNull($response->header('ETag'));
    }
}
