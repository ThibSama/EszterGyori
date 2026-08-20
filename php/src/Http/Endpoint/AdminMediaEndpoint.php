<?php

declare(strict_types=1);

namespace Eszter\Http\Endpoint;

use Eszter\Auth\Authenticator;
use Eszter\Auth\CsrfGuard;
use Eszter\Auth\SessionManager;
use Eszter\Contract\StructuralValidator;
use Eszter\Http\ErrorCatalog;
use Eszter\Http\HttpException;
use Eszter\Http\Request;
use Eszter\Http\Response;
use Eszter\Media\MediaContract;
use Eszter\Media\MediaLibrary;
use Eszter\Support\Logger;

/**
 * The shared boundary of `/api/admin/media` (Package 3.3).
 *
 * The same order of operations as {@see AdminContentEndpoint}, for the same
 * reasons:
 *
 * ```
 * authenticate → CSRF (writes only) → parse/verify → storage
 * ```
 *
 * Authentication first so an anonymous caller is told 401 rather than 403; the
 * token before anything reads bytes, so an unauthorised caller cannot use the
 * upload route as a free image-decoder oracle — which is a sharper version of the
 * "free validation oracle" argument on the content surface, because a decoder is
 * a much larger attack surface than a JSON Schema.
 *
 * ## Why this is not a subclass of AdminContentEndpoint
 *
 * They share four dependencies and one guard, and nothing else. The content base
 * exists to hold the *revision* protocol — `expectedRevision`, the conflict
 * translation, the `x-content-revision` header — and none of that applies here:
 * a media operation moves no revision, and a media response must not carry the
 * header at all. Inheriting it would mean carrying a concurrency mechanism this
 * surface deliberately does not have, and the first person to add
 * `expectedRevision` to an upload would find the machinery already sitting there
 * inviting them.
 *
 * The library has its own optimistic story and it is much simpler: uploads only
 * ever append under a fresh random id, so two concurrent uploads cannot conflict,
 * and a delete is serialised by the library's exclusive lock.
 */
abstract class AdminMediaEndpoint
{
    public const PATH = '/api/admin/media';

    public function __construct(
        protected readonly Authenticator $auth,
        protected readonly SessionManager $sessions,
        protected readonly CsrfGuard $csrf,
        protected readonly MediaContract $contract,
        protected readonly MediaLibrary $library,
        protected readonly StructuralValidator $structural,
        protected readonly Logger $logger,
    ) {
    }

    /** Whether this route changes state and therefore requires a CSRF token. */
    abstract protected function isStateChanging(): bool;

    abstract protected function handle(Request $request): Response;

    final public function __invoke(Request $request): Response
    {
        $this->auth->requireAccount();

        if ($this->isStateChanging()) {
            $session = $this->sessions->current();

            if ($session === null) {
                // Unreachable: requireAccount() established a live session.
                // Stated rather than assumed, because the alternative to throwing
                // on the security-critical path is a null dereference.
                throw HttpException::unauthenticated();
            }

            $this->csrf->assert($request, $session);
        }

        return $this->handle($request);
    }

    /**
     * The headers every media response carries.
     *
     * `no-store`, and never a revision header. The absence is asserted by the
     * contract corpus: a media response that reported `x-content-revision` would
     * suggest media participates in the content revision sequence, and the first
     * client to treat it as a precondition would be protected by nothing.
     *
     * @return array<string, string>
     */
    final protected function mediaHeaders(): array
    {
        return ['Cache-Control' => $this->contract->cacheControl];
    }

    /**
     * Decodes and structurally validates a JSON body against a generated schema.
     *
     * Mirrors {@see AdminContentEndpoint::validatedAgainstSchema()} rather than
     * calling it: these bodies carry no `SiteContent`, so there is no validation
     * *target* for them and the semantic rules — every one of which is about
     * editorial content — would have nothing to say. The generated schemas are
     * closed and required-complete, so "structural" here still means every rule
     * that exists for these bodies.
     *
     * @return array<string, mixed>
     * @throws HttpException 400 INVALID_JSON or 400 VALIDATION_FAILED
     */
    final protected function validatedBody(Request $request, string $schemaFile): array
    {
        /** @var mixed $decoded */
        $decoded = json_decode($request->rawBody, true);

        if (!\is_array($decoded) || json_last_error() !== JSON_ERROR_NONE) {
            throw new HttpException(
                400,
                ErrorCatalog::INVALID_JSON,
                $this->mediaHeaders(),
                'Media request body is not a JSON object.',
            );
        }

        /** @var array<string, mixed> $decoded */
        $issues = $this->structural->validate($decoded, $schemaFile);

        if ($issues !== []) {
            $this->logger->warn('Media body failed structural validation.', [
                'schema' => $schemaFile,
                'issues' => \count($issues),
            ]);

            throw new HttpException(
                400,
                ErrorCatalog::VALIDATION_FAILED,
                $this->mediaHeaders(),
                "Body failed validation against {$schemaFile}.",
            );
        }

        return $decoded;
    }
}
