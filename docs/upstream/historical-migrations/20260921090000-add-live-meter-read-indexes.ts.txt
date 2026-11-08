// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { QueryInterface } from 'sequelize';

/**
 * The CSMS live-session fallback first resolves a station-scoped transaction
 * and then reads that transaction's meter samples in timestamp order. Without
 * these composite indexes PostgreSQL scans and sorts the growing Core tables;
 * a five-row driver history page consequently waited four to five seconds on
 * every meter-summary read.
 *
 * Put tenantId first because Hasura's user role injects the tenant predicate
 * into both queries. CONCURRENTLY keeps charger ingestion available while the
 * indexes are built on an existing deployment.
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions_tenant_station_transaction_id_idx"
      ON "Transactions" ("tenantId", "ocppConnectionName", "transactionId", id DESC)
  `);

  await queryInterface.sequelize.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS "meter_values_tenant_transaction_timestamp_idx"
      ON "MeterValues" ("tenantId", "transactionDatabaseId", "timestamp", id)
  `);
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.query(`
    DROP INDEX CONCURRENTLY IF EXISTS "meter_values_tenant_transaction_timestamp_idx"
  `);

  await queryInterface.sequelize.query(`
    DROP INDEX CONCURRENTLY IF EXISTS "transactions_tenant_station_transaction_id_idx"
  `);
}
