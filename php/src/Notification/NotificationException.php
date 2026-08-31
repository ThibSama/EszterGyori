<?php

declare(strict_types=1);

namespace Eszter\Notification;

/** A caller error: a malformed job, an unknown enum, an impossible transition. */
class NotificationException extends \RuntimeException
{
    public static function invalid(string $field, string $reason): self
    {
        return new self("{$field}: {$reason}");
    }
}
