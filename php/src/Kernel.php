<?php

declare(strict_types=1);

namespace Eszter;

use Eszter\Admin\AccountDirectory;
use Eszter\Admin\AdminAccountRepository;
use Eszter\Auth\Authenticator;
use Eszter\Auth\CsrfGuard;
use Eszter\Auth\PdoSessionStore;
use Eszter\Auth\SessionCookie;
use Eszter\Auth\SessionManager;
use Eszter\Auth\SessionStore;
use Eszter\Booking\BookingApi;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\PdoBookingApi;
use Eszter\Composition\AdminContentRoutes;
use Eszter\Composition\AdminMediaRoutes;
use Eszter\Composition\AuthRoutes;
use Eszter\Composition\AuthenticatedServices;
use Eszter\Composition\BookingRoutes;
use Eszter\Composition\KernelServices;
use Eszter\Composition\PublicRoutes;
use Eszter\Config\Configuration;
use Eszter\Config\ConfigurationException;
use Eszter\Contract\ContentValidator;
use Eszter\Contract\ContractArtifactException;
use Eszter\Contract\ContractArtifacts;
use Eszter\Contract\StructuralValidator;
use Eszter\Database\Database;
use Eszter\Http\Endpoint\AdminMediaEndpoint;
use Eszter\Http\Endpoint\AuthSessionEndpoint;
use Eszter\Http\Endpoint\ExportedPageReader;
use Eszter\Http\ErrorCatalog;
use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Http\RequestId;
use Eszter\Http\Response;
use Eszter\Http\Router;
use Eszter\Media\ManagedMediaReferenceGuard;
use Eszter\Media\MediaContract;
use Eszter\Media\MediaLibrary;
use Eszter\Media\PhpUploadTransport;
use Eszter\Media\UploadTransport;
use Eszter\Notification\NotificationPolicy;
use Eszter\Security\NullRateLimiter;
use Eszter\Security\PdoRateLimiter;
use Eszter\Security\RateLimitGuard;
use Eszter\Security\RateLimitPolicy;
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
 *
 * ## Route surfaces (ESZ-105)
 *
 * Endpoint construction and registration are owned by five dedicated
 * composition classes — {@see PublicRoutes}, {@see AuthRoutes},
 * {@see AdminContentRoutes}, {@see AdminMediaRoutes} and {@see BookingRoutes} —
 * grouped by feature surface. This root still decides *whether* a surface
 * exists (the registration conditions below are the frozen ones) and still
 * constructs every shared service once, handing the composers a readonly
 * {@see KernelServices} snapshot plus their own inputs.
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
        /** The frozen `media` block, so the body guard can size the upload route. */
        public readonly MediaContract $media,
        public readonly MediaLibrary $mediaLibrary,
        /**
         * Null when no authenticated surface is wired, which happens only outside
         * production and only when no `database` block is configured. Production
         * cannot reach that state: {@see Configuration} refuses to boot without
         * one.
         */
        public readonly ?SessionManager $sessions = null,
        /**
         * Abuse control for the three anonymous write routes (ESZ-084).
         *
         * Never null. Without a database it is a {@see NullRateLimiter}, which
         * admits everything and is named so that "not throttled" is visible in a
         * stack rather than inferred from a missing object. Production always has
         * a database — {@see Configuration} refuses to boot without one — so it
         * always gets the real limiter.
         */
        public readonly ?RateLimitGuard $rateLimits = null,
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
     * @param AccountDirectory|null $accountDirectory Overrides where admin
     *        accounts are read from.
     * @param SessionStore|null $sessionStore Overrides where sessions live. The
     *        same seam a third time, and the reason is sharpest here:
     *        `php:http-contract` replays the whole frozen surface — the auth cases
     *        included — and must do so without a MySQL server, while
     *        `sql:integration` proves the SQL implementation of both against a
     *        real one. Production passes null for both and gets
     *        {@see AdminAccountRepository} and {@see PdoSessionStore}.
     * @param UploadTransport|null $uploadTransport Overrides how a multipart part
     *        is recognised and moved (ESZ-036). The seam exists because
     *        `is_uploaded_file()` answers only for paths PHP itself wrote while
     *        parsing the current request, which no test can arrange — and the
     *        parts of the ingest worth testing all come after the move.
     *        Production passes null and gets {@see PhpUploadTransport}, keeping
     *        the real guarantee.
     * @param BookingApi|null $bookingApi Overrides booking use cases for the
     *        contract runner. Production passes null and gets the MySQL-backed
     *        implementation whenever database configuration exists.
     */
    public static function boot(
        string $configPath,
        ?Clock $clock = null,
        ?PublishedContentReader $publishedContentReader = null,
        ?ExportedPageReader $exportedPageReader = null,
        ?AccountDirectory $accountDirectory = null,
        ?SessionStore $sessionStore = null,
        ?UploadTransport $uploadTransport = null,
        ?BookingApi $bookingApi = null,
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
        $structural = new StructuralValidator($artifacts);
        $media = MediaContract::fromArtifacts($artifacts);

        // Constructed unconditionally, like `ContentStorage`: it opens nothing,
        // creates nothing and touches no disk until a media route calls it. A
        // public-surface request therefore pays for it exactly as much as it pays
        // for the content storage it also does not use. Built before the content
        // storage so the ESZ-147 guard can borrow its catalogue.
        $mediaLibrary = new MediaLibrary(
            $media,
            $config->contentDir,
            $config->mediaOriginalsDir,
            $config->mediaPublicDir(),
            $config->tmpDir,
            $config->lockDir,
            $artifacts,
            $structural,
            $clock,
        );

        $mediaReferenceGuard = new ManagedMediaReferenceGuard($media, $mediaLibrary);

        // ESZ-147: every save and publish commit verifies, under the shared
        // media/content boundary, that the managed media src values it is
        // about to persist are all catalogued. ContentStorage cannot build
        // this itself — the media domain owns the contract and the
        // catalogue — so the kernel composes it, exactly as it composes
        // every other production dependency. The guard's own method is the
        // callable, so the two signatures cannot drift.
        $assertManagedReferencesResolvable = $mediaReferenceGuard->assertResolvable(...);

        $storage = new ContentStorage(
            $config->contentDir,
            $config->tmpDir,
            $config->lockDir,
            $artifacts,
            $validator,
            $clock,
            $assertManagedReferencesResolvable,
        );

        // Constructing `Database` opens no connection, so a public-surface
        // request still costs nothing. The connection happens on the first query,
        // which only an `/api/auth/*` request makes.
        $database = $config->database === null ? null : new Database($config->database, $config->lockDir);

        // Whether the authenticated surface is backed by this kernel's own SQL
        // wiring — the account directory and the session store built from
        // `$database` below — rather than by seams the caller injected. Only
        // then does `$database` transact the login (ESZ-134). Captured before
        // `$sessionStore` is replaced by its SQL default, which would erase the
        // distinction.
        $sqlWiring = $accountDirectory === null && $sessionStore === null;

        $accounts = $accountDirectory
            ?? ($database === null ? null : new AdminAccountRepository($database, $clock));
        $sessionStore ??= $database === null ? null : new PdoSessionStore($database, $clock);
        $bookingApi ??= $database === null
            ? null
            : PdoBookingApi::createDefault(
                $database,
                $clock,
                BookingDomainContract::fromArtifacts($artifacts),
                NotificationPolicy::fromArtifacts($artifacts),
            );

        // Read from the artifact at boot so a malformed or unhonourable policy
        // fails the whole request with INVALID_CONFIGURATION, rather than at the
        // first login of the day.
        $rateLimitPolicy = RateLimitPolicy::fromArtifacts($artifacts);
        $rateLimits = new RateLimitGuard(
            $database === null
                ? new NullRateLimiter()
                : new PdoRateLimiter($database, $rateLimitPolicy, $clock, $logger),
            $rateLimitPolicy,
            $logger,
        );

        $sessions = $accounts === null || $sessionStore === null
            ? null
            : new SessionManager(
                $sessionStore,
                SessionCookie::fromArtifacts($artifacts, $config->session->cookieSecure),
                $config->session,
                $clock,
            );

        $router = new Router();
        $kernel = new self(
            $config,
            $artifacts,
            $validator,
            $storage,
            $router,
            $errors,
            $requestIds,
            $logger,
            self::parseByteSize($contract['requestBodyLimit'] ?? '64kb'),
            $media,
            $mediaLibrary,
            $sessions,
            $rateLimits,
        );

        // ESZ-105: the surfaces are composed by dedicated classes. This root
        // keeps the wiring — it constructs every service below once and hands
        // the same instances to every composer — and it keeps the *conditions*
        // under which a surface exists; the composers own which concrete
        // endpoints realise each surface and how they are registered.
        $services = new KernelServices(
            $artifacts,
            $validator,
            $structural,
            $storage,
            $media,
            $mediaLibrary,
            $logger,
            $clock,
        );
        $authenticated = null;

        // The public surface is reachable on every deployment, database or
        // not. The two seam arguments resolve to their production defaults
        // here, next to the parameters of {@see boot()} that document them.
        (new PublicRoutes(
            $services,
            $publishedContentReader ?? $storage,
            $exportedPageReader ?? new ExportedPageFile($config->publicDir),
        ))->register($router);

        if ($accounts !== null && $sessions !== null) {
            // The authenticated surfaces — auth, admin content, admin media
            // and the admin half of the booking surface — exist only where
            // there is a session store to keep sessions in.
            //
            // The authenticator's login transition (ESZ-134) is transactional
            // exactly when this kernel built the SQL wiring itself — the
            // account directory and the session store then share this
            // Database. In the seam-driven replay wiring the seams carry their
            // own (or no) persistence, so passing this Database would open a
            // real connection behind the doubles; there the rotation is
            // compensated rather than rolled back.
            $authenticated = new AuthenticatedServices(
                new Authenticator($accounts, $sessions, $clock, $logger, $sqlWiring ? $database : null),
                $sessions,
                CsrfGuard::fromArtifacts($artifacts),
            );

            (new AuthRoutes($services, $authenticated))->register($router);
            (new AdminContentRoutes($services, $authenticated))->register($router);
            (new AdminMediaRoutes(
                $services,
                $authenticated,
                $uploadTransport ?? new PhpUploadTransport(),
            ))->register($router);
        }

        if ($bookingApi !== null) {
            (new BookingRoutes($services, $bookingApi, $authenticated))->register($router);
        }

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

    public function handle(Request $request): Response
    {
        $requestId = $this->requestIds->resolve($request->header(RequestId::HEADER));

        // Before routing, so that a 403 or a 401 raised inside an endpoint still
        // knows which session it was raised against, and so that the public
        // surface — which never calls ensure() — pays only the cost of a cookie
        // lookup and, at most, one indexed SELECT.
        $this->sessions?->load($request);

        try {
            $this->rejectUnusableBody($request);

            // After the body guard and before dispatch. The order is the policy:
            // an over-limit or unparseable body is the caller's mistake and is
            // refused without spending an allowance, while everything the route
            // would actually do — the password verification, the row lock, the
            // slot computation — happens strictly after the charge.
            $this->rateLimits?->assert($request, $requestId);

            // ESZ-130: the anonymous session read is the one GET the limiter
            // guards. `GET /api/auth/session` with no live session (no cookie,
            // or a missing, malformed, invented or expired one) is what opens a
            // durable anonymous row and mints a CSRF token, so it is charged to
            // `auth.session.bootstrap.address` *before* the route can create
            // anything — a refusal therefore creates no session, no token and
            // no cookie. A read that found a live session is never charged.
            //
            // Between the charge and the row creation the session store runs a
            // bounded, index-backed expiry sweep, so the admission that pays for
            // a new anonymous row also pays for deleting the expired ones. The
            // sweep runs on no other path: it is deliberately deterministic on
            // this one rather than probabilistic, and a sweep failure refuses
            // the request through the catch below without a row having been
            // created.
            $anonymousBootstrap = $request->method === 'GET'
                && $request->path === AuthSessionEndpoint::PATH
                && $this->sessions !== null
                && $this->sessions->current() === null;

            if ($anonymousBootstrap) {
                $this->rateLimits?->assertSessionBootstrap($request, $requestId);
                $this->sessions->collectGarbage();
            }

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

        // Applied to *every* outcome, errors included. A rotated or cleared
        // session must reach the client even when the response that carries it is
        // a 401 — and, just as importantly, a failed login or a rejected CSRF
        // check must not hand out a cookie, which is what
        // `SessionManager::applyTo()` decides rather than each call site.
        $response = $this->sessions?->applyTo($response) ?? $response;

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
        $limit = $this->bodyLimitFor($request);

        // Checked before the raw body, because on a `multipart/form-data` request
        // `php://input` is empty by design — the parts are in `$_FILES` — so the
        // declared length is the only evidence of size that reaches this point.
        // `overLimitBody` leaves the detection method open ("declared
        // Content-Length, bytes actually read") and freezes only the refusal.
        $declared = $request->declaredContentLength();

        if ($declared !== null && $declared > $limit) {
            throw $this->overLimit($request, "declared {$declared} bytes, limit {$limit}");
        }

        if ($request->rawBody === '') {
            return;
        }

        if (\strlen($request->rawBody) > $limit) {
            // Frozen in Package 1.2 as `overLimitBodyOutcome`: 400 INVALID_JSON,
            // enforced before routing and regardless of Content-Type, so an
            // oversized body is a 400 even on a path that would otherwise 404 or
            // 405. The media upload route is the one exception, and it is an
            // exception in both directions — a larger limit and a different code.
            throw $this->overLimit($request, 'body exceeds the limit');
        }

        if (!$request->hasJsonContentType()) {
            return;
        }

        if (json_decode($request->rawBody, true) === null && json_last_error() !== JSON_ERROR_NONE) {
            throw HttpException::invalidJson(json_last_error_msg());
        }
    }

    /**
     * The body limit that applies to one request.
     *
     * `REQUEST_BODY_LIMIT` is 64 kB and stays 64 kB for every route but one.
     * Raising the global limit so that uploads could pass would hand every other
     * route — the unauthenticated ones included — a 128× larger buffer to be
     * asked to parse as JSON, which is a cost paid by the whole surface for the
     * benefit of a single authenticated endpoint. The limit belongs to the route,
     * so it is applied per route, and the exception is stated in exactly one
     * place rather than being a condition inside the guard.
     *
     * The upload route's allowance is the file limit plus the multipart framing,
     * because the framing is part of what a client must send in order to deliver a
     * file of the maximum size — and rejecting a file of exactly the maximum size
     * is the one refusal a user is most likely to hit deliberately.
     */
    private function bodyLimitFor(Request $request): int
    {
        return $request->method === 'POST' && $request->path === AdminMediaEndpoint::PATH
            ? $this->media->requestLimitBytes()
            : $this->requestBodyLimitBytes;
    }

    /**
     * The refusal for an over-limit body: 413 on the upload route, 400 elsewhere.
     *
     * Two codes rather than one, because a client can act on the difference. On
     * every JSON route an oversized body means the client built something wrong,
     * and `overLimitBodyOutcome` freezes that as 400 `INVALID_JSON`. On the upload
     * route it means the person chose a file that is too big, which their UI has
     * to turn into a sentence about file size — and `INVALID_JSON` for a
     * multipart image would be a lie about what was wrong.
     */
    private function overLimit(Request $request, string $detail): HttpException
    {
        return $request->method === 'POST' && $request->path === AdminMediaEndpoint::PATH
            ? HttpException::payloadTooLarge("Upload over the media route limit: {$detail}.")
            : HttpException::invalidJson("Request body exceeds the contract limit: {$detail}.");
    }

    /** Runs the front controller: boot, handle, send. */
    public static function run(string $configPath): void
    {
        /** @var array<string, mixed> $server */
        $server = $_SERVER;
        /** @var array<mixed> $files */
        $files = $_FILES;

        // `php://input` is empty on a multipart request — PHP consumed the body
        // to populate `$_FILES` — so both have to be read for the request object
        // to describe what actually arrived.
        $request = Request::fromGlobals($server, file_get_contents('php://input') ?: '', $files);

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
