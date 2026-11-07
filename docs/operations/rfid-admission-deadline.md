# RFID admission deadline

A real DEV attempt timed out at the Adapter 2 s callback while CSMS/Payment completed security later. Core correctly declined before power; authoritative no-start recovery closed the attempt. This repair gives the ordinary callback a supported 8 s default and bounds cold OIDC, HTTP and response JSON with one deadline. An expired waiter stops waiting without cancelling authentication needed by another caller. A late approval cannot reverse a durable decline. No financial approval is cached.

The coordinated budgets are eMSP 4500 ms, Adapter 5000 ms, Core 8000 ms. Core's existing 100–10000 ms configuration range remains. The 15 s replay/cache setting, explicit-target live revalidation, durable chargingCalloutRef/DECLINED_BEFORE_POWER ledger, 20 s OCPP call budget, emulator 30 s CALL timeout and 60 s EV handshake are separate and unchanged. After cold authentication Core reserves 50 ms for returning/parsing a response and relays only the remaining budget. A relative positive integer `x-evyar-request-budget-ms` header carries remaining time outside the body/hash and can only shorten a downstream server maximum.

## Core v2.1.0 configuration port

The active ConfigLoader now reads schema-based prefixed environment inputs. Use `CITRINEOS_REALTIMEAUTHREQUESTTIMEOUTMS=8000`; deployments using `--env-prefix` substitute that prefix. Set `CITRINEOS_REALTIMEAUTHREPLAYLASTATTEMPT` and the `CITRINEOS_REALTIMEAUTHCHARGINGCALLOUTS_*` schema fields deliberately. `TENANTMAP` is one JSON object mapping Core integer tenant keys to canonical GUID strings; arbitrary nested environment record keys such as `..._TENANTMAP_1` are unsupported. Keep webhook/OIDC secrets private. New default values do not prove deployment configuration.

The pre-upgrade persistent `/data/ocpprouter/systemConfig`/ConfigStoreFactory workflow and bootstrap config loader are removed upstream. They are historical context, not supported activation instructions for this source tree. Review actual new environment/asset inputs with the owner; no runtime settings were changed here. Enabled callouts normally receive the registered ledger store, but the inherited defensive optional-store accessor can disable fencing if DI store resolution fails; enabled alone is not a startup/fail-closed guarantee. Require the ledger schema plus consumer compatibility review before later activation.

Relevant active paths: `packages/types/src/config/types.ts`, `packages/base/src/config/config-loader.ts`, `packages/ocpp/src/services/authorizer/real-time-authorizer.ts`, `packages/ocpp/src/server/container.ts`. The exact source/consumer/migration boundaries are in [the upstream disposition](../upstream/evyar-customizations-20261107.md).

Parent EVYAR/evyar#405; Core repair issue EVYAR/evyar#407 (Core owner repository disables issues). Validation includes cold-auth timeout, independent callers sharing valid OAuth, stalled/late body rejection, no callback after expiry, supported defaults and existing durable decline/fence tests.

## Build scope and memory

The Iran Dockerfile retains the same frozen dependency install and filtered `@citrineos/ocpp-server...` graph (types, base, dal, ocpp, server). Only that build command sets `NODE_OPTIONS=--max-old-space-size=2048` and `--workspace-concurrency=1`; runtime heap/environment, dependencies and versions are untouched. The runtime OCI revision still comes from the existing dynamic `COMMIT_SHA` build argument. A manual prebuild must supply the exact checkout SHA on that one command and attest the resulting label; do not persist a static revision build argument when restoring ordinary auto-deployment.

The OIDC provider also owns an independent fixed 8 s transport deadline across token fetch and both error/success body reads, with a final expiry check before updating its existing completed-token cache. Caller A's shorter authorization deadline only releases A's wait; it does not abort provider transport needed by caller B. Provider timeout leaves no late token cached. No new in-flight cache, refresh path, configuration key or financial approval cache is introduced.
