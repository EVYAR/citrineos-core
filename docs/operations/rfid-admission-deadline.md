# RFID admission deadline

A real DEV attempt timed out at the Adapter 2 s callback while CSMS/Payment completed security later. Core correctly declined before power; authoritative no-start recovery closed the attempt. This repair gives the ordinary callback a supported 8 s default and bounds cold OIDC, HTTP and response JSON with one deadline. An expired waiter stops waiting without cancelling authentication needed by another caller. A late approval cannot reverse a durable decline. No financial approval is cached.

The coordinated budgets are eMSP 4500 ms, Adapter 5000 ms, Core 8000 ms. Core's existing 100–10000 ms configuration range remains. The 15 s replay/cache setting, explicit-target live revalidation, durable chargingCalloutRef/DECLINED_BEFORE_POWER ledger, 20 s OCPP call budget, emulator 30 s CALL timeout and 60 s EV handshake are separate and unchanged. After cold authentication Core reserves 50 ms for returning/parsing a response and relays only the remaining budget. A relative positive integer `x-evyar-request-budget-ms` header carries remaining time outside the body/hash and can only shorten a downstream server maximum.

## Supported effective configuration

Use the existing owner GET `/data/ocpprouter/systemConfig` to retain and review the complete current SystemConfig. PUT on the same route validates and persists the complete body through ConfigStoreFactory; change only top-level `realTimeAuthRequestTimeoutMs` to 8000. Preserve all unrelated fields and transport secrets privately. Do not use SQL, a wipe flag, per-Authorization cache timing, or a synthetic-user override.

The existing supported environment override is `CITRINEOS_REALTIMEAUTHREQUESTTIMEOUTMS=8000`; deployments supplying `--env-prefix=...` use that prefix instead. `defineConfig` merges this override before validation, so it also supersedes an explicit older stored 3 s value. ConfigStore reads local/S3/GCP according to bootstrap configuration. For local storage the physical file is `path.resolve(cwd, configDir ?? fileAccess.local.defaultFilePath, configFileName)`; default configFileName is `config.json`. Read the actual nonsecret bootstrap values/mounts to identify the exact deployment path; never assume a container path.

PUT updates the module config reference but an existing RealTimeAuthorizer retains its constructor reference. Apply the reviewed setting through the normal owner/deployment path with a controlled Core restart/source activation, then read effective configuration and verify the source-bound runtime. A new code default alone does not replace an explicitly persisted value. Verify the selected Core application, domains and configuration are DEV-only before any runtime operation; shared/prod scope requires coordinator review.

Relevant sources: `packages/base/src/interfaces/api/AbstractModuleApi.ts` registers SystemConfig GET/PUT; `packages/core/src/modules/OcppRouter/src/module/DataApi.ts` supplies `/ocpprouter`; `packages/base/src/config/defineConfig.ts` provides supported environment merging; `apps/ocpp-server/src/config/config.loader.ts` selects persistent storage. No runtime configuration is changed by this PR.

Parent EVYAR/evyar#405; Core repair issue EVYAR/evyar#407 (Core owner repository disables issues). Validation includes cold-auth timeout, independent callers sharing valid OAuth, stalled/late body rejection, no callback after expiry, supported defaults and existing durable decline/fence tests.

## Build scope and memory

The Iran Dockerfile retains the same frozen dependency install and filtered `@citrineos/ocpp-server...` graph (base, core, server). Only that build command sets `NODE_OPTIONS=--max-old-space-size=2048` and `--workspace-concurrency=1`; runtime heap/environment, dependencies and versions are untouched. The runtime OCI revision still comes from the existing dynamic `COMMIT_SHA` build argument. A manual prebuild must supply the exact checkout SHA on that one command and attest the resulting label; do not persist a static revision build argument when restoring ordinary auto-deployment.

The OIDC provider also owns an independent fixed 8 s transport deadline across token fetch and both error/success body reads, with a final expiry check before updating its existing completed-token cache. Caller A's shorter authorization deadline only releases A's wait; it does not abort provider transport needed by caller B. Provider timeout leaves no late token cached. No new in-flight cache, refresh path, configuration key or financial approval cache is introduced.
