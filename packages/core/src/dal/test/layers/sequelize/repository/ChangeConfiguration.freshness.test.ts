// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { Sequelize, DataTypes } from 'sequelize';
import { expect, it } from 'vitest';
import { SequelizeChangeConfigurationRepository } from '../../../../layers/sequelize/repository/ChangeConfiguration.js';
import { ChangeConfiguration } from '../../../../layers/sequelize/model/ChangeConfiguration.js';
import type { BootstrapConfig } from '@citrineos/base';
import type { Sequelize as TypedSequelize } from 'sequelize-typescript';
const url = process.env.CGP_CORE_TEST_DATABASE_URL;
it.skipIf(!url)(
  'refreshes the observation timestamp when a charger repeats an unchanged configuration value',
  async () => {
    if (!/^cgp_e2e_[a-z0-9_]+$/.test(new URL(url!).pathname.slice(1)))
      throw new Error('task database required');
    const db = new Sequelize(url!, { logging: false, pool: { max: 1, min: 0 } });
    const model = db.define(
      ChangeConfiguration.MODEL_NAME,
      {
        tenantId: DataTypes.INTEGER,
        ocppConnectionName: DataTypes.STRING,
        key: DataTypes.STRING,
        value: DataTypes.STRING,
        readonly: DataTypes.BOOLEAN,
      },
      { tableName: 'ChangeConfigurations' },
    );
    const key = `cgp-fresh-${randomUUID()}`;
    const value = {
      tenantId: 1,
      ocppConnectionName: process.env.CGP_CORE_TEST_STATION ?? 'cgp-e2e-quota-20261019-r2',
      key,
      value: 'false',
      readonly: false,
    };
    const repository = new SequelizeChangeConfigurationRepository({
      config: {} as BootstrapConfig,
      sequelizeInstance: db as unknown as TypedSequelize,
    });
    try {
      const first = await repository.createOrUpdateChangeConfiguration(
        1,
        value as ChangeConfiguration,
      );
      const before = new Date(first!.get('updatedAt') as Date).getTime();
      await new Promise((resolve) => setTimeout(resolve, 25));
      const since = Date.now();
      await repository.createOrUpdateChangeConfiguration(1, value as ChangeConfiguration);
      const observed = await model.findOne({
        where: { tenantId: 1, ocppConnectionName: value.ocppConnectionName, key },
      });
      expect(observed!.get('value')).toBe('false');
      expect(new Date(observed!.get('updatedAt') as Date).getTime()).toBeGreaterThan(before);
      expect(new Date(observed!.get('updatedAt') as Date).getTime()).toBeGreaterThanOrEqual(since);
    } finally {
      await model.destroy({
        where: { tenantId: 1, ocppConnectionName: value.ocppConnectionName, key },
      });
      await db.close();
    }
  },
);
