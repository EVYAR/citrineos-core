// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { Money } from '@citrineos/base';
import type { ITariffRepository } from '@citrineos/dal';
import type { TariffDto as Tariff, TransactionDto, OCPP2_1 } from '@citrineos/types';
import type { ILogObj } from 'tslog';
import { Logger } from 'tslog';

export interface TariffUsage {
  totalKwh: number;
  chargingDurationSeconds?: number;
  sessionDurationSeconds?: number;
  idleDurationSeconds?: number;
  occurredAt?: Date;
}

export class CostCalculator {
  private readonly _logger: Logger<ILogObj>;

  private readonly _tariffRepository: ITariffRepository;

  constructor({
    tariffRepository,
    logger,
  }: {
    tariffRepository: ITariffRepository;
    logger: Logger<ILogObj>;
  }) {
    this._tariffRepository = tariffRepository;
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
  async calculateTotalCost(tenantId: number, transaction: TransactionDto): Promise<number> {
    if (transaction.connectorId == null || transaction.totalKwh == null) {
      this._logger.error('Cannot calculate cost: connectorId or totalKwh is not set');
      return 0;
    }
    const usage = {
      totalKwh: transaction.totalKwh,
      chargingDurationSeconds: transaction.timeSpentCharging ?? undefined,
      sessionDurationSeconds: elapsedSeconds(transaction.startTime, transaction.endTime),
      occurredAt: transaction.endTime ? new Date(transaction.endTime) : new Date(),
    };
    const tariff = await this._tariffRepository.findByConnectorId(
      tenantId,
      transaction.connectorId,
    );
    return tariff ? this.calculateTariffCost(tariff, usage) : 0;
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
    usage: Omit<TariffUsage, 'totalKwh'> = {},
  ): Promise<number | undefined> {
    const tariff = await this._tariffRepository.findById(tenantId, tariffId);
    if (!tariff) {
      this._logger.error(`Locked tariff ${tariffId} not found`);
      return undefined;
    }
    this._logger.debug(`Calculating total cost with locked tariff ${tariffId}`);
    return this.calculateTariffCost(tariff, { totalKwh, ...usage });
  }

  /**
   * Best-effort operational estimate using every tariff field for which Core
   * has reliable transaction evidence. CSMS still owns the immutable billing
   * CDR: this method intentionally skips idle/reservation prices when their
   * duration is unknown and never treats authorizationAmount as a charge.
   */
  private calculateTariffCost(tariff: Tariff, usage: TariffUsage): number {
    const occurredAt = usage.occurredAt ?? new Date();
    const tariffValidFrom = dateValue(tariff.validFrom);
    if (tariffValidFrom && occurredAt < tariffValidFrom) return 0;
    const chargingMinutes =
      Math.max(0, usage.chargingDurationSeconds ?? usage.sessionDurationSeconds ?? 0) / 60;
    const idleMinutes = Math.max(0, usage.idleDurationSeconds ?? 0) / 60;
    let structuredTotal = 0;
    let legacySubtotal = 0;

    if (tariff.energy?.prices?.length) {
      structuredTotal += this.structuredUsageCost(
        tariff.energy.prices,
        'priceKwh',
        Math.max(0, usage.totalKwh),
        tariff.energy.taxRates,
        usage,
        occurredAt,
      );
    } else {
      legacySubtotal += finite(tariff.pricePerKwh) * Math.max(0, usage.totalKwh);
    }

    if (tariff.chargingTime?.prices?.length) {
      structuredTotal += this.structuredUsageCost(
        tariff.chargingTime.prices,
        'priceMinute',
        chargingMinutes,
        tariff.chargingTime.taxRates,
        usage,
        occurredAt,
      );
    } else {
      legacySubtotal += finite(tariff.pricePerMin) * chargingMinutes;
    }

    if (usage.idleDurationSeconds != null && tariff.idleTime?.prices?.length) {
      structuredTotal += this.structuredUsageCost(
        tariff.idleTime.prices,
        'priceMinute',
        idleMinutes,
        tariff.idleTime.taxRates,
        usage,
        occurredAt,
      );
    }

    if (tariff.fixedFee?.prices?.length) {
      structuredTotal += this.structuredFixedCost(tariff.fixedFee, occurredAt);
    } else {
      legacySubtotal += finite(tariff.pricePerSession);
    }

    legacySubtotal += finite(tariff.paymentFee);

    // Legacy tax belongs only to legacy amounts. Structured components carry
    // their own tax rates and are already tax-adjusted above.
    let total = structuredTotal + legacySubtotal * (1 + finite(tariff.taxRate) / 100);

    total = Math.max(total, this.priceBoundary(tariff.minCost, 0));
    const maximum = this.priceBoundary(tariff.maxCost, Number.POSITIVE_INFINITY);
    total = Math.min(total, maximum);

    // Remove binary floating-point residue (for example 0.09 * 20 becoming
    // 1.799999...) before Money applies Core's deliberate round-down policy.
    return Money.of(Number(total.toFixed(12)), tariff.currency)
      .roundToCurrencyScale()
      .toNumber();
  }

  private structuredUsageCost(
    prices: Array<Record<string, unknown>>,
    priceField: 'priceKwh' | 'priceMinute',
    quantity: number,
    taxRates: Array<{ tax: number; stack?: number | null }> | null | undefined,
    usage: TariffUsage,
    occurredAt: Date,
  ): number {
    const price = prices.find((candidate) =>
      this.conditionsMatch(candidate.conditions, usage, occurredAt),
    );
    if (!price) return 0;
    return finite(price[priceField]) * quantity * taxMultiplier(taxRates);
  }

  private structuredFixedCost(fixed: OCPP2_1.TariffFixedType, occurredAt: Date): number {
    const price = fixed.prices.find((candidate) =>
      this.fixedConditionsMatch(candidate.conditions, occurredAt),
    );
    return price ? finite(price.priceFixed) * taxMultiplier(fixed.taxRates) : 0;
  }

  private conditionsMatch(conditions: unknown, usage: TariffUsage, occurredAt: Date): boolean {
    if (!conditions || typeof conditions !== 'object') return true;
    const value = conditions as Record<string, unknown>;
    if (!this.dateConditionsMatch(value, occurredAt)) return false;
    if (!between(usage.totalKwh, value.minEnergy, value.maxEnergy)) return false;
    const sessionSeconds = usage.sessionDurationSeconds ?? 0;
    const chargingSeconds = usage.chargingDurationSeconds ?? usage.sessionDurationSeconds ?? 0;
    const idleSeconds = usage.idleDurationSeconds ?? 0;
    if (!between(sessionSeconds, value.minTime, value.maxTime)) return false;
    if (!between(chargingSeconds, value.minChargingTime, value.maxChargingTime)) return false;
    if (!between(idleSeconds, value.minIdleTime, value.maxIdleTime)) return false;
    // Core cannot prove electrical/payment/EVSE-kind conditions from the
    // calculator input. Never charge a conditional price it cannot verify.
    return !['minCurrent', 'maxCurrent', 'minPower', 'maxPower', 'evseKind'].some(
      (key) => value[key] != null,
    );
  }

  private fixedConditionsMatch(conditions: unknown, occurredAt: Date): boolean {
    if (!conditions || typeof conditions !== 'object') return true;
    const value = conditions as Record<string, unknown>;
    if (!this.dateConditionsMatch(value, occurredAt)) return false;
    return !['evseKind', 'paymentBrand', 'paymentRecognition'].some((key) => value[key] != null);
  }

  private dateConditionsMatch(value: Record<string, unknown>, occurredAt: Date): boolean {
    const from = dateValue(value.validFromDate);
    const to = dateValue(value.validToDate);
    if (from && occurredAt < from) return false;
    if (to && occurredAt > to) return false;
    const timeOfDay = occurredAt.toISOString().slice(11, 19);
    if (typeof value.startTimeOfDay === 'string' && timeOfDay < value.startTimeOfDay) return false;
    if (typeof value.endTimeOfDay === 'string' && timeOfDay > value.endTimeOfDay) return false;
    if (Array.isArray(value.dayOfWeek)) {
      const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
        occurredAt.getUTCDay()
      ];
      if (
        !value.dayOfWeek.some((candidate) => String(candidate).toLowerCase() === day.toLowerCase())
      ) {
        return false;
      }
    }
    return true;
  }

  private priceBoundary(price: Tariff['minCost'] | Tariff['maxCost'], fallback: number): number {
    if (!price) return fallback;
    if (price.inclTax != null) return finite(price.inclTax);
    if (price.exclTax != null) return finite(price.exclTax) * taxMultiplier(price.taxRates);
    return fallback;
  }
}

function finite(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function taxMultiplier(
  rates: Array<{ tax: number; stack?: number | null }> | null | undefined,
): number {
  const byStack = new Map<number, number>();
  for (const rate of rates ?? []) {
    const stack = rate.stack ?? 0;
    byStack.set(stack, (byStack.get(stack) ?? 0) + finite(rate.tax));
  }
  return [...byStack.entries()]
    .sort(([left], [right]) => left - right)
    .reduce((multiplier, [, tax]) => multiplier * (1 + tax / 100), 1);
}

function between(value: number, minimum: unknown, maximum: unknown): boolean {
  return (
    (minimum == null || value >= finite(minimum)) && (maximum == null || value < finite(maximum))
  );
}

function dateValue(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function elapsedSeconds(start?: string | null, end?: string | null): number | undefined {
  if (!start || !end) return undefined;
  const seconds = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : undefined;
}
