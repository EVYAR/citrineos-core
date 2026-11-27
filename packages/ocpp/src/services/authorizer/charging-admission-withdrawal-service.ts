// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { DatabaseError, QueryTypes, Transaction, UniqueConstraintError } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { DefaultSequelizeInstance } from '@citrineos/dal';
import type { ChargingAdmissionWithdrawalReceipt, ChargingAdmissionWithdrawalRequest, SystemConfig } from '@citrineos/types';
import type { ILogObj, Logger } from 'tslog';
import {
  ChargingAdmissionWithdrawalConflict,
  proveAllRetainedNativeSessions,
  withdrawalRequestHash,
  type RetainedNativeSession,
} from './charging-admission-withdrawal-proof.js';

interface WithdrawalRow {
  requestHash: string;
  actorSubject: string;
  receipt: ChargingAdmissionWithdrawalReceipt;
}
interface CalloutRow {
  id: string; tenantId: number; ocppConnectionName: string; authorizationId: number;
  connectorId: number; state: string; decidedAt: string | null;
}
interface ConnectorRow { id: number; tenantId: number; stationId: number; connectorId: number }

/** Normal owner command, restricted to the configured canonical realtime path. */
export class ChargingAdmissionWithdrawalService {
  private readonly s: Sequelize;
  private readonly enabled: boolean;

  constructor({ config, logger, sequelizeInstance }: {
    config: SystemConfig; logger: Logger<ILogObj>; sequelizeInstance?: Sequelize;
  }) {
    this.s = sequelizeInstance ?? DefaultSequelizeInstance.getInstance(config, logger);
    this.enabled = config.realTimeAuthChargingCallouts?.enabled === true;
  }

  private requireEnabled(): void {
    if (!this.enabled) throw new ChargingAdmissionWithdrawalConflict('Canonical realtime charging callouts are not enabled');
  }

  private async select<T extends object>(sql: string, replacements: Record<string, unknown>, transaction?: Transaction): Promise<T[]> {
    return this.s.query<T>(sql, { replacements, transaction, type: QueryTypes.SELECT });
  }

  async read(tenantId: number, ref: string, actorSubject: string): Promise<ChargingAdmissionWithdrawalReceipt | null> {
    this.requireEnabled();
    const rows = await this.select<WithdrawalRow>(
      'SELECT "requestHash", "actorSubject", receipt FROM "ChargingAdmissionWithdrawals" WHERE "tenantId"=:tenantId AND "chargingCalloutRef"=:ref',
      { tenantId, ref },
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1 || rows[0].actorSubject !== actorSubject) throw new ChargingAdmissionWithdrawalConflict('Withdrawal owner identity disagrees');
    return rows[0].receipt;
  }

