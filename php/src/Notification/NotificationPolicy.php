<?php

declare(strict_types=1);

namespace Eszter\Notification;

use Eszter\Contract\ContractArtifactException;
use Eszter\Contract\ContractArtifacts;

/**
 * The frozen Package 7.1 notification policy, consumed rather than restated
 * (ESZ-070).
 *
 * Every enum, bound and pattern here comes from the `notifications` block of
 * `booking-domain.json`. Nothing in this namespace declares one of its own: the
 * migration's CHECK constraints are the same sets written where SQL can enforce
 * them, and `NotificationSchemaTest` fails if the two ever disagree.
 */
final class NotificationPolicy
{
    /**
     * @param list<string> $channels
     * @param list<string> $jobTypes
     * @param list<string> $timeSensitiveJobTypes
     * @param list<string> $statuses
     * @param list<string> $terminalStatuses
     * @param array<string, list<string>> $transitions
     * @param list<string> $reservedErrorCodes
     * @param list<string> $logFields
     * @param list<string> $forbiddenLogFields
     */
    private function __construct(
        public readonly array $channels,
        public readonly array $jobTypes,
        public readonly array $timeSensitiveJobTypes,
        public readonly array $statuses,
        public readonly string $initialStatus,
        public readonly array $terminalStatuses,
        public readonly array $transitions,
        public readonly string $idempotencyKeyPattern,
        public readonly int $leaseSeconds,
        public readonly string $leaseOwnerPattern,
        public readonly int $maxAttempts,
        public readonly int $baseBackoffSeconds,
        public readonly int $maxBackoffSeconds,
        public readonly int $reminderGraceMinutes,
        public readonly int $defaultBatchSize,
        public readonly int $maxBatchSize,
        public readonly string $errorCodePattern,
        public readonly array $reservedErrorCodes,
        public readonly array $logFields,
        public readonly array $forbiddenLogFields,
    ) {
    }

    public static function fromArtifacts(ContractArtifacts $artifacts): self
    {
        $document = $artifacts->load('booking-domain.json');
        $notifications = self::block($document, 'notifications');
        $statuses = self::block($notifications, 'statuses');
        $identity = self::block($notifications, 'identity');
        $lease = self::block($notifications, 'lease');
        $retry = self::block($notifications, 'retry');
        $catchUp = self::block($notifications, 'catchUp');
        $runner = self::block($notifications, 'runner');
        $diagnostics = self::block($notifications, 'diagnostics');

        return new self(
            self::stringList($notifications, 'channels'),
            self::stringList($notifications, 'jobTypes'),
            self::stringList($notifications, 'timeSensitiveJobTypes'),
            self::stringList($statuses, 'values'),
            self::string($statuses, 'initial'),
            self::stringList($statuses, 'terminal'),
            self::transitionMap($statuses),
            self::string($identity, 'idempotencyKeyPattern'),
            self::positiveInt($lease, 'seconds'),
            self::string($lease, 'ownerPattern'),
            self::positiveInt($retry, 'maxAttempts'),
            self::positiveInt($retry, 'baseBackoffSeconds'),
            self::positiveInt($retry, 'maxBackoffSeconds'),
            self::positiveInt($catchUp, 'reminderGraceMinutes'),
            self::positiveInt($runner, 'defaultBatchSize'),
            self::positiveInt($runner, 'maxBatchSize'),
            self::string($diagnostics, 'errorCodePattern'),
            self::stringList($diagnostics, 'reservedErrorCodes'),
            self::stringList($diagnostics, 'logFields'),
            self::stringList($diagnostics, 'forbiddenLogFields'),
        );
    }

    public function acceptsChannel(string $channel): bool
    {
        return \in_array($channel, $this->channels, true);
    }

    public function acceptsJobType(string $jobType): bool
    {
        return \in_array($jobType, $this->jobTypes, true);
    }

    public function acceptsStatus(string $status): bool
    {
        return \in_array($status, $this->statuses, true);
    }

    public function isTerminal(string $status): bool
    {
        return \in_array($status, $this->terminalStatuses, true);
    }

