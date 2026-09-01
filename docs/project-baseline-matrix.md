# Project baseline matrix — Phase 9

ESZ-091 pins the `thib-tooling` baselines used by Eszter and classifies every top-level control domain for the current V1 production scope.

The machine-readable source is [`docs/project-baseline-matrix.json`](project-baseline-matrix.json). Run `npm run baseline:verify` to prove that all expected domains are classified exactly once and that every N/A decision has a justification.

## Derivation source

- Project: `ThibSama/EszterGyori`
- Branch assessed: `phase/9-consolidation`
- Source SHA used for applicability review: `424bd372463072608d506ce3c28fa2399477096a`
- Production target: Hetzner shared webhosting
- Frontend: Next.js static export; Node is build-time only
- Backend: same-origin PHP API
- State: authoritative JSON editorial content, MySQL operational state, filesystem-managed media
- Operational components: admin auth/session, booking, media upload, notification queue, cron dispatcher, SMTP

## Applicability semantics

`ACTIVE` means the domain is in Eszter's V1 scope. It does **not** mean PASS. Atomic controls inside the domain are evaluated from the pinned baseline according to their `O`, `A` and `R` class and their applicability trigger.

`N/A` means no project-specific `A`/`R` trigger exists for that domain in the current V1 scope. **Universal `O` controls remain evaluated even inside an N/A domain**; this domain prefilter never waives an obligatory control. A scope change invalidates the decision and requires this matrix to be reviewed.

`R` controls remain non-blocking unless an explicit Eszter decision promotes them. `FAIL` or `NOT VERIFIED` on an `O` control or triggered `A` control blocks that baseline gate. `NOT RUN` is never PASS.

## Pinned baseline set

| Baseline | Version | Commit SHA | Repository | ACTIVE domains | N/A domains |
|---|---:|---|---|---:|---:|
| Security | `0.2.0` | `305b475636020598938145f7741d2132b6bc2b69` | `thib-tooling/security-baseline` | 20 | 0 |
| Architecture | `0.1.0` | `c4a47d811b0e5ec6740e2d771d593626c7c99de0` | `thib-tooling/architecture-baseline` | 22 | 1 |
| Quality | `0.1.0` | `e0fa9ed6d0a8f1c7992296f2a9845ec882b0388c` | `thib-tooling/quality-baseline` | 26 | 0 |
| Testing | `0.1.0` | `5b41b0cb220ec705e3b91d5f335861a95fe893e0` | `thib-tooling/testing-baseline` | 32 | 0 |
| Delivery | `0.1.0` | `1c888cc13d0a0a05fc425fde9831683e10262c32` | `thib-tooling/delivery-baseline` | 31 | 3 |
| Operations | `0.1.0` | `9a79e55ac2ab5796915d226448210be4ea66f14f` | `thib-tooling/operations-baseline` | 35 | 1 |
| Data | `0.1.0` | `56451fa2a80fa32e6469c082c0d6ae180ea3072f` | `thib-tooling/data-baseline` | 33 | 5 |
| Performance | `0.1.0` | `e7041d5867107b4a8aad6223ff0a9083055c62bb` | `thib-tooling/performance-baseline` | 39 | 1 |

Total: **249 domains classified: 238 ACTIVE, 11 N/A.**

## N/A decisions

| Domain | Baseline | Project-specific justification |
|---|---|---|
| `ARCH-17` | Architecture | Production has one owned application/backend boundary (static frontend + same-origin PHP API) rather than an owned distributed-service topology; SMTP/MySQL are covered as backing/external services. |
| `DEL-13` | Delivery | The production delivery unit targets Hetzner shared webhosting and contains no container image/runtime; Docker Compose is only a local disposable development dependency. |
| `DEL-25` | Delivery | V1 has no feature-flag system or flag-controlled release path. |
| `DEL-30` | Delivery | V1 publishes no package/container artifact to a registry or public package repository; the production archive is deployed directly to the hosting target. |
| `OPS-26` | Operations | V1 makes no high-availability or automated failover promise and has no redundant production topology; backup/restore/disaster recovery remain active separately. |
| `DATA-23` | Data | V1 contains no embeddings, chunking pipeline, vector store or search-derived vector index. |
| `DATA-24` | Data | V1 has no event stream, event log, CDC pipeline or streaming consumer; the notification table is an operational job queue, not an event-sourcing/CDC authority. |
| `DATA-27` | Data | V1 defines no analytics warehouse, analytical dataset or business-KPI data product. |
| `DATA-31` | Data | V1 has no application-level replica, multi-region store, sharding or multi-writer data topology. |
| `DATA-36` | Data | V1 contains no AI/ML training/evaluation dataset and persists no model-generated data. |
| `PERF-26` | Performance | V1 runs on fixed Hetzner shared webhosting and has no application-controlled autoscaling or load-balancing layer. |

## Active-domain rule

Every domain not listed in the N/A table is ACTIVE. The exact lists are stored in the JSON matrix so future gates do not have to expand prose or infer ranges.

Notable active domains include:

- Security: all `SEC-01` through `SEC-20`.
- Architecture: all domains except `ARCH-17`; notification queue/cron keeps async processing active, while SMTP is handled as an external integration rather than an owned distributed service.
- Quality: all `QUAL-01` through `QUAL-26`, including generated artifacts, multi-language static analysis, repository hygiene and no-regression.
- Testing: all `TEST-01` through `TEST-32`, including MySQL, browser, filesystem/media, concurrency, async notifications, recovery and manual/live acceptance.
- Delivery: exact candidate identity, clean bootstrap, build/package, migrations, multi-component rollout, health/readiness, smoke, CI/CD, artifact promotion, rollback and evidence all remain active.
- Operations: runtime identity, health, logs/metrics/correlation, alerting, dependencies, MySQL, queue/cron, backup/restore, disaster recovery, capacity, incidents, runbooks and evidence freshness remain active.
- Data: JSON/MySQL/media authorities, schemas, identifiers, lifecycle/retention, lineage, ingestion, serialization, conflicts, reconciliation, transactions, files, derived representations, migrations, reference data and recovery remain active.
- Performance: frontend/API/MySQL/media/queue workloads, budgets, latency, concurrency, capacity, resource use, browser/network, load, benchmark methodology, regression and evidence remain active.

## Gate consumption contract

1. `docs/project-baseline-matrix.json` is the canonical project applicability manifest.
2. A gate must never infer an omitted domain as N/A; omission is invalid and `baseline:verify` fails. Domain N/A only disables project-specific conditional triggers; pinned `O` controls remain mandatory.
3. The baseline version **and full commit SHA** are both pinned. A baseline update is a new applicability review, not an invisible dependency update.
4. Scope-changing architecture decisions (for example adding containers in production, HA, feature flags, analytics, vector/AI data or autoscaling) invalidate the corresponding N/A entry before release.
5. This matrix classifies applicability only. Compliance remains proven by the specialist gates and their evidence for the exact candidate.
