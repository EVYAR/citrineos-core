// SPDX-License-Identifier: Apache-2.0
import { afterAll, expect, it } from 'vitest';
import { ChargingStationSequenceTypeEnum, type BootstrapConfig } from '@citrineos/base';
import { SequelizeChargingStationSequenceRepository } from '../../../../layers/sequelize/repository/ChargingStationSequence.js';
import { DefaultSequelizeInstance } from '../../../../layers/sequelize/util.js';
import { ChargingStation } from '../../../../layers/sequelize/model/Location/ChargingStation.js';
import { ChargingStationSequence } from '../../../../layers/sequelize/model/ChargingStationSequence/ChargingStationSequence.js';
import { Transaction } from '../../../../layers/sequelize/model/TransactionEvent/Transaction.js';
const url = process.env.CGP_CORE_TEST_DATABASE_URL;
let db: ReturnType<typeof DefaultSequelizeInstance.getInstance> | undefined;
afterAll(async () => {
  await db?.close();
});
function database() {
  const u = new URL(url!);
  if (!/^cgp_e2e_[a-z0-9_]+$/.test(u.pathname.slice(1))) throw Error('task database required');
  db ??= DefaultSequelizeInstance.getInstance({
    database: {
      host: u.hostname,
      port: Number(u.port),
      database: u.pathname.slice(1),
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      dialect: 'postgres',
      pool: { max: 2, min: 0, acquire: 400, idle: 1000 },
    },
  } as unknown as BootstrapConfig);
  return db!;
}
it.skipIf(!url).each([ChargingStationSequence, Transaction])(
  'resolves station hooks inside their supplied transaction with a two-connection pool: %s',
  async (Model) => {
    database();
    const name = process.env.CGP_CORE_TEST_STATION ?? 'cgp-e2e-quota-20261019-r2';
    const expected = await ChargingStation.findOne({
      where: { tenantId: 1, ocppConnectionName: name },
      attributes: ['id'],
    });
    expect(expected).not.toBeNull();
    const instance: { tenantId: number; ocppConnectionName: string; stationId?: number } = {
      tenantId: 1,
      ocppConnectionName: name,
    };
    await db.transaction(async () =>
      db!.transaction(async (transaction) => {
        await Model.resolveStationId(instance as never, { transaction });
        expect(instance.stationId).toBe(expected!.id);
      }),
    );
  },
);

it.skipIf(!url)(
  'allocates a sequence inside its caller transaction without a third connection and rolls the fixture back',
  async () => {
    const active = database(),
      abort = new Error('rollback-test-only');
    const repository = new SequelizeChargingStationSequenceRepository({
      config: {} as BootstrapConfig,
      sequelizeInstance: active,
    });
    await expect(
      active.transaction(async () =>
        active.transaction(async (transaction) => {
          const next = await repository.getNextSequenceValue(
            1,
            process.env.CGP_CORE_TEST_STATION ?? 'cgp-e2e-quota-20261019-r2',
            ChargingStationSequenceTypeEnum.transactionId,
            transaction,
          );
          expect(Number.isFinite(next)).toBe(true);
          throw abort;
        }),
      ),
    ).rejects.toBe(abort);
  },
);
