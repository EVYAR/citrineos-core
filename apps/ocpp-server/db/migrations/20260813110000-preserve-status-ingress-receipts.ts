// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { QueryInterface } from 'sequelize';

// Runs before upstream's partition swap: the durable witness must outlive message retention.
export async function up(queryInterface: QueryInterface): Promise<void> {
  if (process.env.EVYAR_STATUS_INGRESS_OFFLINE_CUTOVER !== 'acknowledged') {
    throw new Error(
      'Stop all writers, drain deliveries and verify backups before acknowledging EVYAR_STATUS_INGRESS_OFFLINE_CUTOVER',
    );
  }
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(
      `
      CREATE TABLE IF NOT EXISTS "StatusIngressReceipts" (
        id serial PRIMARY KEY,
        "tenantId" integer NOT NULL REFERENCES "Tenants"(id) ON DELETE RESTRICT,
        "stationId" integer NOT NULL REFERENCES "ChargingStations"(id) ON DELETE RESTRICT,
        connection uuid NOT NULL,
        "correlationId" varchar(255) NOT NULL,
        protocol varchar(255) NOT NULL,
        frame jsonb NOT NULL,
        timestamp timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("tenantId", "stationId", connection, "correlationId")
      );
      ALTER TABLE "ChargingStations" ADD COLUMN IF NOT EXISTS "statusIngressConnection" uuid NULL;
      ALTER TABLE "StatusNotifications" ADD COLUMN IF NOT EXISTS "ingressMessageId" integer NULL;
      DO $bridge$
      DECLARE fk record;
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                   AND table_name='OCPPMessages' AND column_name='statusIngressConnection') THEN
          IF EXISTS (
            SELECT 1 FROM "OCPPMessages" m LEFT JOIN "ChargingStations" s
              ON s.id=m."stationId" AND s."tenantId"=m."tenantId"
            WHERE m."statusIngressConnection" IS NOT NULL AND (
              s.id IS NULL OR m."correlationId" IS NULL OR m.protocol IS NULL OR m.timestamp IS NULL
              OR m.message IS NULL OR jsonb_typeof(m.message) IS DISTINCT FROM 'array'
              OR m.message->>0 IS DISTINCT FROM '2' OR m.message->>1 IS DISTINCT FROM m."correlationId"
              OR m.message->>2 IS DISTINCT FROM 'StatusNotification' OR m.origin IS DISTINCT FROM 'cs'
              OR m.action IS DISTINCT FROM 'StatusNotification' OR m.state::text IS DISTINCT FROM '1'
            )
          ) THEN RAISE EXCEPTION 'STATUS_INGRESS_INVALID_SOURCE_ROWS'; END IF;
          IF EXISTS (
            SELECT 1 FROM "OCPPMessages" m WHERE m."statusIngressConnection" IS NOT NULL
            GROUP BY m."tenantId",m."stationId",m."statusIngressConnection",m."correlationId" HAVING count(*)>1
          ) THEN RAISE EXCEPTION 'STATUS_INGRESS_DUPLICATE_SOURCE_IDENTITY'; END IF;
          IF EXISTS (
            SELECT 1 FROM "OCPPMessages" m JOIN "StatusIngressReceipts" r ON r.id=m.id
            WHERE m."statusIngressConnection" IS NOT NULL AND (
              r."tenantId" IS DISTINCT FROM m."tenantId" OR r."stationId" IS DISTINCT FROM m."stationId"
              OR r.connection IS DISTINCT FROM m."statusIngressConnection"
              OR r."correlationId" IS DISTINCT FROM m."correlationId" OR r.protocol IS DISTINCT FROM m.protocol
              OR r.frame IS DISTINCT FROM m.message OR r.timestamp IS DISTINCT FROM m.timestamp
            )
          ) THEN RAISE EXCEPTION 'STATUS_INGRESS_RECEIPT_ID_CONFLICT'; END IF;
          INSERT INTO "StatusIngressReceipts"
            (id,"tenantId","stationId",connection,"correlationId",protocol,frame,timestamp,"createdAt","updatedAt")
          SELECT m.id,m."tenantId",m."stationId",m."statusIngressConnection",m."correlationId",
                 m.protocol,m.message,m.timestamp,m."createdAt",m."updatedAt"
          FROM "OCPPMessages" m WHERE m."statusIngressConnection" IS NOT NULL
          ON CONFLICT (id) DO NOTHING;
        END IF;
        IF EXISTS (
          SELECT 1 FROM "StatusNotifications" sn LEFT JOIN "StatusIngressReceipts" r ON r.id=sn."ingressMessageId"
          WHERE sn."ingressMessageId" IS NOT NULL AND
            (r.id IS NULL OR sn."tenantId" IS DISTINCT FROM r."tenantId" OR sn."stationId" IS DISTINCT FROM r."stationId")
        ) THEN RAISE EXCEPTION 'STATUS_INGRESS_MISSING_OR_CROSS_TENANT_WITNESS'; END IF;
        FOR fk IN SELECT DISTINCT c.conname FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
          WHERE c.conrelid='"StatusNotifications"'::regclass AND c.contype='f'
            AND a.attname='ingressMessageId'
        LOOP
          EXECUTE format('ALTER TABLE "StatusNotifications" DROP CONSTRAINT %I',fk.conname);
        END LOOP;
      END $bridge$;
      SELECT setval(pg_get_serial_sequence('"StatusIngressReceipts"','id'),
                    GREATEST(COALESCE((SELECT max(id) FROM "StatusIngressReceipts"),0),1),
                    EXISTS(SELECT 1 FROM "StatusIngressReceipts"));
      ALTER TABLE "StatusNotifications" ADD CONSTRAINT "StatusNotifications_ingress_receipt_fkey"
        FOREIGN KEY ("ingressMessageId") REFERENCES "StatusIngressReceipts"(id) ON DELETE RESTRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS "StatusNotifications_ingress_identity"
        ON "StatusNotifications" ("ingressMessageId", "connectorId", (COALESCE("evseId", -1)))
        WHERE "ingressMessageId" IS NOT NULL;
    `,
      { transaction },
    );
  });
}

export async function down(): Promise<void> {
  throw new Error('STATUS_INGRESS_ROLLBACK_REQUIRES_OFFLINE_REVIEW');
}
