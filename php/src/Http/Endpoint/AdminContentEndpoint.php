<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Auth\Authenticator;
use Eszter\Auth\CsrfGuard;
use Eszter\Auth\SessionManager;
use Eszter\Contract\ContentValidator;
use Eszter\Contract\ContractArtifacts;
use Eszter\Contract\StructuralValidator;
use Eszter\Http\ErrorCatalog;
use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Storage\ContentStorage;
use Eszter\Storage\RevisionConflictException;
use Eszter\Storage\StorageException;
use Eszter\Support\Logger;

/**
 * The shared boundary of `/api/admin/content/*` (Package 3.1).
 *
 * Four routes, one order of operations, enforced here rather than repeated in
 * each of them:
 *
 * ```
 * authenticate → CSRF (writes only) → parse body → validate body → storage
 * ```
 *
 * The order is the contract's and each step protects the next. Authentication
 * first, because `csrf.requirements` says a caller with neither a session nor a
 * token must be told 401 rather than 403 — the reverse would tell an anonymous
 * caller that its *token* was the problem, implying a session it does not have.
 * The token before the body, so an unauthorised caller cannot use these routes
 * as a free validation oracle for documents it is not allowed to save. And the
 * body before storage, so nothing takes the exclusive lock on a request that was
 * never going to be written.
 *
 * The consequence that matters is that a 401 or a 403 never reaches storage at
 * all: it takes no lock, reads no file and — per
 * `content.rejectedRequestsNeverReachStorage` — sends no revision header, so a
 * rejected caller cannot even learn that a draft exists.
 *
 * ## Why these are not the auth endpoints' shape
 *
 * `/api/auth/*` resolves its own session per call. So does this, through the same
 * {@see Authenticator}: `requireAccount()` re-reads the account from the
 * directory on every request, which is what makes a disabled account 401 here on
 * its *next call* rather than at its next login. Nothing about being "already
 * inside the admin area" is carried between requests, because there is no such
 * thing on a per-request runtime.
 */
abstract class AdminContentEndpoint
{
    public function __construct(
        protected readonly Authenticator $auth,
        protected readonly SessionManager $sessions,
        protected readonly CsrfGuard $csrf,
        protected readonly ContentStorage $storage,
        protected readonly ContentValidator $validator,
        protected readonly StructuralValidator $structural,
        protected readonly ContractArtifacts $artifacts,
        protected readonly Logger $logger,
        /** `adminContent.cacheControl`; `no-store`, read from the artifact. */
        protected readonly string $cacheControl,
        /** `adminContent.revisionHeader`; `x-content-revision`. */
        protected readonly string $revisionHeader,
    ) {
    }

    /** Whether this route changes state and therefore requires a CSRF token. */
    abstract protected function isStateChanging(): bool;

    /** Runs after the guard has passed. */
    abstract protected function handle(Request $request): Response;

    final public function __invoke(Request $request): Response
    {
        // Throws 401 when the session is absent, unknown, expired, or attached to
        // an account that has since been disabled or deleted.
        $this->auth->requireAccount();

        if ($this->isStateChanging()) {
            $session = $this->sessions->current();

            if ($session === null) {
                // Unreachable: requireAccount() established a live session. Stated
                // rather than assumed, because the alternative to throwing here is
                // a null dereference on the security-critical path.
                throw HttpException::unauthenticated();
            }

            $this->csrf->assert($request, $session);
        }

        try {
            return $this->handle($request);
        } catch (RevisionConflictException $conflict) {
            // Not a storage failure and not the caller's mistake: an expected
            // outcome of concurrent editing, answered with everything the client
            // needs to re-read, rebase and retry.
            $this->logger->info(
                'Content write refused: the draft moved under the caller.',
                $conflict->logContext(),
            );

            throw new HttpException(
                409,
                ErrorCatalog::REVISION_CONFLICT,
                $this->contentHeaders($conflict->currentRevision),
                $conflict->getMessage(),
            );
        }
    }

    /**
     * The headers every admin content response carries.
     *
     * `no-store` on all of them, including errors: an error body is not editorial
     * work, but a surface where *some* responses are cacheable is one where the
     * rule has to be got right per response instead of once.
     *
     * The revision header is added only when a revision was actually read under
     * the lock. There is no default: a header reporting `0` because nothing was
     * read would be indistinguishable from one reporting a real head of 0.
     *
     * @return array<string, string>
     */
    final protected function contentHeaders(?int $revision = null): array
    {
        $headers = ['Cache-Control' => $this->cacheControl];

        if ($revision !== null) {
            $headers[$this->revisionHeader] = (string) $revision;
        }

        return $headers;
    }

