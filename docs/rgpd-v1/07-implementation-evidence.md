# 7. Implementation evidence — traceability matrix

Each row points at the implementation authority, the committed test(s) by
file and name, and the accepting commit(s). **The tests are cited as
executable, committed evidence; ESZ-166 did not rerun them** (documentation
checkpoint, no validation budget). No PASS result is claimed here beyond what
the accepted ESZ-161..165 commits already carried. The existence of every path
and test name below was checked deterministically on 2026-09-12 (see §7.9).

Accepted commits:

| Ticket | Commit | Subject |
|---|---|---|
| ESZ-161 | `1f599aa` | feat: align public booking with GDPR V1 |
| ESZ-161 | `5a59537` | fix: five V1 privacy rights and an exclusive basis-evidence check |
| ESZ-162 | `98122a3` | feat: rotate backup archives and manage cron logs |
| ESZ-162 | `dc54af6` | fix: compare the backup cutoff at whole-second precision |
| ESZ-163 | `0d2cd29` | feat: build the admin GDPR request centre |
| ESZ-164 | `22d800e` | feat: execute the GDPR data-subject rights from the register |
| ESZ-165 | `74dbfba` | feat: administer and publish the legal information |

## 7.1 Information without consent, and historical basis evidence

| Concern | Implementation authority | Test file → test | Commit |
|---|---|---|---|
| Booking rests on contract/pre-contractual steps; form shows an information notice, no checkbox | `contracts/booking.ts` `bookingPrivacyNoticePolicy`; `front/app/components/reservation/reservation-details.tsx` | `front/tests/reservation-ui.test.ts` → *the form renders the current catalog privacy notice instead of a consent checkbox*; `front/tests/reservation-flow.test.ts` → *customer validation covers required identity and optional limits, and requires no consent* | `1f599aa` |
| Notice content: controller, basis, retention, recipients, five rights + CNIL, contact, policy link — repository-owned facts only | `contracts/booking.ts` `bookingPrivacyNoticeContents` | `contracts/tests/booking-notice-catalog.test.ts` → *the current privacy notice covers every required statement with repository-owned facts only* | `1f599aa`, `5a59537` |
| Request carries exactly the displayed notice id; consent fields refused on the wire | `contracts/http-contract.ts`; `php/src/Http/Endpoint/PublicBookingCreateEndpoint.php` | `contracts/tests/booking-notice-catalog.test.ts` → *the create schema accepts exactly a catalog privacy notice id and no consent field*; `front/tests/reservation-flow.test.ts` → *the creation request names exactly the privacy notice the form renders*; `php/tests/Sql/SqlIntegrationTest.php` → `testCreatingWithAConsentFieldIsRefusedBeforeInsertion`, `testCreatingWithoutANoticeIdIsRefusedBeforeInsertion`, `testCreatingWithAnUnknownNoticeIdIsRefusedBeforeInsertion` | `1f599aa` |
| Evidence stored: notice id + presentation instant; never a fabricated consent | `php/migrations/0020_booking_privacy_notice_and_public_reference.sql`; `php/src/Booking/BookingRepository.php` | `php/tests/Sql/SqlIntegrationTest.php` → `testAtomicPublicCreationStoresThePrivacyNoticeAndACurrentReference`; `php/tests/Sql/MigrationTest.php` → `testMigration0020AddsPrivacyNoticeEvidenceAndTheCurrentReferenceShape` | `1f599aa` |
| Exactly one basis evidence per booking (consent XOR privacy pair) | `php/migrations/0021_booking_basis_evidence_exclusive.sql` | `php/tests/Sql/MigrationTest.php` → `testMigration0021MakesTheBasisEvidenceCheckExclusive` | `5a59537` |
| Historical consent catalog frozen byte for byte | `contracts/booking.ts` `bookingConsentNoticePolicy` | `contracts/tests/booking-notice-catalog.test.ts` → *the historical consent catalog is preserved byte for byte*; `php/tests/Sql/MigrationTest.php` → `testMigration0014PreservesPreExistingBookingsWithoutInventingProvenance` | `1f599aa` |
| Admin contact edits never rewrite notice facts | `php/src/Booking/BookingLifecycle.php` | `php/tests/Sql/SqlIntegrationTest.php` → `testAdminContactUpdatesNeverRewriteTheStoredNoticeFacts` | `1f599aa` |
| Minimisation on the form: optional transactional-only phone, optional note with sensitive-data warning, keep-the-reference instruction | `front/app/components/reservation/reservation-details.tsx` | `front/tests/reservation-ui.test.ts` → *the phone stays optional and is announced as transactional-only*; *the free field is the optional « précision » with a placeholder and a sensitive-data warning*; *the confirmation tells the visitor to keep the reference* | `1f599aa` |

## 7.2 Retention, anonymisation and backup reconciliation

