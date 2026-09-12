<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Contract\StructuralValidator;
use Eszter\Database\Database;
use Eszter\Legal\LegalInformation;
use Eszter\Legal\LegalInformationRevisionConflictException;
use Eszter\Legal\PdoLegalInformationApi;
use Eszter\Tests\MovableClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-165 — the legal document against the real `system_settings` row: the
 * empty document before any save, a whole-document save with its
 * applicability values stored verbatim, the revision guard, and the
 * output-schema re-check on the way out.
 */
final class LegalInformationSqlTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    private static bool $migrated = false;

    private Database $database;
    private MovableClock $clock;
    private PdoLegalInformationApi $api;

    protected function setUp(): void
    {
        if (!TestDatabase::isConfigured()) {
            self::markTestSkipped(TestDatabase::skipReason());
        }

        $this->database = TestDatabase::connect();

        if (!self::$migrated) {
            TestDatabase::dropEverything($this->database);
            TestDatabase::migrator($this->database)->migrate();
            self::$migrated = true;
        }

        TestDatabase::truncateData($this->database);

        $this->clock = new MovableClock(self::NOW);
        $this->api = new PdoLegalInformationApi(
            $this->database,
            $this->clock,
            new StructuralValidator(TestEnvironment::artifacts()),
        );
    }

    /** @return array<string, mixed> */
    private static function document(): array
    {
        return [
            'legalName' => 'Exemple EI',
            'tradeName' => null,
            'legalForm' => 'Entrepreneur individuel',
            'siren' => '123456789',
            'siret' => '12345678900012',
            'registers' => [['label' => 'Registre national des entreprises', 'reference' => '123 456 789']],
            'vat' => ['applicable' => false],
            'activity' => 'Maquillage permanent',
            'contact' => ['email' => 'contact@example.test', 'phone' => null],
            'hosting' => [
                'name' => 'Hébergeur Exemple',
                'address' => "1 rue de l’Exemple\n59000 Lille",
                'phone' => null,
                'website' => 'https://hebergeur.example',
            ],
            'registeredAddress' => "1 rue de l’Exemple\n59000 Lille",
            'salonAddress' => ['applicable' => false],
        ];
    }

    public function testAFreshDeploymentHoldsTheEmptyDocumentAtRevisionZeroAndNoRow(): void
    {
        self::assertSame(
            ['information' => LegalInformation::empty(), 'revision' => 0, 'updatedAt' => null],
            $this->api->adminRead(),
        );
        self::assertSame(['information' => LegalInformation::empty()], $this->api->read());
        self::assertNull($this->database->fetchOne(
            'SELECT setting_key FROM system_settings WHERE setting_key = :key',
            ['key' => LegalInformation::SETTING_KEY],
        ));
    }

    public function testASaveStoresTheDocumentVerbatimUnderTheNextRevision(): void
    {
        $saved = $this->api->adminSave(['expectedRevision' => 0, 'information' => self::document()]);

        self::assertSame(1, $saved['revision']);
        self::assertSame(self::NOW, $saved['updatedAt']);
        self::assertSame(self::document(), $saved['information']);

        // Both reads are the same row: the public projection sees exactly
        // what the admin stored — a non-applicable VAT and salon address, a
        // null phone, an empty trade name — with nothing filled in for it.
        // (`assertEquals`: the JSON column normalises key order, which the
        // wire does not care about.)
        self::assertEquals(['information' => self::document()], $this->api->read());
        self::assertEquals($saved, $this->api->adminRead());

        $this->clock->advanceSeconds(60);
        $partial = LegalInformation::empty();
        $partial['legalName'] = 'Exemple EI';
        $again = $this->api->adminSave(['expectedRevision' => 1, 'information' => $partial]);
        self::assertSame(2, $again['revision']);
        self::assertSame('2026-06-13T12:01:00.000Z', $again['updatedAt']);
        self::assertEquals($partial, $this->api->read()['information']);
    }

    public function testAStaleRevisionIsRefusedAndWritesNothing(): void
    {
        $this->api->adminSave(['expectedRevision' => 0, 'information' => self::document()]);

        $late = LegalInformation::empty();
        try {
            $this->api->adminSave(['expectedRevision' => 0, 'information' => $late]);
            self::fail('A stale revision must be refused.');
        } catch (LegalInformationRevisionConflictException $exception) {
            self::assertSame(['expectedRevision' => 0, 'currentRevision' => 1], $exception->logContext());
        }

        self::assertSame(1, $this->api->adminRead()['revision']);
        self::assertEquals(self::document(), $this->api->read()['information']);
    }

    public function testADriftedRowIsRefusedRatherThanServedRepaired(): void
    {
        $this->database->run(
            'INSERT INTO system_settings (setting_key, value_json, created_at, updated_at)'
            . ' VALUES (:key, :value, :created, :updated)',
            [
                'key' => LegalInformation::SETTING_KEY,
                'value' => '{"revision":3,"information":{"legalName":"Exemple"}}',
                'created' => self::NOW,
                'updated' => self::NOW,
            ],
        );

        $this->expectException(\RuntimeException::class);
        $this->api->read();
    }
}
