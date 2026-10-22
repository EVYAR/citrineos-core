// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { type BootstrapConfig } from '@citrineos/base';
import { Op, QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type { ILogObj, Logger } from 'tslog';
import { ChargingAdmissionCallout } from '../../dal/layers/sequelize/model/ChargingAdmissionCallout.js';
import { DefaultSequelizeInstance } from '../../dal/layers/sequelize/util.js';
import type { BeginResult, ChargingCalloutKey, ChargingCalloutRow, ChargingCalloutStore } from './ChargingCalloutLedger.js';

const toRow = (m: ChargingAdmissionCallout): ChargingCalloutRow => ({
  id: m.id, tenantId: m.tenantId, ocppConnectionName: m.ocppConnectionName, authorizationId: m.authorizationId, connectorId: m.connectorId,
  state: m.state as ChargingCalloutRow['state'], requestedAt: m.requestedAt, decidedAt: m.decidedAt, coreEvidenceRef: m.coreEvidenceRef,
  declineDeliveredAt: m.declineDeliveredAt, declineAttempts: m.declineAttempts, nextDeclineAt: m.nextDeclineAt, lastDeclineError: m.lastDeclineError,
  declineAbandoned: m.declineAbandoned,
});

/** Postgres-backed ledger. State changes are single conditional UPDATEs, so the database arbitrates every race. */
export class SequelizeChargingCalloutStore implements ChargingCalloutStore {
  private readonly s: Sequelize;

  constructor({ config, logger, sequelizeInstance }: { config: BootstrapConfig; logger?: Logger<ILogObj>; sequelizeInstance?: Sequelize }) {
    this.s = sequelizeInstance ?? DefaultSequelizeInstance.getInstance(config, logger);
  }

  async begin(key: ChargingCalloutKey, now: Date, reuseWindowMs: number, fenceMs: number): Promise<BeginResult> {
    return this.s.transaction(async (transaction) => {
      // Serialise concurrent callouts for the SAME request so exactly one ref is minted.
      await this.s.query('SELECT pg_advisory_xact_lock(hashtextextended(:lock, 0))', {
        replacements: { lock: `chargingCallout:${key.tenantId}:${key.ocppConnectionName}:${key.authorizationId}:${key.connectorId}` },
        type: QueryTypes.SELECT, transaction,
      });
      const latest = await ChargingAdmissionCallout.findOne({ where: { ...key }, order: [['requestedAt', 'DESC']], transaction });
      if (latest) {
        if (latest.state === 'DECLINED_BEFORE_POWER' && latest.decidedAt && now.getTime() - latest.decidedAt.getTime() < fenceMs) {
          return { kind: 'FENCED_DECLINED' as const, ref: latest.id, coreEvidenceRef: latest.coreEvidenceRef! };
        }
        if (latest.state === 'PENDING' && now.getTime() - latest.requestedAt.getTime() < reuseWindowMs) return { kind: 'CALLOUT' as const, ref: latest.id };
      }
      const created = await ChargingAdmissionCallout.create({ id: randomUUID(), ...key, state: 'PENDING', requestedAt: now }, { transaction });
      return { kind: 'CALLOUT' as const, ref: created.id };
    });
  }

  async markAuthorized(ref: string, now: Date): Promise<boolean> {
    const [count] = await ChargingAdmissionCallout.update({ state: 'AUTHORIZED', decidedAt: now }, { where: { id: ref, state: 'PENDING' } });
    return count === 1;
  }

  async markDeclined(ref: string, coreEvidenceRef: string, now: Date): Promise<boolean> {
    const [count] = await ChargingAdmissionCallout.update({ state: 'DECLINED_BEFORE_POWER', decidedAt: now, coreEvidenceRef, nextDeclineAt: now }, { where: { id: ref, state: 'PENDING' } });
    return count === 1;
  }

  async get(ref: string) {
    const m = await ChargingAdmissionCallout.findByPk(ref);
    return m ? toRow(m) : null;
  }

  async dueDeclines(now: Date, limit: number) {
    const rows = await ChargingAdmissionCallout.findAll({
      where: { state: 'DECLINED_BEFORE_POWER', declineDeliveredAt: null, declineAbandoned: false, [Op.or]: [{ nextDeclineAt: null }, { nextDeclineAt: { [Op.lte]: now } }] },
      order: [['nextDeclineAt', 'ASC']], limit,
    });
    return rows.map(toRow);
  }

  async markDeclineDelivered(ref: string, now: Date) {
    await ChargingAdmissionCallout.update({ declineDeliveredAt: now, lastDeclineError: null }, { where: { id: ref } });
  }

  async recordDeclineFailure(ref: string, error: string, nextAt: Date | null, abandoned: boolean) {
    await this.s.query(
      'UPDATE "ChargingAdmissionCallouts" SET "declineAttempts" = "declineAttempts" + 1, "lastDeclineError" = :error, "nextDeclineAt" = :nextAt, "declineAbandoned" = :abandoned, "updatedAt" = now() WHERE "id" = :ref',
      { replacements: { ref, error: error.slice(0, 500), nextAt, abandoned }, type: QueryTypes.UPDATE },
    );
  }
}
