// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';
import {
  loadBootArchiveFixture,
  verifyBootArchiveDatabase,
  type BootArchiveFixture,
} from '../utils/boot-archive-fixture.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Sequelize, QueryTypes } from 'sequelize';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import archive from '../../../../apps/ocpp-server/db/migrations/20260821120000-preserve-unmapped-boot-configs.js';
import upstream from '../../../../apps/ocpp-server/db/migrations/20260821120000-update-boot-pk-id.js';

let container: StartedTestContainer;
let db: Sequelize;
let fixture: BootArchiveFixture | undefined;

async function rows<T extends object>(sql: string): Promise<T[]> {
  return db.query<T>(sql, { type: QueryTypes.SELECT });
}

async function originalRows(): Promise<{ value: string }[]> {
  return rows(`SELECT row_to_json(b)::text AS value FROM "Boots" b ORDER BY id`);
}

beforeAll(async () => {
  const fixtureFile = process.env.BOOT_ARCHIVE_FIXTURE_FILE;
  if (fixtureFile !== undefined) {
    fixture = loadBootArchiveFixture(fixtureFile);
    db = new Sequelize(fixture.database, fixture.username, fixture.password, {
      dialect: 'postgres',
      host: fixture.host,
      port: fixture.port,
      logging: false,
      pool: { max: 1, min: 0 },
      dialectOptions: { application_name: fixture.marker },
    });
    await verifyBootArchiveDatabase(db, fixture);
    return;
  }
  const password = randomBytes(32).toString('hex');
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'boot_archive_ci',
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: 'boot_archive_ci',
    })
    .withResourcesQuota({ memory: 0.25, cpu: 1 })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
    .start();
  db = new Sequelize('boot_archive_ci', 'boot_archive_ci', password, {
    dialect: 'postgres',
    host: container.getHost(),
    port: container.getMappedPort(5432),
    logging: false,
  });
}, 90_000);

afterAll(async () => {
  await db?.close();
  await container?.stop();
});

beforeEach(async () => {
  if (fixture) await verifyBootArchiveDatabase(db, fixture);
  await db.query(`SET TIME ZONE 'UTC'; DROP TABLE IF EXISTS "ExtraReferences", "BootConfigMigrationArchive",
    "VariableAttributes", "Boots", "ChargingStations" CASCADE;
    CREATE TABLE "ChargingStations" (id integer PRIMARY KEY, "tenantId" integer NOT NULL,
      "ocppConnectionName" varchar(255) NOT NULL);
    CREATE TABLE "Boots" (id varchar(255) PRIMARY KEY, "tenantId" integer NOT NULL,
      "lastBootTime" timestamptz, "heartbeatInterval" integer, "bootRetryInterval" integer,
      status varchar(255), "statusInfo" json, "getBaseReportOnPending" boolean,
      "variablesRejectedOnLastBoot" json, "bootWithRejectedVariables" boolean,
      "changeConfigurationsOnPending" boolean, "getConfigurationsOnPending" boolean,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
    CREATE TABLE "VariableAttributes" (id integer PRIMARY KEY, "tenantId" integer NOT NULL,
      "bootConfigId" varchar(255) REFERENCES "Boots"(id) ON DELETE SET NULL);
    INSERT INTO "ChargingStations" VALUES (10,1,'valid');
    INSERT INTO "Boots" (id,"tenantId",status,"statusInfo","lastBootTime","heartbeatInterval",
      "variablesRejectedOnLastBoot","createdAt","updatedAt") VALUES
      ('valid',1,'Accepted','{"a":1}',NULL,30,'[]','2020-01-01','2020-01-02'),
      ('',1,'Pending','{"duplicate":1,"duplicate":2,"decimal":1.00}',
       '2020-01-01T12:34:56.123456Z',NULL,'[{"x":1.00}]','2020-01-03','2020-01-04');
    INSERT INTO "VariableAttributes" VALUES (1,1,'valid');`);
});

const qi = () => db.getQueryInterface();

