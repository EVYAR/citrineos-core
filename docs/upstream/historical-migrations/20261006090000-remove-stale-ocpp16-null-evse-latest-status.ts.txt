// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { QueryInterface } from 'sequelize';

/**
 * OCPP 1.6 connectors are auto-commissioned with one implicit EVSE each (EvseType id = connectorId).
 * Until now the StatusNotification saved for a connector's very first notification carried a null
 * evseId, while every later one carried the EVSE id. LatestStatusNotifications is keyed by
 * (evseId, connectorId), so that first pointer was never replaced and kept showing a stale status
 * (for example a permanent "Charging") next to the real, newer pointer.
 *
 * Remove a null-evseId pointer only when the same station and connector also has a pointer with an
 * evseId. A connector whose only pointer is the null one is left untouched. The StatusNotifications
 * history rows are not modified.
 */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.query(`
    DELETE FROM "LatestStatusNotifications" AS l
    USING "StatusNotifications" AS s
    WHERE s."id" = l."statusNotificationId"
      AND s."evseId" IS NULL
      AND EXISTS (
        SELECT 1
        FROM "LatestStatusNotifications" AS l2
        JOIN "StatusNotifications" AS s2 ON s2."id" = l2."statusNotificationId"
        WHERE l2."tenantId" = l."tenantId"
          AND l2."ocppConnectionName" = l."ocppConnectionName"
          AND s2."connectorId" = s."connectorId"
          AND s2."evseId" IS NOT NULL
      )
  `);
}

export async function down(): Promise<void> {
  // The removed pointers were stale duplicates; there is nothing meaningful to restore.
}
