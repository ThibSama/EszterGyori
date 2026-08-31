<?php

declare(strict_types=1);

namespace Eszter\Notification;

/**
 * The delivery will never succeed: an unroutable address, a rejected number.
 *
 * Terminal immediately. Retrying a permanent refusal spends the whole attempt
 * budget to arrive at the same answer four attempts later.
 */
final class PermanentDeliveryException extends DeliveryException
{
}
