// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { Logger, type ILogObj } from 'tslog';
import { ChargingStationSequenceTypeEnum, type SystemConfig } from '@citrineos/types';
import { SequelizeChargingStationSequenceRepository } from '@dal/repositories/sequelize/charging-station-sequence.js';
import { resolveStationIdOrThrow } from '@dal/repositories/sequelize/resolve-station-id.js';

vi.mock('@dal/db/sequelize/util.js', () => ({
  DefaultSequelizeInstance: { getInstance: vi.fn() },
}));
vi.mock('@dal/repositories/sequelize/resolve-station-id.js', () => ({
  resolveStationIdOrThrow: vi.fn(),
}));

interface QueryOptions {
  bind: { tenantId: number; stationId: number; type: string };
  transaction: Transaction;
}

describe('SequelizeChargingStationSequenceRepository allocation contract', () => {
  const tenantId = 1;
  const connection = 'CP_TEST_001';
  const stationId = 42;
  const type = ChargingStationSequenceTypeEnum.getChargingProfiles;
  const logger = new Logger<ILogObj>({ type: 'hidden' });
  let repository: SequelizeChargingStationSequenceRepository;
  let query: Mock<(sql: string, options: QueryOptions) => Promise<Array<{ value: unknown }>>>;
  let transaction: Mock<(work: (tx: Transaction) => Promise<number>) => Promise<number>>;
  let standaloneTransaction: Transaction;
  let transactionOutcomes: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    standaloneTransaction = {} as Transaction;
    transactionOutcomes = [];
    query = vi.fn<(sql: string, options: QueryOptions) => Promise<Array<{ value: unknown }>>>()
      .mockResolvedValue([{ value: '1' }]);
    transaction = vi.fn(async (work: (tx: Transaction) => Promise<number>) => {
      transactionOutcomes.push('begin');
      try {
        const value = await work(standaloneTransaction);
        transactionOutcomes.push('commit');
        return value;
      } catch (error) {
        transactionOutcomes.push('rollback');
        throw error;
      }
    });
    repository = new SequelizeChargingStationSequenceRepository({
      config: {} as SystemConfig,
      logger,
      sequelizeInstance: { query, transaction } as unknown as Sequelize,
    });
    vi.mocked(resolveStationIdOrThrow).mockResolvedValue(stationId);
  });

  it.each([
    ['first allocation', '1', 1],
    ['existing counter', '5', 5],
    ['BIGINT text', '42', 42],
    ['numeric driver value', 100, 100],
    ['largest exactly representable allocation', String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])('returns the database allocation for %s without substituting a counter', async (_name, value, expected) => {
    query.mockResolvedValue([{ value }]);
    expect(await repository.getNextSequenceValue(tenantId, connection, type)).toBe(expected);
    expect(transactionOutcomes).toEqual(['begin', 'commit']);
  });

  it.each([
    null, undefined, 'invalid', '42trailing', '0', '-1', '01',
    '9007199254740992', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, 1.5,
  ])('rejects malformed or unrepresentable allocation %j instead of resetting to 1', async (value) => {
    query.mockResolvedValue([{ value }]);
    await expect(repository.getNextSequenceValue(tenantId, connection, type)).rejects.toThrow(
      'Cannot allocate a valid positive charging-station sequence value',
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(transactionOutcomes).toEqual(['begin', 'rollback']);
  });

  it('rejects an exhausted or scope-conflicting counter without retrying/resetting it', async () => {
    query.mockResolvedValue([]);
    await expect(repository.getNextSequenceValue(tenantId, connection, type)).rejects.toThrow(
      'Cannot allocate a valid positive charging-station sequence value',
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(transactionOutcomes).toEqual(['begin', 'rollback']);
  });

  it('rejects an ambiguous database result instead of picking an allocation', async () => {
    query.mockResolvedValue([{ value: '1' }, { value: '2' }]);
    await expect(repository.getNextSequenceValue(tenantId, connection, type)).rejects.toThrow(
      'Cannot allocate a valid positive charging-station sequence value',
    );
    expect(transactionOutcomes).toEqual(['begin', 'rollback']);
  });

  it('keeps same-name stations and sequence namespaces scoped to the requested tenant', async () => {
    vi.mocked(resolveStationIdOrThrow).mockImplementation(async (tenant) => tenant === tenantId ? stationId : 84);
    query.mockImplementation(async (_sql, { bind }) => {
      if (bind.tenantId === 1 && bind.stationId === 42 && bind.type === type) return [{ value: '7' }];
      if (bind.tenantId === 2 && bind.stationId === 84 && bind.type === type) return [{ value: '23' }];
      throw new Error('Counter scope diverged');
    });
    expect(await repository.getNextSequenceValue(1, connection, type)).toBe(7);
    expect(await repository.getNextSequenceValue(2, connection, type)).toBe(23);
  });

  it('refuses a station outside the tenant before any counter write', async () => {
    const missing = new Error(`No charging station ${connection} exists in tenant ${tenantId}`);
    vi.mocked(resolveStationIdOrThrow).mockRejectedValue(missing);
    await expect(repository.getNextSequenceValue(tenantId, connection, type)).rejects.toBe(missing);
    expect(query).not.toHaveBeenCalled();
    expect(transactionOutcomes).toEqual(['begin', 'rollback']);
  });

  it('participates in the caller transaction without creating or committing another transaction', async () => {
    const callerTransaction = {} as Transaction;
    query.mockImplementation(async (_sql, options) => {
      if (options.transaction !== callerTransaction) throw new Error('Caller transaction lost');
      return [{ value: '17' }];
    });
    expect(await repository.getNextSequenceValue(tenantId, connection, type, callerTransaction)).toBe(17);
    expect(transaction).not.toHaveBeenCalled();
    expect(transactionOutcomes).toEqual([]);
  });

  it('propagates the original database error and aborts standalone allocation', async () => {
    const failure = new Error('Database refused allocation');
    query.mockRejectedValue(failure);
    await expect(repository.getNextSequenceValue(tenantId, connection, type)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
    expect(transactionOutcomes).toEqual(['begin', 'rollback']);
  });

  it('leaves rollback authority with the caller when an allocation fails in its transaction', async () => {
    const callerTransaction = {} as Transaction;
    const failure = new Error('Caller transaction allocation failed');
    query.mockRejectedValue(failure);
    await expect(repository.getNextSequenceValue(tenantId, connection, type, callerTransaction)).rejects.toBe(failure);
    expect(transaction).not.toHaveBeenCalled();
    expect(transactionOutcomes).toEqual([]);
  });
});
