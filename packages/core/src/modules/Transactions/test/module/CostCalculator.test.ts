// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_TENANT_ID } from '@citrineos/base';
import { ITariffRepository, Tariff } from '@citrineos/core';
import { faker } from '@faker-js/faker';
import { afterEach, beforeEach, describe, expect, it, Mocked, vi } from 'vitest';
import { createTestContainer, getTestInstance } from '../../../../test/testContainer.js';
import { CostCalculator } from '../../src/module/CostCalculator.js';
import { TransactionService } from '../../src/module/TransactionService.js';
import { aTariff } from '../providers/Tariff.js';

describe('CostCalculator', () => {
  const { container } = createTestContainer();
  let tariffRepository: Mocked<ITariffRepository>;
  let transactionService: Mocked<TransactionService>;
  let costCalculator: CostCalculator;

  beforeEach(() => {
    tariffRepository = {
      findByConnectorId: vi.fn(),
      readByKey: vi.fn(),
    } as unknown as Mocked<ITariffRepository>;

    transactionService = {
      recalculateTotalKwh: vi.fn(),
    } as unknown as Mocked<TransactionService>;

    costCalculator = getTestInstance(container, CostCalculator, {
      tariffRepository,
      transactionService,
    });
  });

  afterEach(() => {
    tariffRepository.findByConnectorId.mockReset();
    tariffRepository.readByKey.mockReset();
    transactionService.recalculateTotalKwh.mockReset();
  });

  describe('calculateTotalCostByTariffId', () => {
    it('uses the immutable transaction tariff instead of the current connector assignment', async () => {
      tariffRepository.readByKey.mockResolvedValue(aTariff({ pricePerKwh: 0.47 }));

      await expect(
        costCalculator.calculateTotalCostByTariffId(DEFAULT_TENANT_ID, 42, 20.99),
      ).resolves.toBe(9.86);
      expect(tariffRepository.readByKey).toHaveBeenCalledWith(DEFAULT_TENANT_ID, '42');
      expect(tariffRepository.findByConnectorId).not.toHaveBeenCalled();
    });

    it('returns zero for an explicit free tariff', async () => {
      tariffRepository.readByKey.mockResolvedValue(aTariff({ pricePerKwh: 0 }));

      await expect(
        costCalculator.calculateTotalCostByTariffId(DEFAULT_TENANT_ID, 42, 20.99),
      ).resolves.toBe(0);
    });

    it('returns undefined when the locked tariff cannot be found', async () => {
      tariffRepository.readByKey.mockResolvedValue(undefined);

      await expect(
        costCalculator.calculateTotalCostByTariffId(DEFAULT_TENANT_ID, 42, 20.99),
      ).resolves.toBeUndefined();
    });

    it('uses legacy energy, time, fixed and payment fields and applies legacy tax', async () => {
      tariffRepository.readByKey.mockResolvedValue(
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
      tariffRepository.readByKey.mockResolvedValue(
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
      tariffRepository.readByKey.mockResolvedValue(
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
      tariffRepository.readByKey.mockResolvedValue(
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
      { tariff: aTariff({ pricePerKwh: 0.09 }), kwh: 20, expectedCost: 1.8 },
      { tariff: aTariff({ pricePerKwh: 0.14 }), kwh: 20, expectedCost: 2.8 },
      { tariff: aTariff({ pricePerKwh: 0.23 }), kwh: 20, expectedCost: 4.6 },
      { tariff: aTariff({ pricePerKwh: 0.25 }), kwh: 20, expectedCost: 5.0 },
      { tariff: aTariff({ pricePerKwh: 0.47 }), kwh: 20, expectedCost: 9.4 },
      { tariff: aTariff({ pricePerKwh: 0.61 }), kwh: 20, expectedCost: 12.2 },
    ])('should calculate cost using provided kWh', async ({ tariff, kwh, expectedCost }) => {
      givenTariff(tariff);
      expect(await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, 1, kwh)).toBe(expectedCost);
    });

    it.each([
      {
        tariff: aTariff({ pricePerKwh: 0.09 }),
        kwh: 20.99,
        expectedCost: 1.88,
      },
      {
        tariff: aTariff({ pricePerKwh: 0.14 }),
        kwh: 20.99,
        expectedCost: 2.93,
      },
      {
        tariff: aTariff({ pricePerKwh: 0.23 }),
        kwh: 20.99,
        expectedCost: 4.82,
      },
      {
        tariff: aTariff({ pricePerKwh: 0.25 }),
        kwh: 20.99,
        expectedCost: 5.24,
      },
      {
        tariff: aTariff({ pricePerKwh: 0.47 }),
        kwh: 20.99,
        expectedCost: 9.86,
      },
      {
        tariff: aTariff({ pricePerKwh: 0.61 }),
        kwh: 20.99,
        expectedCost: 12.8,
      },
    ])('should floor cost to 2 decimal places', async ({ tariff, kwh, expectedCost }) => {
      givenTariff(tariff);
      expect(await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, 1, kwh)).toBe(expectedCost);
    });

    it('should return 0 when tariff not found', async () => {
      const anyStationId = faker.string.uuid();
      expect(await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, anyStationId, 20.99)).toBe(
        0,
      );
    });

    it('should return 0 when pricePerKwh is 0', async () => {
      givenTariff(aTariff({ pricePerKwh: 0.0 }));
      expect(await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, 1, 20.99)).toBe(0);
    });

    it('should return 0 when kWh is 0', async () => {
      givenTariff(aTariff({ pricePerKwh: 0.61 }));
      expect(await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, 1, 0)).toBe(0);
    });

    it.each([
      { tariff: aTariff({ pricePerKwh: 0.01 }), kwh: 0.99 },
      { tariff: aTariff({ pricePerKwh: 0.2 }), kwh: 0.049 },
      { tariff: aTariff({ pricePerKwh: 0.23 }), kwh: 0.02 },
    ])('should return 0 when calculated cost is less than 0.01', async ({ tariff, kwh }) => {
      givenTariff(tariff);
      expect(await costCalculator.calculateTotalCost(DEFAULT_TENANT_ID, 1, kwh)).toBe(0);
    });
  });

  function givenTariff(tariff: Tariff) {
    tariffRepository.findByConnectorId.mockResolvedValue(tariff);
    return tariff;
  }
});
