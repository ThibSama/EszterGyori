<?php

declare(strict_types=1);

use Eszter\Config\Configuration;
use Eszter\Contract\ContentValidator;
use Eszter\Database\Database;
use Eszter\Storage\ApplicationSnapshotLock;
use Eszter\Storage\ContentStorage;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Sql\TestDatabase;
use Eszter\Tests\TestEnvironment;

require_once __DIR__ . '/../../vendor/autoload.php';

/** @var list<string> $argv */
$configPath = $argv[1] ?? '';
$marker = $argv[2] ?? '';

if ($configPath === '' || $marker === '') {
    fwrite(STDERR, "mutation worker arguments missing\n");
    exit(2);
}

try {
    $config = Configuration::fromFile($configPath);
    $clock = new FrozenClock('2026-06-13T12:01:00.000Z');
    $database = new Database(TestDatabase::settings(), $config->lockDir);
    $artifacts = TestEnvironment::artifacts();
    $storage = new ContentStorage(
        $config->contentDir,
        $config->tmpDir,
        $config->lockDir,
        $artifacts,
        ContentValidator::create($artifacts),
        $clock,
    );
    $barrier = new ApplicationSnapshotLock($config->lockDir);

    fwrite(STDOUT, "ATTEMPTING\n");
    fflush(STDOUT);

    $barrier->withShared(static function () use ($database, $storage, $artifacts, $marker): void {
        $database->run(
            'INSERT INTO system_settings (setting_key, value_json, created_at, updated_at)'
            . ' VALUES (:key, :value, :created, :updated)'
            . ' ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = VALUES(updated_at)',
            [
                'key' => 'snapshot.marker',
                'value' => json_encode(['marker' => $marker], JSON_THROW_ON_ERROR),
                'created' => '2026-06-13T12:01:00.000Z',
                'updated' => '2026-06-13T12:01:00.000Z',
            ],
        );

        $content = $artifacts->canonicalSiteContent();
        /** @var array<string, mixed> $hero */
        $hero = $content['hero'];
        /** @var array<string, mixed> $title */
        $title = $hero['title'];
        $title['prefix'] = $marker;
        $hero['title'] = $title;
        $content['hero'] = $hero;
        $storage->saveDraft(2, $content);
    });

    fwrite(STDOUT, "MUTATED\n");
    exit(0);
} catch (Throwable $exception) {
    fwrite(STDERR, $exception::class . ': ' . $exception->getMessage() . "\n");
    exit(1);
}
