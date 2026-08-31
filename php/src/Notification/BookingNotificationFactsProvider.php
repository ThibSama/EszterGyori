<?php

declare(strict_types=1);

namespace Eszter\Notification;

interface BookingNotificationFactsProvider
{
    public function forJob(NotificationJob $job): BookingNotificationFacts;
}
