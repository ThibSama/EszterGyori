<?php

declare(strict_types=1);

use Eszter\Backup\BackupWriter;
use Eszter\Config\Configuration;
use Eszter\Contract\ContractArtifacts;
use Eszter\Database\Database;
use Eszter\Database\Migrator;
use Eszter\Support\FrozenClock;
use Eszter\Tests\Sql\TestDatabase;
use Eszter\Tests\TestEnvironment;

require_once __DIR__ . '/../../vendor/autoload.php';

/** @var list<string> $argv */
$configPath = $argv[1] ?? '';
$destination = $argv[2] ?? '';

if ($configPath === '' || $destination === '') {
    fwrite(STDERR, "backup worker arguments missing\n");
    exit(2);
}

try {
    $config = Configuration::fromFile($configPath);
    $clock = new FrozenClock('2026-06-13T12:00:00.000Z');
    $database = new Database(TestDatabase::settings(), $config->lockDir);
    $writer = new BackupWriter(
        $config,
        $database,
        TestEnvironment::artifacts(),
        new Migrator($database, TestDatabase::migrationsDirectory(), $clock),
        $clock,
        static function (): void {
            fwrite(STDOUT, "PAUSED\n");
            fflush(STDOUT);
            if (fgets(STDIN) === false) {
                throw new RuntimeException('backup worker was not released');
            }
        },
    );

    $result = $writer->write($destination);
    fwrite(STDOUT, 'ARCHIVE ' . $result['path'] . "\n");
    exit(0);
} catch (Throwable $exception) {
    fwrite(STDERR, $exception::class . ': ' . $exception->getMessage() . "\n");
    exit(1);
}
