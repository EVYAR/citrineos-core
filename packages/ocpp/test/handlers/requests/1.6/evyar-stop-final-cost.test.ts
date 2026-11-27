// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import '@test/unit-isolation.js';
import { RequestBuilder, type IMessage } from '@citrineos/base';
import {
  DefaultSequelizeInstance,
  sequelize as dalModels,
  StartTransaction,
  Transaction,
} from '@citrineos/dal';
import {
  EventGroup,
  MessageOrigin,
  OCPPVersion,
  OCPP_CallAction,
  type OCPP1_6,
} from '@citrineos/types';
import { StopTransactionRequestOcpp16Handler } from '@handlers/requests/1.6/stop-transaction-request-ocpp-16-handler.js';
import { aSystemConfig } from '@test/providers/system-config.js';
import { createTestContainer, getTestInstance, makeMockOcppSender } from '@test/test-container.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
const { ChargingStation } = dalModels;
const at = '2026-11-07T12:10:00Z';
const request: OCPP1_6.StopTransactionRequest = {
  transactionId: 100,
  meterStop: 5000,
  timestamp: at,
};
const message = (): IMessage<OCPP1_6.StopTransactionRequest> => ({
  ...RequestBuilder.buildCall(
    'CP-TEST',
    'stop-100',
    1,
    OCPP_CallAction.StopTransaction,
    request,
    EventGroup.Transactions,
    MessageOrigin.ChargingStation,
    OCPPVersion.OCPP1_6,
  ),
  payload: request,
});
beforeAll(() => {
  DefaultSequelizeInstance.getInstance(
    aSystemConfig({
      database: {
        host: 'unit.invalid',
        port: 1,
        database: 'evyar_synthetic_unit_never_connect',
        username: 'unit_only',
        password: 'synthetic-no-database',
      },
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});
function fixture(tariffId: number | null = 77, price: number | undefined = 18.7) {
  const tx = Transaction.build({
    id: 100,
    tenantId: 1,
    stationId: 4242,
    transactionId: '100',
    isActive: true,
    tariffId,
    startTime: '2026-11-07T12:01:00Z',
  });
  tx.startTransaction = StartTransaction.build({
    meterStart: 1000,
    timestamp: '2026-11-07T12:00:00Z',
  });
  vi.spyOn(ChargingStation, 'findOne').mockResolvedValue(
    ChargingStation.build({ id: 4242, tenantId: 1, ocppConnectionName: 'CP-TEST' }),
  );
  const find = vi.spyOn(Transaction, 'findOne').mockResolvedValue(tx);
  const save = vi.spyOn(tx, 'save').mockResolvedValue(tx);
  const cost = vi.fn().mockResolvedValue(price);
  const createStop = vi.fn().mockResolvedValue({ id: 200 });
  const { container } = createTestContainer();
  const handler = getTestInstance(container, StopTransactionRequestOcpp16Handler, {
    ocppSender: makeMockOcppSender(),
    authorizationRepository: { readAllByQuerystring: vi.fn().mockResolvedValue([]) },
    transactionRepository: { createStopTransaction: createStop },
    costCalculator: { calculateTotalCostByTariffId: cost },
  });
  return { tx, find, save, cost, createStop, handler };
}
describe('EVYAR locked OCPP1.6 physical finalization', () => {
  it('uses original start-record duration, persists end and captured-tariff cost in one save', async () => {
    const { tx, handler, cost, save } = fixture();
    save.mockImplementation(async () => {
      expect(tx).toMatchObject({
        isActive: false,
        totalKwh: 4,
        totalCost: 18.7,
        endTime: new Date(at).toISOString(),
      });
      return tx;
    });
    await handler.handle(message());
    expect(cost).toHaveBeenCalledWith(1, 77, 4, {
      chargingDurationSeconds: 600,
      sessionDurationSeconds: 600,
      occurredAt: new Date(at),
    });
    expect(save).toHaveBeenCalledOnce();
  });
  it('persists explicit free cost as zero', async () => {
    const { tx, handler } = fixture(77, 0);
    await handler.handle(message());
    expect(tx.totalCost).toBe(0);
  });
  it('does not reprice genuinely unpriced sessions through the current connector', async () => {
    const { handler, cost, tx } = fixture(null);
    await handler.handle(message());
    expect(cost).not.toHaveBeenCalled();
    expect(tx.isActive).toBe(false);
  });
  it('keeps missing locked tariff distinct from free', async () => {
    const { tx, handler, cost } = fixture();
    cost.mockResolvedValue(undefined);
    await handler.handle(message());
    expect(tx.totalCost).toBeUndefined();
    expect(tx.isActive).toBe(false);
  });
  it('still records physical stop if tariff lookup fails', async () => {
    const { tx, handler, cost, save } = fixture();
    cost.mockRejectedValue(new Error('tariff unavailable'));
    await handler.handle(message());
    expect(tx.isActive).toBe(false);
    expect(save).toHaveBeenCalledOnce();
  });
  it('propagates a failed combined save so the durable write is not reported successful', async () => {
    const { handler, save } = fixture();
    save.mockRejectedValue(new Error('write failed'));
    await expect(handler.handle(message())).rejects.toThrow('write failed');
  });
  it('ignores repeated physical stops after durable finalization', async () => {
    const { handler, tx, cost, createStop, save } = fixture();
    tx.isActive = false;
    await handler.handle(message());
    expect(createStop).not.toHaveBeenCalled();
    expect(cost).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
