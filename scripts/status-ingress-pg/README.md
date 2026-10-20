# Canonical Core status PostgreSQL acceptance

Source only until root runs it. No Testcontainers, model sync, copied DDL or old task database is accepted. Use an explicit fresh `cgp_core_status_<16hex>` database and separate nonbypass application role on the exact existing task Postgis container. All canonical compiled migrations run through the normal Sequelize CLI; `SequelizeMeta` stores filenames, so the private receipt additionally binds each source/compiled migration SHA and a normal source-bound build proof.

Private input keys: `sourceCommit`, `externalContainer: evyar-cgp-postgis`, explicit `maintenanceUrl` targeting that container's `/postgres`, `databaseName`, fresh `receiptPath`, `cliConfigPath` and `buildProofPath`. Every file must use a dedicated `private-migration-*.json` name under canonical task control, be regular0600 and avoid symlinks. The build proof is copied privately from the actual normal Core build, never fabricated. Root keeps source clean and unchanged through DROP.

From owner root, under the coordinator's serial memory guard:

```
node --test scripts/status-ingress-pg/fixture.test.cjs
node scripts/status-ingress-pg/database.cjs create <private-input>
CGP_REQUIRE_CORE_STATUS_PG=1 CGP_CORE_STATUS_PG_RECEIPT=<private-receipt> node node_modules/vitest/vitest.mjs run packages/core/src/dal/test/layers/sequelize/repository/status-ingress.canonical.postgres.test.ts
node scripts/status-ingress-pg/database.cjs drop <same-private-input>
```

The real Sequelize model registry and production Location/OCPP repositories perform domain operations using the restricted role. Admin writes only seed fresh scoped canonical rows or temporarily revoke the fresh role's pointer INSERT to verify real transaction rollback, restoring exactly its original grant afterward. Historical status rows remain; the production repository removes only replaced latest pointers. Delayed retired receipts may retain true history but cannot alter live projections.

Cases cover original CALL ordering and reverse consumer completion, real concurrent transactions, both protocol versions, CALL/RESULT replay identity, divergent same-UID refusal, generation/protocol rejection, older observations, existing duplicate latest healing, connector-zero commissioned broadcast and actual database rollback. No station socket, physical charging, power stop or cross-owner acceptance is claimed. Proposed process RSS1024/heap512 with unchanged1536 reserve requires measured execution. No source change or forced connection kill is allowed before exact-owned cleanup. Partial create failures retain their ownership receipt; ambiguous/unmarked state fails closed and needs coordinator review.
