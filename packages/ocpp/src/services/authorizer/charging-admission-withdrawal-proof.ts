// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type {
  ChargingAdmissionNativeSession,
  ChargingAdmissionWithdrawalRequest,
} from '@citrineos/types';

export class ChargingAdmissionWithdrawalConflict extends Error {
  readonly statusCode = 409;
}

export function withdrawalRequestHash(body: ChargingAdmissionWithdrawalRequest): string {
  const target = body.expectedCommercialTarget;
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: body.schemaVersion,
    chargingCalloutRef: body.chargingCalloutRef,
    idempotencyKey: body.idempotencyKey,
    expectedCommercialTarget: {
      ocppConnectionName: target.ocppConnectionName,
      protocol: target.protocol,
      ocppEvseId: target.ocppEvseId,
      ocppConnectorId: target.ocppConnectorId,
    },
  })).digest('hex');
}

export interface RetainedNativeSession {
  id: number;
  createdAt: string;
  stationId: number;
  tenantId: number;
  transactionId: string;
  connectorId: number | null;
  isActive: boolean;
  endTime: string | null;
  starts: Array<{
    id: number; createdAt: string; timestamp: string; meterStart: string | number;
    connectorDatabaseId: number; tenantId: number; ocppConnectionName: string;
  }>;
  stops: Array<{
    id: number; createdAt: string; timestamp: string; meterStop: string | number;
    tenantId: number; ocppConnectionName: string;
  }>;
  eventCount: number;
}

function iso(value: string): string {
  const date = new Date(value);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(value) || !Number.isFinite(date.getTime())) {
    throw new ChargingAdmissionWithdrawalConflict('Missing durable event time');
  }
  // Composite identities must retain PostgreSQL microseconds, not JS Date's millisecond rounding.
  return value;
}

function register(value: string | number): string {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new ChargingAdmissionWithdrawalConflict('Unknown Start/Stop register');
  return BigInt(text).toString();
}

/** No token, time-window or callout-to-transaction inference is involved. */
export function proveAllRetainedNativeSessions(
  rows: RetainedNativeSession[],
  expected: { tenantId: number; stationId: number; connectorId: number; ocppConnectionName: string },
): ChargingAdmissionNativeSession[] {
  if (rows.length === 0 || rows.length > 1000) throw new ChargingAdmissionWithdrawalConflict('Native history absent or exceeds complete bounded proof');
  const seen = new Set<string>();
  return rows.map((row) => {
    const key = `${row.id}:${row.createdAt}`;
    if (seen.has(key)) throw new ChargingAdmissionWithdrawalConflict('Ambiguous native identity');
    seen.add(key);
    if (row.tenantId !== expected.tenantId || row.stationId !== expected.stationId ||
        row.connectorId !== expected.connectorId || row.isActive !== false || !row.endTime ||
        row.eventCount !== 0 || row.starts.length !== 1 || row.stops.length !== 1) {
      throw new ChargingAdmissionWithdrawalConflict('Native history is active, ambiguous or lacks genuine Start/Stop');
    }
    const start = row.starts[0];
    const stop = row.stops[0];
    if (start.tenantId !== expected.tenantId || stop.tenantId !== expected.tenantId ||
        start.ocppConnectionName !== expected.ocppConnectionName || stop.ocppConnectionName !== expected.ocppConnectionName ||
        start.connectorDatabaseId !== expected.connectorId) {
      throw new ChargingAdmissionWithdrawalConflict('Native Start/Stop scope disagrees');
    }
    const meterStartWh = register(start.meterStart);
    const meterStopWh = register(stop.meterStop);
    const endedAt = iso(row.endTime);
    const startAt = iso(start.timestamp);
    const stopAt = iso(stop.timestamp);
    if (meterStartWh !== meterStopWh || stopAt < startAt || endedAt !== stopAt) {
      throw new ChargingAdmissionWithdrawalConflict('Native session has nonzero or inconsistent terminal evidence');
    }
    return {
      nativeTransaction: { id: row.id, createdAt: iso(row.createdAt), stationId: row.stationId, transactionId: row.transactionId },
      startEvent: { id: start.id, createdAt: iso(start.createdAt), timestamp: startAt, meterStartWh },
      stopEvent: { id: stop.id, createdAt: iso(stop.createdAt), timestamp: stopAt, meterStopWh },
      endedAt,
      deliveredEnergyWh: '0',
    };
  });
}
