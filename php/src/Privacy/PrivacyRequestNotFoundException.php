<?php

declare(strict_types=1);

namespace Eszter\Privacy;

/** The register holds no record under the requested internal id. */
final class PrivacyRequestNotFoundException extends \RuntimeException
{
    public function __construct(public readonly int $id)
    {
        parent::__construct("No privacy request exists under id {$id}.");
    }
}
