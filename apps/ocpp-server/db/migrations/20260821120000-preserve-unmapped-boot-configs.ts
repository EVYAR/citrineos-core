// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import type { QueryInterface } from 'sequelize';

const migration = '20260821120000-preserve-unmapped-boot-configs';

export default {
  async up(queryInterface: QueryInterface): Promise<void> {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `SET LOCAL TIME ZONE 'UTC';
        LOCK TABLE "Boots", "ChargingStations", "VariableAttributes" IN SHARE ROW EXCLUSIVE MODE;
        DO $archive$
        DECLARE
          columns_sql text;
          schema_json jsonb;
          reference record;
          join_sql text;
          referenced boolean;
          moved bigint;
          removed bigint;
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='"Boots"'::regclass
                     AND attname='id' AND atttypid='integer'::regtype AND NOT attisdropped) THEN
            IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='"Boots"'::regclass
                           AND attname='stationId' AND attnotnull AND NOT attisdropped) THEN
              RAISE EXCEPTION 'BOOT_ARCHIVE_UNEXPECTED_SCHEMA';
            END IF;
            RETURN;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='"Boots"'::regclass
                         AND attname='id' AND atttypid='varchar'::regtype AND NOT attisdropped)
             OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='"Boots"'::regclass
                        AND attname LIKE '\\_bootArchive%' ESCAPE '\\' AND NOT attisdropped) THEN
            RAISE EXCEPTION 'BOOT_ARCHIVE_UNEXPECTED_SCHEMA';
          END IF;
          IF EXISTS (SELECT 1 FROM "Boots" b JOIN "ChargingStations" cs
                     ON cs."ocppConnectionName"=b.id AND cs."tenantId"=b."tenantId"
                     GROUP BY b.id HAVING count(*)>1) THEN
            RAISE EXCEPTION 'BOOT_ARCHIVE_AMBIGUOUS_STATION';
          END IF;
          IF EXISTS (SELECT 1 FROM "VariableAttributes" va JOIN "Boots" b ON va."bootConfigId"=b.id
                     WHERE NOT EXISTS (SELECT 1 FROM "ChargingStations" cs
                       WHERE cs."ocppConnectionName"=b.id AND cs."tenantId"=b."tenantId")) THEN
            RAISE EXCEPTION 'BOOT_ARCHIVE_REFERENCED_CONFIG';
          END IF;
          FOR reference IN SELECT oid, conrelid FROM pg_constraint
                           WHERE contype='f' AND confrelid='"Boots"'::regclass LOOP
            EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE', reference.conrelid::regclass);
            SELECT string_agg(format('r.%I=b.%I', ra.attname, ba.attname), ' AND ' ORDER BY k.n)
              INTO join_sql FROM pg_constraint c
              CROSS JOIN LATERAL generate_subscripts(c.conkey,1) k(n)
              JOIN pg_attribute ra ON ra.attrelid=c.conrelid AND ra.attnum=c.conkey[k.n]
              JOIN pg_attribute ba ON ba.attrelid=c.confrelid AND ba.attnum=c.confkey[k.n]
              WHERE c.oid=reference.oid;
            EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s r JOIN "Boots" b ON %s
              WHERE NOT EXISTS (SELECT 1 FROM "ChargingStations" cs
                WHERE cs."ocppConnectionName"=b.id AND cs."tenantId"=b."tenantId"))',
              reference.conrelid::regclass, join_sql) INTO referenced;
            IF referenced THEN RAISE EXCEPTION 'BOOT_ARCHIVE_REFERENCED_CONFIG'; END IF;
          END LOOP;
          SELECT string_agg(format('%I',attname),',' ORDER BY attnum),
                 jsonb_object_agg(attname,format_type(atttypid,atttypmod))
            INTO columns_sql,schema_json FROM pg_attribute
            WHERE attrelid='"Boots"'::regclass AND attnum>0 AND NOT attisdropped;
          IF to_regclass('public."BootConfigMigrationArchive"') IS NOT NULL THEN
            RAISE EXCEPTION 'BOOT_ARCHIVE_ALREADY_EXISTS';
          END IF;
          CREATE TABLE "BootConfigMigrationArchive" AS SELECT b.*,
            row_to_json(b) AS "_bootArchiveOriginalRow",
            schema_json AS "_bootArchiveSchema",
            'NO_MATCHING_STATION'::text AS "_bootArchiveReason",
            '${migration}'::text AS "_bootArchiveMigration",
            clock_timestamp() AS "_bootArchiveAt"
            FROM "Boots" b WITH NO DATA;
          ALTER TABLE "BootConfigMigrationArchive" ADD PRIMARY KEY (id),
            ALTER COLUMN "tenantId" SET NOT NULL,
            ALTER COLUMN "_bootArchiveOriginalRow" SET NOT NULL,
            ALTER COLUMN "_bootArchiveSchema" SET NOT NULL,
            ALTER COLUMN "_bootArchiveReason" SET NOT NULL,
            ALTER COLUMN "_bootArchiveMigration" SET NOT NULL,
            ALTER COLUMN "_bootArchiveAt" SET NOT NULL;
          INSERT INTO "BootConfigMigrationArchive"
            SELECT b.*,row_to_json(b),schema_json,'NO_MATCHING_STATION','${migration}',clock_timestamp()
            FROM "Boots" b WHERE NOT EXISTS (SELECT 1 FROM "ChargingStations" cs
              WHERE cs."ocppConnectionName"=b.id AND cs."tenantId"=b."tenantId");
          GET DIAGNOSTICS moved=ROW_COUNT;
          IF EXISTS (SELECT 1 FROM "Boots" b JOIN "BootConfigMigrationArchive" a ON a.id=b.id
                     WHERE a."_bootArchiveOriginalRow"::text IS DISTINCT FROM row_to_json(b)::text) THEN
            RAISE EXCEPTION 'BOOT_ARCHIVE_COPY_MISMATCH';
          END IF;
          EXECUTE format('SELECT EXISTS (SELECT 1 FROM "BootConfigMigrationArchive" a
            WHERE a."_bootArchiveOriginalRow"::text IS DISTINCT FROM
              (SELECT row_to_json(v)::text FROM (SELECT %s FROM "BootConfigMigrationArchive" x WHERE x.id=a.id) v))',
            columns_sql) INTO referenced;
          IF referenced THEN RAISE EXCEPTION 'BOOT_ARCHIVE_COPY_MISMATCH'; END IF;
          DELETE FROM "Boots" b USING "BootConfigMigrationArchive" a WHERE a.id=b.id;
          GET DIAGNOSTICS removed=ROW_COUNT;
          IF moved<>removed THEN RAISE EXCEPTION 'BOOT_ARCHIVE_MOVE_MISMATCH'; END IF;
        END $archive$;`,
        { transaction },
      );
    });
  },

  async down(queryInterface: QueryInterface): Promise<void> {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `SET LOCAL TIME ZONE 'UTC';
        DO $restore$
        DECLARE
          columns_sql text;
          source_schema jsonb;
          target_schema jsonb;
          mismatch boolean;
          archived bigint;
          restored bigint;
        BEGIN
          IF to_regclass('public."BootConfigMigrationArchive"') IS NULL THEN RETURN; END IF;
          LOCK TABLE "Boots", "BootConfigMigrationArchive" IN SHARE ROW EXCLUSIVE MODE;
          IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='"Boots"'::regclass
                         AND attname='id' AND atttypid='varchar'::regtype AND NOT attisdropped) THEN
            RAISE EXCEPTION 'BOOT_ARCHIVE_RESTORE_LEGACY_SCHEMA_FIRST';
          END IF;
          SELECT string_agg(format('%I',attname),',' ORDER BY attnum),
                 jsonb_object_agg(attname,format_type(atttypid,atttypmod))
            INTO columns_sql,source_schema FROM pg_attribute
            WHERE attrelid='"BootConfigMigrationArchive"'::regclass AND attnum>0 AND NOT attisdropped
              AND attname NOT LIKE '\\_bootArchive%' ESCAPE '\\';
          SELECT jsonb_object_agg(attname,format_type(atttypid,atttypmod)) INTO target_schema
            FROM pg_attribute WHERE attrelid='"Boots"'::regclass AND attnum>0 AND NOT attisdropped;
          IF source_schema IS DISTINCT FROM target_schema OR EXISTS (
            SELECT 1 FROM "BootConfigMigrationArchive" WHERE "_bootArchiveSchema" IS DISTINCT FROM source_schema
              OR "_bootArchiveMigration" IS DISTINCT FROM '${migration}'
              OR "_bootArchiveReason" IS DISTINCT FROM 'NO_MATCHING_STATION') THEN
            RAISE EXCEPTION 'BOOT_ARCHIVE_RESTORE_SCHEMA_OR_PROVENANCE_MISMATCH';
          END IF;
          IF EXISTS (SELECT 1 FROM "Boots" b JOIN "BootConfigMigrationArchive" a ON a.id=b.id) THEN
            RAISE EXCEPTION 'BOOT_ARCHIVE_RESTORE_IDENTITY_CONFLICT';
          END IF;
          EXECUTE format('SELECT EXISTS (SELECT 1 FROM "BootConfigMigrationArchive" a
            WHERE a."_bootArchiveOriginalRow"::text IS DISTINCT FROM
              (SELECT row_to_json(v)::text FROM (SELECT %s FROM "BootConfigMigrationArchive" x WHERE x.id=a.id) v))',
            columns_sql) INTO mismatch;
          IF mismatch THEN RAISE EXCEPTION 'BOOT_ARCHIVE_COPY_MISMATCH'; END IF;
          SELECT count(*) INTO archived FROM "BootConfigMigrationArchive";
          EXECUTE format('INSERT INTO "Boots" (%s) SELECT %s FROM "BootConfigMigrationArchive"',columns_sql,columns_sql);
          GET DIAGNOSTICS restored=ROW_COUNT;
          EXECUTE format('SELECT EXISTS (SELECT 1 FROM "BootConfigMigrationArchive" a
            WHERE a."_bootArchiveOriginalRow"::text IS DISTINCT FROM
              (SELECT row_to_json(v)::text FROM (SELECT %s FROM "Boots" b WHERE b.id=a.id) v))',
            columns_sql) INTO mismatch;
          IF archived<>restored OR mismatch THEN RAISE EXCEPTION 'BOOT_ARCHIVE_RESTORE_MISMATCH'; END IF;
          DROP TABLE "BootConfigMigrationArchive";
        END $restore$;`,
        { transaction },
      );
    });
  },
};
