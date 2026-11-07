// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import '@test/unit-isolation.js';
import { DEFAULT_TENANT_ID } from '@citrineos/base';
import { type ITariffRepository } from '@citrineos/dal';
import type { TariffDto } from '@citrineos/types';
import { afterEach, beforeEach, describe, expect, it, type Mocked, vi } from 'vitest';
import { createTestContainer, getTestInstance } from '@test/test-container.js';
import { CostCalculator } from '@modules/transactions/cost-calculator.js';
import { aTariff } from './providers/tariff.js';
import { aTransaction } from './providers/transaction-provider.js';

describe('CostCalculator', () => {
  const { container } = createTestContainer();
  let tariffRepository: Pick<Mocked<ITariffRepository>, 'findByConnectorId' | 'findById'>;
  let costCalculator: CostCalculator;

  beforeEach(() => {
    tariffRepository = {
      findByConnectorId: vi.fn(),
      findById: vi.fn(),
    };

    costCalculator = getTestInstance(container, CostCalculator, {
      tariffRepository,
    });
  });

  afterEach(() => {
    tariffRepository.findByConnectorId.mockReset();
  });

  describe('calculateTotalCostByTariffId', () => {
    it('uses the immutable transaction tariff instead of the current connector assignment', async () => {
      tariffRepository.findById.mockResolvedValue(aTariff({ pricePerKwh: 0.47 }));

      await expect(
        costCalculator.calculateTotalCostByTariffId(DEFAULT_TENANT_ID, 42, 20.99),
      ).resolves.toBe(9.86);
      expect(tariffRepository.findById).toHaveBeenCalledWith(DEFAULT_TENANT_ID, 42);
      expect(tariffRepository.findByConnectorId).not.toHaveBeenCalled();
    });

    it('returns zero for an explicit free tariff', async () => {
      tariffRepository.findById.mockResolvedValue(aTariff({ pricePerKwh: 0 }));

      await expect(
        costCalculator.calculateTotalCostByTariffId(DEFAULT_TENANT_ID, 42, 20.99),
      ).resolves.toBe(0);
    });

    it('returns undefined when the locked tariff cannot be found', async () => {
      tariffRepository.findById.mockResolvedValue(undefined);

      await expect(
        costCalculator.calculateTotalCostByTariffId(DEFAULT_TENANT_ID, 42, 20.99),
      ).resolves.toBeUndefined();
    });

    it('uses legacy energy, time, fixed and payment fields and applies legacy tax', async () => {
      tariffRepository.findById.mockResolvedValue(
        aTariff({
          pricePerKwh: 2,
          pricePerMin: 0.5,
          pricePerSession: 3,
          paymentFee: 1,
          taxRate: 10,
          authorizationAmount: 999,
        }),
      );

      await expect(
        costCalculator.calculateTotalCostByTariffId(DEFAULT_TENANT_ID, 42, 4, {
          chargingDurationSeconds: 600,
          sessionDurationSeconds: 600,
        }),
      ).resolves.toBe(18.7);
    });

    it('prefers structured prices, applies component tax, and clamps to maxCost', async () => {
      tariffRepository.findById.mockResolvedValue(
        aTariff({
          pricePerKwh: 999,
          pricePerMin: 999,
          pricePerSession: 999,
          energy: { prices: [{ priceKwh: 2 }], taxRates: [{ type: 'VAT', tax: 10 }] },
          chargingTime: { prices: [{ priceMinute: 0.5 }] },
          fixedFee: { prices: [{ priceFixed: 3 }] },
          maxCost: { inclTax: 15 },
        }),
      );

      await expect(
        costCalculator.calculateTotalCostByTariffId(DEFAULT_TENANT_ID, 42, 4, {
          chargingDurationSeconds: 600,
          sessionDurationSeconds: 600,
        }),
      ).resolves.toBe(15);
    });

    it('does not add idle fees unless a reliable idle duration is supplied', async () => {
      tariffRepository.findById.mockResolvedValue(
        aTariff({
          pricePerKwh: 0,
          idleTime: { prices: [{ priceMinute: 2 }] },
        }),
      );

      await expect(
        costCalculator.calculateTotalCostByTariffId(DEFAULT_TENANT_ID, 42, 0, {
          sessionDurationSeconds: 600,
        }),
      ).resolves.toBe(0);
      await expect(
        costCalculator.calculateTotalCostByTariffId(DEFAULT_TENANT_ID, 42, 0, {
          sessionDurationSeconds: 600,
          idleDurationSeconds: 120,
        }),
      ).resolves.toBe(4);
    });

    it('applies tax stacks sequentially and duration conditions in seconds', async () => {
      tariffRepository.findById.mockResolvedValue(
        aTariff({
          pricePerKwh: 0,
          chargingTime: {
            prices: [{ priceMinute: 1, conditions: { minChargingTime: 60, maxChargingTime: 121 } }],
            taxRates: [
              { type: 'VAT', tax: 10, stack: 0 },
              { type: 'LOCAL', tax: 10, stack: 1 },
            ],
          },
        }),
      );

      await expect(
        costCalculator.calculateTotalCostByTariffId(DEFAULT_TENANT_ID, 42, 0, {
          chargingDurationSeconds: 120,
          sessionDurationSeconds: 120,
        }),
      ).resolves.toBe(2.42);
    });
  });

  describe('calculateTotalCost', () => {
    it.each([
      { tariff: anEnergyTariff(0.09), kwh: 20, expectedCost: 1.8 },
      { tariff: anEnergyTariff(0.14), kwh: 20, expectedCost: 2.8 },
      { tariff: anEnergyTariff(0.23), kwh: 20, expectedCost: 4.6 },
      { tariff: anEnergyTariff(0.25), kwh: 20, expectedCost: 5.0 },
      { tariff: anEnergyTariff(0.47), kwh: 20, expectedCost: 9.4 },
      { tariff: anEnergyTariff(0.61), kwh: 20, expectedCost: 12.2 },
    ])('should calculate cost using provided kWh', async ({ tariff, kwh, expectedCost }) => {
      givenTariff(tariff);
      expect(
        await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, aChargingTransaction(kwh)),
      ).toBe(expectedCost);
    });

    it.each([
      { tariff: anEnergyTariff(0.09), kwh: 20.99, expectedCost: 1.88 },
      { tariff: anEnergyTariff(0.14), kwh: 20.99, expectedCost: 2.93 },
      { tariff: anEnergyTariff(0.23), kwh: 20.99, expectedCost: 4.82 },
      { tariff: anEnergyTariff(0.25), kwh: 20.99, expectedCost: 5.24 },
      { tariff: anEnergyTariff(0.47), kwh: 20.99, expectedCost: 9.86 },
      { tariff: anEnergyTariff(0.61), kwh: 20.99, expectedCost: 12.8 },
    ])('should floor cost to 2 decimal places', async ({ tariff, kwh, expectedCost }) => {
      givenTariff(tariff);
      expect(
        await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, aChargingTransaction(kwh)),
      ).toBe(expectedCost);
    });

    it('should add time cost using minutes converted from timeSpentCharging seconds', async () => {
      givenTariff(aTariff({ pricePerKwh: 0, pricePerMin: 0.3, pricePerSession: null }));
      const transaction = aChargingTransaction(0, 120);
      expect(await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, transaction)).toBe(0.6);
    });

    it('should add per-session cost', async () => {
      givenTariff(aTariff({ pricePerKwh: 0, pricePerMin: null, pricePerSession: 1.5 }));
      const transaction = aChargingTransaction(0, 0);
      expect(await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, transaction)).toBe(1.5);
    });

    it('should sum energy, time and session costs', async () => {
      givenTariff(aTariff({ pricePerKwh: 0.2, pricePerMin: 0.1, pricePerSession: 1 }));
      const transaction = aChargingTransaction(10, 600);
      // 10 kWh * 0.2 + 10 min * 0.1 + 1 session = 2 + 1 + 1
      expect(await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, transaction)).toBe(4);
    });

    it('should return 0 when tariff not found', async () => {
      expect(
        await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, aChargingTransaction(20.99)),
      ).toBe(0);
    });

    it('should return 0 when connectorId is not set', async () => {
      givenTariff(anEnergyTariff(0.61));
      const transaction = aChargingTransaction(20);
      transaction.connectorId = undefined;
      expect(await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, transaction)).toBe(0);
    });

    it('should return 0 when totalKwh is not set', async () => {
      givenTariff(anEnergyTariff(0.61));
      const transaction = aChargingTransaction(20);
      transaction.totalKwh = null;
      expect(await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, transaction)).toBe(0);
    });

    it('preserves evidenced energy pricing when charging duration is unknown', async () => {
      givenTariff(anEnergyTariff(0.61));
      const transaction = aChargingTransaction(20);
      transaction.timeSpentCharging = null;
      expect(await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, transaction)).toBe(12.2);
    });

    it('should return 0 when pricePerKwh is 0', async () => {
      givenTariff(anEnergyTariff(0.0));
      expect(
        await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, aChargingTransaction(20.99)),
      ).toBe(0);
    });

    it('should return 0 when kWh is 0', async () => {
      givenTariff(anEnergyTariff(0.61));
      expect(
        await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, aChargingTransaction(0)),
      ).toBe(0);
    });

    it.each([
      { tariff: anEnergyTariff(0.01), kwh: 0.99 },
      { tariff: anEnergyTariff(0.2), kwh: 0.049 },
      { tariff: anEnergyTariff(0.23), kwh: 0.02 },
    ])('should return 0 when calculated cost is less than 0.01', async ({ tariff, kwh }) => {
      givenTariff(tariff);
      expect(
        await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, aChargingTransaction(kwh)),
      ).toBe(0);
    });
  });

  function anEnergyTariff(pricePerKwh: number): TariffDto {
    return aTariff({ pricePerKwh, pricePerMin: null, pricePerSession: null });
  }

  function aChargingTransaction(totalKwh: number, timeSpentCharging = 0, connectorId = 1) {
    return aTransaction((transaction) => {
      transaction.connectorId = connectorId;
      transaction.totalKwh = totalKwh;
      transaction.timeSpentCharging = timeSpentCharging;
    });
  }

  function givenTariff(tariff: TariffDto) {
    tariffRepository.findByConnectorId.mockResolvedValue(tariff);
    return tariff;
  }
});
