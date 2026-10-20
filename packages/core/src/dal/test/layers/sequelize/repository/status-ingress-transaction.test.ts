import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageOrigin, MessageState } from '@citrineos/base';
import { SequelizeLocationRepository } from '../../../../layers/sequelize/repository/Location.js';
import { ChargingStation } from '../../../../layers/sequelize/model/Location/ChargingStation.js';
import { Connector } from '../../../../layers/sequelize/model/Location/Connector.js';
import { StatusNotification } from '../../../../layers/sequelize/model/Location/StatusNotification.js';
import { LatestStatusNotification } from '../../../../layers/sequelize/model/Location/LatestStatusNotification.js';
import { VariableAttribute } from '../../../../layers/sequelize/model/DeviceModel/VariableAttribute.js';
import { OCPPMessage } from '../../../../layers/sequelize/model/OCPPMessage.js';

/** Transaction-contract tests; real PostgreSQL lock/rollback acceptance is separate. */
describe('atomic status projection transaction contract', () => {
  afterEach(() => vi.restoreAllMocks());

  function fixture() {
    const transaction = { LOCK: { UPDATE: 'UPDATE' } };
    const owner = { id: 1, statusIngressConnection: 'socket', update: vi.fn().mockResolvedValue(undefined) };
    const history: any[] = [];
    let pointers: any[] = [];
    let connectorStatus: string | undefined;
    let nextReceipt = 101;
    const payload = { connectorId: 1, status: 'Available', timestamp: '2026-10-20T19:59:59.116Z' };
    const station = vi.spyOn(ChargingStation, 'findOne').mockResolvedValue(owner as any);
    const receiptRead = vi.spyOn(OCPPMessage, 'findOne').mockImplementation(async () => ({
      id: nextReceipt, protocol: 'ocpp1.6', message: [2, 'call', 'StatusNotification', payload],
      timestamp: payload.timestamp, origin: MessageOrigin.ChargingStation, state: MessageState.Request,
    }) as any);
    vi.spyOn(StatusNotification, 'findOne').mockImplementation(async (options: any) =>
      history.find((row) => row.ingressMessageId === options.where.ingressMessageId) ?? null);
    vi.spyOn(StatusNotification, 'create').mockImplementation(async (values: any, options: any) => {
      expect(options.transaction).toBe(transaction);
      const row = { ...values, id: history.length + 1, createdAt: new Date() };
      history.push(row);
      return row;
    });
    vi.spyOn(LatestStatusNotification, 'findAll').mockImplementation(async () => pointers as any);
    vi.spyOn(LatestStatusNotification, 'destroy').mockImplementation(async (options: any) => {
      expect(options.transaction).toBe(transaction);
      const count = pointers.length;
      pointers = [];
      return count;
    });
    vi.spyOn(LatestStatusNotification, 'create').mockImplementation(async (values: any, options: any) => {
      expect(options.transaction).toBe(transaction);
      const row = { ...values, id: 1, statusNotification: history.find((s) => s.id === values.statusNotificationId) };
      pointers.push(row);
      return row as any;
    });
    vi.spyOn(Connector, 'findOrCreate').mockImplementation(async (options: any) => {
      expect(options.transaction).toBe(transaction);
      return [{ update: async (values: any, updateOptions: any) => {
        expect(updateOptions.transaction).toBe(transaction);
        connectorStatus = values.status;
      } }, false] as any;
    });
    const repository = Object.create(SequelizeLocationRepository.prototype) as SequelizeLocationRepository;
    Object.defineProperty(repository, 's', { value: { transaction: async (work: any) => work(transaction) } });
    async function apply(id: number, status = 'Available', connection = 'socket', effects: any[] = []) {
      nextReceipt = id;
      payload.status = status;
      return repository.applyOrderedStatus(1, 'station', {
        connectorId: 1, evseId: 1, timestamp: payload.timestamp,
        get: () => ({ connectorId: 1, evseId: 1, timestamp: payload.timestamp, connectorStatus: status }),
      } as any, { connectorId: 1, status, evseId: 1 } as any, payload,
      { messageId: id, correlationId: 'call', connection, protocol: 'ocpp1.6' }, false, effects);
    }
    return { apply, history, owner, station, transaction, repository, receiptRead,
      current: () => ({ pointers, connectorStatus }) };
  }

  it('late completion of the earlier equal-time CALL cannot regress Connector or latest pointer', async () => {
    const f = fixture();
    expect(await f.apply(102, 'Available')).toBe(true);
    expect(await f.apply(101, 'Finishing')).toBe(false);
    expect(f.history).toHaveLength(2);
    expect(f.current().pointers).toHaveLength(1);
    expect(f.current().pointers[0].statusNotification.ingressMessageId).toBe(102);
    expect(f.current().connectorStatus).toBe('Available');
    expect(f.station).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1, ocppConnectionName: 'station' },
      transaction: f.transaction, lock: 'UPDATE',
    }));
  });

  it('replay and retired-socket messages retain evidence without changing live state', async () => {
    const f = fixture();
    expect(await f.apply(101)).toBe(true);
    expect(await f.apply(101)).toBe(false);
    expect(f.history).toHaveLength(1);
    f.owner.statusIngressConnection = 'new-socket';
    expect(await f.apply(102, 'Finishing')).toBe(false);
    expect(f.current().connectorStatus).toBe('Available');
    expect(f.current().pointers).toHaveLength(1);
  });
  it('rechecks the actual current socket only after acquiring the station lock', async () => {
    const f = fixture();
    const order: string[] = [];
    f.station.mockImplementation(async () => { order.push('lock'); return f.owner as any; });
    await expect(f.repository.setStatusIngressConnection(1, 'station', 'retired', async () => {
      order.push('fresh-claim');
      return false;
    })).rejects.toThrow('STATUS_INGRESS_RETIRED_REGISTRATION');
    expect(order).toEqual(['lock', 'fresh-claim']);
    expect(f.owner.update).not.toHaveBeenCalled();
    await f.repository.setStatusIngressConnection(1, 'station', 'new', async () => true);
    expect(f.owner.update).toHaveBeenCalledWith({ statusIngressConnection: 'new' }, { transaction: f.transaction });
  });

  it('commits the winning availability attribute inside the same status transaction only', async () => {
    const f = fixture();
    const update = vi.fn().mockResolvedValue(undefined);
    const attributes = vi.spyOn(VariableAttribute, 'findOrCreate').mockResolvedValue([{ update }, false] as any);
    const effect = { componentId: 3, variableId: 4, value: 'Available', generatedAt: '2026-10-20T19:59:59.116Z' };
    expect(await f.apply(102, 'Available', 'socket', [effect])).toBe(true);
    expect(attributes).toHaveBeenCalledWith(expect.objectContaining({ transaction: f.transaction }));
    expect(update).toHaveBeenCalledWith({ value: 'Available', generatedAt: effect.generatedAt }, { transaction: f.transaction });
    expect(await f.apply(101, 'Finishing', 'socket', [{ ...effect, value: 'Occupied' }])).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('rejects a protocol-mismatched original receipt before any historical or live write', async () => {
    const f = fixture();
    f.receiptRead.mockResolvedValue({ id: 101, protocol: 'ocpp2.0.1',
      message: [2, 'call', 'StatusNotification', { connectorId: 1, status: 'Available', timestamp: '2026-10-20T19:59:59.116Z' }] } as any);
    await expect(f.apply(101)).rejects.toThrow('STATUS_INGRESS_RECEIPT_MISMATCH');
    expect(f.history).toHaveLength(0);
    expect(f.current().pointers).toHaveLength(0);
  });

});
