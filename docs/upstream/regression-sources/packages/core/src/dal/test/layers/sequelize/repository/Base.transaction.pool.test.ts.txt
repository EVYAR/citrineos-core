// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Sequelize, DataTypes } from 'sequelize';
import { SequelizeRepository } from '../../../../layers/sequelize/repository/Base.js';
const url = process.env.CGP_CORE_REPOSITORY_TEST_DATABASE_URL;
let db: Sequelize;
let repository: SequelizeRepository<never>;
beforeAll(async () => {
  if (!url) return;
  const u = new URL(url);
  if (!u.pathname.startsWith('/cgp_e2e_repository_'))
    throw Error('isolated test database required');
  db = new Sequelize(url, { logging: false, pool: { max: 2, min: 0, acquire: 350, idle: 100 } });
  db.define(
    'ConnectorProof',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      tenantId: DataTypes.INTEGER,
      status: DataTypes.STRING,
    },
    { tableName: 'ConnectorProof', timestamps: false },
  );
  await db.sync();
  await db.models.ConnectorProof.bulkCreate([
    { id: 1, tenantId: 1, status: 'Charging' },
    { id: 2, tenantId: 1, status: 'Charging' },
    { id: 3, tenantId: 2, status: 'Charging' },
  ]);
  repository = new SequelizeRepository({
    config: {} as never,
    namespace: 'ConnectorProof',
    sequelizeInstance: db as never,
  });
});
afterAll(async () => {
  await db?.close();
});
it.skipIf(!url)(
  'two concurrent connector updates retain their managed transaction checkout and drain the bounded pool',
  async () => {
    let ready = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    await Promise.all(
      [1, 2].map((id) =>
        db.transaction(async (transaction) => {
          await db.models.ConnectorProof.findByPk(id, { transaction });
          if (++ready === 2) release();
          await both;
          const rows = await repository.updateAllByQuery(1, { status: 'Available' } as never, {
            where: { id },
            transaction,
          });
          expect(rows).toHaveLength(1);
          expect(rows[0].get('status')).toBe('Available');
        }),
      ),
    );
    expect(
      (await db.models.ConnectorProof.findAll({ where: { tenantId: 1 } })).map((x) =>
        x.get('status'),
      ),
    ).toEqual(['Available', 'Available']);
  },
);
it.skipIf(!url)(
  'rollback covers the per-row update and reload, while tenant filtering excludes foreign rows',
  async () => {
    const abort = new Error('fixture rollback');
    await expect(
      db.transaction(async (transaction) => {
        const rows = await repository.updateAllByQuery(1, { status: 'Finishing' } as never, {
          where: { id: 1 },
          transaction,
        });
        expect(rows[0].get('status')).toBe('Finishing');
        expect(
          await repository.updateAllByQuery(1, { status: 'Foreign' } as never, {
            where: { id: 3 },
            transaction,
          }),
        ).toEqual([]);
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect((await db.models.ConnectorProof.findByPk(1))!.get('status')).toBe('Available');
    expect((await db.models.ConnectorProof.findByPk(3))!.get('status')).toBe('Charging');
  },
);

it.skipIf(!url)('keeps ordinary no-transaction updates and empty results working', async () => {
  const rows = await repository.updateAllByQuery(1, { status: 'Available' } as never, {
    where: { id: 1 },
  });
  expect(rows[0].get('status')).toBe('Available');
  expect(
    await repository.updateAllByQuery(1, { status: 'Missing' } as never, { where: { id: 999 } }),
  ).toEqual([]);
});