| Concern | Implementation authority | Test file → test | Commit |
|---|---|---|---|
| 90-day erasure after lifecycle end; placeholders; nothing deleted | `contracts/booking.ts` `customerDataRetentionPolicy`; `php/src/Retention/BookingRetentionService.php`; `php/migrations/0011_booking_customer_data_retention.sql` | `php/tests/Sql/SqlIntegrationTest.php` → `testRetentionErasesExactlyTheRowsPastTheirOwnCutoff`, `testRepeatedRetentionRunsChangeZeroRows`, `testAdminUpdatesCannotReintroducePiiIntoAnErasedBooking`, `testBookingHistoryDetailsJsonNeverHoldsErasedCustomerValues`, `testTheRetentionCliErasesIdempotentlyAndPrintsNoPii`; `php/tests/Retention/RetentionPolicyTest.php` → `testTheFrozenPolicyIsTheDeclaredV1ProductPolicy`, `testTheEmailPlaceholderIsNonDeliverableAndTheNameIsNotAnEmail` | pre-ESZ-161 (ESZ-140), reused by `22d800e` |
| Non-personal evidence survives anonymisation (consent/notice ids, history, terminal jobs) | same | `php/tests/Sql/SqlIntegrationTest.php` → `testRetentionPreservesConsentEvidenceWhileErasingCustomerPii`, `testRetentionRetiresOnlyNonTerminalJobsAndPreservesTerminalEvidence`, `testNotificationFactResolutionRefusesAnErasedBooking` | ESZ-140/142, unchanged |
| Backup archives ≤ 30 days, rotation only after a successful publish | `php/src/Backup/BackupRotation.php`; `php/bin/backup.php` | `php/tests/Backup/BackupRotationTest.php` → `testExpiredCanonicalArchivesGoAndTheBoundaryAndUnrelatedNamesStay`, `testASubSecondClockStillKeepsTheWholeSecondBoundary`, `testAFailedBackupCannotPrune`, `testSymlinkedCanonicalNameRefusesBeforeAnyDeletion`, `testNonRegularCanonicalNameRefusesBeforeAnyDeletion` | `98122a3`, `dc54af6` |
| Restore re-applies retention before success; failure rolls back | `php/src/Backup/BackupRestore.php` | `php/tests/Sql/BackupRestoreSqlTest.php` → `testRestoredRowsWhoseCustomerDataAlreadyExpiredComeBackAnonymized`, `testARetentionReconciliationFailureRollsBackToTheCompleteOldState` | ESZ-097/098, unchanged |
| Logs (incl. cron logs) under one 30-day policy | `php/src/Support/LogMaintenance.php` | `php/tests/Support/LogMaintenanceTest.php` → `testRotationRetentionBoundaryPermissionsAndLoggerRecovery`, `testCronRedirectionLogsAreManagedUnderTheSameThirtyDayBoundary` | `98122a3` |
| Secrets, sessions, rate-limit rows and logs excluded from backups | `php/src/Backup/BackupSet.php` | `php/tests/Backup/BackupSetTest.php` | ESZ-083, unchanged |

## 7.3 GDPR request register and scope (ESZ-163)

| Concern | Implementation authority | Test file → test | Commit |
|---|---|---|---|
| Identification by reference (both shapes) or e-mail; erased bookings unreachable | `php/src/Privacy/PrivacyRequestAdministration.php`; `php/src/Booking/BookingRepository.php` | `php/tests/Sql/PrivacyRequestSqlTest.php` → `testAReferenceOfEitherShapeResolvesExactlyOneLiveBooking`, `testAnErasedBookingIsNotIdentifiableByReferenceEither`, `testAnEmailLookupIsCaseInsensitivePaginatedAndCompleteOnTheWire`, `testTheErasedPlaceholderNeverReconnectsAnonymisedBookings` | `0d2cd29` |
| Register stores references only, never requester e-mail/message/identity | `php/migrations/0022_privacy_requests.sql`; `PrivacyRequestRepository.php` | `php/tests/Sql/PrivacyRequestSqlTest.php` → `testRecordingStoresExactlyTheSelectedReferencesAndNothingAboutTheRequester`, `testRecordingRefusesAnUnknownAnErasedAndADuplicateReference`; `front/tests/admin-privacy-centre.test.ts` → *the record request carries only the type, the reception date and the selected references*; *the register never renders a requester e-mail or message, and failures are worded per surface* | `0d2cd29` |
| Explicit scope selection; shared e-mail never implies all bookings; partial pages block the review | `front/app/lib/admin-privacy-requests.ts`; `admin-privacy-centre.tsx` | `front/tests/admin-privacy-centre.test.ts` → *a shared e-mail never implies all bookings: the scope is an explicit selection or a confirmed empty scope*; *an e-mail search is never silently truncated: partial pages are announced and block the review*; *the flow is type → identification → search → scope review → record* | `0d2cd29` |
| Five frozen types, opposition absent; one-month stored deadline; automatic lifecycle | `contracts/booking.ts` `privacyRequestPolicy`; `php/src/Privacy/PrivacyRequestDeadline.php` | `front/tests/admin-privacy-centre.test.ts` → *the five frozen types are offered, opposition is not, and each has a French label*; *history shows reception date, type, status, closure, references and Voir; detail shows the deadline*; `php/tests/Sql/PrivacyRequestSqlTest.php` → `testTheLifecycleIsAutomaticAndTheClosureInstantLandsWithTheStatus`, `testHistoryReadsAllThreeStatesNewestFirstWithItsOwnPagination` | `0d2cd29` |
| Closed records purged after three years inside the daily sweep | `php/src/Privacy/PrivacyRequestRetention.php`; `php/bin/apply-booking-retention.php` | `php/tests/Sql/PrivacyRequestSqlTest.php` → `testOnlyClosedRecordsOlderThanThreeYearsArePurged` | `0d2cd29` |
| Session + CSRF on the mutation routes | `php/src/Composition/BookingRoutes.php` | `php/tests/Http/HttpContractConformanceTest.php` → `testContractCase` (corpus replay of the `/api/admin/privacy-requests*` cases) | `0d2cd29` |

