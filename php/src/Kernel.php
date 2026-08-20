<?php

declare(strict_types=1);

namespace Eszter;

use Eszter\Config\Configuration;
use Eszter\Config\ConfigurationException;
use Eszter\Contract\ContentValidator;
use Eszter\Contract\ContractArtifactException;
use Eszter\Contract\ContractArtifacts;
use Eszter\Http\Endpoint\ExportedPageReader;
use Eszter\Http\Endpoint\HealthEndpoint;
use Eszter\Http\Endpoint\PublicContentEndpoint;
use Eszter\Http\Endpoint\PublicPageEndpoint;
use Eszter\Http\EntityTag;
use Eszter\Http\ErrorCatalog;
use Eszter\Http\HttpException;
use Eszter\Http\PublicPageBootstrap;
use Eszter\Http\Request;
use Eszter\Http\RequestId;
use Eszter\Http\Response;
use Eszter\Http\Router;
use Eszter\Storage\ContentStorage;
use Eszter\Storage\ExportedPageFile;
use Eszter\Storage\PublishedContentReader;
use Eszter\Storage\StorageException;
use Eszter\Support\Clock;
use Eszter\Support\Logger;
use Eszter\Support\SystemClock;

/**
 * Wires the application and answers one request.
 *
 * ## Fail-fast, on purpose
 *
 * {@see boot()} loads configuration, digest-verifies the contract artifacts and
 * asserts every declared semantic rule is implemented. Any of those failing
 * aborts the boot: the service will not answer from an unverified contract.
 *
 * PHP has no startup, so "bootstrap" is per request. The reference service paid
 * this cost once at `listen()`; here it is paid every time. That is affordable and
 * it is the only way to keep the guarantee on a model with no long-lived process.
 *
 * ## What boot deliberately does *not* do (ESZ-013)
 *
 * Boot no longer initialises content storage. Package 1.1 did, which had two
 * consequences that only became visible once public routes existed:
 *
 *  1. `/api/health` would have depended on content being readable, so an editor
 *     publishing a bad document would have looked like an outage on every monitor
 *     watching the host. The contract now states the opposite as an invariant
 *     (`health.doesNotDependOnContentStorage`).
 *  2. It made a 500 reachable on `/api/health`, whose frozen statuses are 200,
 *     400 and 405.
 *
 * Storage is therefore touched only by the route that needs it, and an unreadable
 * or invalid published document surfaces as the 500 `STORAGE_FAILURE` the contract
 * already freezes for `GET /api/content`. Nothing is weakened: content that does
 * not validate is still never repaired, replaced or served — the failure simply
 * lands on the request that asked for it.
 *
 * A failure *before* routing — unusable configuration, corrupt artifacts — still
 * answers 500 on any path. The contract states that separately under
 * `bootstrapFailure`, rather than as a status of an endpoint, so it cannot be read
 * as a failure mode of health itself.
 */
final class Kernel
{
    private function __construct(
        public readonly Configuration $config,
        public readonly ContractArtifacts $artifacts,
        public readonly ContentValidator $validator,
        public readonly ContentStorage $storage,
        public readonly Router $router,
        public readonly ErrorCatalog $errors,
        public readonly RequestId $requestIds,
        public readonly Logger $logger,
        public readonly int $requestBodyLimitBytes,
    ) {
    }

    /**
     * @param PublishedContentReader|null $publishedContentReader Overrides the
     *        source `GET /api/content` reads from. Used by the HTTP conformance
     *        suite to replay the contract's storage-failure cases against the real
     *        route; production always passes null and gets {@see ContentStorage}.
     * @param ExportedPageReader|null $exportedPageReader Overrides the exported
     *        HTML `GET /` injects into. Same seam, same reason: the suite asserts
     *        against a known export rather than against whatever `front/out/`
     *        happens to hold. Production passes null and reads the document root.
     */
    public static function boot(
        string $configPath,
        ?Clock $clock = null,
        ?PublishedContentReader $publishedContentReader = null,
        ?ExportedPageReader $exportedPageReader = null,
    ): self {
        $clock ??= new SystemClock();
        $config = Configuration::fromFile($configPath);

        $logger = new Logger($config->logFile(), $config->logLevel, $clock);

        $artifacts = new ContractArtifacts($config->contractsDir);
        $artifacts->verifyAll();

        $validator = ContentValidator::create($artifacts);
        $errors = ErrorCatalog::fromArtifacts($artifacts);
        $contract = $artifacts->httpContract();
        $requestIds = RequestId::fromContract($contract);

        $storage = new ContentStorage(
            $config->contentDir,
            $config->tmpDir,
            $config->lockDir,
            $artifacts,
            $validator,
            $clock,
        );

        $kernel = new self(
            $config,
            $artifacts,
            $validator,
            $storage,
            new Router(),
            $errors,
            $requestIds,
            $logger,
            self::parseByteSize($contract['requestBodyLimit'] ?? '64kb'),
        );

        $kernel->registerPublicRoutes(
            $publishedContentReader ?? $storage,
            $exportedPageReader ?? new ExportedPageFile($config->publicDir),
            $clock,
        );

        // Logged after wiring, so the line reports what this request can actually
        // serve. Package 1.1 logged the storage seeding outcome here; storage is
        // no longer touched at boot, and a line naming a step that no longer runs
        // is worse than no line at all.
        $routes = $kernel->router->paths();
        sort($routes);
        $logger->info('Kernel booted.', [
            'environment' => $config->environment,
            'routes' => implode(', ', $routes),
        ]);

        return $kernel;
    }

