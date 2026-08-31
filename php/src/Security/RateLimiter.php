<?php

declare(strict_types=1);

namespace Eszter\Security;

/**
 * Charges one request against one bucket (ESZ-084).
 *
 * An interface with two implementations rather than one class, for the same
 * reason {@see \Eszter\Booking\BookingApi} is: the routes that need throttling
 * must be testable without a database, and the offline suites must not silently
 * become "the limiter did nothing" tests. {@see NullRateLimiter} is explicit
 * about admitting everything, and production never receives one — see
 * {@see \Eszter\Kernel} on how the limiter is wired.
 *
 * `charge()` both decides and records. Splitting the two would create a window
 * between the check and the write in which a second process could be admitted by
 * an allowance the first had already taken, which is precisely the race a
 * cross-request limiter exists to close.
 */
interface RateLimiter
{
    /**
     * @param string $scope One of {@see RateLimitPolicy}'s scope constants.
     * @param string $subject The thing being limited: a client address, a
     *        normalised identity, or a constant for a global ceiling. It is
     *        hashed with the scope before it reaches storage and is never
     *        persisted in clear.
     */
    public function charge(string $scope, string $subject): RateLimitDecision;
}
