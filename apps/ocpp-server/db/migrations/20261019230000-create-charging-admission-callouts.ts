// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { QueryInterface } from 'sequelize';
import { DataTypes } from 'sequelize';

/**
 * CGP-0012: durable ledger of target-specific real-time authorization callouts. The primary key is the
 * `chargingCalloutRef` sent to the authorization authority. A request is PENDING until Core decides it:
 * AUTHORIZED, or DECLINED_BEFORE_POWER (committed before Core answers the charger; fences any late response).
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.createTable('ChargingAdmissionCallouts', {
    id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
    tenantId: { type: DataTypes.INTEGER, allowNull: false },
    ocppConnectionName: { type: DataTypes.STRING(255), allowNull: false },
    authorizationId: { type: DataTypes.INTEGER, allowNull: false },
    connectorId: { type: DataTypes.INTEGER, allowNull: false },
    state: { type: DataTypes.STRING(32), allowNull: false },
    requestedAt: { type: DataTypes.DATE, allowNull: false },
    decidedAt: { type: DataTypes.DATE, allowNull: true },
    coreEvidenceRef: { type: DataTypes.STRING(255), allowNull: true, unique: true },
    declineDeliveredAt: { type: DataTypes.DATE, allowNull: true },
    declineAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    nextDeclineAt: { type: DataTypes.DATE, allowNull: true },
    lastDeclineError: { type: DataTypes.STRING(500), allowNull: true },
    declineAbandoned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  await queryInterface.addIndex(
    'ChargingAdmissionCallouts',
    ['tenantId', 'ocppConnectionName', 'authorizationId', 'connectorId', 'requestedAt'],
    { name: 'ChargingAdmissionCallouts_request_idx' },
  );
  await queryInterface.sequelize.query(
    `CREATE INDEX "ChargingAdmissionCallouts_undelivered_idx" ON "ChargingAdmissionCallouts" ("nextDeclineAt")
     WHERE "state" = 'DECLINED_BEFORE_POWER' AND "declineDeliveredAt" IS NULL AND "declineAbandoned" = false`,
  );
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.dropTable('ChargingAdmissionCallouts');
}
