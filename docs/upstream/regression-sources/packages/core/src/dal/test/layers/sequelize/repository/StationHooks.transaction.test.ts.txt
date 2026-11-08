// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { ChargingStation } from '../../../../layers/sequelize/model/Location/ChargingStation.js';
import { stationHookModels } from './station-hook-models.js';
afterEach(() => vi.restoreAllMocks());
it.each(stationHookModels)(
  'passes caller transaction and exact tenant/station to station resolution: %s',
  async (Model) => {
    const transaction = {} as never;
    const lookup = vi.spyOn(ChargingStation, 'findOne').mockResolvedValue({ id: 71 } as never);
    const row = { tenantId: 9, ocppConnectionName: 'task-station', stationId: undefined };
    await Model.resolveStationId(row as never, { transaction });
    expect(lookup).toHaveBeenCalledWith({
      where: { tenantId: 9, ocppConnectionName: 'task-station' },
      attributes: ['id'],
      transaction,
    });
    expect(row.stationId).toBe(71);
  },
);
it.each(stationHookModels)(
  'preserves prebound ids and ordinary default-option lookup: %s',
  async (Model) => {
    const lookup = vi.spyOn(ChargingStation, 'findOne').mockResolvedValue({ id: 71 } as never);
    const bound = { tenantId: 9, ocppConnectionName: 'task-station', stationId: 13 };
    await Model.resolveStationId(bound as never);
    expect(lookup).not.toHaveBeenCalled();
    expect(bound.stationId).toBe(13);
    const row = { tenantId: 9, ocppConnectionName: 'task-station', stationId: undefined };
    await Model.resolveStationId(row as never);
    expect(lookup.mock.calls[0][0]?.transaction).toBeUndefined();
    expect(row.stationId).toBe(71);
  },
);
