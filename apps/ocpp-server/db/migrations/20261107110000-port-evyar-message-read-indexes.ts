// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { QueryInterface } from 'sequelize';

// Indexes target the partitioned parent; PostgreSQL creates matching partition indexes.
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.query(`
    CREATE INDEX IF NOT EXISTS "ocpp_messages_tenant_station_timestamp_idx"
      ON "OCPPMessages" ("tenantId", "stationId", "timestamp" DESC)
  `);

  await queryInterface.sequelize.query(`
    CREATE INDEX IF NOT EXISTS "ocpp_messages_tenant_station_action_origin_timestamp_idx"
      ON "OCPPMessages" (
        "tenantId",
        "stationId",
        "action",
        "origin",
        "timestamp" DESC
      )
  `);
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.query(`
    DROP INDEX IF EXISTS "ocpp_messages_tenant_station_action_origin_timestamp_idx"
  `);
  await queryInterface.sequelize.query(`
    DROP INDEX IF EXISTS "ocpp_messages_tenant_station_timestamp_idx"
  `);
}
