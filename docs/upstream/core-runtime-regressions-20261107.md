# Core runtime regression completion

Baseline: `d8c1839f018434d32e43b2b0d41b4783ebca1c7c`. This follow-up replaces the source-only acceptance boundary with executable isolated checks. It does not authorize live stations, SMS, production data, rollout or deployment. Parent grants every install/build/suite/container window. Original archived regression and migration bytes remain unchanged.

## Runtime corrections under review

Enabled charging callouts now require successful durable-store resolution at construction. Disabled configurations still need no store. A constructor/DI failure no longer silently removes mandatory fencing.

Transaction authorization now carries optional internal `requiresExplicitAuthorizationTarget` evidence when the OCPP start/event actually named a target. The enabled authorizer rejects failed target resolution rather than treating the station's one connector as a physical start choice. The standard OCPP DTO/payload is unchanged.

Callback registration/cleanup and atomic terminal callback claims now share tenant+station+correlation namespaces. Success/error/timeout/dispatch notifications receive the resolved tenant from the router. Callback HTTP payload/URL/correlation contracts remain unchanged. There is no unsafe fallback to the old station-only cache namespace. Cutover must settle or expire old outstanding callbacks before activation.

## Current executable coverage

| Intent | Current executable surface | Evidence |
| --- | --- | --- |
| OIDC transport owner deadline, cached token, late headers/body/error body | `packages/ocpp/test/apis/authorization/oidc-token-provider-deadline.test.ts` | Window3: 4 runtime passed + typecheck passed |
| Mandatory store, explicit/inferred targets, durable CAS, same-name tenant fences, request/body budget | `packages/ocpp/test/services/authorizer/evyar-admission.test.ts` | Window3: 11 runtime passed + typecheck passed |
| Exact decline body/canonical GUID/fenced acknowledgement, retry/abandon/restart/shutdown | `packages/ocpp/test/services/authorizer/decline-receipt.test.ts` | Window3: 9 runtime passed + typecheck passed |
| Native structured energy/time/idle/fixed/payment/taxes/bounds, locked/free/missing tariff | `packages/ocpp/test/modules/transactions/cost-calculator.test.ts` | Window3: 31 runtime passed + typecheck passed |
| Atomic terminal claim, retry policy/body identity, permanent rejection, tenant/station/correlation isolation | `packages/ocpp/test/modules/ocpp-router/callback-url-notifier.test.ts` | Window3: 10 runtime passed + typecheck passed |
| Bounded socket order/backpressure/failure recovery | `packages/ocpp/test/modules/ocpp-router/status-ingress-queue.test.ts` | Window3: 2 runtime passed + typecheck passed |
| Timestamp/receipt order and malformed evidence rejection | `packages/dal/test/repositories/sequelize/status-ingress-order.test.ts` | Window3: 3 runtime passed + typecheck passed |
| Physical stop and cost in one row save; original start evidence/free/missing/unpriced/error/retry/duplicate | `packages/ocpp/test/handlers/requests/1.6/evyar-stop-final-cost.test.ts` | Window3: 7 runtime passed + typecheck passed; all DB/network boundaries trapped before access |
| Consumer cancellation, handler/ack draining, settlement failure, no reconnect after stop | `packages/ocpp/test/transport/queue/rabbit-mq/evyar-delivery-drain.test.ts` | Window3: 3 runtime passed + typecheck passed |
| Fresh/history/restore/partitioned witness preservation, actual repository replay/broadcast/connection/rollback/pool/ledger | `apps/ocpp-server/test/runtime/{database-fixture,upgrade-and-receipts}.cjs` | Prepared and syntax-checked only; parent container window pending |

Window1 exited 1. Runtime cases outside stop passed, but Vitest's per-project checker ran despite the CLI disable flag, exposing stale built Base metadata plus fixture errors. No combined test/typecheck acceptance is claimed. Source fixes were made for the explicit callback annotation, missing status-ingress integration dependency and nullable Drizzle fixture field. No type casts, DTO weakening or disabled assertions were added to hide errors. Window2 requests a sequential current-source build then the same eight-file rerun with normal typechecking.

