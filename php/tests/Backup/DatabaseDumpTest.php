<?php

declare(strict_types=1);

namespace Eszter\Tests\Backup;

use Eszter\Backup\BackupException;
use Eszter\Backup\DatabaseDump;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class DatabaseDumpTest extends TestCase
{
    public function testOnlyExactDeclaredSingleRowInsertsAreAccepted(): void
    {
        $sql = "-- rows only\n"
            . "INSERT INTO `booking_services` (`service_key`, `booking_label`) VALUES ('brows', 'L\\'arc');\n"
            . "INSERT INTO `schema_migrations` (`version`) VALUES ('0001');\n";

        self::assertSame(1, DatabaseDump::validate($sql, ['schema_migrations']));
    }

    #[DataProvider('hostileDumps')]
    public function testHostileOrAmbiguousSqlIsRefusedBeforeExecution(string $sql): void
    {
        $this->expectException(BackupException::class);
        DatabaseDump::validate($sql, ['schema_migrations']);
    }

    /** @return iterable<string, array{0: string}> */
    public static function hostileDumps(): iterable
    {
        yield 'excluded table' => ["INSERT INTO `admin_sessions` (`id`) VALUES ('x');\n"];
        yield 'unknown table' => ["INSERT INTO `future_table` (`id`) VALUES (1);\n"];
        yield 'ddl' => ["DROP TABLE `bookings`;\n"];
        yield 'dcl' => ["GRANT ALL ON *.* TO 'x';\n"];
        yield 'trailing statement' => ["INSERT INTO `bookings` (`id`) VALUES (1); DROP TABLE `bookings`;\n"];
        yield 'second terminator' => ["INSERT INTO `bookings` (`id`) VALUES (1);;\n"];
        yield 'comment bypass' => ["INSERT/**/INTO `bookings` (`id`) VALUES (1);\n"];
        yield 'table quoting bypass' => ["INSERT INTO `bookings``; DROP TABLE x; --` (`id`) VALUES (1);\n"];
        yield 'value expression' => ["INSERT INTO `bookings` (`id`) VALUES (SLEEP(1));\n"];
        yield 'value suffix' => ["INSERT INTO `bookings` (`id`) VALUES (1 OR 1);\n"];
        yield 'column value mismatch' => ["INSERT INTO `bookings` (`id`, `state`) VALUES (1);\n"];
        yield 'missing terminator' => ["INSERT INTO `bookings` (`id`) VALUES (1)\n"];
        yield 'multiline statement' => ["INSERT INTO `bookings` (`id`)\n VALUES (1);\n"];
    }
}
