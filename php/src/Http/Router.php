<?php

declare(strict_types=1);

namespace Eszter\Http;

/**
 * Exact-path routing for `/api/*`.
 *
 * No pattern matching, no parameters: the frozen surface is two literal paths
 * (`docs/contract-freeze.md`), and every additional path must be added to
 * `contracts/http-contract.ts` *before* it is routed here.
 *
 * Two distinctions the contract makes and this router therefore makes:
 *
 *  - a **known path with an unknown method** is 405 with `Allow`, never 404;
 *  - an **unknown path** is a structured JSON 404, never an HTML error page.
 *
 * As of Package 1.1 no public route is registered. `/api/health` and
 * `/api/content` are ESZ-013; until then they answer 404 exactly like
 * `/api/admin/*` and `/api/auth/*`, which is the frozen behaviour the corpus
 * asserts for unimplemented routes.
 */
final class Router
{
    /** @var array<string, array<string, callable(Request): Response>> */
    private array $routes = [];

    /** @param callable(Request): Response $handler */
    public function register(string $method, string $path, callable $handler): void
    {
        $this->routes[$path][strtoupper($method)] = $handler;
    }

    /** @return list<string> */
    public function paths(): array
    {
        return array_keys($this->routes);
    }

    /** @throws HttpException 404 for an unknown path, 405 for a wrong method. */
    public function dispatch(Request $request): Response
    {
        $handlers = $this->routes[$request->path] ?? null;

        if ($handlers === null) {
            throw HttpException::notFound();
        }

        $handler = $handlers[$request->method] ?? null;

        if ($handler === null) {
            $allowed = array_keys($handlers);
            sort($allowed);

            throw HttpException::methodNotAllowed($allowed);
        }

        return $handler($request);
    }
}