    /**
     * The frozen public surface, and nothing else.
     *
     * Every path registered here must already exist in `http-contract.json`.
     * `/api/admin/*` and `/api/auth/*` stay unregistered on purpose: the contract
     * freezes them at a structured 404, so routing one before it is contracted
     * would be a silent breaking change.
     */
    private function registerPublicRoutes(
        PublishedContentReader $reader,
        ExportedPageReader $pages,
        Clock $clock,
    ): void {
        $contract = $this->artifacts->httpContract();
        /** @var array<string, mixed> $caching */
        $caching = $contract['caching'] ?? [];
        /** @var mixed $cacheControl */
        $cacheControl = $caching['cacheControl'] ?? null;

        if (!\is_string($cacheControl)) {
            throw new \RuntimeException('http-contract.json has no caching.cacheControl.');
        }

        $this->router->register(
            'GET',
            HealthEndpoint::PATH,
            HealthEndpoint::fromArtifacts($this->artifacts, $clock),
        );

        $etags = EntityTag::fromContract($contract);

        $this->router->register(
            'GET',
            PublicContentEndpoint::PATH,
            new PublicContentEndpoint($reader, $this->validator, $etags, $cacheControl),
        );

        // ESZ-021: `/` joined the frozen surface. Until Package 2.1 the front
        // controller was mounted at `/api` and the contract carried a standing PHP
        // exemption saying so; the static export removed the Node server that used
        // to answer here, so the page is now this service's to serve and the
        // exemption is gone.
        //
        // The same `EntityTag` instance backs both routes, which is what makes
        // `page.etagMatchesContentEndpoint` true by construction rather than by
        // two implementations agreeing.
        /** @var mixed $publicPage */
        $publicPage = $contract['publicPage'] ?? null;
        /** @var mixed $pageContentType */
        $pageContentType = \is_array($publicPage) ? ($publicPage['contentType'] ?? null) : null;

        if (!\is_string($pageContentType)) {
            throw new \RuntimeException('http-contract.json has no publicPage.contentType.');
        }

        $page = new PublicPageEndpoint(
            $pages,
            $reader,
            $this->validator,
            PublicPageBootstrap::fromArtifacts($this->artifacts),
            $etags,
            $cacheControl,
            $pageContentType,
            $this->logger,
        );

        // Registered under both methods rather than special-cased in the router:
        // the contract lists `["GET", "HEAD"]` for this path, and the 405 `Allow`
        // header is built from what is registered, so this is what makes
        // `page.post.methodNotAllowed` answer `Allow: GET, HEAD`.
        $this->router->register('GET', PublicPageEndpoint::PATH, $page);
        $this->router->register('HEAD', PublicPageEndpoint::PATH, $page);
    }

    public function handle(Request $request): Response
    {
        $requestId = $this->requestIds->resolve($request->header(RequestId::HEADER));

        try {
            $this->rejectUnusableBody($request);

            $response = $this->router->dispatch($request);
        } catch (HttpException $exception) {
            $response = $this->errorResponse(
                $exception->status,
                $exception->errorCode,
                $requestId,
                $exception->headers,
            );
        } catch (StorageException $exception) {
            // Opaque by contract: the body must not reveal a path, a file name or
            // a schema detail. Diagnostics go to the log and nowhere else.
            $this->logger->error('Content storage failure.', [
                'requestId' => $requestId,
                'detail' => $exception->getMessage(),
            ] + $exception->logContext());

            $response = $this->errorResponse(500, ErrorCatalog::STORAGE_FAILURE, $requestId);
        } catch (\Throwable $exception) {
            $this->logger->error('Unhandled request failure.', [
                'requestId' => $requestId,
                'exception' => $exception::class,
                'detail' => $exception->getMessage(),
            ]);

            $response = $this->errorResponse(500, ErrorCatalog::INTERNAL_ERROR, $requestId);
        }

        // Every response carries the id, including 304 and 500
        // (`requestId.presentOnEveryResponse`).
        return $response->withHeader(RequestId::HEADER, $requestId);
    }

