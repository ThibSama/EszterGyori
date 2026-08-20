<?php

declare(strict_types=1);

namespace Eszter\Tests\Http;

use Eszter\Http\ErrorCatalog;
use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Http\RequestId;
use Eszter\Http\Response;
use Eszter\Http\Router;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

final class RouterTest extends TestCase
{
    private function router(): Router
    {
        $router = new Router();
        $router->register('GET', '/api/thing', static fn (): Response => Response::json(200, ['ok' => true]));
        $router->register('HEAD', '/api/thing', static fn (): Response => Response::empty(200));

        return $router;
    }

    public function testAMatchingRouteIsInvoked(): void
    {
        $response = $this->router()->dispatch(new Request('GET', '/api/thing'));

        self::assertSame(200, $response->status);
        self::assertSame(['ok' => true], $response->decodedBody());
    }

    public function testAnUnknownPathIsNotFound(): void
    {
        try {
            $this->router()->dispatch(new Request('GET', '/api/other'));
            self::fail('an unknown path was routed');
        } catch (HttpException $exception) {
            self::assertSame(404, $exception->status);
            self::assertSame(ErrorCatalog::NOT_FOUND, $exception->errorCode);
        }
    }

    public function testAKnownPathWithAnUnknownMethodIsMethodNotAllowedNot404(): void
    {
        try {
            $this->router()->dispatch(new Request('DELETE', '/api/thing'));
            self::fail('a wrong method was routed');
        } catch (HttpException $exception) {
            self::assertSame(405, $exception->status);
            self::assertSame(ErrorCatalog::METHOD_NOT_ALLOWED, $exception->errorCode);
            self::assertSame('GET, HEAD', $exception->headers['Allow']);
        }
    }

    public function testMethodMatchingIsCaseInsensitiveOnRegistration(): void
    {
        $router = new Router();
        $router->register('get', '/api/thing', static fn (): Response => Response::json(200, []));

        self::assertSame(200, $router->dispatch(new Request('GET', '/api/thing'))->status);
    }

    public function testNoPublicRouteIsRegisteredYet(): void
    {
        // Package 1.1 builds the foundation and stops. /api/health and /api/content
        // are ESZ-013; until then they must answer 404 like any other unknown path.
        self::assertSame([], (new Router())->paths());
    }

    public function testRequestIdsFollowTheContractPattern(): void
    {
        $requestIds = RequestId::fromContract(TestEnvironment::artifacts()->httpContract());

        self::assertTrue($requestIds->isTrusted('req_contract-safe.id:1'));
        self::assertFalse($requestIds->isTrusted('../unsafe request id'));
        self::assertFalse($requestIds->isTrusted(str_repeat('a', 81)));
        self::assertFalse($requestIds->isTrusted(''));
        self::assertFalse($requestIds->isTrusted("safe\nX-Injected: 1"));

        self::assertSame('req_contract-safe.id:1', $requestIds->resolve('req_contract-safe.id:1'));
        self::assertStringStartsWith('req_', $requestIds->resolve('../unsafe'));
        self::assertStringStartsWith('req_', $requestIds->resolve(null));
        self::assertNotSame($requestIds->generate(), $requestIds->generate());
    }

    public function testGeneratedRequestIdsSatisfyTheErrorEnvelopeSchema(): void
    {
        $schema = TestEnvironment::artifacts()->schema('error-envelope.schema.json');
        /** @var string $pattern */
        $pattern = $schema['properties']['error']['properties']['requestId']['pattern'];

        $requestIds = RequestId::fromContract(TestEnvironment::artifacts()->httpContract());

        for ($i = 0; $i < 20; $i++) {
            self::assertMatchesRegularExpression('#' . $pattern . '#', $requestIds->generate());
        }
    }
}