## 7.4 The five rights (ESZ-164)

| Right | Implementation authority | Test file → test | Commit |
|---|---|---|---|
| Access (HTML export) and Portability (JSON export) from one document; nothing persisted; anonymised links never reconnected | `php/src/Privacy/PrivacyDataExport.php`; `PrivacyRightsExecution.php` | `php/tests/Sql/PrivacyRequestSqlTest.php` → `testOneExportEngineAnswersAccessAndPortabilityWithoutReconnectingAnAnonymisedLink`; `front/tests/admin-privacy-centre.test.ts` → *an export is downloaded from the response and stored nowhere; both representations share one document* | `22d800e` |
| Rectification through the single customer-update authority | `php/src/Booking/BookingLifecycle.php::updateCustomerContact` | `php/tests/Sql/PrivacyRequestSqlTest.php` → `testOneExportEngineAnswersAccessAndPortabilityWithoutReconnectingAnAnonymisedLink` (shared-authority assertions); `php/tests/Booking/BookingApiCompositionTest.php` → `testEachPreservedRuleHasExactlyOneOwner` | `22d800e` |
| Erasure = early anonymisation via the ESZ-140/162 primitive; active jobs neutralised | `php/src/Retention/BookingRetentionService.php::eraseBooking`; `BookingLifecycle::anonymize` | `php/tests/Sql/PrivacyRequestSqlTest.php` → `testEarlyAnonymisationRunsTheRetentionPrimitiveAndNeutralisesActiveJobs` | `22d800e` |
| Restriction: authoritative marker, calendar label, action availability | `php/migrations/0023_privacy_rights.sql`; `BookingLifecycle::restrictProcessing` | `php/tests/Sql/MigrationTest.php` → `testMigration0023AddsTheRestrictionMarkerAndWidensTheTwoChecks`; `front/tests/admin-privacy-centre.test.ts` → *the detail offers exactly the actions the server would accept, per type, status and booking state*; *the two markers are the frozen labels, shown in the detail and on the calendar* | `22d800e` |
| Guarded confirmations for anonymisation and lift; every action by id with CSRF | `front/app/components/admin/admin-privacy-centre.tsx` | `front/tests/admin-privacy-centre.test.ts` → *anonymisation and lift are behind an explicit ticked confirmation, and every action is sent by id with CSRF* | `22d800e` |

## 7.5 Restriction — notification suppression and resume

| Concern | Implementation authority | Test file → test | Commit |
|---|---|---|---|
| Restricted booking's jobs never claimed; delivery-time re-check releases a claimed job with the attempt refunded; stale reminder never replayed after lift; one lift e-mail | `php/src/Notification/NotificationJobRepository.php`; `NotificationRunner.php`; `BookingLifecycle::liftProcessingRestriction` | `php/tests/Sql/PrivacyRequestSqlTest.php` → `testRestrictionHoldsAndReleasesJobsAndTheLiftNeverReplaysAStaleReminder`; `php/tests/Notification/NotificationPolicyTest.php` → `testTheFrozenEnumsAreExactlyWhatThePackageDeclares` (`processing_restriction_lifted` job type, `processing_restricted` reserved code) | `22d800e` |

## 7.6 Legal information persistence and applicability (ESZ-165)