    /** @param array<string, string> $headers */
    public function errorResponse(
        int $status,
        string $code,
        string $requestId,
        array $headers = [],
    ): Response {
        return Response::json($status, $this->errors->envelope($code, $requestId), $headers);
    }

    /**
     * Body checks run before routing, mirroring the reference service where the
     * JSON body parser sits ahead of every route: `POST` with a malformed body is
     * a 400, decided before the method is judged.
     */
    private function rejectUnusableBody(Request $request): void
    {
        if ($request->rawBody === '') {
            return;
        }

        if (\strlen($request->rawBody) > $this->requestBodyLimitBytes) {
            // Frozen in Package 1.2 as `overLimitBodyOutcome`: 400 INVALID_JSON,
            // enforced before routing and regardless of Content-Type, so an
            // oversized body is a 400 even on a path that would otherwise 404 or
            // 405. A write route that later accepts bodies may want a dedicated
            // code; that would be a deliberate contract change.
            throw HttpException::invalidJson('Request body exceeds the contract limit.');
        }

        if (!$request->hasJsonContentType()) {
            return;
        }

        if (json_decode($request->rawBody, true) === null && json_last_error() !== JSON_ERROR_NONE) {
            throw HttpException::invalidJson(json_last_error_msg());
        }
    }

    /** Runs the front controller: boot, handle, send. */
    public static function run(string $configPath): void
    {
        /** @var array<string, mixed> $server */
        $server = $_SERVER;
        $request = Request::fromGlobals($server, file_get_contents('php://input') ?: '');

        self::respond($configPath, $request)->send();
    }

    /**
     * Answers one request, including the case where booting is what failed.
     *
     * Split from {@see run()} so the bootstrap-failure path is reachable from a
     * test. It is frozen behaviour (`http-contract.json`, `bootstrapFailure`) and
     * on a per-request runtime it is something clients actually receive, so it
     * needs to be exercised rather than assumed — a boot failure must still answer
     * the frozen JSON envelope, never a PHP error page, because an HTML 500 under
     * `/api/*` would break the contract's promise that every `/api` response is
     * JSON.
     */
    public static function respond(string $configPath, Request $request): Response
    {
        try {
            return self::boot($configPath)->handle($request);
        } catch (\Throwable $exception) {
            return self::bootFailureResponse($exception, $request);
        }
    }

    private static function bootFailureResponse(\Throwable $exception, Request $request): Response
    {
        $code = match (true) {
            $exception instanceof ConfigurationException,
            $exception instanceof ContractArtifactException => ErrorCatalog::INVALID_CONFIGURATION,
            $exception instanceof StorageException => ErrorCatalog::STORAGE_FAILURE,
            default => ErrorCatalog::INTERNAL_ERROR,
        };

        // The catalog itself may be what failed to load, so the messages are
        // restated here as a last resort. This is the one place a duplicate of the
        // contract copy is unavoidable; ContractCopyTest asserts it stays equal.
        $messages = [
            ErrorCatalog::INVALID_CONFIGURATION => 'La configuration du serveur est invalide.',
            ErrorCatalog::STORAGE_FAILURE => 'Le contenu publié est momentanément indisponible.',
            ErrorCatalog::INTERNAL_ERROR => 'Une erreur interne est survenue.',
        ];

        $inbound = $request->header(RequestId::HEADER);
        $requestId = $inbound !== null && preg_match('#^[A-Za-z0-9._:-]{1,80}$#', $inbound) === 1
            ? $inbound
            : 'req_' . bin2hex(random_bytes(16));

        error_log(\sprintf(
            '[eszter] boot failure (%s): %s',
            $exception::class,
            $exception->getMessage(),
        ));

        return Response::json(500, [
            'error' => ['code' => $code, 'message' => $messages[$code], 'requestId' => $requestId],
        ])->withHeader(RequestId::HEADER, $requestId);
    }

    /** Parses the contract's `requestBodyLimit` (`"64kb"`). */
    public static function parseByteSize(mixed $value): int
    {
        if (\is_int($value)) {
            return $value;
        }

        if (!\is_string($value) || preg_match('/^(\d+)\s*(b|kb|mb)?$/i', trim($value), $match) !== 1) {
            throw new \InvalidArgumentException('Unparseable byte size in http-contract.json.');
        }

        return (int) $match[1] * match (strtolower($match[2] ?? 'b')) {
            'kb' => 1024,
            'mb' => 1024 * 1024,
            default => 1,
        };
    }
}
