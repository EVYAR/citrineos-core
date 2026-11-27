// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { proveAllRetainedNativeSessions, withdrawalRequestHash, type RetainedNativeSession } from '@/services/authorizer/charging-admission-withdrawal-proof.js';
import type { ChargingAdmissionWithdrawalRequest } from '@citrineos/types';

const expected = { tenantId: 1, stationId: 4, connectorId: 22, ocppConnectionName: 'fixture-station' };
const at = '2026-11-16T00:00:00.000Z';
const end = '2026-11-16T00:01:00.000Z';
function session(id = 8): RetainedNativeSession {
  return { id, createdAt: at, stationId: 4, tenantId: 1, transactionId: String(id), connectorId: 22,
    isActive: false, endTime: end, eventCount: 0,
    starts: [{ id: 1, createdAt: at, timestamp: at, meterStart: '9007199254740993', connectorDatabaseId: 22, tenantId: 1, ocppConnectionName: 'fixture-station' }],
    stops: [{ id: 2, createdAt: end, timestamp: end, meterStop: '9007199254740993', tenantId: 1, ocppConnectionName: 'fixture-station' }],
  };
}
describe('independent all-retained-native-session withdrawal proof', () => {
  it('keeps actual composite identity and exact decimal registers without inventing callout causality', () => {
    expect(proveAllRetainedNativeSessions([session()], expected)).toEqual([{
      nativeTransaction: { id: 8, createdAt: at, stationId: 4, transactionId: '8' },
      startEvent: { id: 1, createdAt: at, timestamp: at, meterStartWh: '9007199254740993' },
      stopEvent: { id: 2, createdAt: end, timestamp: end, meterStopWh: '9007199254740993' },
      endedAt: end, deliveredEnergyWh: '0',
    }]);
  });
  it('retains microsecond native composite identities instead of rounding two rows together', () => {
    const first = session();
    first.createdAt = '2026-11-16T00:00:00.000001Z';
    const second = session();
    second.createdAt = '2026-11-16T00:00:00.000002Z';
    const proof = proveAllRetainedNativeSessions([first, second], expected);
    expect(proof.map((row) => row.nativeTransaction.createdAt)).toEqual([first.createdAt, second.createdAt]);
  });
  it('refuses one nonzero historical session even when another session is safely zero', () => {
    const bad = session(7); bad.stops[0].meterStop = '9007199254740994';
    expect(() => proveAllRetainedNativeSessions([bad, session()], expected)).toThrow(/nonzero/);
  });
  it.each([
    ['active', (r: RetainedNativeSession) => { r.isActive = true; }],
    ['unknown state', (r: RetainedNativeSession) => { r.isActive = null as unknown as boolean; }],
    ['missing Stop', (r: RetainedNativeSession) => { r.stops = []; }],
    ['missing Start', (r: RetainedNativeSession) => { r.starts = []; }],
    ['duplicate Start', (r: RetainedNativeSession) => { r.starts.push({ ...r.starts[0] }); }],
    ['wrong connector', (r: RetainedNativeSession) => { r.starts[0].connectorDatabaseId = 21; }],
    ['wrong tenant', (r: RetainedNativeSession) => { r.stops[0].tenantId = 2; }],
    ['wrong station', (r: RetainedNativeSession) => { r.stationId = 5; }],
    ['missing end', (r: RetainedNativeSession) => { r.endTime = null; }],
    ['negative register', (r: RetainedNativeSession) => { r.starts[0].meterStart = '-1'; }],
    ['unknown register', (r: RetainedNativeSession) => { r.stops[0].meterStop = 'NaN'; }],
    ['2.x event ambiguity', (r: RetainedNativeSession) => { r.eventCount = 1; }],
    ['terminal time drift', (r: RetainedNativeSession) => { r.endTime = at; }],
  ])('refuses %s', (_name, mutate) => {
    const row = session(); mutate(row);
    expect(() => proveAllRetainedNativeSessions([row], expected)).toThrow();
  });
  it('requires a genuine session and complete bounded unique history', () => {
    expect(() => proveAllRetainedNativeSessions([], expected)).toThrow();
    expect(() => proveAllRetainedNativeSessions([session(), session()], expected)).toThrow(/identity/);
    expect(() => proveAllRetainedNativeSessions(Array.from({ length: 1001 }, (_, id) => session(id)), expected)).toThrow(/bounded/);
  });
  it('hashes fixed semantic field order but binds every commercial value and stable key', () => {
    const body: ChargingAdmissionWithdrawalRequest = { schemaVersion: '1.0.0', chargingCalloutRef: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'stable', expectedCommercialTarget: { ocppConnectionName: 'fixture-station', protocol: 'ocpp1.6', ocppEvseId: 1, ocppConnectorId: 1 } };
    const reordered = { expectedCommercialTarget: { ocppConnectorId: 1, ocppEvseId: 1, protocol: 'ocpp1.6' as const, ocppConnectionName: 'fixture-station' }, idempotencyKey: 'stable', chargingCalloutRef: body.chargingCalloutRef, schemaVersion: '1.0.0' as const };
    expect(withdrawalRequestHash(reordered)).toBe(withdrawalRequestHash(body));
    expect(withdrawalRequestHash({ ...body, idempotencyKey: 'other' })).not.toBe(withdrawalRequestHash(body));
    expect(withdrawalRequestHash({ ...body, expectedCommercialTarget: { ...body.expectedCommercialTarget, ocppConnectorId: 2 } })).not.toBe(withdrawalRequestHash(body));
  });
});