| Concern | Implementation authority | Test file → test | Commit |
|---|---|---|---|
| Empty document = all unknown; every required fact warns; non-applicable = complete and hidden; applicable-but-unknown warns and is hidden | `contracts/legal.ts` | `contracts/tests/legal-information.test.ts` → *the empty document is all unknown and every required fact warns*; *a complete document warns about nothing and publishes every fact*; *a non-applicable fact is complete for the admin and absent from the public projection*; *an applicable-but-unknown fact warns the admin and is still hidden from the public*; *applicability is structural: a non-applicable VAT cannot carry a number* | `74dbfba` |
| Persistence in one `system_settings` row under a revision; stale revision refused; drift refused | `php/src/Legal/PdoLegalInformationApi.php` | `php/tests/Sql/LegalInformationSqlTest.php` → `testAFreshDeploymentHoldsTheEmptyDocumentAtRevisionZeroAndNoRow`, `testASaveStoresTheDocumentVerbatimUnderTheNextRevision`, `testAStaleRevisionIsRefusedAndWritesNothing`, `testADriftedRowIsRefusedRatherThanServedRepaired` | `74dbfba` |
| Admin form: draft round-trip, malformed identifiers refused, missing facts reported; save with CSRF | `front/app/lib/admin-legal-information.ts`; `admin-settings.tsx` | `front/tests/legal-pages.test.ts` → *the admin draft round-trips, refuses malformed identifiers and reports missing required facts*; *the admin settings page reads and saves through the frozen route, with CSRF on the save only* | `74dbfba` |

## 7.7 Two public legal pages, footer and reservation integration

| Concern | Implementation authority | Test file → test | Commit |
|---|---|---|---|
| `/mentions-legales` and `/confidentialite` are distinct exact export routes; the privacy path is the one the ESZ-161 notice froze | `contracts/legal.ts`; `php/src/Deploy/DocumentRootRouting.php`; `php/public/.htaccess` | `contracts/tests/legal-information.test.ts` → *the two public pages are distinct, and the privacy path is the one the ESZ-161 notice froze*; *the generated HTTP contract freezes the two legal routes and their cases*; `php/tests/Deploy/DocumentRootRoutingTest.php` → `testTheLegalPagesAreTwoDistinctExactStaticExportRoutes`, `testTheCommittedHtaccessMatchesTheRoutingTable`; `front/tests/legal-pages.test.ts` → *the two legal pages are distinct exported routes reading one public document* | `74dbfba` |
| Footer keeps content links and adds the two fixed legal links; booking form still points at `/confidentialite` | `front/app/components/site-preview.tsx`; `reservation-details.tsx` | `front/tests/legal-pages.test.ts` → *the footer keeps its content links and adds the two fixed legal links; the booking form still points at /confidentialite* | `74dbfba` |
| Public read degrades to one neutral message; no configuration gap shown | `front/app/components/legal/legal-page-frame.tsx` | `front/tests/legal-pages.test.ts` → *the public read parses the frozen document and degrades to one neutral message* | `74dbfba` |
| Public routes composed with the database, legal routes wired | `php/src/Composition/LegalRoutes.php`; `php/src/Kernel.php` | `php/tests/Http/KernelCompositionTest.php` → `testBootWithConfiguredDatabaseWiringRegistersTheWholeFrozenSurface`; `php/tests/Http/HttpContractConformanceTest.php` → `testContractCase` (legal corpus cases) | `74dbfba` |

## 7.8 Supporting security controls cited by the register

| Concern | Implementation authority | Test file → test |
|---|---|---|
| Session cookie attributes, rotation, server-side logout | `php/src/Auth/SessionCookie.php`, `SessionManager.php` | `php/tests/Auth/AuthenticationTest.php` → `testTheSessionCookieCarriesItsAttributes`, `testTheSessionIdRotatesOnLogin`, `testLogoutInvalidatesTheSessionServerSide` |
| Login-failure fingerprints keyed and identity-free | `php/src/Support/LoginIdentityPseudonymizer.php` | `php/tests/Auth/AuthenticationTest.php` → `testRejectedLoginFingerprintsAreKeyedNormalizedAndContainNoIdentity` |
| Rate-limit subjects never stored in clear | `php/src/Security/PdoRateLimiter.php` | `php/tests/Sql/RateLimiterSqlTest.php` → `testNoSubjectIsStoredInClear` |
| Notification log allowlist | `php/src/Notification/NotificationLogContext.php` | `php/tests/Notification/NotificationPolicyTest.php` → `testTheLogAllowlistExcludesEveryFieldDeclaredForbidden`, `testTheLogChokePointMechanicallyDropsCustomerAndMessageValues` |

## 7.9 How this matrix was checked (ESZ-166)

- Every repository path named in this dossier (191 backticked path references) was checked for existence against `git ls-files` with a throwaway script, on 2026-09-12.
- Every PHP `test…` method name (59) and every quoted TypeScript test title (32) was grepped in its cited file.
- No test suite was executed by ESZ-166.
