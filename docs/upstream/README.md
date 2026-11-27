# Stable upstream synchronization

The 2026-11-07 source update is prepared on local branch `chore/upstream-sync-20261107`. It is **held for review, not ready for deployment**.

| Component                | Selected stable                                    | Result                                                                                                                         |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Core                     | v2.1.0, `4fd7599b91c2fb6e6065e7c9b94be69880cced27` | Merged locally with EVYAR history in `4526860600d3a314bc123b7b8298112c96a0cf89`; custom behavior ported to active new packages |
| Separate OCPI repository | v2.0.1, `3ffcf6f589baea7865fcc8af12d8064acf719e58` | Already included in its dev branch; no upstream code merge or dependency change needed                                         |

Core now also contains an integrated OCPI library/server. This update does not switch the deployed standalone OCPI service to that implementation.

## EVYAR customizations retained

- **Charging authorization:** station/connector target evidence, domestic/RFID callouts, canonical tenant mapping, bounded OIDC/HTTP waits, durable admission and decline receipts.
- **Command delivery:** callback registration before dispatch, terminal outcomes, bounded retries and preservation of callbacks while a busy charger command is requeued.
- **Device state:** socket-bound status ordering, exact replay checks, connector-zero broadcast handling, atomic status/device effects and transaction/pool fixes. A new receipt ledger preserves these witnesses across upstream message partitioning.
- **Pricing:** IRR support, the more complete native tariff estimator, transaction tariff-ID pinning for OCPP 1.6 finalization, and the narrowly tenant-fenced CSMS final-cost role. These are operational Core estimates/writeback boundaries; CSMS billing ownership remains separate.
- **Operation and packaging:** queue draining/shutdown behavior, relevant TLS handling, internal image/npm mirrors, Dokploy packaging, source provenance and release governance.

The standalone OCPI audit separately identifies EVYAR station-ID/GraphQL compatibility adjustments, tariff-query cleanup, environment selection and packaging. Some retained credential/discovery fixes came from upstream after its stable tag; they are not EVYAR-only features.

See the [complete Core inventory](evyar-customizations-20261107.md) for all 124 fork-side commits, 162 changed paths, active entrypoints and remaining limitations.

## Tariff direction

This update does not redesign CSMS tariffs, packages or payment policies. Reusing Core's tariff field vocabulary is a reasonable next design step, but a stored field does not prove that every Core or OCPI calculation uses it. The EVYAR estimator is retained because stock Core's calculator is narrower; standalone OCPI still has pricing/export limitations. Group eligibility, quotas and payment collection remain product responsibilities outside a public connector tariff.

## Validation and remaining gates

OCPP and integrated OCPI service dependency builds passed with pinned pnpm 10.19.0 and host Node 24.22.2, sequentially with a 2 GiB Node heap. Scoped formatting passed. Original historical archives were verified byte-for-byte. No tests, application/device flows, database queries/migrations, deployment or publication ran.

Before merge/deployment:

1. Adapt the existing adapter and standalone OCPI queries, partition identity, status relationships, management endpoints and configuration to the new Core contracts.
2. Validate fresh installation and an offline upgrade/restore against backed-up database histories. The bridge requires stopped writers; an acknowledgement flag alone is not proof that writers stopped.
3. Port the archived custom regression assertions into executable coverage and perform authorized integration acceptance. Archived source is evidence of intent, not passing coverage.
4. Resolve the existing release-policy rejection of the upstream version adoption through reviewed upstream-release handling. The actual check currently exits 1; it was not disabled or bypassed.

No dev/prod branch, running app, live station or deployed database was changed by this task.
