import type { QueryInterface } from 'sequelize';

/** Nullable additions preserve historical records; only new bound status CALLs use these keys. */
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE "ChargingStations" ADD COLUMN "statusIngressConnection" uuid NULL;
      ALTER TABLE "OCPPMessages" ADD COLUMN "statusIngressConnection" uuid NULL;
      CREATE UNIQUE INDEX "OCPPMessages_status_ingress_identity"
        ON "OCPPMessages" ("tenantId", "ocppConnectionName", "statusIngressConnection", "correlationId")
        WHERE "statusIngressConnection" IS NOT NULL;
      ALTER TABLE "StatusNotifications" ADD COLUMN "ingressMessageId" integer NULL
        REFERENCES "OCPPMessages" (id) ON DELETE RESTRICT;
      CREATE UNIQUE INDEX "StatusNotifications_ingress_identity"
        ON "StatusNotifications" ("ingressMessageId", "connectorId", (COALESCE("evseId", -1))) WHERE "ingressMessageId" IS NOT NULL;
    `, { transaction });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  // Removing a live ordering witness would permit stale replay. Roll back code
  // while retaining these nullable additive columns, or perform reviewed offline rollback.
  const [rows] = await queryInterface.sequelize.query(
    'SELECT 1 FROM "OCPPMessages" WHERE "statusIngressConnection" IS NOT NULL LIMIT 1',
  );
  if (rows.length) throw new Error('STATUS_INGRESS_ROLLBACK_REQUIRES_OFFLINE_REVIEW');
  await queryInterface.sequelize.query(`
    DROP INDEX "StatusNotifications_ingress_identity";
    ALTER TABLE "StatusNotifications" DROP COLUMN "ingressMessageId";
    DROP INDEX "OCPPMessages_status_ingress_identity";
    ALTER TABLE "OCPPMessages" DROP COLUMN "statusIngressConnection";
    ALTER TABLE "ChargingStations" DROP COLUMN "statusIngressConnection";
  `);
}
