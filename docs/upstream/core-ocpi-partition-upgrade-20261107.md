# Coordinated Core/OCPI partition notifications

Core and OCPI use one Core database and its public `SequelizeMeta` ledger. Readiness preserves the full queried history and classifies both owners using exact source and compiled migration hashes. It never inserts aliases, renames old rows or assumes every ledger entry belongs to Core.

Core's upstream migration `20260818120000-partition-transactions.ts` replaces Transactions and five child tables. Its later upstream migration `20260924120000-restore-ocpi-notification-triggers.ts` already restores TransactionNotification and MeterValueNotification on the current partition parents when their OCPI functions exist. With a fresh Core database the functions do not yet exist; subsequent OCPI migrations create the normal bindings. No additional trigger-repair migration is needed. The earlier proposed duplicate was removed before dev/prod rollout; an append-only correction declaration records that removal.

The other historical OCPI bindings target ChargingStations, Tariffs, Evses, Locations and Connectors, which these partition migrations do not replace. Standard wire IDs and notification payloads remain unchanged. The separately added OCPI identity migration includes stationId and the exact createdAt in transaction updates so the subscriber can identify a partitioned row without guessing.

## Paired fixture

Run `apps/ocpp-server/test/runtime/core-ocpi-upgrade.cjs` only with a fresh parent-owned private grant and an explicit absolute `CORE_RUNTIME_OLD_OCPI_SOURCE` checkout containing commit `8326909087ed7c56f2d0d77cf5e29f09defa35f3`. Build current Core and OCPI artifacts first. The fixture uses normal sequelize-cli execution, unique owned database names/comments, quiescence checks and the existing ownership restrictions.

The fresh lane runs current Core then current OCPI. The upgrade lane first executes all 52 frozen Core migrations and seven byte-identical original OCPI migrations, then executes current Core and current OCPI. It verifies that upstream already restores current-parent bindings after Core upgrade, preserves every earlier ledger row, and leaves history unchanged on repeated CLI execution.

Actual LISTEN checks cover transaction INSERT/UPDATE, meter INSERT, exact tenant/station/transaction/createdAt identity, six-digit fractional seconds, equal numeric IDs in different partitions and tenants, and absence of duplicate notifications. Direct SQL cases exercise upstream restoration, repetition, down/up and its intentional skip when an optional OCPI function is absent. They do not rewrite the ledger. This is SQL and migration acceptance, separate from running subscribers and partner session/CDR delivery.

The private result records all full ledgers, trigger inventories, source/emitted hashes and notification witnesses. Failed attempts remain separate evidence. The nullable Connector.timestamp regression uses the separate current-DAL database lane. Old applied migration bodies remain unchanged. No live station, SMS, dev/prod data or deployment is part of these fixtures.
