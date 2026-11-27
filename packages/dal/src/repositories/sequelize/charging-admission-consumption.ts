// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { ChargingAdmissionProvenance } from '@citrineos/types';
import type { Sequelize, Transaction } from 'sequelize';

/** Must run after the native row is saved and before its Start, in the same SQL transaction. */
export async function consumeChargingAdmission(
  db: Sequelize,
  transaction: Transaction,
  tenantId: number,
  stationId: number,
  connectorId: number | null | undefined,
  authorizationId: number | null | undefined,
  transactionDatabaseId: number,
  transactionCreatedAt: Date,
  provenance: ChargingAdmissionProvenance | undefined,
): Promise<void> {
  if (provenance === undefined) return;
  await db.query(
    `SELECT charging_admission_consume(
      :tenantId, :stationId, :connectorId, :authorizationId,
      :transactionDatabaseId, :transactionCreatedAt, CAST(:provenance AS jsonb))`,
    {
      transaction,
      replacements: {
        tenantId,
        stationId,
        connectorId: connectorId ?? null,
        authorizationId: authorizationId ?? null,
        transactionDatabaseId,
        transactionCreatedAt,
        provenance: JSON.stringify(provenance),
      },
    },
  );
}
