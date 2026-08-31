<?php

declare(strict_types=1);

namespace Eszter\Security;

/**
 * One bucket of `rateLimitPolicy`, in the form the algorithm actually uses.
 *
 * The contract states a rule the way a person reads it — "10 requests per 900
 * seconds, burst 5". GCRA needs the same rule expressed as two durations, and the
 * conversion is done once, here, rather than at every call site. Doing it at the
 * call site is how two routes end up disagreeing about what the same numbers
 * meant.
 *
 * Milliseconds throughout, integer throughout. `RateLimitPolicy` refuses a bucket
 * whose emission interval is not a whole number of milliseconds, so nothing here
 * ever rounds and the same inputs always produce the same decision — which is
 * what makes the limiter testable against a frozen clock instead of a stopwatch.
 */
final class RateLimitRule
{
    private function __construct(
        public readonly string $scope,
        public readonly int $limit,
        public readonly int $periodSeconds,
        public readonly int $burst,
        /** How often one unit of allowance is restored. */
        public readonly int $emissionIntervalMs,
        /**
         * How far ahead of the long-run rate a caller may run.
         *
         * `(burst - 1) * emissionInterval`, not `burst * emissionInterval`. The
         * textbook GCRA writes the latter, and with it a bucket admits `burst + 1`
         * requests arriving at the same instant — the first one costs nothing
         * because the arrival time starts at `now`. That off-by-one is harmless in
         * a paper and misleading in a contract, where `burst: 5` has to mean five.
         * Subtracting one interval makes the declared number the number of
         * simultaneous requests admitted, and `burst: 1` then means strictly one
         * per emission interval rather than two.
         */
        public readonly int $delayToleranceMs,
    ) {
    }

    public static function create(string $scope, int $limit, int $periodSeconds, int $burst): self
    {
        if ($limit < 1 || $periodSeconds < 1 || $burst < 1) {
            throw new \InvalidArgumentException(
                "Rate limit bucket `{$scope}` must have a positive limit, period and burst.",
            );
        }

        $periodMs = $periodSeconds * 1000;

        if ($periodMs % $limit !== 0) {
            // Refused rather than rounded. A fractional emission interval makes
            // the decision depend on where the rounding happened, so PHP and the
            // contract could reach different answers about the same request and
            // neither would be wrong.
            throw new \InvalidArgumentException(
                "Rate limit bucket `{$scope}` has a fractional emission interval "
                . "({$periodSeconds}s / {$limit}); choose a limit that divides the period in milliseconds.",
            );
        }

        $emission = intdiv($periodMs, $limit);

        return new self($scope, $limit, $periodSeconds, $burst, $emission, ($burst - 1) * $emission);
    }

    /**
     * How long a row stays meaningful after its arrival time.
     *
     * One full period beyond the tolerance. Shorter would sweep rows that are
     * still in force; much longer would only keep dead rows around. Either way
     * the sweep can never grant allowance — see the column comment on
     * `expires_at_ms`.
     */
    public function retentionMs(): int
    {
        return $this->delayToleranceMs + $this->periodSeconds * 1000;
    }
}
