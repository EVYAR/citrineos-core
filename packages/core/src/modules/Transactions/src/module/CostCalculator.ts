// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { Money } from '@citrineos/base';
import type { ITariffRepository } from '@dal/interfaces/repositories.js';
import { Tariff } from '@dal/layers/sequelize/model/Tariff/index.js';
import type { ILogObj } from 'tslog';
import { Logger } from 'tslog';
import { TransactionService } from './TransactionService.js';

export class CostCalculator {
  private readonly _logger: Logger<ILogObj>;

  private readonly _tariffRepository: ITariffRepository;
  private readonly _transactionService: TransactionService;

  constructor({
    tariffRepository,
    transactionService,
    logger,
  }: {
    tariffRepository: ITariffRepository;
    transactionService: TransactionService;
    logger: Logger<ILogObj>;
  }) {
    this._tariffRepository = tariffRepository;
    this._transactionService = transactionService;
    this._logger = logger
      ? logger.getSubLogger({ name: this.constructor.name })
      : new Logger<ILogObj>({ name: this.constructor.name });
  }

  /**
   * Calculates the total cost for a transaction.
   *
   * Computes the cost based on `connectorId` and `totalKwh`.
   *
   * @param connectorId - The database ID of the connector.
   * @param totalKwh - The total kilowatt-hours.
   *
   * @returns A promise that resolves to the total cost.
   */
  async calculateTotalCost(
    tenantId: number,
    connectorId: number | undefined,
    totalKwh: number,
  ): Promise<number> {
    if (connectorId == null) {
      this._logger.error('Cannot calculate cost: connectorId is not set on transaction');
      return 0;
    }
    this._logger.debug(`Calculating total cost for connector ${connectorId} and ${totalKwh} kWh`);
    const tariff: Tariff | undefined = await this._tariffRepository.findByConnectorId(
      tenantId,
      connectorId,
    );
    if (tariff) {
      this._logger.debug(`Tariff ${tariff.id} found for connector ${connectorId}`);
      return this.calculateEnergyCost(tariff, totalKwh);
    } else {
      this._logger.error(`Tariff not found for connector ${connectorId}`);
      return 0;
    }
  }

  /**
   * Calculates cost from the tariff locked onto a transaction at start.
   *
   * Connector assignments are mutable, so looking the tariff up through the
   * connector when a transaction ends can silently reprice an in-flight
   * session. Callers finalizing a transaction should use this method with the
   * transaction's persisted tariff id instead.
   *
   * `undefined` deliberately means that the locked tariff no longer exists;
   * it must not be confused with an explicit zero-price tariff.
   */
  async calculateTotalCostByTariffId(
    tenantId: number,
    tariffId: number,
    totalKwh: number,
  ): Promise<number | undefined> {
    const tariff = await this._tariffRepository.readByKey(tenantId, tariffId.toString());
    if (!tariff) {
      this._logger.error(`Locked tariff ${tariffId} not found`);
      return undefined;
    }
    this._logger.debug(`Calculating total cost with locked tariff ${tariffId}`);
    return this.calculateEnergyCost(tariff, totalKwh);
  }

  private calculateEnergyCost(tariff: Tariff, totalKwh: number): number {
    return Money.of(tariff.pricePerKwh, tariff.currency)
      .multiply(totalKwh)
      .roundToCurrencyScale()
      .toNumber();
  }
}
