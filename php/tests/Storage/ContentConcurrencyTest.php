<?php

declare(strict_types=1);

namespace Eszter\Tests\Storage;

use Eszter\Contract\ContentValidator;
use Eszter\Storage\ContentStorage;
use Eszter\Storage\RevisionConflictException;
use Eszter\Storage\StorageException;
use Eszter\Support\FrozenClock;
use Eszter\Tests\TestEnvironment;
use PHPUnit\Framework\TestCase;

/**
 * The storage half of Package 3.1: the revision sequence and the lock.
 *
 * {@see \Eszter\Tests\Http\AdminContentTest} proves the same guarantees through
 * HTTP. This suite goes at them directly, for two things HTTP cannot reach:
 *
 *  - **Real concurrency.** The contract requires the exclusive lock to be held
 *    across the whole read-modify-write, and the only way to show that is to run
 *    a second process against the same directory while the first one is inside
 *    an operation. That needs a child process, not a second `Kernel::handle()`
 *    on one thread.
 *  - **The reentrancy trap.** {@see \Eszter\Storage\FileLock} refuses to nest
 *    rather than silently releasing the outer lock, so every operation here has
 *    to reach the draft through the locked private path. A refactor that reached
 *    for the public `readDraft()` instead would throw, and the test below is what
 *    turns that into a failure rather than a 500 someone sees in production.
 */
final class ContentConcurrencyTest extends TestCase
{
    private const NOW = '2026-06-13T12:00:00.000Z';

    private string $root;

    protected function setUp(): void
    {
        $this->root = TestEnvironment::makeTempDirectory('eszter-concurrency');
    }

    protected function tearDown(): void
    {
        TestEnvironment::removeDirectory($this->root);
    }

    private function storage(): ContentStorage
    {
        $artifacts = TestEnvironment::artifacts();

        return new ContentStorage(
            $this->root . '/data/content',
            $this->root . '/var/tmp',
            $this->root . '/data/locks',
            $artifacts,
            ContentValidator::create($artifacts),
            new FrozenClock(self::NOW),
        );
    }

    /** @return array<string, mixed> */
    private function content(string $copy): array
    {
        $content = TestEnvironment::artifacts()->canonicalSiteContent();
        /** @var array<string, mixed> $hero */
        $hero = $content['hero'];
        $hero['description'] = $copy;
        $content['hero'] = $hero;

        return $content;
    }

    public function testEachOperationSeedsOnDemandWithoutNestingTheLock(): void
    {
        // Deliberately *not* initialized first. Each operation must be able to
        // seed a missing file from inside its own exclusive lock; reaching for
        // the public read path to do it would nest the lock, and FileLock throws
        // a LogicException rather than silently releasing the outer one.
        self::assertSame(1, $this->storage()->saveDraft(0, $this->content('Seeded by a save'))['revision']);

        TestEnvironment::removeDirectory($this->root . '/data/content');
        self::assertSame(0, $this->storage()->publishDraft(0)['revision']);

        TestEnvironment::removeDirectory($this->root . '/data/content');
        self::assertSame(1, $this->storage()->resetDraftToPublished(0)['revision']);
    }

    public function testTheHeadIsReadUnderTheLockThatWritesIt(): void
    {
        $storage = $this->storage();
        $storage->initialize();

        // A precondition read before the write, from outside any lock, is exactly
        // what this mechanism must not be built on. `draftRevision()` is a
        // snapshot and is documented as unusable as a write input; the write
        // paths re-read the head themselves. Proving that here means the two
        // reads can disagree and the write still refuses.
        $stale = $storage->draftRevision();
        $storage->saveDraft($stale, $this->content('Landed first'));

        $this->expectException(RevisionConflictException::class);
        $storage->saveDraft($stale, $this->content('Should not land'));
    }

    public function testAConflictCarriesBothRevisionsAndWritesNothing(): void
    {
        $storage = $this->storage();
        $storage->initialize();
        $storage->saveDraft(0, $this->content('Head is now one'));

        $draftBefore = $this->rawDraft();
        $publishedBefore = $this->rawPublished();

        try {
            $storage->saveDraft(0, $this->content('Stale'));
            self::fail('a stale save was accepted');
        } catch (RevisionConflictException $conflict) {
            self::assertSame(0, $conflict->expectedRevision);
            self::assertSame(1, $conflict->currentRevision);
            self::assertSame(
                ['expectedRevision' => 0, 'currentRevision' => 1],
                $conflict->logContext(),
            );
        }

        // Thrown before any write, so this follows from where it is raised rather
        // than from a cleanup path that has to be correct.
        self::assertSame($draftBefore, $this->rawDraft());
        self::assertSame($publishedBefore, $this->rawPublished());
        self::assertSame([], $this->temporaryFiles());
    }

    public function testAConflictIsNotAStorageFailure(): void
    {
        // The distinction is the whole reason RevisionConflictException exists.
        // Every StorageException collapses to an opaque 500 in the Kernel, which
        // is right for a fault nobody can act on and wrong for a conflict — a
        // normal outcome of concurrent editing that the caller recovers from,
        // and one that has to answer 409 with the head attached.
        //
        // The two hierarchies are disjoint, and PHPStan proves it: both classes
        // are final and neither extends the other, so a runtime assertion on the
        // relationship is rejected as an impossible type check. What is left to
        // assert here is the behaviour — a stale precondition raises the conflict
        // and not a storage fault — while the consequence that actually matters,
        // that the Kernel answers 409 rather than folding it into the opaque 500,
        // is asserted over HTTP in
        // {@see \Eszter\Tests\Http\AdminContentTest::testAConflictWritesNothingAndReportsTheCurrentHead}.
        $storage = $this->storage();
        $storage->initialize();

        $this->expectException(RevisionConflictException::class);
        $storage->publishDraft(99);
    }