    /**
     * Decodes and contract-validates the request body against one target.
     *
     * Validation failure is a 400 whose body is the frozen envelope: the issue
     * list goes to the log and never onto the wire. That is the same rule the
     * public surface follows, and it matters more here — the issues name JSON
     * pointers into the content schema, and a response carrying them would
     * publish the shape of the document to anyone who could reach the route.
     *
     * @return array<string, mixed> The normalised, validated body.
     * @throws HttpException 400 INVALID_JSON or 400 VALIDATION_FAILED
     */
    final protected function validatedBody(Request $request, string $target): array
    {
        $result = $this->validator->validate($this->decodedObject($request), $target);

        if (!$result->valid || !\is_array($result->value)) {
            $this->logger->warn('Admin content body failed contract validation.', [
                'target' => $target,
                'issues' => \count($result->issues),
            ]);

            throw HttpException::validationFailed("Body failed validation for {$target}.");
        }

        /** @var array<string, mixed> */
        return $result->value;
    }

    /**
     * Decodes and structurally validates a body that carries no content document.
     *
     * The publish and reset bodies are two scalars each. Running them through
     * {@see ContentValidator} would mean naming a validation *target* for a
     * document with no `SiteContent` in it, and the semantic rules — every one of
     * which is about editorial content — would have nothing to say. Worse, it
     * would leave a content-shaped seam for someone to later add a content field
     * to a route whose whole point is that it has none.
     *
     * So these use the structural validator directly against their generated
     * schema. The schemas are closed and required-complete, so "structural" here
     * still means every rule that exists for these bodies.
     *
     * @return array<string, mixed>
     * @throws HttpException 400 INVALID_JSON or 400 VALIDATION_FAILED
     */
    final protected function validatedAgainstSchema(Request $request, string $schemaFile): array
    {
        $decoded = $this->decodedObject($request);
        $issues = $this->structural->validate($decoded, $schemaFile);

        if ($issues !== []) {
            $this->logger->warn('Admin content body failed structural validation.', [
                'schema' => $schemaFile,
                'issues' => \count($issues),
            ]);

            throw HttpException::validationFailed("Body failed validation against {$schemaFile}.");
        }

        return $decoded;
    }

    /**
     * @return array<string, mixed>
     * @throws HttpException 400 INVALID_JSON
     */
    private function decodedObject(Request $request): array
    {
        /** @var mixed $decoded */
        $decoded = json_decode($request->rawBody, true);

        if (!\is_array($decoded) || json_last_error() !== JSON_ERROR_NONE) {
            // A body that is not JSON at all is normally caught before routing.
            // It reaches here only when the request declared no JSON Content-Type,
            // and the answer is the same one the pre-routing check would have
            // given, rather than a second dialect for the same problem.
            throw HttpException::invalidJson('Admin content body is not a JSON object.');
        }

        /** @var array<string, mixed> */
        return $decoded;
    }

    /**
     * The `expectedRevision` precondition, already schema-checked as a
     * non-negative integer by {@see validatedBody()}.
     *
     * @param array<string, mixed> $body
     */
    final protected function expectedRevision(array $body): int
    {
        /** @var mixed $expected */
        $expected = $body['expectedRevision'] ?? null;

        if (!\is_int($expected) || $expected < 0) {
            // Unreachable: the request schemas require it and pin its type. The
            // check stands because an unconditional write is the one outcome this
            // surface must never produce by accident.
            throw HttpException::validationFailed('expectedRevision is absent or not a revision.');
        }

        return $expected;
    }

    /**
     * The revision of an envelope that has just been read back from storage.
     *
     * Never defaulted. A header reporting `0` because the value was unreadable
     * would be indistinguishable from one reporting a real head of `0`, and the
     * client would rebase onto a revision that does not exist.
     *
     * @param array<string, mixed> $envelope
     */
    final protected function revisionOf(array $envelope): int
    {
        /** @var mixed $revision */
        $revision = $envelope['revision'] ?? null;

        if (!\is_int($revision) || $revision < 0) {
            // Unreachable: the envelope came back through readEnvelope(), whose
            // schema pins revision to a non-negative integer.
            throw new StorageException(
                StorageException::VALIDATION_FAILED,
                'A stored envelope came back without a usable revision.',
            );
        }

        return $revision;
    }
}
