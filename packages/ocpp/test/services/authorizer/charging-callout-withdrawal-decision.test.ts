// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
// SPDX-License-Identifier: Apache-2.0
import { ChargingAdmissionCallout } from '@citrineos/dal';
import type { SystemConfig } from '@citrineos/types';
import { SequelizeChargingCalloutStore } from '@services/authorizer/SequelizeChargingCalloutStore.js';
import { Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ref = '2a43d152-c973-4336-8867-e9c39fc80731';
const now = new Date('2026-11-16T00:00:00.000Z');

function setup(state = 'PENDING', withdrawn = false) {
  const original = {
    id: ref, tenantId: 1, connectorId: 100, state,
    decidedAt: state === 'AUTHORIZED' ? now : null,
    coreEvidenceRef: null, declineDeliveredAt: null, declineAttempts: 0,
    nextDeclineAt: null, lastDeclineError: null, declineAbandoned: false,
  };
  const events: string[] = [];
  const tx = { LOCK: Transaction.LOCK } as Transaction;
  const query = vi.fn(async (sql: string, _options: unknown) => {
    if (sql.includes('"Connectors"')) {
      events.push('connector');
      return [{ id: 100 }];
    }
    events.push('withdrawal');
    return withdrawn ? [{ chargingCalloutRef: ref }] : [];
  });
  const transaction = vi.fn(async (_options: unknown, run: (tx: Transaction) => Promise<boolean>) => run(tx));
  vi.spyOn(ChargingAdmissionCallout, 'findByPk').mockImplementation((async (
    _ref: unknown, options: { lock?: unknown },
  ) => {
    events.push(options.lock ? 'callout' : 'identity');
    return { ...original };
  }) as never);
  const update = vi.spyOn(ChargingAdmissionCallout, 'update').mockImplementation((async () => {
    events.push('update');
    return [1];
  }) as never);
  const store = new SequelizeChargingCalloutStore({
    config: {} as SystemConfig,
    sequelizeInstance: { query, transaction } as unknown as Sequelize,
  });
  return { store, events, original, query, transaction, update, tx };
}

afterEach(() => vi.restoreAllMocks());

describe('callout decision withdrawal arbitration through Sequelize ports', () => {
  it.each(['authorize', 'decline'] as const)('locks connector before callout and commits %s in READ COMMITTED', async (decision) => {
    const f = setup();
    const result = decision === 'authorize'
      ? await f.store.markAuthorized(ref, now)
      : await f.store.markDeclined(ref, 'core-decision:declined', now);
    expect(result).toBe(true);
    expect(f.events).toEqual(['identity', 'connector', 'callout', 'withdrawal', 'update']);
    expect(f.transaction.mock.calls[0][0]).toEqual({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED });
    expect(f.query.mock.calls[0][1]).toMatchObject({
      replacements: { connectorId: 100, tenantId: 1 }, transaction: f.tx,
    });
    expect(f.update.mock.calls[0][0]).toMatchObject({
      state: decision === 'authorize' ? 'AUTHORIZED' : 'DECLINED_BEFORE_POWER', decidedAt: now,
    });
    expect(f.update.mock.calls[0][1]).toMatchObject({
      transaction: f.tx, where: { id: ref, state: 'PENDING' },
    });
  });

  it.each(['authorize', 'decline'] as const)('refuses late %s without changing withdrawn original evidence', async (decision) => {
    const f = setup('AUTHORIZED', true);
    const before = { ...f.original };
    const result = decision === 'authorize'
      ? await f.store.markAuthorized(ref, new Date(now.getTime() + 1))
      : await f.store.markDeclined(ref, 'must-not-replace-original', new Date(now.getTime() + 1));
    expect(result).toBe(false);
    expect(f.events).toEqual(['identity', 'connector', 'callout']);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.original).toEqual(before);
  });

  it.each(['authorize', 'decline'] as const)('checks persisted withdrawal even if a port reports PENDING during %s', async (decision) => {
    const f = setup('PENDING', true);
    const result = decision === 'authorize'
      ? await f.store.markAuthorized(ref, now)
      : await f.store.markDeclined(ref, 'must-not-write', now);
    expect(result).toBe(false);
    expect(f.events).toEqual(['identity', 'connector', 'callout', 'withdrawal']);
    expect(f.update).not.toHaveBeenCalled();
  });

});
