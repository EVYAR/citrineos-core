# EVYAR monorepo application packaging

Source-only handoff, 2026-11-07. No images built or deployed by this task.

Keep the existing three Dokploy applications and domains. Change their repository to the reviewed Core monorepo commit, with repository-root build context `.`. Do not add replacement applications or delete standalone repositories/data before verified cutover.

| Existing application | Mirror Dockerfile                       | Public Dockerfile                    | Runtime                                                                     |
| -------------------- | --------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| OCPP                 | `apps/ocpp-server/deploy.Dockerfile.ir` | `apps/ocpp-server/deploy.Dockerfile` | Existing OCPP entrypoint; parent owns migration/config review               |
| OCPI                 | `apps/ocpi-server/deploy.Dockerfile.ir` | `apps/ocpi-server/deploy.Dockerfile` | `/usr/local/apps/citrineos/apps/ocpi-server/entrypoint.sh`, `dist/index.js` |
| Operator UI          | `apps/operator-ui/Dockerfile.ir`        | `apps/operator-ui/Dockerfile`        | `/app`, `node apps/operator-ui/server.js`, port 3000                        |

Mirror arguments: `NODE_IMAGE` (default `git.ev-yar.ir/evyar/node:24.16.0-alpine`) and `NPM_REGISTRY` (default `https://npm.ev-yar.ir/`). Both new mirror files use pinned pnpm 10.19.0, frozen workspace lockfile and bounded sequential package builds. No old package dependencies, GraphQL peer bypasses or vendor version rewrites. Pin approved base image digests in deployment evidence. Supply `COMMIT_SHA` as the full exact source SHA for all application images; inspect `org.opencontainers.image.revision` on built images and record immutable digests. This label is not a running deployment observation.

OCPI deploy copies pnpm's production artifact plus entrypoint and `.sequelizerc`; package build copies `src/assets` to `dist/assets`, and compiles migration/seed/config paths into dist. UI copies monorepo standalone output plus `.next/static` and `public`, and runs as nextjs. Native dependencies must be built for the image's libc/architecture; do not copy host dependencies.

## Configuration and startup

OCPI application and Sequelize bridge both select `APP_ENV ?? OCPI_ENV`, default local outside Docker. Entrypoint defaults docker and APP_NAME=ocpi and exports the selected environment for both migration and server. Explicit APP_ENV wins. `start:docker:cloud` uses this entrypoint without exposing the Node inspector. `DB_STRATEGY=migrate` is the backward-compatible default. Set `DB_STRATEGY=none` for independently managed startup after the parent runs the reviewed OCPI notification migrations manually. Unknown strategy fails closed. Seeds are never run by startup.

Supply runtime OCPI `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASS`, `GRAPHQL_ENDPOINT`, optional `REDIS_HOST`/`REDIS_PORT`, `AMQP_URL`, `AMQP_EXCHANGE`, and `COMMANDS_OCPI_BASE_URL` (public callback-reachable OCPI URL). Set `COMMANDS_CORE_HEADERS` as secret JSON if required, and configure each `COMMANDS_OCPP1_6_*`, `COMMANDS_OCPP2_0_1_*`, `COMMANDS_OCPP2_1_*` endpoint against the integrated `/ocpp/<version>` routes. Inspect `src/config/envs/docker.ts` and OCPI config schema for exact keys/defaults. OCPI listens on 8085 in the supplied Docker config. Never assume old standalone environment files map to the new schema. New migration `20261107185250-notify-transaction-partition-identity.ts` adds immutable createdAt/stationId to UPDATE notification identity; deploy it before the new OCPI server or updates without partition evidence will be withheld. Its down restores the prior function. Notification migrations install PG triggers/channels; PG-to-router-to-RabbitMQ subscriptions must be tested, not inferred from GraphQL compatibility.

UI Docker build arguments declare the NEXT_PUBLIC settings consumed by `src/lib/utils/config.ts`: API/WS/Core/file URLs, app/banner/logo/help, auth provider, tenant/Hasura claim, public admin email, public Keycloak URL, map IDs/center. They are public browser data, baked into bytes. Pass the actual existing app endpoints/branding; do not use production secrets or a public password argument. A different environment requires its own candidate image/digest. Map service API keys continue through server runtime routes.

UI server runtime secrets/settings: `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `OPERATOR_ADMIN_EMAIL` (or `ADMIN_EMAIL`), `OPERATOR_ADMIN_PASSWORD` (or `ADMIN_PASSWORD`), `KEYCLOAK_SERVER_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, storage credentials, map API keys. Generic auth still validates on the server. Prefer Keycloak for tenant/role tokens; never put a Hasura admin secret into browser build variables. Legacy NEXT_PUBLIC_ADMIN_PASSWORD is deliberately unsupported: migrate it to OPERATOR_ADMIN_PASSWORD. Application Dockerfile-specific ignore files exclude env files from the root context. Do not pass credentials through build args or embed them in commit metadata.

## Cutover gates and recovery

Parent owns install/build/test/container windows and all remote operations. Validate independent filtered builds, lint/typecheck/unit suites, both mirror images, runtime paths/assets and labels. In isolated services, validate fresh and upgrade OCPI migrations, notification subscription, credentials discovery/outbound token direction, numeric station lookup, duplicate partner identity fencing, all command callbacks, session/CDR ownership and amounts. Exercise UI login/role/tenant, provisioning/edit, ISO expiry, locked tariff detail and existing locales/branding without changing product design. No live SMS/stations or production access is authorized here.

Follow-up/acceptance coverage: destructive standalone cascades are excluded and station history deletion is blocked; OCPI wire session IDs still use potentially repeated OCPP transactionId (duplicate batch contexts now rejected); exact partition identity lookups require the new notification migration; current upstream contractual tariff calculations are retained. Preserve current contractual pricing in this upgrade; inherited export/cost limitations belong to platform issue 430. Do not substitute private retail Core.totalCost. Do not hide these behind schema-only checks or invent pricing/identity contracts.

Retain exact old standalone images/config and verified database backups. Parent inventories live Dokploy overrides, queued jobs, domains, secrets, volumes and networks; none were queried here. Roll back by restoring reviewed matching runtime/config/database artifacts according to parent migration plan; never point old apps at a migrated database on assumption. No deploy, migration, seed or remote change is performed by these instructions.

## Independent build identity

OCPI `dist/build-info.json` derives component name/version from its own package (3.1.0). UI `/build-info.json` derives from its own package (1.4.0). Both record the supplied common COMMIT_SHA; omitted SHA is explicitly null, and invalid nonempty SHAs fail the build. Release candidates must supply the full SHA and inspect these artifacts plus separate immutable image digests. The root workspace version does not label these apps. Parent owns equivalent OCPP 2.1.0 metadata.

The parent identifies existing dev UI as Dokploy EqVHZEl4vXWJVDFK1LpJM in TestWorkspace, Gitea source, domain operator-ui.dev.ev-yar.ir. Other app/Hasura inventory is in control/dokploy-inventory.json. This is supplied inventory, not a fresh remote observation.