Window3 final outcome: 86 runtime cases across ten files passed (Base6/OCPP77/DAL3), plus normal project typechecking (68 discovered cases, not extra runtime coverage). Base command registration adds six runtime cases covering awaited storage/rejection, authoritative router forwarding, mismatch cleanup and tenant collision. Initial window3 fixture failures and retry logs remain recorded in control/CORE_RUNTIME_UNIT_RESULT.md. Window2 current five-package OCPP build passed. No database/container checks have run; the unit batch uses sterile environment and pre-access database/network traps.

## Database acceptance design

The fixture requires a private parent grant manifest and inspects the exact container task/nonce labels, running state, <=1GiB memory limit and loopback/random PostgreSQL binding. It accepts no live URL/environment. Owned synthetic databases have unique nonce names and COMMENT markers. It verifies no other database connections before/after migration and never starts services; the cutover flag is an acknowledgement, not the quiescence proof.

Frozen baseline migration sources (52) are compiled into an owned private fixture directory, with source/emitted hashes. A fixture-only import facade restores just the historical Base exports after checking their values against frozen source/current exports. Migration bodies and historical archives are unchanged. Actual sequelize-cli execution creates all original SequelizeMeta entries; none are invented. Active current migrations use actual compiled discovery, retaining retired names in stored history. This checks pinned migration sources with the installed supported SQL dependency implementation, not an old application artifact.

Synthetic out-of-retention original CALL/status/pointer records are inserted explicitly. The script dumps the old schema/history/evidence, restores into a distinct owned database and compares original values. Forward upgrade must preserve exact witness IDs/frames before the upstream partition swap, retain old history, transfer connector pointers and tolerate retired stored names. Actual built repositories then exercise order, whole-receipt/divergent replay, per-target broadcast winners, retired socket/registration fencing, rollback, bounded sequence pool and persistent admission CAS/restart/tenant isolation. Cleanup may touch only owned marked databases; failure retains private artifacts for parent inspection.

Still required before acceptance: execute/fix both lanes; add device-availability atomic rollback and negative bridge/preflight cases, partition retention/transaction identities and owner lifecycle checks; extend actual command registration/terminal/busy-retry and protocol/connection/config/TLS/meter/SoC cases; record source-bound results and remaining gaps. Neither this document nor archived evidence closes those gates.

## Release/ownership handoff

The runtime corrections need a parent-owned appropriate release-impact record; this owner does not edit `.release`. Vendor versions and package manifests stay unchanged. Apps/integrated OCPI/operator UI and release governance belong to other owners. Local scoped commits are allowed; no push/merge/PR/deploy is performed here.

## Dedicated external Core JWT boundary (prepared; not executed)

`auth.jwt.requiredTenantClaim` is optional and opt-in. In `auth.mode=jwt`, set issuer/JWKS to the reviewed IAM issuer, audience `citrineos-core`, tenantClaim `core_tenant_id`, rolesClaim `core_roles`, and requiredTenantClaim `true`. After signature/issuer/audience verification, the private tenant claim must be a positive PostgreSQL integer ID (number or canonical decimal string, range1..2147483647). Missing/null/UUID/object/boolean/fractional/noncanonical/out-of-range claims fail authentication with no default tenant. The canonical IAM UUID `tenant_id` remains a separate product claim. This is validation of signed authority, not mapping UUIDs or granting issuer bindings.

Upstream localDev construction does not forward this flag and keeps default-tenant behavior; external JWT configurations that omit the flag keep existing fallback semantics. Both query and body tenant IDs must match the signed Core tenant; a valid query cannot hide a conflicting body. Public wire/DTO contracts are unchanged.

The OCPP resource role seed now includes only the adapter handoff's `evyar-adapter` role:49 exact permissions, empty UI resources, no wildcard/admin. Contract snapshot provenance: sibling adapter `docs/upgrades/core-api-machine-policy.json`. Ordinary `roles` or IAM scopes do not substitute for `core_roles`. Parent owns actual issuer grants, credential provisioning and runtime deployment configuration; these source changes enable enforcement but do not activate it in a live deployment.

Prepared `evyar-core-jwt-boundary.test.ts` uses bounded local ES256 signing keys, real signature verification, actual PolicyStore and mocked role loading, and in-memory Fastify injection with pre-access network/database traps. It covers missing/malformed claims, valid integer claims, wrong audience/issuer/signature, opt-out fallback, exact machine permissions and cross-tenant query/body conflicts. No suite/build/install/container was launched for this follow-up while apps holds the resource window. Types must rebuild before its config/typecheck runs; do not mistake stale built declarations for source acceptance.
