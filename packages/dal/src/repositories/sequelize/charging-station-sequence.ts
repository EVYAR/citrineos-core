// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import type { Transaction as SequelizeTransaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import type { ChargingStationSequenceTypeEnumType } from '@citrineos/types';
import type { IChargingStationSequenceRepository } from '../repositories.js';
import { ChargingStationSequence } from '../../models/charging-station-sequence/charging-station-sequence.js';
import { SequelizeRepository, type SequelizeRepositoryDependencies } from './base.js';
import { resolveStationIdOrThrow } from './resolve-station-id.js';

const POSITIVE_SEQUENCE_TEXT = /^[1-9][0-9]*$/;

export class SequelizeChargingStationSequenceRepository
  extends SequelizeRepository<ChargingStationSequence>
  implements IChargingStationSequenceRepository
{
  private static readonly SEQUENCE_START = 1;

  constructor({ config, logger, sequelizeInstance }: SequelizeRepositoryDependencies) {
    super({ config, namespace: ChargingStationSequence.MODEL_NAME, logger, sequelizeInstance });
  }

  /**
   * Converts a Sequelize bigint value to a JavaScript number.
   * Sequelize returns PostgreSQL BIGINT columns as strings to avoid precision loss,
   * but OCPP requires numeric types (e.g., requestId in GetChargingProfilesRequest).
   *
   * @param value - The value from Sequelize (may be string or number)
   * @returns A JavaScript number
   */
  private _ensureNumber(value: string | number | null | undefined): number {
    const parsed =
      typeof value === 'string' && POSITIVE_SEQUENCE_TEXT.test(value) ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error('Cannot allocate a valid positive charging-station sequence value');
    }
    return parsed;
  }

  async getNextSequenceValue(
    tenantId: number,
    ocppConnectionName: string,
    type: ChargingStationSequenceTypeEnumType,
    existingTransaction?: SequelizeTransaction,
  ): Promise<number> {
    const next = async (transaction: SequelizeTransaction) => {
      const stationId = await resolveStationIdOrThrow(
        tenantId,
        ocppConnectionName,
        `allocate a ${type} sequence value`,
        transaction,
      );
      // Match Drizzle's one-statement allocation without findOrCreate's temporary function.
      const rows = await this.s.query<{ value: string }>(
        `INSERT INTO "ChargingStationSequences"
          ("tenantId", "stationId", "type", "value", "createdAt", "updatedAt")
        VALUES ($tenantId, $stationId, $type, $start, $now, $now)
        ON CONFLICT ("stationId", "type") DO UPDATE
          SET "value" = "ChargingStationSequences"."value" + 1,
              "updatedAt" = EXCLUDED."updatedAt"
          WHERE "ChargingStationSequences"."tenantId" = EXCLUDED."tenantId"
            AND "ChargingStationSequences"."value" BETWEEN 0 AND $maxCurrentValue
        RETURNING "value"::text AS "value"`,
        {
          bind: {
            tenantId,
            stationId,
            type,
            start: SequelizeChargingStationSequenceRepository.SEQUENCE_START,
            now: new Date(),
            maxCurrentValue: Number.MAX_SAFE_INTEGER - 1,
          },
          type: QueryTypes.SELECT,
          transaction,
        },
      );
      if (rows.length !== 1) {
        throw new Error('Cannot allocate a valid positive charging-station sequence value');
      }
      return this._ensureNumber(rows[0].value);
    };
    return existingTransaction ? next(existingTransaction) : this.s.transaction(next);
  }
}

export default SequelizeChargingStationSequenceRepository;
