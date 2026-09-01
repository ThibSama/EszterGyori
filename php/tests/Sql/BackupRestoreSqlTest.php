<?php

declare(strict_types=1);

namespace Eszter\Tests\Sql;

use Eszter\Backup\BackupException;
use Eszter\Backup\BackupRestore;
use Eszter\Backup\BackupSet;
use Eszter\Backup\BackupWriter;
use Eszter\Backup\DatabaseDump;
use Eszter\Backup\TarArchive;
use Eszter\Booking\BookingDomainContract;
use Eszter\Booking\BookingRepository;
use Eszter\Config\Configuration;
use Eszter\Database\Database;
use Eszter\Media\MediaLibrary;
use Eszter\Notification\NotificationPolicy;
use Eszter\Storage\ApplicationSnapshotLock;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Media\MediaFixtures;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * ESZ-083 — the restore proof.
 *
 * ## Why this test is the deliverable and the backup command is not
 *
 * A backup that has never been restored is a hypothesis. Everything that actually
 * goes wrong with backups goes wrong at restore time and is invisible until then:
 * a table nobody remembered to include, a file written with the wrong permissions,
 * a foreign key that only resolves because the source database still had the row,
 * an image whose bytes changed on the way through. None of it can be found by
 * inspecting the archive; all of it is found by restoring into somewhere that held
 * nothing and asking whether the site is back.
 *
 * So this test does exactly that, against real MySQL, twice over:
 *
 *  1. A realistic source is built — services, availability, a booking with its
 *     history and its notification jobs, published and draft content, a real JPEG
 *     asset with its original and its derivative.
 *  2. It is backed up to an archive.
 *  3. A **second, empty database** and a **second, empty deployment directory**
 *     are created; the restore runs migrations there and applies the archive.
 *  4. The restored deployment is interrogated for the things a person would
 *     actually notice: the published page's words, the booking and its customer,
 *     the history, the notification queue, and the image byte for byte.
 *
 * The second database is a separate schema on the same server, so the restore is
 * never reading and writing the same rows. Nothing here touches the source after
 * the archive is written.
 *
 * ## Not wrapped in a transaction
 *
 * Like the rate-limit suite and for a related reason: the restore opens its own
 * transaction and runs migrations, which commit implicitly on MySQL. An enclosing
 * transaction would be ended by the first DDL statement and the rollback the other
 * suites rely on would silently stop rolling anything back.
 */