  async withdraw(tenantId: number, body: ChargingAdmissionWithdrawalRequest, actorSubject: string): Promise<ChargingAdmissionWithdrawalReceipt> {
    this.requireEnabled();
    if (!actorSubject || body.schemaVersion !== '1.0.0' || body.expectedCommercialTarget.protocol !== 'ocpp1.6' ||
        body.expectedCommercialTarget.ocppEvseId !== body.expectedCommercialTarget.ocppConnectorId) {
      throw new ChargingAdmissionWithdrawalConflict('Unsupported owner withdrawal scope');
    }
    const requestHash = withdrawalRequestHash(body);
    return this.s.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async (transaction) => {
      // Serialize retries before any history locks; no caller can supply evidence or a fence.
      await this.select('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))',
        { key: `chargingWithdrawal:${tenantId}:${body.idempotencyKey}` }, transaction);
      const previous = await this.select<WithdrawalRow>(
        'SELECT "requestHash", "actorSubject", receipt FROM "ChargingAdmissionWithdrawals" WHERE "tenantId"=:tenantId AND ("chargingCalloutRef"=:ref OR "idempotencyKey"=:key)',
        { tenantId, ref: body.chargingCalloutRef, key: body.idempotencyKey }, transaction);
      if (previous.length) {
        if (previous.length !== 1 || previous[0].requestHash !== requestHash || previous[0].actorSubject !== actorSubject) {
          throw new ChargingAdmissionWithdrawalConflict('Divergent withdrawal identity or request');
        }
        return previous[0].receipt;
      }
      // SHARE precedes connector locks: every in-flight native insert/update and partition-retention DDL
      // must finish first. This bounded, exceptional owner operation cannot certify a moving history.
      await this.s.query('LOCK TABLE "Transactions", "TransactionKeys", "StartTransactions", "StopTransactions", "TransactionEvents" IN SHARE MODE', { transaction });
      const candidates = await this.select<CalloutRow>(
        'SELECT id,"tenantId","ocppConnectionName","authorizationId","connectorId",state,"decidedAt" FROM "ChargingAdmissionCallouts" WHERE id=:ref AND "tenantId"=:tenantId',
        { ref: body.chargingCalloutRef, tenantId }, transaction);
      const candidate = candidates[0];
      if (candidates.length !== 1 || !candidate || candidate.ocppConnectionName !== body.expectedCommercialTarget.ocppConnectionName) {
        throw new ChargingAdmissionWithdrawalConflict('Stored callout target is not the requested station');
      }
      const stations = await this.select<{ id: number; protocol: string }>(
        'SELECT id,protocol FROM "ChargingStations" WHERE "tenantId"=:tenantId AND "ocppConnectionName"=:connection FOR SHARE',
        { tenantId, connection: candidate.ocppConnectionName }, transaction);
      if (stations.length !== 1 || stations[0].protocol !== 'ocpp1.6') throw new ChargingAdmissionWithdrawalConflict('Station protocol/mapping is unknown');
      const stationId = stations[0].id;
      const connectors = await this.select<ConnectorRow>(
        'SELECT id,"tenantId","stationId","connectorId" FROM "Connectors" WHERE "tenantId"=:tenantId AND "stationId"=:stationId AND (id=:native OR "connectorId"=:wire) ORDER BY id FOR UPDATE',
        { tenantId, stationId, native: candidate.connectorId, wire: body.expectedCommercialTarget.ocppConnectorId }, transaction);
      const native = connectors.filter((c) => c.id === candidate.connectorId);
      const commercial = connectors.filter((c) => c.connectorId === body.expectedCommercialTarget.ocppConnectorId);
      if (connectors.length !== 2 || native.length !== 1 || commercial.length !== 1 || native[0].id === commercial[0].id ||
          !Number.isSafeInteger(native[0].connectorId) || native[0].connectorId <= 0) {
        throw new ChargingAdmissionWithdrawalConflict('Commercial/native target mapping is ambiguous or not distinct');
      }
      const locked = await this.select<CalloutRow>(
        `SELECT id,"tenantId","ocppConnectionName","authorizationId","connectorId",state,to_char("decidedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "decidedAt" FROM "ChargingAdmissionCallouts" WHERE id=:ref AND "tenantId"=:tenantId FOR UPDATE`,
        { tenantId, ref: candidate.id }, transaction);
      const callout = locked[0];
      if (!callout || callout.connectorId !== candidate.connectorId || callout.ocppConnectionName !== candidate.ocppConnectionName ||
          callout.authorizationId !== candidate.authorizationId || callout.state !== 'AUTHORIZED' || !callout.decidedAt) {
        throw new ChargingAdmissionWithdrawalConflict('Original callout is not an unchanged AUTHORIZED decision');
      }
      const raced = await this.select<WithdrawalRow>(
        'SELECT "requestHash", "actorSubject", receipt FROM "ChargingAdmissionWithdrawals" WHERE "tenantId"=:tenantId AND "chargingCalloutRef"=:ref',
        { tenantId, ref: callout.id }, transaction);
      if (raced.length) {
        if (raced.length !== 1 || raced[0].requestHash !== requestHash || raced[0].actorSubject !== actorSubject) {
          throw new ChargingAdmissionWithdrawalConflict('Divergent withdrawal identity or request');
        }
        return raced[0].receipt;
      }
      const consumed = await this.select<{ count: string }>(
        'SELECT count(*)::text AS count FROM "ChargingAdmissionConsumptions" WHERE "chargingCalloutRef"=:ref', { ref: callout.id }, transaction);
      if (consumed[0].count !== '0') throw new ChargingAdmissionWithdrawalConflict('Callout has a proven native consumption');
      // All station keys must have retained composite rows; unknown connector attribution is not filtered away.
      const consistency = await this.select<{ invalid: boolean }>(`
        SELECT EXISTS(
          SELECT 1 FROM "TransactionKeys" k LEFT JOIN "Transactions" t
            ON t.id=k."transactionDatabaseId" AND t."createdAt"=k."createdAt"
          WHERE k."stationId"=:stationId AND (k."tenantId"<>:tenantId OR t.id IS NULL OR t."stationId"<>:stationId OR t."tenantId"<>:tenantId OR t."transactionId"<>k."transactionId")
          UNION ALL
          SELECT 1 FROM "Transactions" t LEFT JOIN "TransactionKeys" k
            ON k."transactionDatabaseId"=t.id AND k."createdAt"=t."createdAt" AND k."stationId"=t."stationId" AND k."transactionId"=t."transactionId"
          LEFT JOIN "Connectors" c ON c.id=t."connectorId"
          WHERE t."stationId"=:stationId AND (t."tenantId"<>:tenantId OR k."stationId" IS NULL OR c.id IS NULL OR c."stationId"<>:stationId OR c."tenantId"<>:tenantId)
          UNION ALL
          SELECT 1 FROM "StartTransactions" e LEFT JOIN "Transactions" t ON t.id=e."transactionDatabaseId" AND t."createdAt"=e."transactionCreatedAt"
          WHERE (e."ocppConnectionName"=:connection AND e."tenantId"=:tenantId OR e."connectorDatabaseId" IN (:native,:commercial))
            AND (t.id IS NULL OR t."stationId"<>:stationId OR t."tenantId"<>:tenantId OR e."tenantId"<>:tenantId OR e."ocppConnectionName"<>:connection OR t."connectorId"<>e."connectorDatabaseId")
          UNION ALL
          SELECT 1 FROM "StopTransactions" e LEFT JOIN "Transactions" t ON t.id=e."transactionDatabaseId" AND t."createdAt"=e."transactionCreatedAt"
          WHERE e."ocppConnectionName"=:connection AND e."tenantId"=:tenantId AND (t.id IS NULL OR t."stationId"<>:stationId)
          UNION ALL
          SELECT 1 FROM "TransactionEvents" e LEFT JOIN "Transactions" t ON t.id=e."transactionDatabaseId" AND t."createdAt"=e."transactionCreatedAt"
          WHERE e."ocppConnectionName"=:connection AND e."tenantId"=:tenantId AND (t.id IS NULL OR t."stationId"<>:stationId OR t."tenantId"<>:tenantId)
        ) AS invalid`, { tenantId, stationId, connection: callout.ocppConnectionName, native: native[0].id, commercial: commercial[0].id }, transaction);
      if (consistency[0].invalid) throw new ChargingAdmissionWithdrawalConflict('Station transaction-key/event retention or attribution gap');
      const rows = await this.select<RetainedNativeSession>(`
        SELECT t.id,to_char(t."createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",t."stationId",t."tenantId",t."transactionId",t."connectorId",t."isActive",
          to_char(t."endTime" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "endTime",
          (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',e.id,'createdAt',to_char(e."createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'timestamp',to_char(e.timestamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'meterStart',e."meterStart"::text,'connectorDatabaseId',e."connectorDatabaseId",'tenantId',e."tenantId",'ocppConnectionName',e."ocppConnectionName")), '[]'::jsonb)
            FROM "StartTransactions" e WHERE e."transactionDatabaseId"=t.id AND e."transactionCreatedAt"=t."createdAt") AS starts,
          (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',e.id,'createdAt',to_char(e."createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'timestamp',to_char(e.timestamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'meterStop',e."meterStop"::text,'tenantId',e."tenantId",'ocppConnectionName',e."ocppConnectionName")), '[]'::jsonb)
            FROM "StopTransactions" e WHERE e."transactionDatabaseId"=t.id AND e."transactionCreatedAt"=t."createdAt") AS stops,
          (SELECT count(*)::integer FROM "TransactionEvents" e WHERE e."transactionDatabaseId"=t.id AND e."transactionCreatedAt"=t."createdAt") AS "eventCount"
        FROM "Transactions" t WHERE t."connectorId"=:connectorId
        ORDER BY t."createdAt",t.id LIMIT 1001`, { connectorId: native[0].id }, transaction);
      const nativeSessions = proveAllRetainedNativeSessions(rows, { tenantId, stationId, connectorId: native[0].id, ocppConnectionName: callout.ocppConnectionName });
      const id = randomUUID();
      const allocated = await this.select<{ fence: string; withdrawnAt: string }>(
        `SELECT nextval(pg_get_serial_sequence('"ChargingAdmissionWithdrawals"','fence'))::text AS fence, to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "withdrawnAt"`, {}, transaction);
      const receipt: ChargingAdmissionWithdrawalReceipt = {
        schemaVersion: 'CORE_AUTHORIZED_TARGET_WITHDRAWAL_V1', coreEvidenceRef: `core-withdrawal:${id}`,
        chargingCalloutRef: callout.id, coreTenantId: tenantId, ocppConnectionName: callout.ocppConnectionName,
        authorizationId: callout.authorizationId, originalDecision: 'AUTHORIZED', originalDecisionRecordedAt: callout.decidedAt,
        authorizedTarget: { nativeConnectorId: native[0].id, protocol: 'ocpp1.6', ocppEvseId: native[0].connectorId, ocppConnectorId: native[0].connectorId },
        requestedCommercialTarget: { nativeConnectorId: commercial[0].id, protocol: 'ocpp1.6', ocppEvseId: commercial[0].connectorId, ocppConnectorId: commercial[0].connectorId },
        withdrawal: { state: 'WITHDRAWN', fence: allocated[0].fence, withdrawnAt: allocated[0].withdrawnAt, durable: true },
        nativeSessionScope: 'ALL_RETAINED_SESSIONS_FOR_AUTHORIZED_NATIVE_CONNECTOR', nativeSessions,
        causalCalloutTransactionBinding: 'NOT_ASSERTED_FOR_LEGACY_ROWS', requestHash, actorSubject,
      };
      await this.s.query(`INSERT INTO "ChargingAdmissionWithdrawals"
        (id,"tenantId","chargingCalloutRef","idempotencyKey","requestHash","actorSubject","stationId","authorizedConnectorId","commercialConnectorId",fence,"withdrawnAt",receipt)
        VALUES (:id,:tenantId,:ref,:key,:hash,:actor,:stationId,:native,:commercial,:fence,:at,CAST(:receipt AS jsonb))`,
        { replacements: { id, tenantId, ref: callout.id, key: body.idempotencyKey, hash: requestHash, actor: actorSubject, stationId, native: native[0].id, commercial: commercial[0].id, fence: receipt.withdrawal.fence, at: receipt.withdrawal.withdrawnAt, receipt: JSON.stringify(receipt) }, transaction });
      return receipt;
    }).catch((error: unknown) => {
      if (error instanceof UniqueConstraintError ||
          error instanceof DatabaseError && ['P0001', '23514', '23505', '40001', '40P01'].includes((error.original as Error & { code?: string }).code ?? '')) {
        throw new ChargingAdmissionWithdrawalConflict('Withdrawal conflicts with durable native state or concurrent consumption');
      }
      throw error;
    });
  }
}