async function expectRefusal(pattern: RegExp): Promise<void> {
  const before = await originalRows();
  await expect(archive.up(qi())).rejects.toThrow(pattern);
  expect(await originalRows()).toEqual(before);
  expect(await rows(`SELECT to_regclass('public."BootConfigMigrationArchive"') AS name`)).toEqual([
    { name: null },
  ]);
}

describe('unmapped legacy Boot archival', () => {
  it('preserves typed payload, JSON text, provenance and valid references through upstream up/down', async () => {
    const before = await originalRows();
    await archive.up(qi());
    expect(await rows('SELECT id FROM "Boots"')).toEqual([{ id: 'valid' }]);
    const [saved] = await rows<{ payload: string; reason: string; migration: string }>(
      `SELECT "_bootArchiveOriginalRow"::text payload, "_bootArchiveReason" reason,
       "_bootArchiveMigration" migration FROM "BootConfigMigrationArchive"`,
    );
    expect(saved).toEqual({
      payload: before[0].value,
      reason: 'NO_MATCHING_STATION',
      migration: '20260821120000-preserve-unmapped-boot-configs',
    });
    await upstream.up(qi());
    expect(
      await rows(`SELECT b."stationId" FROM "VariableAttributes" va
      JOIN "Boots" b ON b.id=va."bootConfigId" WHERE va.id=1`),
    ).toEqual([{ stationId: 10 }]);
    await expect(
      db.query(`INSERT INTO "Boots" ("stationId","tenantId","createdAt","updatedAt")
      VALUES (999,1,now(),now())`),
    ).rejects.toThrow();
    await expect(archive.down(qi())).rejects.toThrow(/RESTORE_LEGACY_SCHEMA_FIRST/);
    await upstream.down(qi());
    await archive.down(qi());
    // Upstream down reorders id; compare every field by name and JSON lexical values separately.
    expect(
      (
        await rows<{ id: string; info: string; rejected: string }>(
          'SELECT id,"statusInfo"::text info,"variablesRejectedOnLastBoot"::text rejected FROM "Boots" ORDER BY id',
        )
      )[0],
    ).toEqual({
      id: '',
      info: '{"duplicate":1,"duplicate":2,"decimal":1.00}',
      rejected: '[{"x":1.00}]',
    });
    expect(await rows(`SELECT "lastBootTime"::text value FROM "Boots" WHERE id=''`)).toEqual([
      { value: '2020-01-01 12:34:56.123456+00' },
    ]);
    expect(await rows('SELECT "bootConfigId" FROM "VariableAttributes" WHERE id=1')).toEqual([
      { bootConfigId: 'valid' },
    ]);
  });

  it('round-trips all legacy values exactly without the upstream conversion', async () => {
    const before = await originalRows();
    await archive.up(qi());
    await archive.down(qi());
    expect(await originalRows()).toEqual(before);
  });

  it('refuses an orphan reference even with a different tenant and no FK', async () => {
    await db.query(`ALTER TABLE "VariableAttributes" DROP CONSTRAINT "VariableAttributes_bootConfigId_fkey";
      INSERT INTO "VariableAttributes" VALUES (2,2,'');`);
    await expectRefusal(/REFERENCED_CONFIG/);
  });

  it('refuses unknown inbound references before ON DELETE CASCADE can destroy them', async () => {
    await db.query(`CREATE TABLE "ExtraReferences" (id integer PRIMARY KEY,
      boot varchar(255) REFERENCES "Boots"(id) ON DELETE CASCADE);
      INSERT INTO "ExtraReferences" VALUES (2,'');`);
    await expectRefusal(/REFERENCED_CONFIG/);
    expect(await rows('SELECT * FROM "ExtraReferences"')).toEqual([{ id: 2, boot: '' }]);
  });

  it('refuses composite inbound references without changing their relationships', async () => {
    await db.query(`ALTER TABLE "Boots" ADD UNIQUE (id,"tenantId");
      CREATE TABLE "ExtraReferences" (id integer PRIMARY KEY, boot varchar(255), tenant integer,
        FOREIGN KEY (boot,tenant) REFERENCES "Boots"(id,"tenantId") ON DELETE SET NULL);
      INSERT INTO "ExtraReferences" VALUES (2,'',1);`);
    await expectRefusal(/REFERENCED_CONFIG/);
    expect(await rows('SELECT boot,tenant FROM "ExtraReferences"')).toEqual([
      { boot: '', tenant: 1 },
    ]);
  });

  it('refuses ambiguous station attribution and rolls everything back', async () => {
    await db.query(`INSERT INTO "ChargingStations" VALUES (11,1,'valid')`);
    await expectRefusal(/AMBIGUOUS_STATION/);
  });

  it('uses tenant-qualified attribution rather than a station in another tenant', async () => {
    await db.query(`INSERT INTO "ChargingStations" VALUES (11,2,'')`);
    await archive.up(qi());
    expect(await rows('SELECT id FROM "BootConfigMigrationArchive"')).toEqual([{ id: '' }]);
  });

  it('handles a fresh empty legacy schema and an already-converted schema', async () => {
    await db.query('DELETE FROM "VariableAttributes"; DELETE FROM "Boots"');
    await archive.up(qi());
    expect(await rows('SELECT count(*)::integer n FROM "BootConfigMigrationArchive"')).toEqual([
      { n: 0 },
    ]);
    await upstream.up(qi());
    await archive.up(qi());
    expect(await rows('SELECT count(*)::integer n FROM "BootConfigMigrationArchive"')).toEqual([
      { n: 0 },
    ]);
  });

  it('refuses an existing archive instead of replacing evidence', async () => {
    await archive.up(qi());
    const before = await rows(
      'SELECT "_bootArchiveOriginalRow"::text value FROM "BootConfigMigrationArchive"',
    );
    await expect(archive.up(qi())).rejects.toThrow(/ALREADY_EXISTS/);
    expect(
      await rows('SELECT "_bootArchiveOriginalRow"::text value FROM "BootConfigMigrationArchive"'),
    ).toEqual(before);
  });

  it('refuses rollback identity collisions without overwriting either row', async () => {
    await archive.up(qi());
    await db.query(`INSERT INTO "Boots" (id,"tenantId",status) VALUES ('',1,'replacement')`);
    await expect(archive.down(qi())).rejects.toThrow(/IDENTITY_CONFLICT/);
    expect(await rows(`SELECT status FROM "Boots" WHERE id=''`)).toEqual([
      { status: 'replacement' },
    ]);
    expect(await rows('SELECT count(*)::integer n FROM "BootConfigMigrationArchive"')).toEqual([
      { n: 1 },
    ]);
  });

  it('refuses changed provenance without restoring or removing the archive', async () => {
    await archive.up(qi());
    await db.query(`UPDATE "BootConfigMigrationArchive" SET "_bootArchiveMigration"='unrelated'`);
    await expect(archive.down(qi())).rejects.toThrow(/SCHEMA_OR_PROVENANCE_MISMATCH/);
    expect(await rows('SELECT count(*)::integer n FROM "BootConfigMigrationArchive"')).toEqual([
      { n: 1 },
    ]);
    expect(await rows(`SELECT count(*)::integer n FROM "Boots" WHERE id=''`)).toEqual([{ n: 0 }]);
  });

  it('refuses tampered archive payload and schema drift without discarding evidence', async () => {
    await archive.up(qi());
    await db.query(`UPDATE "BootConfigMigrationArchive" SET status='tampered'`);
    await expect(archive.down(qi())).rejects.toThrow(/COPY_MISMATCH/);
    await db.query('ALTER TABLE "Boots" ADD COLUMN unexpected text');
    await expect(archive.down(qi())).rejects.toThrow(/SCHEMA_OR_PROVENANCE_MISMATCH/);
    expect(await rows('SELECT count(*)::integer n FROM "BootConfigMigrationArchive"')).toEqual([
      { n: 1 },
    ]);
  });
});
