<?php

declare(strict_types=1);

namespace Eszter\Legal;

/**
 * The shape of the persisted legal document, as PHP needs to know it.
 *
 * PHP stores and serves the document; it does not interpret it. The field
 * catalog, the required-field warnings and the public hiding rule are the
 * contract's (`contracts/legal.ts`), computed by the frontend from what this
 * backend hands back — so the only knowledge here is the *empty* document a
 * deployment starts from, and the rule that a stored document must still
 * satisfy the frozen schema on the way out.
 */
final class LegalInformation
{
    /** The `system_settings` key (contract: `legalInformationPolicy.settingKey`). */
    public const SETTING_KEY = 'legal.information';

    /** The schema every stored document is checked against before it is served. */
    public const SCHEMA = 'public-legal-information-response.schema.json';

    /**
     * Nothing known. VAT and the salon address start as applicable-and-unknown
     * rather than as "does not apply": that decision is the administrator's.
     *
     * @return array<string, mixed>
     */
    public static function empty(): array
    {
        return [
            'legalName' => null,
            'tradeName' => null,
            'legalForm' => null,
            'siren' => null,
            'siret' => null,
            'registers' => [],
            'vat' => ['applicable' => true, 'number' => null],
            'activity' => null,
            'contact' => ['email' => null, 'phone' => null],
            'hosting' => ['name' => null, 'address' => null, 'phone' => null, 'website' => null],
            'registeredAddress' => null,
            'salonAddress' => ['applicable' => true, 'address' => null],
        ];
    }
}
