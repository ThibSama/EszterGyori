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
use Eszter\Config\Configuration;
use Eszter\Config\ConfigurationException;
use Eszter\Contract\StructuralValidator;
use Eszter\Database\Database;
use Eszter\Contract\ContentValidator;
use Eszter\Contract\ContractArtifactException;
use Eszter\Contract\ContractArtifacts;
use Eszter\Http\Endpoint\AdminDraftReadEndpoint;
use Eszter\Http\Endpoint\AdminDraftSaveEndpoint;
use Eszter\Http\Endpoint\AdminMediaDeleteEndpoint;
use Eszter\Http\Endpoint\AdminMediaEndpoint;
use Eszter\Http\Endpoint\AdminMediaListEndpoint;
use Eszter\Http\Endpoint\AdminMediaUploadEndpoint;
use Eszter\Http\Endpoint\AdminPublishEndpoint;
use Eszter\Http\Endpoint\AdminResetEndpoint;
use Eszter\Http\Endpoint\AdminBookingsMutationEndpoint;
use Eszter\Http\Endpoint\AdminBookingsQueryEndpoint;
use Eszter\Http\Endpoint\AdminBookingMoveAvailabilityEndpoint;
use Eszter\Http\Endpoint\AdminBookingsSummaryEndpoint;
use Eszter\Http\Endpoint\AdminAvailabilityQueryEndpoint;
use Eszter\Http\Endpoint\AdminAvailabilityWeeklyEndpoint;
use Eszter\Http\Endpoint\AdminAvailabilityExceptionsEndpoint;
use Eszter\Http\Endpoint\AuthLoginEndpoint;
use Eszter\Http\Endpoint\AuthLogoutEndpoint;
use Eszter\Http\Endpoint\AuthSessionEndpoint;
use Eszter\Http\Endpoint\ExportedPageReader;
use Eszter\Http\Endpoint\HealthEndpoint;
use Eszter\Http\Endpoint\PublicContentEndpoint;
use Eszter\Http\Endpoint\PublicPageEndpoint;
use Eszter\Http\Endpoint\PublicBookingAvailabilityEndpoint;
use Eszter\Http\Endpoint\PublicBookableServicesEndpoint;
use Eszter\Http\Endpoint\PublicBookingCreateEndpoint;
use Eszter\Http\EntityTag;
use Eszter\Http\ErrorCatalog;
use Eszter\Http\HttpException;
use Eszter\Http\PublicPageBootstrap;
use Eszter\Http\Request;
use Eszter\Http\RequestId;
use Eszter\Http\Response;
use Eszter\Http\Router;
use Eszter\Media\ImagePipeline;
use Eszter\Media\MediaContract;
use Eszter\Media\MediaIngest;
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

        $storage = new ContentStorage(
            $config->contentDir,
            $config->tmpDir,
            $config->lockDir,
            $artifacts,
            $validator,
            $clock,
        );

        // Constructed unconditionally, like `ContentStorage`: it opens nothing,
        // creates nothing and touches no disk until a media route calls it. A
        // public-surface request therefore pays for it exactly as much as it pays
        // for the content storage it also does not use.
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

        // Constructing `Database` opens no connection, so a public-surface
        // request still costs nothing. The connection happens on the first query,
        // which only an `/api/auth/*` request makes.
        $database = $config->database === null ? null : new Database($config->database, $config->lockDir);

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
            $media,
            $mediaLibrary,
            $sessions,
            $rateLimits,
        );

        $kernel->registerPublicRoutes(
            $publishedContentReader ?? $storage,
            $exportedPageReader ?? new ExportedPageFile($config->publicDir),
            $clock,
        );
        if ($bookingApi !== null) {
            $kernel->registerPublicBookingRoutes($bookingApi, $structural, $logger);
        }

        if ($accounts !== null && $sessions !== null) {
            $kernel->registerAuthenticatedRoutes(
                $accounts,
                $sessions,
                $clock,
                $logger,
                $structural,
                $uploadTransport ?? new PhpUploadTransport(),
                $bookingApi,
            );
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

    /**
     * The authenticated surface (ESZ-025 / ESZ-026).
     *
     * Registered separately from {@see registerPublicRoutes()} because the two
     * have opposite invariants. The public routes must be reachable on every
     * deployment; these must be reachable only where there is a database to keep
     * sessions in, and `Configuration` guarantees that production is such a place.
     *
     * `/admin` itself is *not* registered here and never will be. It is a static
     * file served by Apache, it enforces nothing, and every guarantee about who may
     * do what is made by these three routes and the ones that will join them
     * (`auth.accessControl`).
     */
    private function registerAuthenticatedRoutes(
        AccountDirectory $accounts,
        SessionManager $sessions,
        Clock $clock,
        Logger $logger,
        StructuralValidator $structural,
        UploadTransport $uploadTransport,
        ?BookingApi $bookingApi,
    ): void {
        $authenticator = new Authenticator($accounts, $sessions, $clock, $logger);
        $csrf = CsrfGuard::fromArtifacts($this->artifacts);

        $this->router->register('GET', AuthSessionEndpoint::PATH, new AuthSessionEndpoint($authenticator));
        $this->router->register(
            'POST',
            AuthLoginEndpoint::PATH,
            new AuthLoginEndpoint($authenticator, $sessions, $csrf, $structural),
        );
        $this->router->register(
            'POST',
            AuthLogoutEndpoint::PATH,
            new AuthLogoutEndpoint($authenticator, $sessions, $csrf),
        );

        $this->registerAdminContentRoutes($authenticator, $sessions, $csrf, $structural, $logger);
        $this->registerAdminMediaRoutes(
            $authenticator,
            $sessions,
            $csrf,
            $structural,
            $logger,
            $clock,
            $uploadTransport,
        );
        if ($bookingApi !== null) {
            $shared = [$bookingApi, $structural, $logger, $authenticator, $sessions, $csrf];
            $this->router->register(
                'POST',
                AdminBookingsQueryEndpoint::PATH,
                new AdminBookingsQueryEndpoint(...$shared),
            );
            $this->router->register(
                'POST',
                AdminBookingMoveAvailabilityEndpoint::PATH,
                new AdminBookingMoveAvailabilityEndpoint(...$shared),
            );
            $this->router->register(
                'PATCH',
                AdminBookingsMutationEndpoint::PATH,
                new AdminBookingsMutationEndpoint(...$shared),
            );

            // ESZ-063/064/065. Gated on the same `$bookingApi !== null` condition
            // as the routes above and for the same reason: without booking use
            // cases these would only ever answer 500.
            $this->router->register(
                'POST',
                AdminBookingsSummaryEndpoint::PATH,
                new AdminBookingsSummaryEndpoint(...$shared),
            );
            $this->router->register(
                'POST',
                AdminAvailabilityQueryEndpoint::PATH,
                new AdminAvailabilityQueryEndpoint(...$shared),
            );
            $this->router->register(
                'PUT',
                AdminAvailabilityWeeklyEndpoint::PATH,
                new AdminAvailabilityWeeklyEndpoint(...$shared),
            );
            $this->router->register(
                'PATCH',
                AdminAvailabilityExceptionsEndpoint::PATH,
                new AdminAvailabilityExceptionsEndpoint(...$shared),
            );
        }
    }

    private function registerPublicBookingRoutes(
        BookingApi $booking,
        StructuralValidator $structural,
        Logger $logger,
    ): void {
        $dependencies = [$booking, $structural, $logger];
        $this->router->register(
            'GET',
            PublicBookableServicesEndpoint::PATH,
            new PublicBookableServicesEndpoint(...$dependencies),
        );
        $this->router->register(
            'POST',
            PublicBookingAvailabilityEndpoint::PATH,
            new PublicBookingAvailabilityEndpoint(...$dependencies),
        );
        $this->router->register(
            'POST',
            PublicBookingCreateEndpoint::PATH,
            new PublicBookingCreateEndpoint(...$dependencies),
        );
    }

    /**
     * The admin media surface (ESZ-036 / ESZ-037).
     *
     * Gated on the same condition as the content surface and for the same
     * reason: a deployment with no session store can authenticate nobody, so
     * routing these would only produce endpoints that answer 401 forever.
     *
     * Three verbs on one path, registered separately, so the 405 `Allow` header is
     * built from what is registered and reports `DELETE, GET, POST` without
     * anything restating it. There is no `{id}` route: `Router` is exact-path by
     * construction, and `mediaDeleteRequestSchema` argues why the id travels in the
     * body instead.
     *
     * The delete endpoint takes the real {@see ContentStorage}, not the
     * `PublishedContentReader` seam the public routes accept, because it must read
     * the *authoritative* draft as well as the published document — and the seam
     * exists to fake published reads, which is exactly what a reference check must
     * not be given.
     */
    private function registerAdminMediaRoutes(
        Authenticator $authenticator,
        SessionManager $sessions,
        CsrfGuard $csrf,
        StructuralValidator $structural,
        Logger $logger,
        Clock $clock,
        UploadTransport $uploadTransport,
    ): void {
        $images = new ImagePipeline($this->media);

        $shared = [
            $authenticator,
            $sessions,
            $csrf,
            $this->media,
            $this->mediaLibrary,
            $structural,
            $logger,
        ];

        $this->router->register(
            'GET',
            AdminMediaEndpoint::PATH,
            new AdminMediaListEndpoint(...$shared),
        );
        $this->router->register(
            'POST',
            AdminMediaEndpoint::PATH,
            new AdminMediaUploadEndpoint(...$shared, ingest: new MediaIngest(
                $this->media,
                $images,
                $this->mediaLibrary,
                $structural,
                $uploadTransport,
                $clock,
                $logger,
            )),
        );
        $this->router->register(
            'DELETE',
            AdminMediaEndpoint::PATH,
            new AdminMediaDeleteEndpoint(...$shared, storage: $this->storage),
        );
    }

    /**
     * The admin content surface (ESZ-030/031/032/033).
     *
     * Registered alongside `/api/auth/*` rather than beside the public routes,
     * and gated on the same condition, because they share the thing that makes
     * them possible: a session store. A deployment with no database has nowhere
     * to keep a session, so it can authenticate nobody, so routing these would
     * only produce endpoints that answer 401 forever. `Configuration` guarantees
     * production is never such a deployment.
     *
     * These routes read and write through {@see ContentStorage} directly — the
     * real one, not the `PublishedContentReader` seam the public routes accept.
     * That seam exists so the conformance suite can replay storage *failures*
     * against a read-only surface; a writing surface has to be exercised against
     * a real directory, because atomic replacement, locking and the revision
     * sequence are precisely what a fixture would fake away.
     *
     * `/api/admin/content/draft` is registered under two methods on one path, so
     * the 405 `Allow` header is built from what is registered and reports
     * `GET, PUT` without anything restating it.
     */
    private function registerAdminContentRoutes(
        Authenticator $authenticator,
        SessionManager $sessions,
        CsrfGuard $csrf,
        StructuralValidator $structural,
        Logger $logger,
    ): void {
        /** @var array<string, mixed> $adminContent */
        $adminContent = $this->artifacts->adminContentContract();
        /** @var mixed $cacheControl */
        $cacheControl = $adminContent['cacheControl'] ?? null;
        /** @var mixed $revisionHeader */
        $revisionHeader = $adminContent['revisionHeader'] ?? null;

        if (!\is_string($cacheControl) || !\is_string($revisionHeader)) {
            throw new \RuntimeException(
                'http-contract.json has no adminContent.cacheControl/revisionHeader.',
            );
        }

        $dependencies = [
            $authenticator,
            $sessions,
            $csrf,
            $this->storage,
            $this->validator,
            $structural,
            $this->artifacts,
            $logger,
            $cacheControl,
            $revisionHeader,
        ];

        $this->router->register(
            'GET',
            AdminDraftReadEndpoint::PATH,
            new AdminDraftReadEndpoint(...$dependencies),
        );
        $this->router->register(
            'PUT',
            AdminDraftSaveEndpoint::PATH,
            new AdminDraftSaveEndpoint(...$dependencies),
        );
        $this->router->register(
            'POST',
            AdminPublishEndpoint::PATH,
            new AdminPublishEndpoint(...$dependencies),
        );
        $this->router->register(
            'POST',
            AdminResetEndpoint::PATH,
            new AdminResetEndpoint(...$dependencies),
        );
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
