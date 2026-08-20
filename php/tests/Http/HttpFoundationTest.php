<?php

declare(strict_types=1);

namespace Eszter\Tests\Http;

use Eszter\Http\ErrorCatalog;
use Eszter\Http\Request;
use Eszter\Http\RequestId;
use Eszter\Http\Response;
use Eszter\Kernel;
use Eszter\Support\FrozenClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * The ESZ-010 front controller: the mechanics every route inherits.
 *
 * The contract *cases* now live in {@see HttpContractConformanceTest}, which
 * replays the whole artifact against the real routes. What stays here is the
 * layer underneath — request-id handling, the closed error envelope, contract-owned
 * copy, body handling ahead of routing, the 405-with-Allow branch — asserted
 * directly rather than through whichever endpoint happens to exercise it.
 *
 * Package 1.1's `testUnimplementedContractCases()` is gone with the gap it
 * tracked: it named the `/api/health` and `/api/content` cases as pending, and
 * ESZ-013/ESZ-014 implemented them.
 */
final class HttpFoundationTest extends TestCase
{
    private static ?string $root = null;
    private static ?Kernel $kernel = null;

    public static function tearDownAfterClass(): void
    {
        if (self::$root !== null) {
            TestEnvironment::removeDirectory(self::$root);
            self::$root = null;
            self::$kernel = null;
        }
    }

    private static function kernel(): Kernel
    {
        if (self::$kernel === null) {
            self::$root = TestEnvironment::makeTempDirectory('eszter-http');
            self::$kernel = Kernel::boot(
                TestEnvironment::writeDeployment(self::$root),
                new FrozenClock('2026-06-13T12:00:00.000Z'),
            );
        }

        return self::$kernel;
    }

    /** @return array<mixed> */
    private static function contract(): array
    {
        return TestEnvironment::artifacts()->httpContract();
    }

    public function testEveryResponseCarriesARequestId(): void
    {
        $response = self::kernel()->handle(new Request('GET', '/api/unknown'));

        $requestId = $response->header(RequestId::HEADER);
        self::assertIsString($requestId);
        self::assertStringStartsWith('req_', $requestId);

        $body = $response->decodedBody();
        self::assertIsArray($body);
        self::assertSame($requestId, $body['error']['requestId']);
    }

    public function testASafeInboundRequestIdIsEchoedVerbatim(): void
    {
        $response = self::kernel()->handle(new Request(
            'GET',
            '/api/unknown',
            ['x-request-id' => 'req_contract-safe.id:1'],
        ));

        self::assertSame('req_contract-safe.id:1', $response->header(RequestId::HEADER));
    }

    public function testAnUnsafeInboundRequestIdIsReplaced(): void
    {
        $unsafe = "../unsafe request id\r\nX-Injected: 1";

        $response = self::kernel()->handle(new Request(
            'GET',
            '/api/unknown',
            ['x-request-id' => $unsafe],
        ));

        $requestId = $response->header(RequestId::HEADER);
        self::assertIsString($requestId);
        self::assertNotSame($unsafe, $requestId);
        self::assertStringStartsWith('req_', $requestId);
    }

    public function testTheErrorEnvelopeIsClosedAndMatchesTheGeneratedSchema(): void
    {
        $response = self::kernel()->handle(new Request('GET', '/api/unknown'));
        $body = $response->decodedBody();

        self::assertIsArray($body);
        self::assertSame(['error'], array_keys($body));
        self::assertSame(['code', 'message', 'requestId'], array_keys($body['error']));
        self::assertSame(Response::JSON_CONTENT_TYPE, $response->header('content-type'));
    }

    public function testErrorMessagesComeFromTheContractNotFromPhp(): void
    {
        $catalog = ErrorCatalog::fromArtifacts(TestEnvironment::artifacts());
        /** @var array<string, string> $messages */
        $messages = self::contract()['errorMessages'];

        foreach ($catalog->codes() as $code) {
            self::assertSame($messages[$code], $catalog->message($code));
        }

        $body = self::kernel()->handle(new Request('GET', '/api/unknown'))->decodedBody();
        self::assertIsArray($body);
        self::assertSame($messages[ErrorCatalog::NOT_FOUND], $body['error']['message']);
    }

    public function testAMalformedJsonBodyIsRejectedBeforeRouting(): void
    {
        // The reference parses the body ahead of every route, so a bad body is a
        // 400 even on a path that would otherwise be a 404.
        $response = self::kernel()->handle(new Request(
            'POST',
            '/api/unknown',
            ['content-type' => 'application/json'],
            '{invalid-json',
        ));

        self::assertSame(400, $response->status);
        $body = $response->decodedBody();
        self::assertIsArray($body);
        self::assertSame(ErrorCatalog::INVALID_JSON, $body['error']['code']);
    }

    public function testABodyOverTheContractLimitIsRejected(): void
    {
        $limit = Kernel::parseByteSize(self::contract()['requestBodyLimit']);

        $response = self::kernel()->handle(new Request(
            'POST',
            '/api/unknown',
            ['content-type' => 'application/json'],
            json_encode(['pad' => str_repeat('x', $limit)]) ?: '',
        ));

        self::assertSame(400, $response->status);
    }

    public function testAWellFormedBodyOnAnUnknownPathIsStillA404(): void
    {
        $response = self::kernel()->handle(new Request(
            'POST',
            '/api/unknown',
            ['content-type' => 'application/json'],
            '{"ok":true}',
        ));

        self::assertSame(404, $response->status);
    }

    public function testAKnownPathWithAWrongMethodIs405WithAllow(): void
    {
        $response = self::kernel()->handle(new Request('POST', '/api/health'));

        self::assertSame(405, $response->status);
        self::assertSame('GET', $response->header('Allow'));

        $body = $response->decodedBody();
        self::assertIsArray($body);
        self::assertSame(ErrorCatalog::METHOD_NOT_ALLOWED, $body['error']['code']);
    }

    public function testAnUnknownPathIsA404RatherThanA405(): void
    {
        // The distinction the router exists to make: a wrong method on a *known*
        // path is 405 with Allow, an unknown path is a structured 404. An
        // unimplemented but planned route must fall in the second class until it
        // is contracted, which is what keeps /api/admin/* and /api/auth/* frozen.
        $response = self::kernel()->handle(new Request('POST', '/api/auth/login'));

        self::assertSame(404, $response->status);
        self::assertNull($response->header('Allow'));
    }

    public function testTheContractRequestBodyLimitParsesToSixtyFourKilobytes(): void
    {
        self::assertSame(65536, Kernel::parseByteSize(self::contract()['requestBodyLimit']));
    }
}
