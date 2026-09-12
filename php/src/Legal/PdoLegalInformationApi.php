<?php

declare(strict_types=1);

namespace Eszter\Legal;

use Eszter\Contract\StructuralValidator;
use Eszter\Database\Database;
use Eszter\Support\Clock;

/**
 * The MySQL implementation: one `system_settings` row.
 *
 * ESZ-040 created `system_settings` for exactly this — a non-secret
 * operational setting that becomes meaningful when a feature defines its key
 * and JSON shape — so no migration is needed. The row's `value_json` is
 * `{"revision": n, "information": {…}}`; `updated_at` is the last write.
 *
 * ## Revision
 *
 * The save is optimistic: the row is locked `FOR UPDATE` inside the
 * transaction, the stored revision is compared with the one the caller last
 * read, and a mismatch is a {@see LegalInformationRevisionConflictException}
 * that writes nothing. A missing row is revision 0 and the empty document,
 * so the first save of a fresh deployment names `expectedRevision: 0`.
 *
 * ## Nothing is invented
 *
 * A stored document is served as stored, after the frozen output schema
 * re-checks it; a row that drifted from the contract is a
 * {@see \RuntimeException} — an opaque 500 — rather than a silently repaired
 * document, because a legal page must never show a value nobody entered.
 */
final class PdoLegalInformationApi implements LegalInformationApi
{
    public function __construct(
        private readonly Database $database,
        private readonly Clock $clock,
        private readonly StructuralValidator $structural,
    ) {
    }

    public function read(): array
    {
        return ['information' => $this->stored()['information']];
    }

    public function adminRead(): array
    {
        return $this->stored();
    }

    public function adminSave(array $request): array
    {
        $expected = $request['expectedRevision'];
        $information = $request['information'];

        return $this->database->transactional(function () use ($expected, $information): array {
            $now = $this->clock->nowIso();
            $this->database->run(
                'INSERT IGNORE INTO system_settings (setting_key, value_json, created_at, updated_at)'
                . ' VALUES (:key, :value, :created, :updated)',
                [
                    'key' => LegalInformation::SETTING_KEY,
                    'value' => self::encode(0, LegalInformation::empty()),
                    'created' => $now,
                    'updated' => $now,
                ],
            );
            $row = $this->database->fetchOne(
                'SELECT value_json FROM system_settings WHERE setting_key = :key FOR UPDATE',
                ['key' => LegalInformation::SETTING_KEY],
            );
            if ($row === null) {
                throw new \RuntimeException('The legal information row disappeared while being locked.');
            }

            $current = $this->decode($row);
            if ($current['revision'] !== $expected) {
                throw new LegalInformationRevisionConflictException($expected, $current['revision']);
            }

            $next = $current['revision'] + 1;
            $this->database->run(
                'UPDATE system_settings SET value_json = :value, updated_at = :updated WHERE setting_key = :key',
                [
                    'key' => LegalInformation::SETTING_KEY,
                    'value' => self::encode($next, $information),
                    'updated' => $now,
                ],
            );

            return ['information' => $information, 'revision' => $next, 'updatedAt' => $now];
        });
    }

    /** @return array{information: array<string, mixed>, revision: int, updatedAt: ?string} */
    private function stored(): array
    {
        $row = $this->database->fetchOne(
            'SELECT value_json, updated_at FROM system_settings WHERE setting_key = :key',
            ['key' => LegalInformation::SETTING_KEY],
        );
        if ($row === null) {
            return ['information' => LegalInformation::empty(), 'revision' => 0, 'updatedAt' => null];
        }

        $decoded = $this->decode($row);
        /** @var mixed $updatedAt */
        $updatedAt = $row['updated_at'] ?? null;

        return $decoded + ['updatedAt' => \is_string($updatedAt) ? $updatedAt : null];
    }

    /**
     * @param array<string, mixed> $row
     * @return array{information: array<string, mixed>, revision: int}
     */
    private function decode(array $row): array
    {
        $json = $row['value_json'] ?? null;
        if (!\is_string($json)) {
            throw new \RuntimeException('The legal information row is malformed.');
        }

        /** @var mixed $decoded */
        $decoded = json_decode($json, true, 16, JSON_THROW_ON_ERROR);
        $revision = \is_array($decoded) ? ($decoded['revision'] ?? null) : null;
        $information = \is_array($decoded) ? ($decoded['information'] ?? null) : null;
        if (!\is_int($revision) || $revision < 0 || !\is_array($information)) {
            throw new \RuntimeException('The legal information row is malformed.');
        }

        // Re-validated on the way out, as published content is: a row that no
        // longer satisfies the frozen document shape is refused rather than
        // served with a value the page would have to guess around.
        if ($this->structural->validate(['information' => $information], LegalInformation::SCHEMA) !== []) {
            throw new \RuntimeException('The stored legal information no longer matches the contract.');
        }

        /** @var array<string, mixed> $information */
        return ['information' => $information, 'revision' => $revision];
    }

    /** @param array<string, mixed> $information */
    private static function encode(int $revision, array $information): string
    {
        return json_encode(
            ['revision' => $revision, 'information' => $information],
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE,
        );
    }
}