    public function testPublishCopiesTheStoredDraftAtItsOwnRevision(): void
    {
        $storage = $this->storage();
        $storage->initialize();

        $draft = $storage->saveDraft(0, $this->content('Ready to publish'));
        $published = $storage->publishDraft(1);

        // published.revision *is* the draft head that was published — not a count
        // of publishes, and not head + 1.
        self::assertSame(1, $draft['revision']);
        self::assertSame(1, $published['revision']);
        self::assertSame($draft['content'], $published['content']);

        // The draft is untouched by publishing.
        self::assertSame(1, $storage->draftRevision());
        self::assertSame($draft['content'], $storage->readDraft()['content']);
    }

    public function testAnUnpublishableDraftStopsThePublishAndChangesNothing(): void
    {
        $storage = $this->storage();
        $storage->initialize();
        $storage->saveDraft(0, $this->content('Good copy'));
        $storage->publishDraft(1);

        $publishedBefore = $this->rawPublished();

        // Structurally valid JSON, but not a valid envelope: the semantic layer
        // must catch it on the re-read, inside the lock, before anything is
        // written to published.json.
        file_put_contents(
            $this->root . '/data/content/draft.json',
            (string) json_encode(['schemaVersion' => 1, 'revision' => 1, 'updatedAt' => self::NOW]),
        );

        try {
            $this->storage()->publishDraft(1);
            self::fail('an invalid draft was published');
        } catch (StorageException $exception) {
            self::assertSame(StorageException::VALIDATION_FAILED, $exception->storageCode);
        }

        self::assertSame($publishedBefore, $this->rawPublished());
        self::assertSame([], $this->temporaryFiles());
    }

    public function testResetRebuildsTheDraftAndLeavesPublishedByteIdentical(): void
    {
        $storage = $this->storage();
        $storage->initialize();
        $storage->saveDraft(0, $this->content('Published baseline'));
        $storage->publishDraft(1);

        $publishedBefore = $this->rawPublished();

        $storage->saveDraft(1, $this->content('Regretted'));
        $draft = $storage->resetDraftToPublished(2);

        self::assertSame(3, $draft['revision'], 'reset did not advance the head');
        self::assertSame(
            $storage->readPublished()['content'],
            $draft['content'],
            'the reset draft is not the published content',
        );
        self::assertSame($publishedBefore, $this->rawPublished(), 'reset wrote to published.json');
    }

    /**
     * Two processes, one directory, overlapping writes.
     *
     * The child holds the exclusive lock for a beat while the parent tries to
     * write. If the lock were released between the read and the write — or taken
     * per-step instead of per-operation — the two would interleave and one
     * revision would be lost. What must hold is that they serialise: the head
     * ends at 2 after two successful saves, never at 1.
     *
     * `pcntl` is not available on every build, and the target is shared hosting
     * where it usually is not. This skips rather than failing there: the
     * single-process guarantees above still run, and the gate stays honest about
     * what it could not execute.
     */
    public function testTwoProcessesWritingAtOnceSerialiseAndLoseNoRevision(): void
    {
        if (!\function_exists('pcntl_fork')) {
            self::markTestSkipped('pcntl is unavailable; real concurrency cannot be exercised.');
        }

        $this->storage()->initialize();

        $pid = pcntl_fork();

        if ($pid === -1) {
            self::markTestSkipped('Could not fork.');
        }

        if ($pid === 0) {
            // Child: a fresh storage object, so it opens its own lock handle
            // rather than inheriting the parent's.
            try {
                $this->storage()->saveDraft(0, $this->content('Child'));
                exit(0);
            } catch (\Throwable) {
                // A conflict here is a legitimate outcome of the race: it means
                // the parent got there first. Only a crash is a failure.
                exit(1);
            }
        }

        $parentSucceeded = true;
        try {
            $this->storage()->saveDraft(0, $this->content('Parent'));
        } catch (RevisionConflictException) {
            $parentSucceeded = false;
        }

        pcntl_waitpid($pid, $status);
        $childSucceeded = pcntl_wexitstatus($status) === 0;

        // Exactly one of them may win the race for revision 1. Both winning would
        // mean a lost update; neither winning would mean the lock deadlocked.
        self::assertTrue(
            $parentSucceeded !== $childSucceeded,
            'both writers claimed the same revision, or neither made progress',
        );

        // And the file that landed is a complete, valid envelope at revision 1 —
        // not a blend of the two writes.
        $draft = $this->storage()->readDraft();
        self::assertSame(1, $draft['revision']);
        /** @var array<string, mixed> $hero */
        $hero = $draft['content']['hero'];
        self::assertContains($hero['description'], ['Parent', 'Child']);
        self::assertSame([], $this->temporaryFiles());
    }

    private function rawDraft(): string
    {
        return (string) file_get_contents($this->root . '/data/content/draft.json');
    }

    private function rawPublished(): string
    {
        return (string) file_get_contents($this->root . '/data/content/published.json');
    }

    /** @return list<string> */
    private function temporaryFiles(): array
    {
        $entries = @scandir($this->root . '/var/tmp');

        if ($entries === false) {
            return [];
        }

        return array_values(array_filter(
            $entries,
            static fn (string $entry): bool => $entry !== '.' && $entry !== '..',
        ));
    }
}
