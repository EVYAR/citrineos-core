# EVYAR Core upstream synchronization — 2026-11-07

## Frozen inventory before merge

Fork baseline: `af5f736f16e2c7390255b2e49d66769e41a7863f`. Origin dev: `af5f736f16e2c7390255b2e49d66769e41a7863f`; origin prod: `9d316092e1fa5cb3919222ac67a1a4cb500010ad`. Shared ancestor: `362adf1195349267fbbc98263f9cd14854ace499`. Selected stable: `v2.1.0`, `4fd7599b91c2fb6e6065e7c9b94be69880cced27`. Public tag and main verified using git ls-remote on 2026-11-07. No upstream remote configuration changed.

The following complete file inventory records actual net differences from the shared ancestor, including regression fixtures and reverted work only where it survives in the net diff. Commit subjects supply purpose and provenance; final path/disposition review follows below.

| Original fork path | Net change | Fork commits touching path (newest first) |
| --- | --- | --- |
| `.github/workflows/component-version-policy.yml` | A | 948a493d1 fix(ci): retain source metadata independently of artifact quota; 5b613a6e5 ci(release): run portable policy checks on hosted runners; bc8985c57 chore(release): adopt component version governance |
| `.github/workflows/license-check.yml` | M | a280b6694 ci: run GitHub Actions on evjex |
| `.github/workflows/lint.yml` | M | a280b6694 ci: run GitHub Actions on evjex |
| `.github/workflows/publish-swagger.yml` | M | a280b6694 ci: run GitHub Actions on evjex |
| `.github/workflows/push-release-tagged-ocpi.yml` | M | a280b6694 ci: run GitHub Actions on evjex |
| `.github/workflows/push-release-tagged-operator-ui.yml` | M | a280b6694 ci: run GitHub Actions on evjex |
| `.github/workflows/push-release-tagged-server.yml` | M | a280b6694 ci: run GitHub Actions on evjex |
| `.github/workflows/renew-certs.yml` | M | a280b6694 ci: run GitHub Actions on evjex |
| `.github/workflows/test-build-server.yml` | M | a280b6694 ci: run GitHub Actions on evjex |
| `.github/workflows/unit-tests.yml` | M | a280b6694 ci: run GitHub Actions on evjex |
| `.release/README.md` | A | 948a493d1 fix(ci): retain source metadata independently of artifact quota; e04b8c116 chore(release): clarify initial baseline policy; bc8985c57 chore(release): adopt component version governance |
| `.release/change-template.json` | A | bc8985c57 chore(release): adopt component version governance |
| `.release/changes/adopt-release-policy.json` | A | bc8985c57 chore(release): adopt component version governance |
| `.release/changes/cgp-charging-groups.json` | A | be43e5cf8 chore(release): record charging-group integration changes |
| `.release/changes/command-retry-callback-20261031.json` | A | bc3c398f0 fix: preserve callbacks while busy commands are requeued |
| `.release/changes/rfid-admission-deadline.json` | A | 6dde793aa fix: bound OIDC owner transport independently of callers; 9382194b8 fix: bound RFID authorization cold auth and response waits |
| `.release/component.json` | A | bc8985c57 chore(release): adopt component version governance |
| `.release/open-release.py` | A | bc8985c57 chore(release): adopt component version governance |
| `.release/release.py` | A | 3ca1702b6 fix(release): reject incomplete artifact evidence cleanly; bc8985c57 chore(release): adopt component version governance |
| `.release/tests/test_policy.py` | A | 3ca1702b6 fix(release): reject incomplete artifact evidence cleanly; bc8985c57 chore(release): adopt component version governance |
| `apps/ocpp-server/.env.dokploy.api.example` | A |  |
| `apps/ocpp-server/.env.dokploy.core.example` | A | 7c33b7899 fix(deploy): migrate OCPP server assets |
| `apps/ocpp-server/.env.dokploy.db.example` | A |  |
| `apps/ocpp-server/.env.dokploy.environment.example` | A |  |
| `apps/ocpp-server/.env.dokploy.everest.example` | A | 7c33b7899 fix(deploy): migrate OCPP server assets |
| `apps/ocpp-server/.env.dokploy.everest.manager.example` | A |  |
| `apps/ocpp-server/.env.dokploy.everest.mqtt.example` | A |  |
| `apps/ocpp-server/.env.dokploy.everest.nodered.example` | A |  |
| `apps/ocpp-server/.env.dokploy.file.example` | A |  |
| `apps/ocpp-server/.env.dokploy.project.example` | A |  |
| `apps/ocpp-server/.env.dokploy.rabbitmq.example` | A |  |
| `apps/ocpp-server/.env.dokploy.redis.example` | A |  |
| `apps/ocpp-server/deploy.Dockerfile.ir` | A | 9382194b8 fix: bound RFID authorization cold auth and response waits; d78a9fb45 fix(config): accept canonical tenant GUIDs for charging callouts; 318f4e56b build: use npm.ev-yar.ir registry in Dockerfile.ir; 7c33b7899 fix(deploy): migrate OCPP server assets |
| `apps/ocpp-server/docker-compose.dokploy-api.yml` | A |  |
| `apps/ocpp-server/docker-compose.dokploy-core.yml` | A | 7c33b7899 fix(deploy): migrate OCPP server assets |
| `apps/ocpp-server/docker-compose.dokploy-db.yml` | A |  |
| `apps/ocpp-server/docker-compose.dokploy-everest.yml` | A |  |
| `apps/ocpp-server/docker-compose.dokploy-file.yml` | A |  |
| `apps/ocpp-server/docker-compose.dokploy-infra.yml` | A |  |
| `apps/ocpp-server/docker-compose.dokploy-rabbitmq.yml` | A |  |
| `apps/ocpp-server/docker-compose.dokploy-redis.yml` | A |  |
| `apps/ocpp-server/docker-compose.yml` | A |  |
| `apps/ocpp-server/everest/Dockerfile` | M |  |
| `apps/ocpp-server/everest/README.md` | M | 7c33b7899 fix(deploy): migrate OCPP server assets |
| `apps/ocpp-server/everest/docker-compose.yml` | M |  |
| `apps/ocpp-server/everest/start.sh` | M |  |
| `apps/ocpp-server/hasura-metadata/databases/default/tables/public_Transactions.yaml` | M | 174260e3f feat(charging): grant tenant-fenced final-cost service role |
| `apps/ocpp-server/hasura.Dockerfile` | A |  |
| `apps/ocpp-server/hasura.Dockerfile.ir` | A |  |
| `apps/ocpp-server/migrations/20260921080000-add-ocpp-message-read-indexes.ts` | A | 94401cbba fix(db): index OCPP message history reads |
| `apps/ocpp-server/migrations/20261006090000-remove-stale-ocpp16-null-evse-latest-status.ts` | A | 0062d4a3d fix(ocpp1.6): store the implicit EVSE id on a connector's first StatusNotification |
| `apps/ocpp-server/migrations/20261019230000-create-charging-admission-callouts.ts` | A | 7a845e05d feat(authorizer): durable decline-before-power ledger and receipt producer for target-specific callouts |
| `apps/ocpp-server/migrations/20261020210000-bind-status-ingress.ts` | A | 04dc00402 fix(core): fence registration and apply broadcast and device effects by original receipt; 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically |
| `apps/ocpp-server/package.json` | M |  |
| `apps/ocpp-server/src/citrineOSServer.shutdown.test.ts` | A | 48ee588d8 fix: prevent Rabbit reconnect after intentional shutdown; 800be7a3b fix: stop Rabbit consumers before Core shutdown |
| `apps/ocpp-server/src/citrineOSServer.ts` | M | 48ee588d8 fix: prevent Rabbit reconnect after intentional shutdown; 800be7a3b fix: stop Rabbit consumers before Core shutdown |
| `apps/ocpp-server/src/container.ts` | M | 7a845e05d feat(authorizer): durable decline-before-power ledger and receipt producer for target-specific callouts |
| `apps/ocpp-server/test/hasura-final-cost-permissions.test.ts` | A | 174260e3f feat(charging): grant tenant-fenced final-cost service role |
| `docs/architecture/status-ingress-order.md` | A | f96ae42d2 docs(core): record implemented status ordering and required evidence boundaries; f00c4f87d design(core): specify durable status ingress and bounded order queue |
| `docs/csms-final-cost-hasura-role.md` | A | 174260e3f feat(charging): grant tenant-fenced final-cost service role |
| `docs/operations/rfid-admission-deadline.md` | A | 6dde793aa fix: bound OIDC owner transport independently of callers; 9382194b8 fix: bound RFID authorization cold auth and response waits |
| `docs/repository-transaction-update.md` | A | 64a6301d1 fix(core): retain caller transaction during repository row updates |
| `docs/station-hook-transactions.md` | A | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/base/src/config/types.ts` | M | 9382194b8 fix: bound RFID authorization cold auth and response waits; d78a9fb45 fix(config): accept canonical tenant GUIDs for charging callouts; 7a845e05d feat(authorizer): durable decline-before-power ledger and receipt producer for target-specific callouts; 932959a2e feat(authorizer): carry explicit start target evidence, bound and optionally never replay real-time authorization |
| `packages/base/src/interfaces/cache/types.ts` | M | 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically |
| `packages/base/src/interfaces/dto/ocpp.message.dto.ts` | M | 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically |
| `packages/base/src/interfaces/dto/status.notification.dto.ts` | M | 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically |
| `packages/base/src/interfaces/dto/types/authorization.ts` | M | 1a20cddf0 fix(authorizer): support station scoped realtime auth |
| `packages/base/src/interfaces/messages/MessageContext.ts` | M | 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically |
| `packages/base/src/interfaces/modules/AbstractModule.ts` | M | 83e1edd67 fix(core): complete command callback outcomes; f860043a3 fix(callbacks): prevent lost command results (#2) |
| `packages/base/src/interfaces/router/Router.ts` | M | 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically |
| `packages/base/src/money/Currency.ts` | M | f6b279ba1 fix: support IRR and scope OCPP correlations |
| `packages/base/test/config/ChargingCalloutTenantMap.test.ts` | A | d78a9fb45 fix(config): accept canonical tenant GUIDs for charging callouts |
| `packages/base/test/config/RealTimeAdmissionBudget.test.ts` | A | 9382194b8 fix: bound RFID authorization cold auth and response waits |
| `packages/base/test/modules/AbstractModule.test.ts` | A | 83e1edd67 fix(core): complete command callback outcomes |
| `packages/base/test/money/Currency.test.ts` | M | f6b279ba1 fix: support IRR and scope OCPP correlations |
| `packages/base/test/money/Money.test.ts` | M | f6b279ba1 fix: support IRR and scope OCPP correlations |
| `packages/core/src/dal/interfaces/repositories.ts` | M | 04dc00402 fix(core): fence registration and apply broadcast and device effects by original receipt; 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically; 72a8cea39 fix: share the transaction connection during OCPP starts |
| `packages/core/src/dal/layers/sequelize/index.ts` | M | 7a845e05d feat(authorizer): durable decline-before-power ledger and receipt producer for target-specific callouts |
| `packages/core/src/dal/layers/sequelize/model/Certificate/DeleteCertificateAttempt.ts` | M | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/layers/sequelize/model/Certificate/InstallCertificateAttempt.ts` | M | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/layers/sequelize/model/Certificate/InstalledCertificate.ts` | M | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/layers/sequelize/model/ChargingAdmissionCallout.ts` | A | 7a845e05d feat(authorizer): durable decline-before-power ledger and receipt producer for target-specific callouts |
| `packages/core/src/dal/layers/sequelize/model/ChargingStationSecurityInfo.ts` | M | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/layers/sequelize/model/ChargingStationSequence/ChargingStationSequence.ts` | M | 72a8cea39 fix: share the transaction connection during OCPP starts |
| `packages/core/src/dal/layers/sequelize/model/DeviceModel/VariableAttribute.ts` | M | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/layers/sequelize/model/Location/ChargingStation.ts` | M | 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically |
| `packages/core/src/dal/layers/sequelize/model/Location/ChargingStationNetworkProfile.ts` | M | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/layers/sequelize/model/Location/Connector.ts` | M | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/layers/sequelize/model/Location/Evse.ts` | M | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/layers/sequelize/model/Location/LatestStatusNotification.ts` | M | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/layers/sequelize/model/Location/SetNetworkProfile.ts` | M | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/layers/sequelize/model/Location/StatusNotification.ts` | M | 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically; da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/layers/sequelize/model/OCPPMessage.ts` | M | 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically; da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/layers/sequelize/model/TransactionEvent/Transaction.ts` | M | 72a8cea39 fix: share the transaction connection during OCPP starts |
| `packages/core/src/dal/layers/sequelize/model/VariableMonitoring/EventData.ts` | M | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/layers/sequelize/model/VariableMonitoring/VariableMonitoring.ts` | M | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/layers/sequelize/model/index.ts` | M | 7a845e05d feat(authorizer): durable decline-before-power ledger and receipt producer for target-specific callouts |
| `packages/core/src/dal/layers/sequelize/repository/Base.ts` | M | 64a6301d1 fix(core): retain caller transaction during repository row updates |
| `packages/core/src/dal/layers/sequelize/repository/ChangeConfiguration.ts` | M | f9b5526b2 fix: refresh repeated charger configuration observations |
| `packages/core/src/dal/layers/sequelize/repository/ChargingStationSequence.ts` | M | 72a8cea39 fix: share the transaction connection during OCPP starts |
| `packages/core/src/dal/layers/sequelize/repository/Location.ts` | M | b9d881fbb fix(core): respect persisted text message states without changing numeric wire DTOs; 71ee1909a fix(core): exclude the station broadcast address from physical targets; 04dc00402 fix(core): fence registration and apply broadcast and device effects by original receipt; 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically |
| `packages/core/src/dal/layers/sequelize/repository/OCPPMessage.ts` | M | b9d881fbb fix(core): respect persisted text message states without changing numeric wire DTOs; 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically; f6b279ba1 fix: support IRR and scope OCPP correlations |
| `packages/core/src/dal/layers/sequelize/repository/TransactionEvent.ts` | M | 72a8cea39 fix: share the transaction connection during OCPP starts |
| `packages/core/src/dal/layers/sequelize/repository/status-ingress-order.ts` | A | 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically |
| `packages/core/src/dal/layers/sequelize/util.ts` | M | 7a845e05d feat(authorizer): durable decline-before-power ledger and receipt producer for target-specific callouts |
| `packages/core/src/dal/test/layers/sequelize/repository/Base.transaction.pool.test.ts` | A | a245c290a style(core): format repository transaction regressions; 64a6301d1 fix(core): retain caller transaction during repository row updates |
| `packages/core/src/dal/test/layers/sequelize/repository/ChangeConfiguration.freshness.test.ts` | A | f9b5526b2 fix: refresh repeated charger configuration observations |
| `packages/core/src/dal/test/layers/sequelize/repository/ChargingStationSequence.test.ts` | M | 72a8cea39 fix: share the transaction connection during OCPP starts |
| `packages/core/src/dal/test/layers/sequelize/repository/StationHooks.pool.test.ts` | A | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/test/layers/sequelize/repository/StationHooks.transaction.test.ts` | A | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/test/layers/sequelize/repository/Transaction.pool.test.ts` | A | 72a8cea39 fix: share the transaction connection during OCPP starts |
| `packages/core/src/dal/test/layers/sequelize/repository/station-hook-models.ts` | A | da484b38b fix(core): preserve transaction in station resolution hooks |
| `packages/core/src/dal/test/layers/sequelize/repository/status-ingress-order.test.ts` | A | 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically |
| `packages/core/src/dal/test/layers/sequelize/repository/status-ingress-receipt.test.ts` | A | b9d881fbb fix(core): respect persisted text message states without changing numeric wire DTOs; d0fb86b4d test(core): prove exact receipt replay and socket reuse isolation |
| `packages/core/src/dal/test/layers/sequelize/repository/status-ingress-transaction.test.ts` | A | b9d881fbb fix(core): respect persisted text message states without changing numeric wire DTOs; 73a1499ec test(core): keep connector zero as one original broadcast fact; 83ec27294 test(core): cover partial broadcast wins and whole-receipt replay; e8f03548d test(core): bind protocol and availability writes to the winning transaction; 04dc00402 fix(core): fence registration and apply broadcast and device effects by original receipt; e8508ccca test(core): cover reversed status completion and immutable replay transactions |
| `packages/core/src/dal/test/layers/sequelize/repository/status-ingress.canonical.postgres.test.ts` | A | b9d881fbb fix(core): respect persisted text message states without changing numeric wire DTOs; cd3893aa8 test(core): load canonical status repositories through native built modules; 4549ee715 test(core): bind broadcast fixture to explicit station opt-in; de0579ec1 test(core): add owned canonical PostgreSQL status race acceptance |
| `packages/core/src/modules/OcppRouter/src/module/DataApi.ts` | M | f6b279ba1 fix: support IRR and scope OCPP correlations |
| `packages/core/src/modules/OcppRouter/src/module/router.ts` | M | bc3c398f0 fix: preserve callbacks while busy commands are requeued; 04dc00402 fix(core): fence registration and apply broadcast and device effects by original receipt; 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically; 6d5963026 fix: register allowed unknown stations before OCPP persistence; 8bbae5c98 fix(ocpp-router): serialize connection-status writes to close a rapid disconnect/reconnect race; 83e1edd67 fix(core): complete command callback outcomes |
| `packages/core/src/modules/OcppRouter/src/module/status-ingress-queue.ts` | A | f00c4f87d design(core): specify durable status ingress and bounded order queue |
| `packages/core/src/modules/OcppRouter/src/module/webhook.dispatcher.ts` | M | b9d881fbb fix(core): respect persisted text message states without changing numeric wire DTOs; 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically; 6a4982b09 fix: keep subscription refresh task void typed; 6d5963026 fix: register allowed unknown stations before OCPP persistence; 83e1edd67 fix(core): complete command callback outcomes; f860043a3 fix(callbacks): prevent lost command results (#2) |
| `packages/core/src/modules/OcppRouter/test/module/MessageRouterImpl.test.ts` | M | bc3c398f0 fix: preserve callbacks while busy commands are requeued; 6d5963026 fix: register allowed unknown stations before OCPP persistence; 8bbae5c98 fix(ocpp-router): serialize connection-status writes to close a rapid disconnect/reconnect race; 83e1edd67 fix(core): complete command callback outcomes |
| `packages/core/src/modules/OcppRouter/test/module/WebhookDispatcher.test.ts` | M | 6d5963026 fix: register allowed unknown stations before OCPP persistence; 83e1edd67 fix(core): complete command callback outcomes; f860043a3 fix(callbacks): prevent lost command results (#2) |
| `packages/core/src/modules/OcppRouter/test/module/status-ingress-queue.test.ts` | A | f00c4f87d design(core): specify durable status ingress and bounded order queue |
| `packages/core/src/modules/Transactions/src/module/CostCalculator.ts` | M | 628856a82 feat(transactions): calculate full native tariff estimate; dc358a96d fix(transactions): price OCPP 1.6 stops |
| `packages/core/src/modules/Transactions/src/module/CostNotifier.ts` | M | 628856a82 feat(transactions): calculate full native tariff estimate |
| `packages/core/src/modules/Transactions/src/module/StatusNotificationService.ts` | M | 04dc00402 fix(core): fence registration and apply broadcast and device effects by original receipt; e8508ccca test(core): cover reversed status completion and immutable replay transactions; 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically; 0062d4a3d fix(ocpp1.6): store the implicit EVSE id on a connector's first StatusNotification |
| `packages/core/src/modules/Transactions/src/module/TransactionService.ts` | M | f62028562 fix(transactions): apply one concurrentTransaction polarity to OCPP 1.6, 2.0.1 and 2.1 |
| `packages/core/src/modules/Transactions/src/module/module.ts` | M | 04dc00402 fix(core): fence registration and apply broadcast and device effects by original receipt; 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically; 628856a82 feat(transactions): calculate full native tariff estimate; dc358a96d fix(transactions): price OCPP 1.6 stops |
| `packages/core/src/modules/Transactions/test/module/CostCalculator.test.ts` | M | 628856a82 feat(transactions): calculate full native tariff estimate; dc358a96d fix(transactions): price OCPP 1.6 stops |
| `packages/core/src/modules/Transactions/test/module/StatusNotificationService.test.ts` | M | 0062d4a3d fix(ocpp1.6): store the implicit EVSE id on a connector's first StatusNotification |
| `packages/core/src/modules/Transactions/test/module/TransactionService.test.ts` | M | f62028562 fix(transactions): apply one concurrentTransaction polarity to OCPP 1.6, 2.0.1 and 2.1 |
| `packages/core/src/modules/Transactions/test/providers/Tariff.ts` | M | 628856a82 feat(transactions): calculate full native tariff estimate |
| `packages/core/src/util/authorization/OidcTokenProvider.ts` | M | 6dde793aa fix: bound OIDC owner transport independently of callers |
| `packages/core/src/util/authorizer/ChargingCalloutDeclineNotifier.ts` | A | a8f995cd7 fix: cancel decline delivery during shutdown without spending retries; 48ee588d8 fix: prevent Rabbit reconnect after intentional shutdown; 717c426d7 fix(authorizer): require confirmed decline fencing before delivery acknowledgment; 7a845e05d feat(authorizer): durable decline-before-power ledger and receipt producer for target-specific callouts |
| `packages/core/src/util/authorizer/ChargingCalloutLedger.ts` | A | 7a845e05d feat(authorizer): durable decline-before-power ledger and receipt producer for target-specific callouts |
| `packages/core/src/util/authorizer/RealTimeAuthorizer.ts` | M | 9382194b8 fix: bound RFID authorization cold auth and response waits; df23c3048 fix(core): await authorization attempt persistence before handler completes; 48ee588d8 fix: prevent Rabbit reconnect after intentional shutdown; a53cc2039 fix(auth): keep unresolved explicit charging targets failed closed; 5ab07e51e style(auth): format live authorization and durable callout regressions; 397827040 fix(auth): require live fenced decisions for explicit charging starts; bba2eb677 style(authorizer): remove trailing blank line; 7a845e05d feat(authorizer): durable decline-before-power ledger and receipt producer for target-specific callouts; 932959a2e feat(authorizer): carry explicit start target evidence, bound and optionally never replay real-time authorization; 1a20cddf0 fix(authorizer): support station scoped realtime auth |
| `packages/core/src/util/authorizer/SequelizeChargingCalloutStore.ts` | A | 7a845e05d feat(authorizer): durable decline-before-power ledger and receipt producer for target-specific callouts |
| `packages/core/src/util/authorizer/index.ts` | M | 7a845e05d feat(authorizer): durable decline-before-power ledger and receipt producer for target-specific callouts |
| `packages/core/src/util/cache/memory.ts` | M | 6d5963026 fix: register allowed unknown stations before OCPP persistence |
| `packages/core/src/util/networkconnection/WebsocketNetworkConnection.ts` | M | 0a18001e0 fix(core): persist socket-bound status order before fanout and project atomically; 9f4f99436 fix(core): report safe connection registration error categories; 2d71bc11f fix(tls): fall back to local disk for mTLS CA cert when not in file storage |
| `packages/core/src/util/networkconnection/connection-error-category.test.ts` | A | a148db976 fix(core): keep connection error diagnostics safe against throwing accessors; 9f4f99436 fix(core): report safe connection registration error categories |
| `packages/core/src/util/networkconnection/connection-error-category.ts` | A | a148db976 fix(core): keep connection error diagnostics safe against throwing accessors; 9f4f99436 fix(core): report safe connection registration error categories |
| `packages/core/src/util/queue/rabbit-mq/ConnectionManager.ts` | M | 48ee588d8 fix: prevent Rabbit reconnect after intentional shutdown |
| `packages/core/src/util/queue/rabbit-mq/receiver.ts` | M | 53308fc61 fix(core): drain in-flight RabbitMQ deliveries before shutdown; 800be7a3b fix: stop Rabbit consumers before Core shutdown |
| `packages/core/src/util/test/authorization/OidcTokenProvider.test.ts` | A | 6dde793aa fix: bound OIDC owner transport independently of callers |
| `packages/core/src/util/test/authorizer/ChargingCalloutDeclineNotifier.test.ts` | A | a8f995cd7 fix: cancel decline delivery during shutdown without spending retries; 48ee588d8 fix: prevent Rabbit reconnect after intentional shutdown; 717c426d7 fix(authorizer): require confirmed decline fencing before delivery acknowledgment; 7a845e05d feat(authorizer): durable decline-before-power ledger and receipt producer for target-specific callouts |
| `packages/core/src/util/test/authorizer/ChargingCalloutStore.contract.test.ts` | A | 7044c7c0e test(authorizer): run actual callout migration against disposable PostgreSQL; 7a845e05d feat(authorizer): durable decline-before-power ledger and receipt producer for target-specific callouts |
| `packages/core/src/util/test/authorizer/RealTimeAuthorizer.chargingCallouts.test.ts` | A | 6dde793aa fix: bound OIDC owner transport independently of callers; 9382194b8 fix: bound RFID authorization cold auth and response waits; a53cc2039 fix(auth): keep unresolved explicit charging targets failed closed; 5ab07e51e style(auth): format live authorization and durable callout regressions; 397827040 fix(auth): require live fenced decisions for explicit charging starts; 7a845e05d feat(authorizer): durable decline-before-power ledger and receipt producer for target-specific callouts |
| `packages/core/src/util/test/authorizer/RealTimeAuthorizer.test.ts` | M | df23c3048 fix(core): await authorization attempt persistence before handler completes; 932959a2e feat(authorizer): carry explicit start target evidence, bound and optionally never replay real-time authorization; 1a20cddf0 fix(authorizer): support station scoped realtime auth |
| `packages/core/src/util/test/queue/rabbit-mq/ConnectionManager.test.ts` | A | 48ee588d8 fix: prevent Rabbit reconnect after intentional shutdown |
| `packages/core/src/util/test/queue/rabbit-mq/receiver-drain.test.ts` | A | 53308fc61 fix(core): drain in-flight RabbitMQ deliveries before shutdown |
| `packages/core/src/util/test/queue/rabbit-mq/receiver.test.ts` | M | 800be7a3b fix: stop Rabbit consumers before Core shutdown |
| `scripts/status-ingress-pg/README.md` | A | cd3893aa8 test(core): load canonical status repositories through native built modules; a6a837a6c test(core): provision and bind fresh PostGIS infrastructure before migrations; de0579ec1 test(core): add owned canonical PostgreSQL status race acceptance |
| `scripts/status-ingress-pg/built.cjs` | A | cd3893aa8 test(core): load canonical status repositories through native built modules |
| `scripts/status-ingress-pg/built.test.cjs` | A | cd3893aa8 test(core): load canonical status repositories through native built modules |
| `scripts/status-ingress-pg/database.cjs` | A | a6a837a6c test(core): provision and bind fresh PostGIS infrastructure before migrations; 1823a7a1e test(core): pin canonical migration CLI environment explicitly; c3a80a2a0 test(core): exclude filename-only metadata from serial sequence grants; de0579ec1 test(core): add owned canonical PostgreSQL status race acceptance |
| `scripts/status-ingress-pg/fixture.cjs` | A | a6a837a6c test(core): provision and bind fresh PostGIS infrastructure before migrations; cdbd540d1 test(core): bind fixture endpoints and build proof to private input; de0579ec1 test(core): add owned canonical PostgreSQL status race acceptance |
| `scripts/status-ingress-pg/fixture.test.cjs` | A | a6a837a6c test(core): provision and bind fresh PostGIS infrastructure before migrations; de0579ec1 test(core): add owned canonical PostgreSQL status race acceptance |
| `scripts/status-ingress-pg/lifecycle-safety.cjs` | A | de0579ec1 test(core): add owned canonical PostgreSQL status race acceptance |
| `scripts/status-ingress-pg/private-path.cjs` | A | de0579ec1 test(core): add owned canonical PostgreSQL status race acceptance |
| `vitest.config.ts` | M | 628856a82 feat(transactions): calculate full native tariff estimate |

## Validation boundary

Source-only synchronization. No tests, dependency installation, builds, services, containers, migrations, live API calls, deployment, publishing or push are authorized/run. Pricing redesign is excluded. Runtime and database compatibility require later owner validation.
