<?php

declare(strict_types=1);

namespace Eszter\Tests\Http;

use Eszter\Legal\LegalInformation;
use Eszter\Legal\LegalInformationApi;
use Eszter\Legal\LegalInformationRevisionConflictException;

/**
 * Deterministic transport fixture for the legal routes (ESZ-165); the
 * `system_settings` behaviour is proved by the SQL suite.
 */
final class InMemoryLegalInformationApi implements LegalInformationApi
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    /** @var array<string, mixed> */
    private array $information;
    private int $revision = 0;
    private ?string $updatedAt = null;

    public function __construct()
    {
        $this->information = LegalInformation::empty();
    }

    public function read(): array
    {
        return ['information' => $this->information];
    }

    public function adminRead(): array
    {
        return [
            'information' => $this->information,
            'revision' => $this->revision,
            'updatedAt' => $this->updatedAt,
        ];
    }

    public function adminSave(array $request): array
    {
        if ($request['expectedRevision'] !== $this->revision) {
            throw new LegalInformationRevisionConflictException($request['expectedRevision'], $this->revision);
        }

        $this->information = $request['information'];
        ++$this->revision;
        $this->updatedAt = self::NOW;

        return $this->adminRead();
    }
}