    public function isTimeSensitive(string $jobType): bool
    {
        return \in_array($jobType, $this->timeSensitiveJobTypes, true);
    }

    /** @return list<string> */
    public function nextStatuses(string $status): array
    {
        return $this->transitions[$status] ?? [];
    }

    public function allowsTransition(string $from, string $to): bool
    {
        return \in_array($to, $this->nextStatuses($from), true);
    }

    public function acceptsIdempotencyKey(string $key): bool
    {
        return preg_match('#' . $this->idempotencyKeyPattern . '#D', $key) === 1;
    }

    public function acceptsLeaseOwner(string $owner): bool
    {
        return preg_match('#' . $this->leaseOwnerPattern . '#D', $owner) === 1;
    }

    public function acceptsErrorCode(string $code): bool
    {
        return preg_match('#' . $this->errorCodePattern . '#D', $code) === 1;
    }

    /**
     * Deterministic exponential backoff, clamped.
     *
     * `$attempts` is the number already made, so the first retry — after one
     * attempt — waits the base delay rather than twice it. Doubling is computed
     * with a bounded shift because `2 ** 40` seconds is not a delay, it is an
     * overflow waiting to be clamped by accident.
     */
    public function backoffSeconds(int $attempts): int
    {
        if ($attempts < 1) {
            return $this->baseBackoffSeconds;
        }

        $doublings = min($attempts - 1, 20);
        $delay = $this->baseBackoffSeconds * (2 ** $doublings);

        return (int) min($delay, $this->maxBackoffSeconds);
    }

    /** True once a job that has made this many attempts may not be retried again. */
    public function attemptsExhausted(int $attempts): bool
    {
        return $attempts >= $this->maxAttempts;
    }

    public function isLogFieldAllowed(string $field): bool
    {
        return \in_array($field, $this->logFields, true);
    }

    /**
     * @param array<mixed> $source
     * @return array<mixed>
     */
    private static function block(array $source, string $key): array
    {
        $value = $source[$key] ?? null;

        if (!\is_array($value)) {
            throw new ContractArtifactException("booking-domain.json has no `{$key}` notification block.");
        }

        return $value;
    }

    /** @param array<mixed> $source */
    private static function string(array $source, string $key): string
    {
        $value = $source[$key] ?? null;

        if (!\is_string($value) || $value === '') {
            throw new ContractArtifactException("booking-domain.json has no non-empty `{$key}` string.");
        }

        return $value;
    }

    /** @param array<mixed> $source */
    private static function positiveInt(array $source, string $key): int
    {
        $value = $source[$key] ?? null;

        if (!\is_int($value) || $value <= 0) {
            throw new ContractArtifactException("booking-domain.json has no positive `{$key}` integer.");
        }

        return $value;
    }

    /**
     * @param array<mixed> $source
     * @return list<string>
     */
    private static function stringList(array $source, string $key): array
    {
        $value = $source[$key] ?? null;

        if (!\is_array($value) || $value === []) {
            throw new ContractArtifactException("booking-domain.json has no non-empty `{$key}` list.");
        }

        $strings = [];
        foreach ($value as $entry) {
            if (!\is_string($entry) || $entry === '') {
                throw new ContractArtifactException("booking-domain.json has a malformed `{$key}` entry.");
            }
            $strings[] = $entry;
        }

        return $strings;
    }

    /**
     * @param array<mixed> $statuses
     * @return array<string, list<string>>
     */
    private static function transitionMap(array $statuses): array
    {
        $value = $statuses['transitions'] ?? null;

        if (!\is_array($value)) {
            throw new ContractArtifactException('booking-domain.json has no notification transition map.');
        }

        $map = [];
        foreach ($value as $from => $targets) {
            if (!\is_string($from) || !\is_array($targets)) {
                throw new ContractArtifactException('booking-domain.json has a malformed notification transition.');
            }
            $map[$from] = [];
            foreach ($targets as $target) {
                if (!\is_string($target)) {
                    throw new ContractArtifactException(
                        'booking-domain.json has a non-string notification transition target.',
                    );
                }
                $map[$from][] = $target;
            }
        }

        return $map;
    }
}