final class BackupRestoreSqlTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';
    private const SERVICE = 'brows';
    private const CUSTOMER = 'Amélie Dupont';
    private const CUSTOMER_EMAIL = 'amelie@example.test';
    private const CUSTOMER_PHONE = '+33 6 12 34 56 78';
    private const HEADLINE = 'Restaurée depuis une sauvegarde';

    private Database $source;
    private Database $target;
    private FrozenClock $clock;

    private string $sourceRoot;
    private string $targetRoot;
    private string $backupsRoot;

    private Configuration $sourceConfig;
    private Configuration $targetConfig;

    protected function setUp(): void
    {
        if (!TestDatabase::isConfigured()) {
            self::markTestSkipped(TestDatabase::skipReason());
        }

        $this->clock = new FrozenClock(self::NOW);

        $this->source = TestDatabase::connect();
        TestDatabase::dropEverything($this->source);
        TestDatabase::migrator($this->source, $this->clock)->migrate();

        // The clean environment the restore lands in: its own schema, and its own
        // deployment directory with nothing in it.
        $this->target = TestDatabase::connectRestoreTarget();
        TestDatabase::dropEverything($this->target);

        $this->sourceRoot = TestEnvironment::makeTempDirectory('eszter-backup-source');
        $this->targetRoot = TestEnvironment::makeTempDirectory('eszter-backup-target');
        $this->backupsRoot = TestEnvironment::makeTempDirectory('eszter-backup-archives');

        $this->sourceConfig = Configuration::fromFile(
            TestEnvironment::writeDeployment($this->sourceRoot),
        );
        $this->targetConfig = Configuration::fromFile(
            TestEnvironment::writeDeployment($this->targetRoot),
        );
    }

    protected function tearDown(): void
    {
        foreach ([$this->sourceRoot ?? null, $this->targetRoot ?? null, $this->backupsRoot ?? null] as $root) {
            if (\is_string($root)) {
                TestEnvironment::removeDirectory($root);
            }
        }
    }

    /**
     * The whole proof, end to end. Everything else in this file is a property of
     * one step; this is the question the package exists to answer.
     */
    public function testARealisticDeploymentSurvivesABackupAndRestoreIntoACleanEnvironment(): void
    {
        $expected = $this->seedRealisticSource();
        $archive = $this->writeBackup();

        $result = $this->restoreIntoTarget($archive);

        // The archive declared what it held, and every byte of it verified.
        self::assertGreaterThan(0, \count($result['manifest']->entries));
        self::assertSame(
            TestDatabase::migrator($this->source, $this->clock)->appliedVersions(),
            $result['manifest']->appliedMigrations,
        );

        // ── Published content: the words a visitor sees ─────────────────────
        $published = $this->targetJson('published.json');
        self::assertSame(1, $published['revision'] ?? null);
        self::assertStringContainsString(
            self::HEADLINE,
            (string) json_encode($published, JSON_UNESCAPED_UNICODE),
            'the restored site does not carry the published headline',
        );

        // The draft is a separate document and comes back separately; a restore
        // that only brought the published copy would silently discard unpublished
        // work.
        self::assertSame(2, $this->targetJson('draft.json')['revision'] ?? null);

        // ── The booking, with the customer data an operator would look for ──
        $booking = $this->target->fetchOne(
            'SELECT * FROM bookings WHERE reference = :reference',
            ['reference' => $expected['reference']],
        );

        self::assertNotNull($booking, 'the booking did not survive the restore');
        self::assertSame(self::CUSTOMER, $booking['customer_name']);
        self::assertSame(self::CUSTOMER_EMAIL, $booking['customer_email']);
        self::assertSame(self::CUSTOMER_PHONE, $booking['customer_phone']);
        self::assertSame('confirmed', $booking['state']);

        // Accented UTF-8 through a dump, an archive and a reload. This is where a
        // charset mistake surfaces, and it surfaces as mojibake in a customer's
        // name rather than as an error.
        self::assertSame(
            self::CUSTOMER,
            $this->target->fetchOne(
                'SELECT customer_name FROM bookings WHERE reference = :reference',
                ['reference' => $expected['reference']],
            )['customer_name'] ?? null,
        );

        // ── History: append-only, and it must come back whole ──────────────
        $history = $this->target->fetchAll(
            'SELECT event_type FROM booking_history WHERE booking_id = :id ORDER BY id',
            ['id' => $booking['id']],
        );
        self::assertSame(
            $expected['historyEvents'],
            array_map(static fn (array $row): mixed => $row['event_type'], $history),
        );

        // ── Notification history ───────────────────────────────────────────
        $jobs = $this->target->fetchAll(
            'SELECT job_type, status, idempotency_key FROM notification_jobs ORDER BY id',
        );
        self::assertSame($expected['notificationCount'], \count($jobs));
        self::assertSame($expected['notificationKeys'], array_column($jobs, 'idempotency_key'));

        // ── Availability ───────────────────────────────────────────────────
        self::assertSame(
            $expected['weeklyRules'],
            $this->rowCount($this->target, 'availability_rules'),
        );
        self::assertSame(
            $expected['services'],
            $this->rowCount($this->target, 'booking_services'),
        );

        // ── Media integrity, byte for byte ─────────────────────────────────
        //
        // The derivative is compared rather than rebuilt. A restore that
        // re-encoded would change what the site serves, invalidate every cached
        // copy, and do it silently.
        foreach ($expected['media'] as $relative => $bytes) {
            $restored = $this->targetRoot . '/' . $relative;

            self::assertFileExists($restored, "media file {$relative} did not survive");
            self::assertSame(
                hash('sha256', $bytes),
                hash_file('sha256', $restored),
                "media file {$relative} came back with different bytes",
            );
        }

        // The catalogue that names them came back too; an asset with no entry is
        // an asset the admin panel cannot see.
        self::assertSame(
            $expected['assetIds'],
            array_column($this->targetJson(MediaLibrary::INDEX_FILE)['assets'] ?? [], 'id'),
        );
    }

    /**
     * The exclusions, proved by their absence rather than asserted in prose.
     *
     * Each of these in a backup is its own small disaster: a config file carries
     * the database and SMTP passwords, a session table resurrects credentials that
     * were deliberately ended, and a log carries customer contact details into
     * every copy of the archive that was ever downloaded.
     */
    public function testTheArchiveCarriesNoSecretSessionLogOrTransientFile(): void
    {
        $this->seedRealisticSource();

        // A live session, a rate-limit counter and a log line, all present in the
        // source at the moment the backup is taken.
        $this->source->run(
            'INSERT INTO admin_sessions (id, account_id, csrf_token, created_at, last_seen_at,'
            . ' expires_at, absolute_expires_at)'
            . ' VALUES (:id, NULL, :csrf, :now, :now2, :expires, :absolute)',
            [
                'id' => str_repeat('a', 64),
                'csrf' => str_repeat('b', 64),
                'now' => self::NOW,
                'now2' => self::NOW,
                'expires' => '2026-06-13T13:00:00.000Z',
                'absolute' => '2026-06-14T00:00:00.000Z',
            ],
        );
        file_put_contents($this->sourceRoot . '/var/log/app.log', '{"customerEmail":"leak@example.test"}');
        file_put_contents($this->sourceRoot . '/data/locks/content.lock', '');
        file_put_contents($this->sourceRoot . '/var/tmp/.draft.json.123.abc.tmp', 'half a write');
        @mkdir($this->sourceRoot . '/data/media-originals/.intake', 0o700, true);
        file_put_contents(
            $this->sourceRoot . '/data/media-originals/.intake/unverified',
            'an upload nobody has checked yet',
        );

        $entries = TarArchive::read($this->writeBackup());
        $dump = $entries[BackupSet::DATABASE_FILE] ?? '';
        $everything = implode("\n", array_keys($entries)) . "\n" . $dump;

        foreach (['config.php', 'app.log', 'content.lock', '.tmp', '.intake', 'unverified'] as $forbidden) {
            self::assertStringNotContainsString(
                $forbidden,
                implode("\n", array_keys($entries)),
                "the archive carries {$forbidden}",
            );
        }

        // The excluded tables are excluded from the dump, not merely from the file
        // list — they have no files of their own to omit.
        foreach (array_keys(BackupSet::EXCLUDED_TABLES) as $table) {
            self::assertStringNotContainsString(
                'INSERT INTO `' . $table . '`',
                $dump,
                "the dump carries rows from the excluded table {$table}",
            );
        }

        self::assertStringNotContainsString('leak@example.test', $everything);
        self::assertStringNotContainsString('CHANGE_ME', $everything);
    }

    /** An archive that has been altered must never be applied. */
    public function testATamperedArchiveIsRefusedBeforeAnythingIsWritten(): void
    {
        $this->seedRealisticSource();
        $archive = $this->writeBackup();

        $entries = TarArchive::read($archive);
        $published = $entries[BackupSet::CONTENT_PREFIX . 'published.json'];

        // One byte, and the length left untouched, so the refusal has to come from
        // the digest rather than from the cheaper size check. A tamper that changed
        // the size would be caught by either.
        $entries[BackupSet::CONTENT_PREFIX . 'published.json'] = substr_replace(
            $published,
            $published[100] === 'x' ? 'y' : 'x',
            100,
            1,
        );
        TarArchive::write($archive, $entries, 1_700_000_000);

        TestDatabase::migrator($this->target, $this->clock)->migrate();

        try {
            $this->restoreIntoTarget($archive);
            self::fail('a tampered archive was applied');
        } catch (BackupException $refusal) {
            self::assertStringContainsString('digest', $refusal->getMessage());
        }

        // Nothing was written. The verification runs before the first DELETE, so a
        // refused restore is indistinguishable from one that never started.
        self::assertSame(0, $this->rowCount($this->target, 'bookings'));
        self::assertFileDoesNotExist($this->targetConfig->contentDir . '/published.json');
    }

    /**
     * The accident this refusal exists for: the operator meant the staging
     * configuration and typed the production one.
     */
    public function testRestoringOverADatabaseThatHoldsDataIsRefusedWithoutOverwrite(): void
    {
        $this->seedRealisticSource();
        $archive = $this->writeBackup();

        // The target is now a live install rather than an empty one.
        $this->restoreIntoTarget($archive);
        $before = $this->rowCount($this->target, 'bookings');

        try {
            $this->restoreIntoTarget($archive);
            self::fail('a restore overwrote a populated database without being asked to');
        } catch (BackupException $refusal) {
            self::assertStringContainsString('--overwrite', $refusal->getMessage());
        }

        self::assertSame($before, $this->rowCount($this->target, 'bookings'));
    }

    /** And with the flag, it proceeds — a refusal that cannot be overridden is a bug. */
    public function testOverwriteRestoresOverAPopulatedDatabase(): void
    {
        $this->seedRealisticSource();
        $archive = $this->writeBackup();

        $this->restoreIntoTarget($archive);
        $result = $this->restoreIntoTarget($archive, overwrite: true);

        self::assertGreaterThan(0, $result['statements']);
        self::assertSame(1, $this->rowCount($this->target, 'bookings'));
    }

    /**
     * The second, independent refusal. A production configuration is refused even
     * when the target is empty, because "restore production" and "restore
     * production onto the wrong host" look identical until afterwards.
     */
    public function testAProductionConfigurationIsRefusedWithoutAnExplicitFlag(): void
    {
        $this->seedRealisticSource();
        $archive = $this->writeBackup();

        // Migrated first, so "nothing was written" is a claim about rows rather
        // than about a table that never existed. The environment refusal fires
        // before the migrator, which is itself the point: it is the very first
        // thing a restore decides.
        TestDatabase::migrator($this->target, $this->clock)->migrate();

        $production = new BackupRestore(
            $this->productionShapedConfig(),
            $this->target,
            TestDatabase::migrator($this->target, $this->clock),
        );

        try {
            $production->restore($archive, overwrite: true, allowProduction: false);
            self::fail('a production restore proceeded without the flag');
        } catch (BackupException $refusal) {
            self::assertStringContainsString('--allow-production', $refusal->getMessage());
        }

        self::assertSame(0, $this->rowCount($this->target, 'bookings'));
    }

    /**
     * A backup taken at a schema the target has never reached is refused, because
     * it may carry columns this code has nowhere to put and dropping them would be
     * data loss reported as success.
     */
    public function testABackupFromANewerSchemaIsRefused(): void
    {
        $this->seedRealisticSource();
        $archive = $this->writeBackup();

        $entries = TarArchive::read($archive);
        /** @var array<string, mixed> $manifest */
        $manifest = json_decode($entries[BackupSet::MANIFEST_FILE], true);
        /** @var list<string> $applied */
        $applied = $manifest['appliedMigrations'];
        $manifest['appliedMigrations'] = [...$applied, '9999_from_the_future'];

        // Re-digested so the manifest itself still verifies: the refusal under test
        // is the schema check, not the tamper check.
        $manifest['entriesDigest'] = $this->digestOf($manifest['entries']);
        $entries[BackupSet::MANIFEST_FILE] = (string) json_encode($manifest, JSON_PRETTY_PRINT);
        TarArchive::write($archive, $entries, 1_700_000_000);

        try {
            $this->restoreIntoTarget($archive);
            self::fail('a backup from a newer schema was applied');
        } catch (BackupException $refusal) {
            self::assertStringContainsString('9999_from_the_future', $refusal->getMessage());
        }
    }

    /** A backup written into the document root would be one URL guess from public. */
    public function testABackupIsRefusedIfItWouldLandInsideTheDocumentRoot(): void
    {
        $this->expectException(BackupException::class);
        $this->expectExceptionMessageMatches('/document root/');

        $this->writer()->write($this->sourceConfig->publicDir);
    }

    /** Two backups of an unchanged deployment agree, so "has anything changed?" is a digest comparison. */
    public function testTwoBackupsOfAnUnchangedDeploymentRecordTheSameDigest(): void
    {
        $this->seedRealisticSource();

        $first = TarArchive::read($this->writeBackup());
        $second = TarArchive::read($this->writeBackup());

        unset($first[BackupSet::MANIFEST_FILE], $second[BackupSet::MANIFEST_FILE]);

        self::assertSame($first, $second);
    }

    public function testEveryDumpedTableAndRowCountComesFromOneMysqlSnapshot(): void
    {
        $this->source->run(
            'INSERT INTO system_settings (setting_key, value_json, created_at, updated_at)'
            . ' VALUES (:key, :value, :created, :updated)',
            [
                'key' => 'snapshot.proof',
                'value' => '{"state":"PRE"}',
                'created' => self::NOW,
                'updated' => self::NOW,
            ],
        );
        $this->source->run(
            'INSERT INTO booking_services'
            . ' (service_key, booking_label, duration_minutes, buffer_before_minutes,'
            . ' buffer_after_minutes, is_active, created_at, updated_at)'
            . ' VALUES (:key, :label, 30, 0, 0, 1, :created, :updated)',
            [
                'key' => 'snapshot-proof',
                'label' => 'PRE',
                'created' => self::NOW,
                'updated' => self::NOW,
            ],
        );

        $mutated = false;
        $dump = DatabaseDump::export(
            $this->source,
            ['system_settings', 'booking_services'],
            function (string $table) use (&$mutated): void {
                if ($table !== 'system_settings') {
                    return;
                }

                $writer = TestDatabase::connectSeparately();
                $writer->transactional(static function (Database $database): void {
                    $database->run(
                        'UPDATE system_settings SET value_json = :value WHERE setting_key = :key',
                        ['value' => '{"state":"POST"}', 'key' => 'snapshot.proof'],
                    );
                    $database->run(
                        'UPDATE booking_services SET booking_label = :label WHERE service_key = :key',
                        ['label' => 'POST', 'key' => 'snapshot-proof'],
                    );
                });
                $mutated = true;
            },
        );

        self::assertTrue($mutated);
        self::assertSame(['system_settings' => 1, 'booking_services' => 1], $dump['rowCounts']);
        self::assertStringContainsString('PRE', $dump['sql']);
        self::assertStringNotContainsString('POST', $dump['sql']);
        self::assertSame(
            ['state' => 'POST'],
            json_decode((string) ($this->source->fetchOne(
                'SELECT value_json FROM system_settings WHERE setting_key = :key',
                ['key' => 'snapshot.proof'],
            )['value_json'] ?? ''), true, 512, JSON_THROW_ON_ERROR),
        );
        self::assertSame(
            'POST',
            $this->source->fetchOne(
                'SELECT booking_label FROM booking_services WHERE service_key = :key',
                ['key' => 'snapshot-proof'],
            )['booking_label'] ?? null,
        );
    }

    public function testPausedBackupExcludesACorrelatedDatabaseAndContentMutation(): void
    {
        $this->seedRealisticSource();
        $marker = 'POST-SNAPSHOT-CORRELATED-MARKER';

        $backupPipes = [];
        $backup = proc_open(
            [PHP_BINARY, __DIR__ . '/BackupSnapshotWorker.php', $this->sourceRoot . '/config.php', $this->backupsRoot],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $backupPipes,
        );
        self::assertIsResource($backup);
        stream_set_timeout($backupPipes[1], 5);
        self::assertSame("PAUSED\n", fgets($backupPipes[1]), 'backup never reached the controlled boundary');

        $mutationPipes = [];
        $mutation = proc_open(
            [PHP_BINARY, __DIR__ . '/SnapshotMutationWorker.php', $this->sourceRoot . '/config.php', $marker],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $mutationPipes,
        );
        self::assertIsResource($mutation);
        fclose($mutationPipes[0]);
        stream_set_timeout($mutationPipes[1], 5);
        self::assertSame("ATTEMPTING\n", fgets($mutationPipes[1]), 'mutation never reached the barrier');

        // The mutation announced itself while the backup is paused, yet neither
        // half can land until the backup releases its exclusive barrier.
        self::assertNull($this->source->fetchOne(
            'SELECT value_json FROM system_settings WHERE setting_key = :key',
            ['key' => 'snapshot.marker'],
        ));
        self::assertStringNotContainsString(
            $marker,
            (string) file_get_contents($this->sourceConfig->contentDir . '/draft.json'),
        );

        fwrite($backupPipes[0], "continue\n");
        fclose($backupPipes[0]);
        $backupOutput = trim((string) stream_get_contents($backupPipes[1]));
        $backupError = trim((string) stream_get_contents($backupPipes[2]));
        fclose($backupPipes[1]);
        fclose($backupPipes[2]);
        self::assertSame(0, proc_close($backup), $backupError);
        self::assertStringStartsWith('ARCHIVE ', $backupOutput);
        $archive = substr($backupOutput, \strlen('ARCHIVE '));

        $mutationOutput = trim((string) stream_get_contents($mutationPipes[1]));
        $mutationError = trim((string) stream_get_contents($mutationPipes[2]));
        fclose($mutationPipes[1]);
        fclose($mutationPipes[2]);
        self::assertSame(0, proc_close($mutation), $mutationError);
        self::assertSame('MUTATED', $mutationOutput);

        $entries = TarArchive::read($archive);
        $archivedDraft = $entries[BackupSet::CONTENT_PREFIX . 'draft.json'] ?? '';
        $archivedDump = $entries[BackupSet::DATABASE_FILE] ?? '';

        self::assertStringNotContainsString($marker, $archivedDraft);
        self::assertStringNotContainsString($marker, $archivedDump);
        self::assertStringContainsString($marker, (string) file_get_contents(
            $this->sourceConfig->contentDir . '/draft.json',
        ));
        self::assertStringContainsString(
            $marker,
            (string) ($this->source->fetchOne(
                'SELECT value_json FROM system_settings WHERE setting_key = :key',
                ['key' => 'snapshot.marker'],
            )['value_json'] ?? ''),
        );
    }

    public function testFailedPublicationLeavesOnlyARestrictedPartialAndReleasesEverything(): void
    {
        $this->seedRealisticSource();
        $writer = new BackupWriter(
            $this->sourceConfig,
            $this->source,
            TestEnvironment::artifacts(),
            TestDatabase::migrator($this->source, $this->clock),
            $this->clock,
            afterDatabaseExport: null,
            beforePublish: static function (): never {
                throw new \RuntimeException('controlled publication failure');
            },
        );

        try {
            $writer->write($this->backupsRoot);
            self::fail('the controlled backup failure published an archive');
        } catch (\RuntimeException $failure) {
            self::assertSame('controlled publication failure', $failure->getMessage());
        }

        self::assertSame([], glob($this->backupsRoot . '/*.tar.gz') ?: []);
        $partials = glob($this->backupsRoot . '/*.partial') ?: [];
        self::assertCount(1, $partials);
        self::assertSame(0o600, fileperms($partials[0]) & 0o777);
        self::assertFalse($this->source->inTransaction());
        self::assertSame(
            'released',
            (new ApplicationSnapshotLock($this->sourceConfig->lockDir))->withShared(
                static fn (): string => 'released',
            ),
        );
    }

    // --- fixture ------------------------------------------------------------

    /**
     * Builds a source deployment that looks like a real one.
     *
     * Deliberately not minimal. A restore proof against one table and one file
     * proves that the machinery runs; what it does not prove is that anything a
     * person cares about came back. So the fixture has a published site *and* an
     * unpublished draft, a booking with a full name, an accented one, an e-mail and
     * a phone number, its history rows, its notification jobs, availability, and a
     * real JPEG with both its original and its derivative.
     *
     * @return array<string, mixed>
     */
    private function seedRealisticSource(): array
    {
        $contract = BookingDomainContract::fromArtifacts(TestEnvironment::artifacts());

        $this->source->run(
            'INSERT INTO booking_services'
            . ' (service_key, booking_label, duration_minutes, buffer_before_minutes,'
            . ' buffer_after_minutes, is_active, created_at, updated_at)'
            . ' VALUES (:key, :label, 120, 0, 15, 1, :now, :now2)',
            ['key' => self::SERVICE, 'label' => 'Sourcils', 'now' => self::NOW, 'now2' => self::NOW],
        );

        $this->source->run(
            'INSERT INTO admin_accounts (email, password_hash, is_enabled, created_at, updated_at)'
            . ' VALUES (:email, :hash, 1, :now, :now2)',
            [
                'email' => 'editor@example.test',
                'hash' => password_hash('correct-horse-battery', PASSWORD_DEFAULT),
                'now' => self::NOW,
                'now2' => self::NOW,
            ],
        );

        $this->source->run(
            'INSERT INTO availability_rules'
            . ' (weekday_iso, start_local, end_local, valid_from, valid_until,'
            . ' fold_utc_offset, is_active, created_at, updated_at)'
            . ' VALUES (3, :start, :end, :from, NULL, NULL, 1, :now, :now2)',
            [
                'start' => '09:00:00',
                'end' => '17:00:00',
                'from' => '2026-01-01',
                'now' => self::NOW,
                'now2' => self::NOW,
            ],
        );

        $time = new \Eszter\Booking\BookingTimePolicy($contract);
        $bookings = new BookingRepository(
            $this->source,
            $this->clock,
            $contract,
            $time,
            new \Eszter\Booking\BookableServiceRepository($this->source, $this->clock, $contract),
            new \Eszter\Booking\BookingStateMachine($contract),
        );

        $booking = $bookings->createConfirmed(
            self::SERVICE,
            new \DateTimeImmutable('2026-07-01T08:00:00.000Z'),
            new \DateTimeImmutable('2026-07-01T10:00:00.000Z'),
            self::CUSTOMER,
            self::CUSTOMER_EMAIL,
            self::CUSTOMER_PHONE,
            'Première séance — merci de prévoir 15 minutes.',
            new \DateTimeImmutable(self::NOW),
        );

        $bookingRow = $this->source->fetchOne(
            'SELECT id FROM bookings WHERE reference = :reference',
            ['reference' => $booking->reference],
        );
        /** @var int $bookingId */
        $bookingId = $bookingRow['id'];

        $policy = NotificationPolicy::fromArtifacts(TestEnvironment::artifacts());
        $jobs = new \Eszter\Notification\NotificationJobRepository($this->source, $this->clock, $policy);
        $keys = [];

        foreach ([['booking_confirmation', '+0 second'], ['booking_reminder', '+17 day']] as [$type, $when]) {
            $key = "restore.proof.{$type}";
            $jobs->enqueue($bookingId, 'email', $type, $key, $this->clock->now()->modify($when));
            $keys[] = $key;
        }

        // Content: a published document and a draft one revision ahead of it, so a
        // restore that conflated the two would fail rather than look right.
        $this->writeContent('published.json', 1, self::HEADLINE);
        $this->writeContent('draft.json', 2, self::HEADLINE . ' (brouillon)');

        $media = $this->seedMedia();

        return [
            'reference' => $booking->reference,
            'historyEvents' => array_column(
                $this->source->fetchAll(
                    'SELECT event_type FROM booking_history WHERE booking_id = :id ORDER BY id',
                    ['id' => $bookingId],
                ),
                'event_type',
            ),
            'notificationCount' => 2,
            'notificationKeys' => $keys,
            'weeklyRules' => 1,
            'services' => 1,
            'media' => $media['files'],
            'assetIds' => $media['ids'],
        ];
    }

    /**
     * A real JPEG, stored the way an upload stores one: the original under
     * `data/media-originals/`, the served derivative under `public_html/media/`,
     * and an entry in the catalogue naming both.
     *
     * @return array{files: array<string, string>, ids: list<string>}
     */
    private function seedMedia(): array
    {
        $id = 'med_' . bin2hex(random_bytes(16));
        $name = $id . '.jpg';
        $bytes = MediaFixtures::jpeg(96, 64);

        $originals = $this->sourceConfig->mediaOriginalsDir;
        $derivatives = $this->sourceConfig->mediaPublicDir();

        foreach ([$originals, $derivatives] as $directory) {
            if (!is_dir($directory)) {
                mkdir($directory, 0o750, true);
            }
        }

        file_put_contents($originals . '/' . $name, $bytes);
        file_put_contents($derivatives . '/' . $name, $bytes);

        // A staging file, which must not travel: it is a derivative mid-write.
        file_put_contents($derivatives . '/.staging-' . bin2hex(random_bytes(4)), 'half an image');

        file_put_contents(
            $this->sourceConfig->contentDir . '/' . MediaLibrary::INDEX_FILE,
            (string) json_encode([
                'schemaVersion' => 1,
                'assets' => [[
                    'id' => $id,
                    'path' => '/media/' . $name,
                    'mimeType' => 'image/jpeg',
                    'byteSize' => \strlen($bytes),
                    'width' => 96,
                    'height' => 64,
                    'uploadedAt' => self::NOW,
                ]],
            ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES),
        );

        return [
            'files' => [
                'data/media-originals/' . $name => $bytes,
                'public_html/media/' . $name => $bytes,
            ],
            'ids' => [$id],
        ];
    }

    private function writeContent(string $file, int $revision, string $headline): void
    {
        $content = TestEnvironment::artifacts()->canonicalSiteContent();
        $content['hero'] = \is_array($content['hero'] ?? null) ? $content['hero'] : [];
        /** @var array<string, mixed> $hero */
        $hero = $content['hero'];
        /** @var array<string, mixed> $title */
        $title = $hero['title'];
        $title['prefix'] = $headline;
        $hero['title'] = $title;
        $content['hero'] = $hero;

        file_put_contents(
            $this->sourceConfig->contentDir . '/' . $file,
            (string) json_encode([
                'schemaVersion' => TestEnvironment::artifacts()->contentSchemaVersion(),
                'revision' => $revision,
                'updatedAt' => self::NOW,
                'content' => $content,
            ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        );
    }

    private function writeBackup(): string
    {
        return $this->writer()->write($this->backupsRoot)['path'];
    }

    private function writer(): BackupWriter
    {
        return new BackupWriter(
            $this->sourceConfig,
            $this->source,
            TestEnvironment::artifacts(),
            TestDatabase::migrator($this->source, $this->clock),
            $this->clock,
        );
    }

    /** @return array{manifest: \Eszter\Backup\BackupManifest, statements: int, files: int, migrations: list<string>} */
    private function restoreIntoTarget(string $archive, bool $overwrite = false): array
    {
        return (new BackupRestore(
            $this->targetConfig,
            $this->target,
            TestDatabase::migrator($this->target, $this->clock),
        ))->restore($archive, $overwrite, allowProduction: false);
    }

    /**
     * A configuration identical to the target's except that it calls itself
     * production, so the environment refusal is tested without a second deployment.
     */
    private function productionShapedConfig(): Configuration
    {
        // A configuration production would actually accept, rather than one with
        // `environment` swapped: Configuration refuses a production boot without a
        // database, SMTP and a secure cookie, and a stub that skipped those would be
        // testing the refusal against a config that could not exist.
        $path = TestEnvironment::writeDeployment($this->targetRoot, [
            'environment' => 'production',
            'logLevel' => 'error',
            'database' => [
                'dsn' => TestDatabase::restoreTargetSettings()->dsn,
                'username' => TestDatabase::restoreTargetSettings()->username,
                'password' => TestDatabase::restoreTargetSettings()->password,
                'connectTimeoutSeconds' => 5,
            ],
            'session' => [
                'idleTimeoutMinutes' => 60,
                'absoluteLifetimeMinutes' => 720,
                'cookieSecure' => true,
            ],
            'notifications' => [
                'email' => [
                    'host' => 'smtp.example.test',
                    'port' => 587,
                    'encryption' => 'starttls',
                    'authenticationRequired' => true,
                    'username' => 'restore-proof',
                    'password' => 'restore-proof-secret',
                    'senderAddress' => 'bonjour@example.test',
                    'senderName' => 'Eszter Gyori',
                    'timeoutSeconds' => 10,
                    'customerContact' => 'Répondez à cet e-mail.',
                    'customerInstructions' => 'Prévenez en cas d’empêchement.',
                ],
            ],
        ]);

        // Production refuses a group- or world-readable configuration file.
        chmod($path, 0o600);

        return Configuration::fromFile($path);
    }

    /** @return array<string, mixed> */
    private function targetJson(string $file): array
    {
        $path = $this->targetConfig->contentDir . '/' . $file;
        self::assertFileExists($path, "{$file} did not survive the restore");

        /** @var array<string, mixed> $decoded */
        $decoded = json_decode((string) file_get_contents($path), true);

        return $decoded;
    }

    private function rowCount(Database $database, string $table): int
    {
        $row = $database->fetchOne('SELECT COUNT(*) AS total FROM `' . $table . '`');

        return (int) ($row['total'] ?? 0);
    }

    /** @param array<string, array{bytes: int, sha256: string}> $entries */
    private function digestOf(array $entries): string
    {
        ksort($entries);
        $material = '';

        foreach ($entries as $path => $entry) {
            $material .= $path . "\0" . $entry['bytes'] . "\0" . $entry['sha256'] . "\n";
        }

        return hash('sha256', $material);
    }
}
