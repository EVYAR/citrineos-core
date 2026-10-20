// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { BootstrapConfig } from '@citrineos/base';
import { DefaultSequelizeInstance } from '../../../../layers/sequelize/util.js';
import { ChargingStation } from '../../../../layers/sequelize/model/Location/ChargingStation.js';
import { Evse } from '../../../../layers/sequelize/model/Location/Evse.js';
import { Connector } from '../../../../layers/sequelize/model/Location/Connector.js';
import { StatusNotification } from '../../../../layers/sequelize/model/Location/StatusNotification.js';
import { LatestStatusNotification } from '../../../../layers/sequelize/model/Location/LatestStatusNotification.js';
const url = process.env.CGP_CORE_REPOSITORY_TEST_DATABASE_URL;
let db: ReturnType<typeof DefaultSequelizeInstance.getInstance>;
beforeAll(async () => {
  if (!url) return;
  const u = new URL(url);
  if (!u.pathname.startsWith('/cgp_e2e_repository_'))
    throw Error('isolated task database required');
  db = DefaultSequelizeInstance.getInstance({
    database: {
      host: u.hostname,
      port: Number(u.port),
      database: u.pathname.slice(1),
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      dialect: 'postgres',
      pool: { max: 2, min: 0, acquire: 350, idle: 100 },
    },
  } as BootstrapConfig);
  await db.query(
    'CREATE TABLE "ChargingStations"(id integer PRIMARY KEY, "tenantId" integer, "ocppConnectionName" text); INSERT INTO "ChargingStations" VALUES(71,9,\'task-station\'),(72,10,\'task-station\')',
  );
});
afterAll(async () => {
  await db?.close();
});
it.skipIf(!url).each([Evse, Connector, StatusNotification, LatestStatusNotification])(
  'actual station hook resolves concurrently using two existing transaction checkouts: %s',
  async (Model) => {
    let count = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    await Promise.all(
      [9, 10].map((tenantId) =>
        db.transaction(async (transaction) => {
          await db.query('SELECT 1', { transaction });
          if (++count === 2) release();
          await both;
          const row = { tenantId, ocppConnectionName: 'task-station', stationId: undefined };
          await Model.resolveStationId(row as never, { transaction });
          expect(row.stationId).toBe(tenantId === 9 ? 71 : 72);
        }),
      ),
    );
    expect(await ChargingStation.count()).toBe(2);
  },
);
