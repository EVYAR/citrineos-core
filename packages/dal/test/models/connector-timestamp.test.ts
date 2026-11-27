// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import '@test/unit-isolation.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorSchemaWithoutParent } from '@citrineos/types';
import { Connector } from '@dal/models/location/connector.js';
import { DefaultSequelizeInstance } from '@dal/db/sequelize/util.js';
import { aSystemConfig } from '@test/providers/system-config.js';

let sequelize: ReturnType<typeof DefaultSequelizeInstance.getInstance> | undefined;
beforeAll(() => {
  sequelize = DefaultSequelizeInstance.getInstance(
    aSystemConfig({
      database: {
        host: 'unit.invalid',
        port: 1,
        database: 'synthetic_connector_no_database',
        username: 'unit_only',
        password: 'synthetic-no-database',
      },
    }),
  );
});
afterAll(async () => {
  await sequelize?.close();
});
function connector() {
  return Connector.build({ id: 1, tenantId: 1, stationId: 1, evseId: 1, connectorId: 1 });
}
describe('nullable connector observation timestamp', () => {
  it.each([null, undefined])(
    'serializes absent database timestamp %j without inventing evidence',
    (value) => {
      const row = connector();
      row.setDataValue('timestamp', value);
      expect(row.timestamp).toBeUndefined();
      expect(row.get({ plain: true }).timestamp).toBeUndefined();
      const serialized = JSON.parse(JSON.stringify(row));
      expect(serialized).not.toHaveProperty('timestamp');
      expect(ConnectorSchemaWithoutParent.safeParse(serialized).success).toBe(true);
    },
  );
  it('serializes an observed Date to its exact ISO value', () => {
    const row = connector();
    const timestamp = '2026-11-07T12:34:56.789Z';
    row.setDataValue('timestamp', new Date(timestamp));
    expect(row.timestamp).toBe(timestamp);
    expect(row.get({ plain: true }).timestamp).toBe(timestamp);
    const serialized = JSON.parse(JSON.stringify(row));
    expect(serialized.timestamp).toBe(timestamp);
    expect(ConnectorSchemaWithoutParent.safeParse(serialized).success).toBe(true);
  });
});
