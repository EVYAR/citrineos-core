// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { QueryInterface } from 'sequelize';

/**
 * OCPPMessages is append-only and can become one of Core's largest tables.
 * The operator/adapter read path scopes every query by tenant + station and
 * orders or bounds it by timestamp.  The previous single-column station
 * index still forced PostgreSQL to scan and sort a station's complete
 * history, which made recent status reads hit Hasura's statement timeout.
 *
 * CONCURRENTLY keeps charger message ingestion available while these indexes
 * are built on an existing deployment. sequelize-cli does not wrap migrations
 * in a transaction unless the migration explicitly creates one.
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS "ocpp_messages_tenant_station_timestamp_idx"
      ON "OCPPMessages" ("tenantId", "ocppConnectionName", "timestamp" DESC)
  `);

  await queryInterface.sequelize.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS "ocpp_messages_tenant_station_action_origin_timestamp_idx"
      ON "OCPPMessages" (
        "tenantId",
        "ocppConnectionName",
        "action",
        "origin",
        "timestamp" DESC
      )
  `);
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.query(`
    DROP INDEX CONCURRENTLY IF EXISTS "ocpp_messages_tenant_station_action_origin_timestamp_idx"
  `);
  await queryInterface.sequelize.query(`
    DROP INDEX CONCURRENTLY IF EXISTS "ocpp_messages_tenant_station_timestamp_idx"
  `);
}
